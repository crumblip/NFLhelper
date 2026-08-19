import { sqlite } from './db/index';
import {
  CATEGORY_BLURB,
  CATEGORY_LABEL,
  FANTASY_CATEGORIES,
  STATUS_ORDER,
  statusRank,
  type NewsCategory,
} from './news-shared';

/**
 * The read side of the news tab. `/news` renders this; nothing else computes it.
 *
 * Same split as `lib/waiver.ts`: the page owns none of the logic, so a script
 * and a route cannot drift apart.
 *
 * One decision governs the shape of everything here. The tab is organised
 * **by team first**, because that is how a manager reads news — he holds four
 * Bengals and wants to know what happened in Cincinnati, not to scroll a
 * national wire. Position is a filter *inside* a team rather than a peer of it,
 * and team-level items (a coach describing the offence, a coordinator change)
 * are their own bucket rather than being forced onto a player.
 */

export interface NewsPlayer {
  playerId: string | null;
  name: string;
  position: string | null;
  /** How the attribution was made, so the page can mark a soft match. */
  method: string;
}

export interface NewsRow {
  id: string;
  source: string;
  headline: string;
  body: string | null;
  url: string | null;
  publishedAt: number;
  category: NewsCategory;
  categoryBasis: string | null;
  /** Skill players this item names, on the team being viewed. */
  players: NewsPlayer[];
  /** Positions present in `players` — the filter key. */
  positions: string[];
  /** True when the item is about the team with no skill player attached. */
  teamLevel: boolean;
}

export interface TeamNews {
  team: string;
  rows: NewsRow[];
  /** Item counts by position, for the filter chips. Includes 'TEAM'. */
  counts: Record<string, number>;
}

export interface NewsMeta {
  /** Items held in total, including the ones filtered out of the tab. */
  stored: number;
  /** Items in a fantasy category — what the tab can show. */
  relevant: number;
  /** Items the rules could not place. Stated, never silently dropped. */
  setAside: number;
  /**
   * Relevant items that belong to no single team, and so appear only under ALL.
   *
   * Mostly league-wide fantasy writing — a rankings piece, a draft guide — which
   * genuinely has no team. Worth counting rather than hiding, because the same
   * number would grow if team attribution started failing, and a silent drop is
   * indistinguishable from a quiet week.
   */
  leagueWide: number;
  oldest: number | null;
  newest: number | null;
  /** Last time any ingest ran. */
  fetchedAt: number | null;
  sources: Array<{ source: string; n: number }>;
  /** Teams with at least one relevant item. */
  teamsCovered: number;
}

export const NEWS_CATEGORIES = FANTASY_CATEGORIES;
export { CATEGORY_LABEL, CATEGORY_BLURB, STATUS_ORDER, statusRank };

/**
 * Cached against the newest write, the same way the board and the search index
 * are. News is cheap to query but `/news` is `force-dynamic`, so without this
 * every navigation re-runs the join.
 */
let cache: {
  stamp: string;
  data: { meta: NewsMeta; byTeam: Map<string, TeamNews>; all: NewsRow[] };
} | null = null;

function dataStamp(): string {
  const n = sqlite
    .prepare(`SELECT COALESCE(MAX(fetched_at),0) t, COUNT(*) c FROM news_item`)
    .get() as { t: number; c: number };
  const m = sqlite.prepare(`SELECT COUNT(*) c FROM news_mention`).get() as { c: number };
  return `${n.t}:${n.c}:${m.c}`;
}

