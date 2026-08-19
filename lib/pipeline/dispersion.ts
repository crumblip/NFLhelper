import { sqlite } from '../db/index';
import type { CanonicalStat, Scope } from '../providers/props/markets';

/**
 * How uncertain is a season outcome, relative to its expectation?
 *
 * Needed to convert a posted line into a mean: the shift from line to mean is
 * (sigma x probit(p_over)), so sigma sets how much a skewed price moves the
 * projection. Rather than assume a number, this measures it from nflverse.
 *
 * Method: bin players by what they did in season t, then measure the spread of
 * what they did in season t+1 within each bin. Inside a bin the expectation is
 * roughly constant, so the remaining variation is close to genuine predictive
 * uncertainty — injuries, role changes, touchdown luck.
 *
 * Restricted to players who appeared in season t+1 at all. Including players
 * who retired would inflate sigma with something the market already prices
 * separately, but partial seasons stay in because injury risk is exactly the
 * uncertainty being measured.
 */

const SEASON_COLUMNS: Record<CanonicalStat, string> = {
  passingYards: 'passing_yards',
  passingTds: 'passing_tds',
  interceptions: 'interceptions',
  rushingYards: 'rushing_yards',
  rushingTds: 'rushing_tds',
  receptions: 'receptions',
  receivingYards: 'receiving_yards',
  receivingTds: 'receiving_tds',
};

/** Below these, a stat is noise rather than a role, and cv explodes. */
const MIN_LEVEL: Record<CanonicalStat, number> = {
  passingYards: 1000,
  passingTds: 8,
  interceptions: 4,
  rushingYards: 200,
  rushingTds: 3,
  receptions: 20,
  receivingYards: 200,
  receivingTds: 3,
};

/**
 * Fallbacks used when a stat has too little history to calibrate. Deliberately
 * mid-range: they only apply to stats the data cannot speak to, and a wrong
 * sigma shifts a projection by a few percent, not orders of magnitude.
 */
const DEFAULT_CV: Record<Scope, number> = { season: 0.45, game: 0.65 };

export interface Dispersion {
  stat: CanonicalStat;
  scope: Scope;
  cv: number;
  sampleN: number;
}

function stats(values: number[]): { mean: number; sd: number } {
  const n = values.length;
  if (n < 2) return { mean: values[0] ?? 0, sd: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, sd: Math.sqrt(variance) };
}

/** Year-over-year dispersion of season totals, binned by prior-season level. */
export function calibrateSeason(stat: CanonicalStat): Dispersion {
  const col = SEASON_COLUMNS[stat];
  const rows = sqlite
    .prepare(
      `SELECT player_id, season, SUM(${col}) AS total
       FROM player_stats_week WHERE season_type = 'REG'
       GROUP BY player_id, season HAVING total IS NOT NULL`,
    )
    .all() as Array<{ player_id: string; season: number; total: number }>;

  const byPlayer = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const m = byPlayer.get(r.player_id) ?? new Map<number, number>();
    m.set(r.season, r.total);
    byPlayer.set(r.player_id, m);
  }

  // Consecutive-season pairs where the player was above the noise floor in the
  // first year and on the field at all in the second.
  const pairs: Array<{ prior: number; next: number }> = [];
  for (const seasons of byPlayer.values()) {
    for (const [season, prior] of seasons) {
      if (prior < MIN_LEVEL[stat]) continue;
      const next = seasons.get(season + 1);
      if (next === undefined) continue;
      pairs.push({ prior, next });
    }
  }

  if (pairs.length < 40) {
    return { stat, scope: 'season', cv: DEFAULT_CV.season, sampleN: pairs.length };
  }

  /*
   * Dispersion is measured as the spread of residuals around a fitted
   * predictor, not around a coarse bin average.
   *
   * The distinction matters. Binning by prior-season total leaves the spread of
   * genuine talent inside each bin sitting in the variance, which inflated
   * season passing yards to a cv near 0.58 — implying a book setting a 3550
   * line is uncertain to +/-2000 yards. It plainly is not. Removing the part of
   * next season that last season already predicts leaves something much closer
   * to the uncertainty a price actually expresses.
   *
   * This is still an upper bound: a book also knows the depth chart, the
   * offseason moves and who is healthy, none of which is in here.
   */
  pairs.sort((a, b) => a.prior - b.prior);
  const k = Math.max(8, Math.round(pairs.length * 0.15));

  const residuals: number[] = [];
  const fitted: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const lo = Math.max(0, i - k);
    const hi = Math.min(pairs.length, i + k + 1);
    let sum = 0;
    let n = 0;
    for (let j = lo; j < hi; j++) {
      if (j === i) continue; // leave-one-out, so a point never predicts itself
      sum += pairs[j]!.next;
      n++;
    }
    if (n === 0) continue;
    const predicted = sum / n;
    residuals.push(pairs[i]!.next - predicted);
    fitted.push(predicted);
  }

  const meanLevel = fitted.reduce((a, b) => a + b, 0) / (fitted.length || 1);
  const { sd } = stats(residuals);
  const cv = meanLevel > 0 ? sd / meanLevel : DEFAULT_CV.season;

  return { stat, scope: 'season', cv, sampleN: pairs.length };
}

/** Week-to-week dispersion within a season, for the per-game props path. */
export function calibrateGame(stat: CanonicalStat): Dispersion {
  const col = SEASON_COLUMNS[stat];
  const rows = sqlite
    .prepare(
      `SELECT player_id, season, ${col} AS v
       FROM player_stats_week
       WHERE season_type = 'REG' AND ${col} IS NOT NULL`,
    )
    .all() as Array<{ player_id: string; season: number; v: number }>;

  const byPlayerSeason = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${r.player_id}|${r.season}`;
    const list = byPlayerSeason.get(key) ?? [];
    list.push(r.v);
    byPlayerSeason.set(key, list);
  }

  let weightedCv = 0;
  let weight = 0;
  let sampleN = 0;
  const perGameFloor = MIN_LEVEL[stat] / 17;

  for (const weeks of byPlayerSeason.values()) {
    if (weeks.length < 8) continue;
    const { mean, sd } = stats(weeks);
    if (mean < perGameFloor || mean <= 0) continue;
    weightedCv += (sd / mean) * weeks.length;
    weight += weeks.length;
    sampleN++;
  }

  if (sampleN < 20) return { stat, scope: 'game', cv: DEFAULT_CV.game, sampleN };
  return { stat, scope: 'game', cv: weightedCv / weight, sampleN };
}

/** Reads a calibrated cv, falling back if the stat was never calibrated. */
export function loadDispersion(): Map<string, number> {
  const rows = sqlite
    .prepare(`SELECT stat, scope, cv FROM stat_dispersion`)
    .all() as Array<{ stat: string; scope: string; cv: number }>;
  const map = new Map<string, number>();
  for (const r of rows) map.set(`${r.stat}|${r.scope}`, r.cv);
  return map;
}

export function cvFor(map: Map<string, number>, stat: string, scope: Scope): number {
  return map.get(`${stat}|${scope}`) ?? DEFAULT_CV[scope];
}
