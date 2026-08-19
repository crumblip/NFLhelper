import { sqlite } from './db/index';

/** Row shape the board renders. Assembled here so the page stays presentational. */
export interface BoardRow {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  bye: number | null;
  adp: number;
  impliedPoints: number | null;
  adpEquivalent: number | null;
  slotGap: number | null;
  expectedVorp: number;
  impliedVorp: number | null;
  signal: string;
  completeness: number;
  usageGrade: number | null;
  marketPct: number | null;
  usageGap: number | null;
  blendedPoints: number | null;
  /**
   * Points above the freely available player at his position — the real draft
   * order.
   *
   * Slot gap answers "is he cheap for his pick", which at deep ADP flatters
   * anyone startable: Justin Herbert shows +54 while projecting three points
   * below a replacement quarterback. Value over replacement puts him where he
   * belongs at 75th, and produces a board that is 33 receivers and 18 backs in
   * the top sixty with the first quarterback at eighteen — which is how the
   * position actually gets drafted.
   */
  blendedVorp: number | null;
  blendedSlotGap: number | null;
  /**
   * Value over next available: points above the best player at his position
   * expected to survive to the drafter's next turn. VALUE compares to a FREE
   * replacement; this compares to the actual alternative, which is the question
   * a pick is made on.
   */
  vona: number | null;
  /**
   * Held a real role last season (10+ games, 80+ points).
   *
   * Late in the draft this separates two groups the ADP ordering cannot compare.
   * Among late picks who held a role, taking the earlier one is worth 41 points;
   * among those who did not, 14.
   */
  heldRole: boolean | null;
  /**
   * The bust-to-breakout axis, 0-100, ranked within position and draft band.
   * High is good. Replaces the separate UPSIDE and BUST columns, which were one
   * measurement shown twice (they correlate −0.87 and neither survives the
   * other). The two halves stay available for the hover.
   */
  outlookPctile: number | null;
  /** The two halves, kept for explanation rather than for ranking. */
  breakoutPctile: number | null;
  bustPctile: number | null;
  /** Expected share of weeks startable — the projection restated, not a signal. */
  startableRate: number | null;
  disagreement: number | null;
  verdict: string | null;
  riskNotes: string | null;
  expectedGames: number | null;
  tags: Array<{ id: string; label: string; kind: string; detail: string; weight: number }>;
  /**
   * Outcome rates from the 40 most similar historical player-seasons.
   *
   * These are what make the late rounds readable. Value over replacement is the
   * right currency through round eight and a dead one after it — almost every
   * player still available projects below replacement, so ranking forty of them
   * by how far below tells you nothing. What separates them is whether the
   * profile has ever paid off: `breakoutRate` is the share of comparables that
   * finished top-12 at the position, `bustRate` the share that returned less
   * than a freely available player — the exact complement of `hitRate`.
   */
  breakoutRate: number | null;
  bustRate: number | null;
  hitRate: number | null;
  marketStats: number;
  extrapolatedStats: number;
  derivedStats: number;
  baselineSampleN: number;
}

export interface BoardMeta {
  format: string;
  teams: number;
  season: number;
  adpWindow: { start: string; end: string; drafts: number } | null;
  propsFetchedAt: number | null;
  ranked: number;
  partial: number;
  none: number;
}

export function getBoard(format: string, teams: number, season: number): BoardRow[] {
  const rows = sqlite
    .prepare(
      `SELECT v.player_id AS playerId, a.name, v.position, a.team, a.bye, v.adp,
              v.implied_points AS impliedPoints, v.adp_equivalent AS adpEquivalent,
              v.slot_gap AS slotGap, v.expected_vorp AS expectedVorp,
              v.implied_vorp AS impliedVorp, v.signal, v.completeness,
              v.usage_grade AS usageGrade, v.market_pct AS marketPct,
              v.usage_gap AS usageGap, v.blended_points AS blendedPoints,
              v.blended_slot_gap AS blendedSlotGap, v.disagreement, v.verdict,
              v.vona, v.startable_rate AS startableRate,
              v.breakout_pctile AS breakoutPctile, v.bust_pctile AS bustPctile,
              v.outlook_pctile AS outlookPctile,
              v.held_role AS heldRole,
              -- Read, never recomputed. The right replacement level depends on
              -- which scale the projection is on, and only build-blend knows
              -- that. Subtracting actual-points replacement from a usage-only
              -- projection charged those players ~20 phantom points and made
              -- "no betting lines" indistinguishable from "not good".
              v.blended_vorp AS blendedVorp,
              v.risk_notes AS riskNotes, v.expected_games AS expectedGames,
              v.tags AS tagsJson, v.outlook AS outlookJson,
              v.market_stats AS marketStats, v.extrapolated_stats AS extrapolatedStats,
              v.derived_stats AS derivedStats,
              v.baseline_sample_n AS baselineSampleN
       FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ?
       ORDER BY v.adp`,
    )
    .all(format, teams, season) as Array<
    Omit<BoardRow, 'heldRole'> & {
      tagsJson: string | null; outlookJson: string | null;
      /*
       * SQLite has no boolean. This column comes back as 0 or 1 through the raw
       * driver — drizzle's `{ mode: 'boolean' }` only converts for queries that
       * go through drizzle, and this one does not. Typing it as `boolean` here
       * made `heldRole === true` false for every row on the board, and the
       * filter silently returned nothing. The type has to describe what the
       * driver actually hands back, then convert.
       */
      heldRole: number | null;
    }
  >;

  // Tags are stored as JSON so each can carry its own explanation and be
  // filtered on; the board works with them as objects.
  return rows.map(({ tagsJson, outlookJson, heldRole, ...r }) => {
    // Outcome rates live inside the outlook blob; the board needs them as plain
    // numbers so the late rounds can be sorted on upside rather than on a
    // projection that is negative for everybody down there.
    const o = outlookJson
      ? (JSON.parse(outlookJson) as { breakoutRate?: number; bustRate?: number; hitRate?: number })
      : null;
    return {
      ...r,
      heldRole: heldRole === null ? null : heldRole === 1,
      tags: tagsJson ? (JSON.parse(tagsJson) as BoardRow['tags']) : [],
      breakoutRate: o?.breakoutRate ?? null,
      bustRate: o?.bustRate ?? null,
      hitRate: o?.hitRate ?? null,
    };
  });
}

export function getMeta(format: string, teams: number, season: number): BoardMeta {
  const adp = sqlite
    .prepare(
      `SELECT MIN(fetched_at) AS fetched, SUM(times_drafted) AS drafts
       FROM adp_raw WHERE format = ? AND teams = ? AND year = ?`,
    )
    .get(format, teams, season) as { fetched: number | null; drafts: number | null };

  const props = sqlite
    .prepare(`SELECT MAX(fetched_at) AS fetched FROM prop_lines`)
    .get() as { fetched: number | null };

  const tiers = sqlite
    .prepare(
      `SELECT signal, COUNT(*) n FROM value_scores
       WHERE format = ? AND teams = ? AND season = ? GROUP BY signal`,
    )
    .all(format, teams, season) as Array<{ signal: string; n: number }>;

  const count = (s: string) => tiers.find((t) => t.signal === s)?.n ?? 0;

  return {
    format,
    teams,
    season,
    adpWindow: adp.fetched
      ? {
          start: new Date(adp.fetched).toISOString().slice(0, 10),
          end: new Date(adp.fetched).toISOString().slice(0, 10),
          drafts: adp.drafts ?? 0,
        }
      : null,
    propsFetchedAt: props.fetched,
    ranked: count('full'),
    partial: count('partial'),
    none: count('none'),
  };
}
