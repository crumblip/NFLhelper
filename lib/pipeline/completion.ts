import { sqlite } from '../db/index';

/**
 * Completing a partial market projection instead of discarding it.
 *
 * When sportsbooks price only part of what a player does — most often a back
 * with rushing lines and no receiving line — the blend used to drop the market
 * entirely and fall back on usage or draft capital. That threw away the most
 * specific information available. Jeremiyah Love was priced at 885 rushing
 * yards and 5.5 rushing touchdowns, worth 121 points, and the tool replaced it
 * with 276 from a draft-capital median.
 *
 * The market number is not wrong, it is incomplete. So it is kept as the anchor
 * and scaled by how much of a position's scoring the covered categories
 * normally account for. A rushing-only line on a back is grossed up by the
 * historical rushing share of back scoring, nothing more.
 */

export interface CategoryShares {
  /** Fraction of the position's points coming from each category group. */
  rushing: number;
  receiving: number;
  passing: number;
}

/** Measured from history rather than assumed. */
export function categoryShares(format: string): Map<string, CategoryShares> {
  const mult = format === 'ppr' ? 1 : format === 'standard' ? 0 : 0.5;

  const rows = sqlite
    .prepare(
      `SELECT position,
              SUM(COALESCE(rushing_yards,0)) * 0.1 + SUM(COALESCE(rushing_tds,0)) * 6 AS rush,
              SUM(COALESCE(receiving_yards,0)) * 0.1 + SUM(COALESCE(receiving_tds,0)) * 6
                + SUM(COALESCE(receptions,0)) * ? AS rec,
              SUM(COALESCE(passing_yards,0)) * 0.04 + SUM(COALESCE(passing_tds,0)) * 4 AS pass
       FROM player_stats_week
       WHERE season_type = 'REG' AND season >= 2021 AND position IN ('QB','RB','WR','TE')
       GROUP BY position`,
    )
    .all(mult) as Array<{ position: string; rush: number; rec: number; pass: number }>;

  const out = new Map<string, CategoryShares>();
  for (const r of rows) {
    const total = r.rush + r.rec + r.pass;
    if (total <= 0) continue;
    out.set(r.position, {
      rushing: r.rush / total,
      receiving: r.rec / total,
      passing: r.pass / total,
    });
  }
  return out;
}

/**
 * Grosses a partial market projection up to a whole one.
 *
 * `covered` names which category groups the market actually priced. The result
 * is capped: a rushing line alone cannot be scaled into a top-five season, and
 * the cap keeps a thinly-covered player from outranking a fully-priced one on
 * arithmetic alone.
 */
export function completeMarket(
  marketPoints: number,
  position: string,
  covered: { rushing: boolean; receiving: boolean; passing: boolean },
  shares: Map<string, CategoryShares>,
): { points: number; coveredShare: number } | null {
  const s = shares.get(position);
  if (!s) return null;

  const coveredShare =
    (covered.rushing ? s.rushing : 0) +
    (covered.receiving ? s.receiving : 0) +
    (covered.passing ? s.passing : 0);

  // Below a third covered there is not enough of the player priced to gross up
  // responsibly — that is a floor, not a projection.
  if (coveredShare < 0.33) return null;

  return { points: marketPoints / coveredShare, coveredShare };
}

/** Which category groups a player's implied stats actually cover. */
export function coveredGroups(stats: Set<string>): {
  rushing: boolean;
  receiving: boolean;
  passing: boolean;
} {
  return {
    rushing: stats.has('rushingYards') || stats.has('rushingTds'),
    receiving: stats.has('receivingYards') || stats.has('receivingTds'),
    passing: stats.has('passingYards') || stats.has('passingTds'),
  };
}
