import { sqlite } from './db/index';
import { getWaiverBoard } from './waiver';
import { buildRoleCertainty, type RoleCertainty } from './pipeline/role';
import type { Outlook } from './pipeline/comparables';
import type { DerivationStep } from './pipeline/blend';
import type { PlayerCase } from './pipeline/case';
import { buildScouting, type Scouting } from './pipeline/scouting';

/**
 * Everything the player page needs.
 *
 * The split matters here: `value` and `props` are the signal — they trace back
 * to sportsbook lines. `context` is nflverse history, shown to explain *why* a
 * line might sit where it does, and it never feeds the projection. A player
 * whose target share collapsed last year is worth knowing about; that fact
 * still does not move their number.
 */

export interface PlayerHeader {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  bye: number | null;
  status: string | null;
  rookieSeason: number | null;
}

/**
 * The comparables read, parsed.
 *
 * This is stored as a JSON blob and was being rendered straight into the page,
 * so the player card printed a wall of `{"n":40,"floor":55.84,...}` at the
 * reader. It is the most informative thing on the page once unpacked: the range
 * of what forty similar historical seasons went on to do, and which players
 * those were.
 */
/*
 * Re-exported rather than redeclared. The page used to read a hand-written copy
 * of this shape, so adding a field to the engine left the two silently out of
 * step — the panel can only render what it has been told exists.
 */
export type { DerivationStep } from './pipeline/blend';
export type {
  Comparable as OutlookComparable,
  Outlook,
  Support,
  Bands,
} from './pipeline/comparables';

export interface ValueDetail {
  adp: number;
  impliedPoints: number | null;
  impliedVorp: number | null;
  expectedVorp: number;
  adpEquivalent: number | null;
  slotGap: number | null;
  signal: string;
  completeness: number;
  marketStats: number;
  extrapolatedStats: number;
  derivedStats: number;
  baselineSampleN: number;
  replacement: number | null;
  usageGrade: number | null;
  usageGap: number | null;
  marketPct: number | null;
  blendedAdpEquivalent: number | null;
  blendedPoints: number | null;
  blendedVorp: number | null;
  blendedSlotGap: number | null;
  verdict: string | null;
  outlook: Outlook | null;
  /** Step-by-step arithmetic behind VALUE. */
  derivation: DerivationStep[] | null;
  archetype: string | null;
  vacatedShare: number | null;
  opportunityNote: string | null;
  riskNotes: string | null;
  expectedGames: number | null;
  tags: Array<{ id: string; label: string; kind: string; detail: string; weight: number }>;
  /** One verdict plus the argument, stamped with each point's evidence strength. */
  playerCase: PlayerCase | null;
  /** Points above the best player at his position expected to last to your next turn. */
  vona: number | null;
  vonaRound: number | null;
  dropToNext: number | null;
  nextAtPosition: string | null;
  /** Expected share of weeks startable — the projection restated, not a signal. */
  startableRate: number | null;
}

/**
 * What is known about a player who is not being drafted.
 *
 * The board has nothing to say about him — no ADP means no price, so no value
 * over price. The waiver read is the substitute: what his role was, how deep he
 * is listed, and whether work ahead of him has opened up.
 */
export interface WaiverDetail {
  /** Points over replacement, and the draft pick that has returned the same. */
  vorp: number | null;
  equivalentPick: number | null;
  grade: number;
  points: number;
  depthRank: number | null;
  vacated: number;
  opportunity: string | null;
  notes: string[];
  qualified: boolean;
  priority: boolean;
  youngPath: boolean;
  age: number | null;
}

export interface PropDetail {
  stat: string;
  scope: string;
  mu: number;
  line: number | null;
  pOver: number | null;
  sigma: number | null;
  source: string;
  basis: string | null;
  bookCount: number;
  bookSpread: number | null;
}

export interface RawLine {
  book: string;
  stat: string;
  scope: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  gameDate: string | null;
  fetchedAt: number;
}

export interface SeasonContext {
  season: number;
  games: number;
  targets: number | null;
  targetShare: number | null;
  airYardsShare: number | null;
  adot: number | null;
  snapPct: number | null;
  receptions: number | null;
  receivingYards: number | null;
  receivingTds: number | null;
  carries: number | null;
  rushingYards: number | null;
  rushingTds: number | null;
  passingYards: number | null;
  passingTds: number | null;
  fantasyPointsHalf: number | null;
}

