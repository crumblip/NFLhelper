import { sqlite } from '../db/index';
import { rulesFor, scoreStatLine, type StatLine } from './scoring';
import { expectedAt, adpEquivalent, type GridPoint } from './baseline';
import { maskStatLine, type CoverageProfile } from './coverage';
import type { CanonicalStat } from '../providers/props/markets';

/**
 * The value engine: market projection against what the draft slot has been
 * worth historically.
 *
 * Everything here reduces to one comparison. The market says a player is worth
 * X. History says a pick at their ADP returns Y. The gap, expressed in draft
 * slots, is the entire point of the tool.
 */

export type Signal = 'full' | 'partial' | 'none';

/**
 * The stats that define a role. Without these there is no market read at all,
 * and scoring the gaps as zero would rank a player last rather than unknown.
 *
 * Everything beyond this is judged against the coverage profile rather than a
 * second hardcoded list, so completeness always means "has what the market
 * prices for this position" — and stays correct when coverage changes.
 */
const REQUIRED: Record<string, CanonicalStat[]> = {
  QB: ['passingYards', 'passingTds'],
  RB: ['rushingYards', 'rushingTds'],
  WR: ['receivingYards', 'receivingTds'],
  TE: ['receivingYards', 'receivingTds'],
};

export interface PlayerImplied {
  playerId: string;
  position: string;
  stats: Map<CanonicalStat, { mu: number; source: string }>;
}

export interface ValueRow {
  playerId: string;
  position: string;
  adp: number;
  impliedPoints: number | null;
  impliedVorp: number | null;
  expectedVorp: number;
  vorpGap: number | null;
  adpEquivalent: number | null;
  slotGap: number | null;
  signal: Signal;
  completeness: number;
  marketStats: number;
  extrapolatedStats: number;
  derivedStats: number;
  baselineSampleN: number;
}

/**
 * Replacement level for a season that has not been played.
 *
 * It cannot be measured from outcomes the way historical seasons are, so it is
 * the average of recent completed seasons. That is defensible because the
 * levels are stable year to year — QB12 has sat between 263 and 283 across
 * eight seasons — and because the baseline curve is denominated the same way,
 * so both sides of the comparison stay on one scale.
 *
 * Deriving it from the implied projections instead would be circular and, at
 * 69% market coverage, simply wrong: the 31st best *covered* WR is not the 31st
 * best WR.
 */
export function projectedReplacement(
  format: string,
  teams: number,
  season: number,
  lookback = 3,
): Map<string, number> {
  const rows = sqlite
    .prepare(
      `SELECT position, AVG(points) AS pts FROM replacement_level
       WHERE format = ? AND teams = ? AND season >= ? AND season < ?
       GROUP BY position`,
    )
    .all(format, teams, season - lookback, season) as Array<{ position: string; pts: number }>;

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.position, r.pts);
  return map;
}

function toStatLine(stats: Map<CanonicalStat, { mu: number; source: string }>): StatLine {
  const g = (k: CanonicalStat) => stats.get(k)?.mu ?? 0;
  return {
    passingYards: g('passingYards'),
    passingTds: g('passingTds'),
    interceptions: g('interceptions'),
    rushingYards: g('rushingYards'),
    rushingTds: g('rushingTds'),
    receptions: g('receptions'),
    receivingYards: g('receivingYards'),
    receivingTds: g('receivingTds'),
  };
}

