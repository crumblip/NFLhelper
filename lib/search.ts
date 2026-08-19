import { sqlite } from './db/index';

/**
 * The searchable player universe.
 *
 * The board is built from `value_scores JOIN adp_raw`, which means it can only
 * ever contain players the ADP feed prices — 179 of them. Searching it therefore
 * could not find Dylan Sampson: Cleveland's listed RB2, 15 games and a 17% rush
 * share last season, simply absent because nobody drafts him in a 12-team
 * league. That is exactly the player a waiver tool exists to surface, so search
 * has to run against a wider pool than the board does.
 *
 * The union here is deliberately three sources rather than the whole `players`
 * table, which holds 25,000 rows going back to the 1970s. A player is searchable
 * if he is being drafted, if he had a role last season, or if he is on a current
 * depth chart. Anyone outside all three has no 2026 relevance to look up.
 */

export type Availability = 'board' | 'wire' | 'roster';

export interface SearchEntry {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  /** Null for anyone not being drafted. */
  adp: number | null;
  /** Points over replacement from the blend — board players only. */
  vorp: number | null;
  /** Usage percentile within position, where last season gives one. */
  usageGrade: number | null;
  depthRank: number | null;
  games: number | null;
  /**
   * `board` is being drafted, `wire` had a real role but goes undrafted, and
   * `roster` is on a depth chart with no measured usage behind him.
   */
  availability: Availability;
  /** Lowercased tokens plus the joined form, so "dylan", "sampson" and
   *  "dylansampson" all hit without normalizing on every keystroke. */
  haystack: string;
}

let cache: { stamp: string; key: string; entries: SearchEntry[] } | null = null;

function dataStamp(season: number): string {
  const v = sqlite
    .prepare(`SELECT COALESCE(MAX(computed_at), 0) AS t, COUNT(*) AS n FROM value_scores WHERE season = ?`)
    .get(season) as { t: number; n: number };
  const d = sqlite
    .prepare(`SELECT COALESCE(MAX(as_of), '') AS t, COUNT(*) AS n FROM depth_chart WHERE season = ?`)
    .get(season) as { t: string; n: number };
  const u = sqlite
    .prepare(`SELECT COALESCE(MAX(computed_at), 0) AS t, COUNT(*) AS n FROM player_usage`)
    .get() as { t: number; n: number };
  return `${v.t}:${v.n}|${d.t}:${d.n}|${u.t}:${u.n}`;
}

/**
 * Built once and handed to the client whole.
 *
 * At roughly a thousand rows this is small enough to ship, and doing so makes
 * search instant while typing rather than a round trip per keystroke — which
 * matters when the tool is open mid-draft and the clock is running.
 */
export function getSearchIndex(format: string, teams: number, season: number): SearchEntry[] {
  const key = `${format}|${teams}|${season}`;
  const stamp = dataStamp(season);
  if (cache && cache.key === key && cache.stamp === stamp) return cache.entries;

  const rows = sqlite
    .prepare(
      `WITH pool AS (
         SELECT player_id FROM adp_raw
           WHERE year = ? AND format = ? AND teams = ? AND player_id IS NOT NULL
         UNION
         SELECT player_id FROM player_usage
           WHERE season = ? AND position IN ('QB','RB','WR','TE')
         UNION
         SELECT player_id FROM depth_chart
           WHERE season = ? AND pos_abb IN ('QB','RB','WR','TE')
       )
       SELECT p.player_id AS playerId,
              pl.display_name AS name,
              COALESCE(a.position, u.position, dc.pos_abb, pl.position) AS position,
              COALESCE(a.team, dc.team, u.team, pl.latest_team) AS team,
              a.adp,
              v.blended_vorp AS vorp,
              v.usage_grade AS usageGrade,
              dc.rank AS depthRank,
              u.games
       FROM pool p
       JOIN players pl ON pl.gsis_id = p.player_id
       LEFT JOIN adp_raw a ON a.player_id = p.player_id AND a.year = ?
         AND a.format = ? AND a.teams = ?
       LEFT JOIN value_scores v ON v.player_id = p.player_id AND v.season = ?
         AND v.format = ? AND v.teams = ?
       LEFT JOIN player_usage u ON u.player_id = p.player_id AND u.season = ?
       LEFT JOIN (
              -- Rank within the player's own position. Taking MIN(pos_rank)
              -- across every listing picks up a kick-return entry instead:
              -- Dylan Sampson is KR2 and RB2, and the naive query reported him
              -- as a returner.
              SELECT player_id, team, pos_abb, MIN(pos_rank) AS rank
              FROM depth_chart WHERE season = ? AND pos_abb IN ('QB','RB','WR','TE')
              GROUP BY player_id
            ) dc ON dc.player_id = p.player_id
       WHERE COALESCE(a.position, u.position, dc.pos_abb, pl.position)
             IN ('QB','RB','WR','TE')`,
    )
    .all(
      season, format, teams,      // pool: adp
      season - 1,                  // pool: usage
      season,                      // pool: depth chart
      season, format, teams,       // adp join
      season, format, teams,       // value join
      season - 1,                  // usage join
      season,                      // depth chart join
    ) as Array<Omit<SearchEntry, 'availability' | 'haystack'>>;

  const entries = rows.map((r) => {
    const availability: Availability =
      r.adp !== null ? 'board' : (r.games ?? 0) > 0 ? 'wire' : 'roster';
    const lower = r.name.toLowerCase();
    return {
      ...r,
      availability,
      // Diacritics stripped so "penix" finds "Peñix"; punctuation dropped so
      // "jamarr" finds "Ja'Marr"; both forms kept so either spelling hits.
      haystack: [
        lower,
        lower.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9 ]/g, ''),
        (r.team ?? '').toLowerCase(),
        (r.position ?? '').toLowerCase(),
      ].join(' '),
    };
  });

  entries.sort((a, b) => {
    // Board players first, then anyone with a measured role, then the rest.
    const rank = (e: SearchEntry) => (e.availability === 'board' ? 0 : e.availability === 'wire' ? 1 : 2);
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    if (a.adp !== null && b.adp !== null) return a.adp - b.adp;
    return (b.usageGrade ?? -1) - (a.usageGrade ?? -1);
  });

  cache = { stamp, key, entries };
  return entries;
}