function load(): { meta: NewsMeta; byTeam: Map<string, TeamNews>; all: NewsRow[] } {
  const stamp = dataStamp();
  if (cache && cache.stamp === stamp) return cache.data;

  const placeholders = FANTASY_CATEGORIES.map(() => '?').join(',');

  /*
   * Every relevant item first, then its mentions — rather than one join that
   * requires a team.
   *
   * The join version silently lost 30 of 85 items: a rankings piece belongs to
   * no team, so an inner join on `team IS NOT NULL` dropped it from the team
   * pages *and* from the league view, which was built from the same map. It
   * appeared nowhere at all. Loading items independently of attribution means a
   * failure to attribute costs a filter, never the item.
   */
  const items = sqlite
    .prepare(
      `SELECT id, source, headline, body, url, published_at AS publishedAt,
              category, category_basis AS categoryBasis
       FROM news_item
       WHERE category IN (${placeholders})
       ORDER BY published_at DESC`,
    )
    .all(...FANTASY_CATEGORIES) as Array<{
    id: string; source: string; headline: string; body: string | null; url: string | null;
    publishedAt: number; category: NewsCategory; categoryBasis: string | null;
  }>;

  const mentions = sqlite
    .prepare(
      `SELECT m.news_id AS newsId, m.team, m.player_id AS playerId, m.raw_name AS rawName,
              m.position, m.method, m.is_team_level AS isTeamLevel
       FROM news_mention m
       JOIN news_item i ON i.id = m.news_id
       WHERE i.category IN (${placeholders})`,
    )
    .all(...FANTASY_CATEGORIES) as Array<{
    newsId: string; team: string | null; playerId: string | null; rawName: string;
    position: string | null; method: string; isTeamLevel: number;
  }>;

  const byItem = new Map<string, typeof mentions>();
  for (const m of mentions) {
    const list = byItem.get(m.newsId) ?? [];
    list.push(m);
    byItem.set(m.newsId, list);
  }

  const byTeam = new Map<string, TeamNews>();
  const all: NewsRow[] = [];

  for (const it of items) {
    const ms = byItem.get(it.id) ?? [];
    const teams = [...new Set(ms.map((m) => m.team).filter((t): t is string => !!t))];

    const base = (): NewsRow => ({
      id: it.id, source: it.source, headline: it.headline, body: it.body, url: it.url,
      publishedAt: it.publishedAt, category: it.category, categoryBasis: it.categoryBasis,
      players: [], positions: [], teamLevel: true,
    });

    // The league view holds one copy naming everybody.
    const leagueRow = base();
    for (const m of ms) {
      if (m.isTeamLevel || !m.playerId) continue;
      leagueRow.players.push({
        playerId: m.playerId, name: m.rawName, position: m.position, method: m.method,
      });
      leagueRow.teamLevel = false;
      if (m.position && !leagueRow.positions.includes(m.position)) {
        leagueRow.positions.push(m.position);
      }
    }
    all.push(leagueRow);

    /*
     * A per-team copy naming only that team's players. An item about a trade is
     * news in both rooms, and in each it should list the men on that roster —
     * showing a Cowboys reader the Saints players in the same headline would
     * make the position filter answer for the wrong team.
     */
    for (const team of teams) {
      let entry = byTeam.get(team);
      if (!entry) {
        entry = { team, rows: [], counts: {} };
        byTeam.set(team, entry);
      }
      const row = base();
      for (const m of ms) {
        if (m.isTeamLevel || !m.playerId || m.team !== team) continue;
        row.players.push({
          playerId: m.playerId, name: m.rawName, position: m.position, method: m.method,
        });
        row.teamLevel = false;
        if (m.position && !row.positions.includes(m.position)) row.positions.push(m.position);
      }
      entry.rows.push(row);
    }
  }

  for (const entry of byTeam.values()) {
    for (const row of entry.rows) {
      // An item with no skill player on this team is team news. That is a real
      // category, not a leftover: "the coordinator wants to run more" belongs to
      // the room, and forcing it onto whichever back happens to be listed first
      // would attribute a coaching statement to a player.
      const keys = row.teamLevel ? ['TEAM'] : row.positions;
      for (const k of keys) entry.counts[k] = (entry.counts[k] ?? 0) + 1;
    }
  }

  const stored = (sqlite.prepare(`SELECT COUNT(*) n FROM news_item`).get() as { n: number }).n;
  const relevant = (
    sqlite
      .prepare(`SELECT COUNT(*) n FROM news_item WHERE category IN (${placeholders})`)
      .get(...FANTASY_CATEGORIES) as { n: number }
  ).n;
  const span = sqlite
    .prepare(
      `SELECT MIN(published_at) a, MAX(published_at) b, MAX(fetched_at) f FROM news_item`,
    )
    .get() as { a: number | null; b: number | null; f: number | null };
  const sources = sqlite
    .prepare(`SELECT source, COUNT(*) n FROM news_item GROUP BY source ORDER BY n DESC`)
    .all() as Array<{ source: string; n: number }>;

  const teamed = new Set<string>();
  for (const t of byTeam.values()) for (const r of t.rows) teamed.add(r.id);

  const meta: NewsMeta = {
    stored,
    relevant,
    setAside: stored - relevant,
    leagueWide: all.length - teamed.size,
    oldest: span.a,
    newest: span.b,
    fetchedAt: span.f,
    sources,
    teamsCovered: byTeam.size,
  };

  const data = { meta, byTeam, all };
  cache = { stamp, data };
  return data;
}