export interface WeeklyPoint {
  week: number;
  targetShare: number | null;
  snapPct: number | null;
  points: number | null;
}

/**
 * The comparables read, and what it was built from.
 *
 * This hangs off the player rather than off `value` because `value` exists only
 * for players the ADP feed prices. Nesting it there meant the single most
 * informative panel on the page was missing for every undrafted player — the
 * exact population a waiver claim comes from.
 */
export interface OutlookDetail {
  outlook: Outlook;
  archetype: string | null;
  /** Which season's usage described him. */
  profileSeason: number;
  /** How many games that profile rests on. */
  profileGames: number;
  /** His own total and per-game scoring in the profile season, for reference. */
  ownPoints: number | null;
  ownPpg: number | null;
  /** Replacement level at his position, so the bar has a line to sit against. */
  replacement: number | null;
}

export interface PlayerDetail {
  header: PlayerHeader;
  /** How safe his job is, and the room he sits in. */
  role: RoleCertainty | null;
  value: ValueDetail | null;
  /** Comparables, for anyone with a measured role — drafted or not. */
  outlook: OutlookDetail | null;
  /** Advanced per-opportunity indicators and the offence he plays in. */
  scouting: Scouting | null;
  /** Populated only when the player has no ADP — see WaiverDetail. */
  waiver: WaiverDetail | null;
  props: PropDetail[];
  rawLines: RawLine[];
  context: SeasonContext[];
  weekly: WeeklyPoint[];
  latestContextSeason: number | null;
}

function parseOutlook(raw: string | null): Outlook | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Outlook;
    return typeof o.n === 'number' ? o : null;
  } catch {
    return null;
  }
}

