import { sqlite } from '../db/index';

/**
 * The two ways a draft pick quietly fails: the player cannot stay on the field,
 * or last season's scoring was luck that will not repeat.
 *
 * Both are measured, and both turned out to be real:
 *
 *   Durability — games played predicts games played at r≈0.42 for receivers and
 *   backs. A receiver who missed four or more games misses time again 73% of
 *   the time; one who stayed healthy, 41%. That is not noise, and a per-game
 *   rate flatters a player who is only available two thirds of the season.
 *
 *   Touchdown regression — scoring above what red-zone volume supports carries
 *   over at r=0.12 for receivers and 0.03 for tight ends. Essentially zero. A
 *   player who outscored his opportunity last year is priced on something that
 *   is not coming back.
 *
 * Durability is applied only to the usage side. Season-long props already price
 * missed time — that is why a line sits below a full-season pace — so applying
 * it to the market projection as well would charge the same risk twice.
 */

const FULL_SEASON = 17;
/** Weight on the most recent season when estimating availability. */
const RECENT_WEIGHT = 0.65;

export interface RiskProfile {
  playerId: string;
  /** Games expected available, from weighted history. */
  expectedGames: number;
  /** Expected games as a fraction of a full season. */
  durability: number;
  seasonsObserved: number;
  /** Touchdowns above or below what red-zone volume supports. */
  tdOverExpected: number | null;
  /** Share of last season's points that came from unsustainable scoring. */
  tdRegressionPoints: number | null;
}

/** League-average touchdowns per red-zone touch, by position. */
function tdRates(): Map<string, number> {
  const rows = sqlite
    .prepare(
      `SELECT position, SUM(total_tds) td,
              SUM(COALESCE(rz_carries,0) + COALESCE(rz_targets,0)) touches
       FROM player_usage WHERE games >= 6 GROUP BY position`,
    )
    .all() as Array<{ position: string; td: number; touches: number }>;
  const out = new Map<string, number>();
  for (const r of rows) if (r.touches) out.set(r.position, r.td / r.touches);
  return out;
}

export function buildRiskProfiles(season: number, lookback = 3): Map<string, RiskProfile> {
  const rates = tdRates();

  const rows = sqlite
    .prepare(
      /*
       * Availability, not usage.
       *
       * `player_usage.games` counts games with a recorded stat line, so a healthy
       * backup who touched the ball five times reads identically to a starter who
       * was injured for twelve weeks. Snap counts record every week a player
       * dressed, which is the fact durability is actually about — and for 108
       * players in 2025 the two differ by four games or more. Falls back to the
       * usage count where no snap data exists.
       */
      `SELECT u.player_id, u.season, u.position,
              COALESCE(sc.dressed, u.games) AS games,
              u.rz_carries, u.rz_targets, u.total_tds
       FROM player_usage u
       LEFT JOIN (SELECT player_id, season, COUNT(*) AS dressed FROM snap_counts
                  WHERE game_type = 'REG' GROUP BY player_id, season) sc
         ON sc.player_id = u.player_id AND sc.season = u.season
       WHERE u.season > ? AND u.season <= ? ORDER BY u.season DESC`,
    )
    .all(season - lookback, season) as Array<{
    player_id: string; season: number; position: string; games: number;
    rz_carries: number | null; rz_targets: number | null; total_tds: number | null;
  }>;

  const byPlayer = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byPlayer.get(r.player_id) ?? [];
    list.push(r);
    byPlayer.set(r.player_id, list);
  }

  const out = new Map<string, RiskProfile>();
  for (const [playerId, seasons] of byPlayer) {
    // Weighted average games, recent season counting most.
    let gamesSum = 0;
    let weightSum = 0;
    seasons.forEach((s, i) => {
      const w = i === 0 ? RECENT_WEIGHT : (1 - RECENT_WEIGHT) / Math.max(1, seasons.length - 1);
      gamesSum += Math.min(s.games, FULL_SEASON) * w;
      weightSum += w;
    });
    const expectedGames = weightSum ? gamesSum / weightSum : FULL_SEASON;

    const latest = seasons[0]!;
    const rate = rates.get(latest.position);
    const touches = (latest.rz_carries ?? 0) + (latest.rz_targets ?? 0);
    const tdOverExpected =
      rate !== undefined && touches > 0 ? (latest.total_tds ?? 0) - touches * rate : null;

    out.set(playerId, {
      playerId,
      expectedGames,
      durability: expectedGames / FULL_SEASON,
      seasonsObserved: seasons.length,
      tdOverExpected,
      // Six points a touchdown, so this is the points cushion that is unlikely
      // to survive into next season.
      tdRegressionPoints: tdOverExpected === null ? null : tdOverExpected * 6,
    });
  }

  return out;
}

/**
 * Plain-language risk notes for a scouting line. Only flags what is far enough
 * from normal to be worth saying.
 */
export function riskNotes(r: RiskProfile | undefined): string[] {
  if (!r) return [];
  const notes: string[] = [];

  if (r.seasonsObserved >= 1) {
    if (r.expectedGames <= 12.5) {
      notes.push(`durability risk, ${r.expectedGames.toFixed(1)} games/yr`);
    } else if (r.expectedGames <= 14.5) {
      notes.push(`some missed time, ${r.expectedGames.toFixed(1)} games/yr`);
    }
  }

  if (r.tdOverExpected !== null) {
    if (r.tdOverExpected >= 2.5) {
      notes.push(`TD regression, scored ${r.tdOverExpected.toFixed(1)} above red-zone volume`);
    } else if (r.tdOverExpected <= -2.0) {
      notes.push(`TD positive regression, ${Math.abs(r.tdOverExpected).toFixed(1)} below volume`);
    }
  }

  return notes;
}