export function getNewsMeta(): NewsMeta {
  return load().meta;
}

/** Every team that has news, richest first. Drives the team picker. */
export function getTeamsWithNews(): Array<{ team: string; n: number }> {
  const { byTeam } = load();
  return [...byTeam.values()]
    .map((t) => ({ team: t.team, n: t.rows.length }))
    .sort((a, b) => b.n - a.n || a.team.localeCompare(b.team));
}

export function getTeamNews(team: string): TeamNews {
  return load().byTeam.get(team) ?? { team, rows: [], counts: {} };
}

/**
 * The whole feed, newest first — everything relevant, whether or not it could
 * be pinned to a team. No cap: the archive is small and the reader filtering it
 * down should not silently be filtering a truncated list.
 */
export function getLeagueNews(): NewsRow[] {
  return load().all;
}

/* ------------------------------------------------------------------------- */

export interface InjuryRow {
  playerId: string | null;
  name: string;
  position: string | null;
  team: string | null;
  status: string;
  bodyPart: string | null;
  detail: string | null;
  analysis: string | null;
  reportedAt: number | null;
  /** True when this player is on the draft board — i.e. someone owns him. */
  drafted: boolean;
  adp: number | null;
}

let injuryCache: { stamp: string; rows: InjuryRow[] } | null = null;

export function getInjuries(season: number): InjuryRow[] {
  const stamp = (
    sqlite
      .prepare(`SELECT COALESCE(MAX(fetched_at),0) t, COUNT(*) c FROM injury_report`)
      .get() as { t: number; c: number }
  ).t.toString();
  if (injuryCache && injuryCache.stamp === stamp) return injuryCache.rows;

  const rows = sqlite
    .prepare(
      `SELECT r.player_id AS playerId, r.raw_name AS name, r.position, r.team,
              r.status, r.body_part AS bodyPart, r.detail, r.analysis,
              r.reported_at AS reportedAt,
              a.adp
       FROM injury_report r
       LEFT JOIN (SELECT player_id, MIN(adp) adp FROM adp_raw
                  WHERE year = ? AND player_id IS NOT NULL GROUP BY player_id) a
         ON a.player_id = r.player_id
       ORDER BY r.team, r.position`,
    )
    .all(season) as Array<Omit<InjuryRow, 'drafted'>>;

  const out = rows.map((r) => ({ ...r, drafted: r.adp != null }));
  injuryCache = { stamp, rows: out };
  return out;
}

export interface InjuryMeta {
  total: number;
  /** How many are drafted somewhere — the ones that change a lineup. */
  drafted: number;
  fetchedAt: number | null;
  teams: number;
  withAnalysis: number;
}

export function getInjuryMeta(season: number): InjuryMeta {
  const rows = getInjuries(season);
  const f = sqlite
    .prepare(`SELECT MAX(fetched_at) f FROM injury_report`)
    .get() as { f: number | null };
  return {
    total: rows.length,
    drafted: rows.filter((r) => r.drafted).length,
    fetchedAt: f.f,
    teams: new Set(rows.map((r) => r.team).filter(Boolean)).size,
    withAnalysis: rows.filter((r) => r.analysis).length,
  };
}