export function getPlayerDetail(
  playerId: string,
  format: string,
  teams: number,
  season: number,
): PlayerDetail | null {
  const header = sqlite
    .prepare(
      `SELECT p.gsis_id AS playerId, p.display_name AS name,
              COALESCE(a.position, p.position) AS position,
              COALESCE(a.team, p.latest_team) AS team,
              a.bye, p.status, p.rookie_season AS rookieSeason
       FROM players p
       LEFT JOIN adp_raw a ON a.player_id = p.gsis_id AND a.year = ?
        AND a.format = ? AND a.teams = ?
       WHERE p.gsis_id = ?`,
    )
    .get(season, format, teams, playerId) as PlayerHeader | undefined;

  if (!header) return null;

  const valueRow = sqlite
    .prepare(
      `SELECT v.adp, v.implied_points AS impliedPoints, v.implied_vorp AS impliedVorp,
              v.expected_vorp AS expectedVorp, v.adp_equivalent AS adpEquivalent,
              v.slot_gap AS slotGap, v.signal, v.completeness,
              v.market_stats AS marketStats, v.extrapolated_stats AS extrapolatedStats,
              v.derived_stats AS derivedStats, v.baseline_sample_n AS baselineSampleN,
              v.usage_grade AS usageGrade, v.usage_gap AS usageGap, v.market_pct AS marketPct,
              v.blended_adp_equivalent AS blendedAdpEquivalent,
              v.blended_points AS blendedPoints, v.blended_vorp AS storedVorp,
              v.blended_slot_gap AS blendedSlotGap,
              v.verdict, v.outlook, v.archetype, v.derivation,
              v.vacated_share AS vacatedShare, v.opportunity_note AS opportunityNote,
              v.risk_notes AS riskNotes, v.expected_games AS expectedGames,
              v.tags AS tagsJson, v.player_case AS caseJson,
              v.vona, v.vona_round AS vonaRound, v.drop_to_next AS dropToNext,
              v.next_at_position AS nextAtPosition, v.startable_rate AS startableRate,
              (SELECT AVG(points) FROM replacement_level r
               WHERE r.format = v.format AND r.teams = v.teams
                 AND r.position = v.position AND r.season >= v.season - 3
                 AND r.season < v.season) AS replacement
       FROM value_scores v
       WHERE v.player_id = ? AND v.format = ? AND v.teams = ? AND v.season = ?`,
    )
    .get(playerId, format, teams, season) as
    | (Omit<ValueDetail, 'tags' | 'blendedVorp' | 'outlook' | 'derivation' | 'playerCase'> & {
        tagsJson: string | null;
        caseJson: string | null;
        storedVorp: number | null;
        outlook: string | null;
        derivation: string | null;
      })
    | undefined;

  const value: ValueDetail | null = valueRow
    ? {
        ...valueRow,
        // Same rule as the board: read the stored figure, which was measured
        // against the replacement level matching this player's scale.
        blendedVorp: valueRow.storedVorp,
        tags: valueRow.tagsJson
          ? (JSON.parse(valueRow.tagsJson) as ValueDetail['tags'])
          : [],
        playerCase: (() => {
          if (!valueRow.caseJson) return null;
          try {
            return JSON.parse(valueRow.caseJson) as PlayerCase;
          } catch {
            return null;
          }
        })(),
        outlook: parseOutlook(valueRow.outlook),
        derivation: (() => {
          if (!valueRow.derivation) return null;
          try {
            const d = JSON.parse(valueRow.derivation) as DerivationStep[];
            return Array.isArray(d) && d.length ? d : null;
          } catch {
            return null;
          }
        })(),
      }
    : null;

  const props = sqlite
    .prepare(
      `SELECT stat, scope, mu, line, p_over AS pOver, sigma, source, basis,
              book_count AS bookCount, book_spread AS bookSpread
       FROM implied_stats WHERE player_id = ?
       ORDER BY CASE scope WHEN 'season' THEN 0 ELSE 1 END, stat`,
    )
    .all(playerId) as PropDetail[];

  // Latest snapshot per (book, stat, scope) — the actual posted lines behind
  // the numbers above.
  const rawLines = sqlite
    .prepare(
      `SELECT p.book, p.stat, p.scope, p.line, p.over_price AS overPrice,
              p.under_price AS underPrice, p.game_date AS gameDate, p.fetched_at AS fetchedAt
       FROM prop_lines p
       JOIN (SELECT book, stat, scope, MAX(fetched_at) mx FROM prop_lines
             WHERE player_id = ? GROUP BY book, stat, scope) l
         ON l.book = p.book AND l.stat = p.stat AND l.scope = p.scope AND l.mx = p.fetched_at
       WHERE p.player_id = ?
       ORDER BY CASE p.scope WHEN 'season' THEN 0 ELSE 1 END, p.stat, p.book`,
    )
    .all(playerId, playerId) as RawLine[];

  const context = sqlite
    .prepare(
      `SELECT s.season,
              COUNT(*) AS games,
              SUM(s.targets) AS targets,
              AVG(s.target_share) AS targetShare,
              AVG(s.air_yards_share) AS airYardsShare,
              CASE WHEN SUM(s.targets) > 0
                   THEN SUM(s.receiving_air_yards) * 1.0 / SUM(s.targets) END AS adot,
              (SELECT AVG(sc.offense_pct) FROM snap_counts sc
               WHERE sc.player_id = s.player_id AND sc.season = s.season) AS snapPct,
              SUM(s.receptions) AS receptions,
              SUM(s.receiving_yards) AS receivingYards,
              SUM(s.receiving_tds) AS receivingTds,
              SUM(s.carries) AS carries,
              SUM(s.rushing_yards) AS rushingYards,
              SUM(s.rushing_tds) AS rushingTds,
              SUM(s.passing_yards) AS passingYards,
              SUM(s.passing_tds) AS passingTds,
              SUM(s.fantasy_points_half) AS fantasyPointsHalf
       FROM player_stats_week s
       WHERE s.player_id = ? AND s.season_type = 'REG'
       GROUP BY s.season ORDER BY s.season DESC LIMIT 4`,
    )
    .all(playerId) as SeasonContext[];

  const latestContextSeason = context[0]?.season ?? null;

  const weekly = latestContextSeason
    ? (sqlite
        .prepare(
          `SELECT s.week, s.target_share AS targetShare,
                  (SELECT sc.offense_pct FROM snap_counts sc
                   WHERE sc.player_id = s.player_id AND sc.season = s.season
                     AND sc.week = s.week) AS snapPct,
                  s.fantasy_points_half AS points
           FROM player_stats_week s
           WHERE s.player_id = ? AND s.season = ? AND s.season_type = 'REG'
           ORDER BY s.week`,
        )
        .all(playerId, latestContextSeason) as WeeklyPoint[])
    : [];

  /*
   * A player with no ADP has no price, so the board's whole frame — value
   * against cost — does not apply to him. Rather than showing an empty page,
   * fall through to the waiver read, which asks the question that does apply:
   * what was his role, and is work opening up ahead of him.
   */
  const waiver: WaiverDetail | null = value
    ? null
    : (() => {
        const row = getWaiverBoard(format, teams, season).rows.find(
          (r) => r.playerId === playerId,
        );
        if (!row) return null;
        return {
          grade: row.grade,
          points: row.points,
          vorp: row.vorp,
          equivalentPick: row.equivalentPick,
          depthRank: row.depthRank,
          vacated: row.vacated,
          opportunity: row.opportunity,
          notes: row.notes,
          qualified: row.qualified,
          priority: row.priority,
          youngPath: row.youngPath,
          age: row.age,
        };
      })();

  /*
   * Read from `player_outlook`, which covers everyone with a measured role.
   * `value_scores.outlook` still carries the same JSON for board players so the
   * board can sort and filter without a join, but it is written from these rows
   * and must never be read as a second source of truth.
   */
  const outlookRow = sqlite
    .prepare(
      `SELECT o.outlook, o.archetype, o.profile_season AS profileSeason,
              o.profile_games AS profileGames, o.position,
              (SELECT AVG(points) FROM replacement_level r
               WHERE r.format = o.format AND r.teams = o.teams
                 AND r.position = o.position AND r.season >= o.season - 3
                 AND r.season < o.season) AS replacement
       FROM player_outlook o
       WHERE o.player_id = ? AND o.format = ? AND o.teams = ? AND o.season = ?`,
    )
    .get(playerId, format, teams, season) as
    | {
        outlook: string;
        archetype: string | null;
        profileSeason: number;
        profileGames: number;
        position: string;
        replacement: number | null;
      }
    | undefined;

  const outlook: OutlookDetail | null = (() => {
    if (!outlookRow) return null;
    const parsed = parseOutlook(outlookRow.outlook);
    if (!parsed) return null;

    // What he himself did in the season being matched on. Without it the range
    // is a set of numbers with nothing to sit against — a reader cannot tell
    // that a ceiling of 288 is below what the player already scored.
    const own = context.find((c) => c.season === outlookRow.profileSeason);
    const ownPoints = own?.fantasyPointsHalf ?? null;

    return {
      outlook: parsed,
      archetype: outlookRow.archetype,
      profileSeason: outlookRow.profileSeason,
      profileGames: outlookRow.profileGames,
      ownPoints,
      ownPpg:
        ownPoints !== null && outlookRow.profileGames > 0
          ? ownPoints / outlookRow.profileGames
          : null,
      replacement: outlookRow.replacement,
    };
  })();

  return {
    header,
    role: buildRoleCertainty(season).get(playerId) ?? null,
    value,
    outlook,
    scouting: buildScouting(season).get(playerId) ?? null,
    waiver,
    props,
    rawLines,
    context,
    weekly,
    latestContextSeason,
  };
}

/** Board-order neighbours, so you can walk the board from a player page. */
export function getNeighbours(
  playerId: string,
  format: string,
  teams: number,
  season: number,
): { prev: { id: string; name: string } | null; next: { id: string; name: string } | null } {
  const row = sqlite
    .prepare(
      `SELECT adp FROM value_scores WHERE player_id = ? AND format = ? AND teams = ? AND season = ?`,
    )
    .get(playerId, format, teams, season) as { adp: number } | undefined;
  if (!row) return { prev: null, next: null };

  const q = (op: string, dir: string) =>
    sqlite
      .prepare(
        `SELECT v.player_id AS id, a.name FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.adp ${op} ?
         ORDER BY v.adp ${dir} LIMIT 1`,
      )
      .get(format, teams, season, row.adp) as { id: string; name: string } | undefined;

  return { prev: q('<', 'DESC') ?? null, next: q('>', 'ASC') ?? null };
}
