import { sqlite } from '../db/index';
import type { StatLine } from './scoring';

/**
 * Which scoring categories the market actually prices, per position.
 *
 * This exists to fix a bias that is invisible until you look for it. A category
 * the market never posts is scored as zero on the implied side, but the
 * historical baseline it gets compared against still contains it. The mismatch
 * is systematic by position, so it shows up as a confident-looking edge:
 *
 *   - Interceptions are posted for 0% of QBs and are worth about -20 points a
 *     season. Every QB was landing ~20 points ahead of a baseline that paid the
 *     penalty, which read as "late QBs are massively undervalued".
 *
 * The fix is not to impute the missing category. It is to drop that category
 * from *both* sides — the implied line, replacement level, and the historical
 * actuals behind the curve — so the comparison is like for like. Because VORP
 * is a difference, a category dropped consistently very nearly cancels.
 *
 * Categories that some players at a position have and others do not are a
 * different problem, and are not solved here — see `signal` in value.ts.
 */

export type Category = keyof StatLine;

/** Present for at least this share of a position's players to count as priced. */
const COVERAGE_THRESHOLD = 0.6;

const STAT_TO_CATEGORY: Record<string, Category> = {
  passingYards: 'passingYards',
  passingTds: 'passingTds',
  interceptions: 'interceptions',
  rushingYards: 'rushingYards',
  rushingTds: 'rushingTds',
  receptions: 'receptions',
  receivingYards: 'receivingYards',
  receivingTds: 'receivingTds',
};

/**
 * Categories that must never be dropped, because they define the position.
 * Guards against a thin data day silently removing the main scoring source.
 */
const ALWAYS: Record<string, Category[]> = {
  // QB rushing is kept despite sitting near the coverage threshold: dropping it
  // would score Jalen Hurts as a pocket passer. Quarterbacks without a rushing
  // line are marked partial instead, the same treatment RBs missing a receiving
  // line get.
  QB: ['passingYards', 'passingTds', 'rushingYards', 'rushingTds'],
  RB: ['rushingYards', 'rushingTds', 'receivingYards', 'receptions', 'receivingTds'],
  WR: ['receivingYards', 'receivingTds', 'receptions'],
  TE: ['receivingYards', 'receivingTds', 'receptions'],
};

export type CoverageProfile = Map<string, Set<Category>>;

export function buildCoverageProfile(
  format: string,
  teams: number,
  season: number,
): CoverageProfile {
  const rows = sqlite
    .prepare(
      `SELECT a.position, i.stat, COUNT(DISTINCT i.player_id) AS n
       FROM implied_stats i
       JOIN adp_raw a ON a.player_id = i.player_id
        AND a.year = ? AND a.format = ? AND a.teams = ?
       WHERE i.scope = 'season'
       GROUP BY a.position, i.stat`,
    )
    .all(season, format, teams) as Array<{ position: string; stat: string; n: number }>;

  const totals = sqlite
    .prepare(
      `SELECT a.position, COUNT(DISTINCT a.player_id) AS n
       FROM adp_raw a
       WHERE a.year = ? AND a.format = ? AND a.teams = ?
         AND EXISTS (SELECT 1 FROM implied_stats i
                     WHERE i.player_id = a.player_id AND i.scope = 'season')
       GROUP BY a.position`,
    )
    .all(season, format, teams) as Array<{ position: string; n: number }>;

  const denom = new Map(totals.map((t) => [t.position.toUpperCase(), t.n]));
  const profile: CoverageProfile = new Map();

  for (const pos of Object.keys(ALWAYS)) {
    profile.set(pos, new Set(ALWAYS[pos]));
  }

  for (const r of rows) {
    const pos = r.position.toUpperCase();
    const category = STAT_TO_CATEGORY[r.stat];
    const total = denom.get(pos) ?? 0;
    if (!category || !total) continue;
    if (r.n / total >= COVERAGE_THRESHOLD) {
      const set = profile.get(pos) ?? new Set<Category>();
      set.add(category);
      profile.set(pos, set);
    }
  }

  return profile;
}

/** Zeroes every category the market does not price for this position. */
export function maskStatLine(line: StatLine, categories: Set<Category>): StatLine {
  const out: StatLine = {};
  for (const key of Object.keys(line) as Category[]) {
    if (categories.has(key)) out[key] = line[key];
  }
  return out;
}

export function describeProfile(profile: CoverageProfile): string {
  return [...profile]
    .sort()
    .map(([pos, set]) => `${pos}: ${[...set].sort().join(', ')}`)
    .join('\n  ');
}