export function computeValue(
  player: PlayerImplied,
  adp: number,
  format: string,
  replacement: Map<string, number>,
  grid: GridPoint[],
  profile: CoverageProfile,
): ValueRow {
  const position = player.position.toUpperCase();
  const required = REQUIRED[position];
  const baseline = expectedAt(grid, adp);

  const count = (src: string) =>
    [...player.stats.values()].filter((s) => s.source === src).length;

  const base: Omit<ValueRow, 'impliedPoints' | 'impliedVorp' | 'vorpGap' | 'adpEquivalent' | 'slotGap' | 'signal' | 'completeness'> = {
    playerId: player.playerId,
    position,
    adp,
    expectedVorp: baseline.expectedVorp,
    marketStats: count('market'),
    extrapolatedStats: count('extrapolated'),
    derivedStats: count('derived'),
    baselineSampleN: baseline.sampleN,
  };

  const noSignal: ValueRow = {
    ...base,
    impliedPoints: null,
    impliedVorp: null,
    vorpGap: null,
    adpEquivalent: null,
    slotGap: null,
    signal: 'none',
    completeness: 0,
  };

  if (!required) return noSignal;

  // Required props missing means no market read — not a bad one.
  if (!required.every((s) => player.stats.has(s))) return noSignal;

  // Completeness is measured against what the market prices for this position,
  // so a category no book posts anywhere never counts against anyone.
  const priced = [...(profile.get(position) ?? new Set())] as CanonicalStat[];
  const present = priced.filter((s) => player.stats.has(s)).length;
  const completeness = priced.length ? present / priced.length : 0;

  // Masked with the same category set the baseline was fit on, so the two
  // sides of the comparison are denominated identically.
  const categories = profile.get(position);
  const line = toStatLine(player.stats);
  const impliedPoints = scoreStatLine(
    categories ? maskStatLine(line, categories) : line,
    rulesFor(format),
  );
  const repl = replacement.get(position) ?? 0;
  const impliedVorp = impliedPoints - repl;

  const equivalent = adpEquivalent(grid, impliedVorp);

  return {
    ...base,
    impliedPoints,
    impliedVorp,
    vorpGap: impliedVorp - baseline.expectedVorp,
    adpEquivalent: equivalent,
    /*
     * Positive means value: the market prices this player like an earlier pick
     * than the one you actually spend. A player whose props imply pick-24 value
     * going at 58 scores +34.
     */
    slotGap: adp - equivalent,
    signal: completeness >= 0.999 ? 'full' : 'partial',
    completeness,
  };
}

/** Loads every player's implied season stat line. */
export function loadImplied(): Map<string, PlayerImplied> {
  const rows = sqlite
    .prepare(
      `SELECT i.player_id, i.stat, i.mu, i.source, a.position
       FROM implied_stats i
       JOIN adp_raw a ON a.player_id = i.player_id
       WHERE i.scope = 'season'
       GROUP BY i.player_id, i.stat`,
    )
    .all() as Array<{
    player_id: string;
    stat: CanonicalStat;
    mu: number;
    source: string;
    position: string;
  }>;

  const map = new Map<string, PlayerImplied>();
  for (const r of rows) {
    const entry =
      map.get(r.player_id) ??
      { playerId: r.player_id, position: r.position, stats: new Map() };
    entry.stats.set(r.stat, { mu: r.mu, source: r.source });
    map.set(r.player_id, entry);
  }
  return map;
}

/**
 * Baseline grids keyed by position, with 'ALL' as the pooled fallback for
 * positions that were too thin to fit on their own.
 */
export function loadGrids(format: string, teams: number): Map<string, GridPoint[]> {
  const rows = sqlite
    .prepare(
      `SELECT position, adp_slot AS adpSlot, expected_points AS expectedPoints,
              expected_vorp AS expectedVorp, sample_n AS sampleN
       FROM adp_baseline WHERE format = ? AND teams = ? ORDER BY position, adp_slot`,
    )
    .all(format, teams) as Array<GridPoint & { position: string }>;

  const out = new Map<string, GridPoint[]>();
  for (const r of rows) {
    const list = out.get(r.position) ?? [];
    list.push(r);
    out.set(r.position, list);
  }
  return out;
}

/** The right curve for a position, falling back to pooled. */
export function gridFor(grids: Map<string, GridPoint[]>, position: string): GridPoint[] {
  return grids.get(position.toUpperCase()) ?? grids.get('ALL') ?? [];
}

/** Pooled curve only — kept for callers that are not position-aware. */
export function loadGrid(format: string, teams: number): GridPoint[] {
  return loadGrids(format, teams).get('ALL') ?? [];
}

export function saveValues(rows: ValueRow[], format: string, teams: number, season: number) {
  const now = Date.now();
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO value_scores
     (player_id, format, teams, season, position, adp, implied_points, implied_vorp,
      expected_vorp, slot_gap, adp_equivalent, vorp_gap, signal, completeness,
      market_stats, extrapolated_stats, derived_stats, baseline_sample_n, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sqlite.transaction(() => {
    for (const r of rows) {
      stmt.run(
        r.playerId, format, teams, season, r.position, r.adp, r.impliedPoints,
        r.impliedVorp, r.expectedVorp, r.slotGap, r.adpEquivalent, r.vorpGap,
        r.signal, r.completeness, r.marketStats, r.extrapolatedStats,
        r.derivedStats, r.baselineSampleN, now,
      );
    }
  })();
}
