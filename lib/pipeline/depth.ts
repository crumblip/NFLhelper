import { sqlite } from '../db/index';
import { buildRiskProfiles } from './risk';

/**
 * Contingent opportunity — the volume a player would inherit if the man ahead
 * of him falls over.
 *
 * Vacated opportunity only counts players who already left the roster. That
 * misses the two ways a job actually opens up during a season: the starter gets
 * hurt, or the starter is bad enough to be replaced. Both are visible before
 * they happen. A back listed second behind a thirty-two-year-old who averages
 * eleven games a season is in a materially different position from one behind a
 * twenty-four-year-old who has never missed a start, even though both are RB2
 * today.
 *
 * So each blocker is scored on how likely he is to stop being a blocker, and
 * the volume he currently holds is weighted by that.
 */

export interface Blocker {
  playerId: string;
  name: string;
  depthRank: number;
  age: number | null;
  expectedGames: number | null;
  /** His share of the team's work at this position. */
  volumeShare: number;
  /** Scoring work he holds, which a promoted backup inherits alongside volume. */
  rzShare: number;
  goalLineShare: number;
  /** Chance he misses meaningful time or loses the job. */
  vulnerability: number;
  reason: string;
}

export interface Contingency {
  playerId: string;
  blockers: Blocker[];
  /** Volume-weighted chance of inheriting work, 0-1. */
  contingentShare: number;
  note: string | null;
}

/**
 * Chance a blocker stops blocking.
 *
 * Injury risk is measured: a player who missed four or more games misses time
 * again 73% of the time against 41% for one who stayed healthy, so games played
 * maps directly onto it. Age adds to it past the position curve. Weak play adds
 * a smaller amount — being replaced for performance is real but slower and less
 * predictable than getting hurt.
 */
/**
 * Durability thresholds, set from the population that actually holds a role.
 *
 * The old cutoffs were 12 and 14.5 games, which sound like reasonable
 * definitions of "misses time" and are not: across everyone with usage history
 * the median is 11.3 games, so 54% of the league tripped the larger penalty and
 * 68% the smaller. A penalty that applies to most of a population is its default
 * state, and it pushed 53% of every depth chart to "Shaky" — the reader learns
 * nothing from a label that half the league carries.
 *
 * These are the quartiles among players who hold a real share, which is the only
 * group for whom missing time is a fact about their availability rather than
 * about their place on the roster.
 */
const GAMES_FRAGILE = 9;
const GAMES_SOME = 13.5;

/**
 * Below this share of his position's work there is no job to lose.
 *
 * 546 of 826 skill players on a depth chart hold under 5%. Scoring them on
 * durability alone made a healthy sixth receiver read "Secure" — a confident
 * statement about a role he does not have, and the only Green Bay receiver not
 * marked at risk.
 */
const ROLE_FLOOR = 0.08;

export function vulnerabilityOf(
  expectedGames: number | null,
  age: number | null,
  position: string,
  usageGrade: number | null,
  volumeShare: number | null = null,
): { p: number; reason: string; known: boolean; hasRole: boolean } {
  const reasons: string[] = [];

  /*
   * 0.25 is a prior, not a measurement, and it must not be presented as one.
   *
   * When none of the three inputs is available the function used to return the
   * untouched baseline, which meant 681 of 948 players on the depth chart —
   * 72% — displayed exactly "25%" as though it had been computed for them. A
   * number that is really "we have no idea" has to say so, or it crowds out the
   * players where the figure is real.
   */
  let p = 0.25;

  /*
   * Durability is the substance of this number — age and role only modify it.
   * A 24-year-old with no games on record has nothing behind his figure, so
   * having a birth date does not make the result measured.
   */
  const known = expectedGames !== null;
  const hasRole = volumeShare === null || volumeShare >= ROLE_FLOOR;

  if (expectedGames !== null) {
    if (expectedGames <= GAMES_FRAGILE) {
      p += 0.3;
      reasons.push(`${expectedGames.toFixed(1)} games a year`);
    } else if (expectedGames <= GAMES_SOME) {
      p += 0.12;
      reasons.push('misses some time');
    } else {
      p -= 0.08;
    }
  }

  const ageLimit = position === 'RB' ? 28 : 30;
  if (age !== null && age >= ageLimit) {
    p += 0.12 + Math.min(0.15, (age - ageLimit) * 0.04);
    reasons.push(`age ${age}`);
  }

  /*
   * Deliberately NOT penalising a low usage grade.
   *
   * The grade is a league-wide percentile, so a third receiver scores low for
   * being a third receiver — the penalty fired on 36% of graded depth-chart
   * players and said only "he is not a star", which the depth rank already
   * says. Using it here made insecurity circular: buried, therefore fragile,
   * therefore buried. Losing a job to performance is real but slow, and nothing
   * in this dataset measures it cleanly, so it is left out rather than faked.
   */

  return { p: Math.max(0.05, Math.min(0.85, p)), reason: reasons.join(', '), known, hasRole };
}

export function buildContingencies(season: number): Map<string, Contingency> {
  /*
   * Durability comes from the risk profiles, which cover every player with usage
   * history (867), not from `value_scores`, which only holds the 179 being
   * drafted (162 with a games figure). Joining the board threw the number away
   * for every backup — exactly the players whose vulnerability this function
   * exists to score.
   */
  const risk = buildRiskProfiles(season - 1);
  const rows = sqlite
    .prepare(
      `SELECT dc.player_id AS playerId, p.display_name AS name, dc.team, dc.pos_abb AS pos,
              dc.pos_rank AS depthRank,
              ? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age,
              v.usage_grade AS usageGrade,
              COALESCE(u.rush_share, u.target_share, 0) AS volumeShare,
              COALESCE(u.rz_touch_share, 0) AS rzShare,
              COALESCE(u.goal_line_share, 0) AS goalLineShare
       FROM depth_chart dc
       JOIN players p ON p.gsis_id = dc.player_id
       LEFT JOIN value_scores v ON v.player_id = dc.player_id AND v.season = ?
       LEFT JOIN player_usage u ON u.player_id = dc.player_id AND u.season = ? - 1
       WHERE dc.season = ? AND dc.pos_abb IN ('RB','WR','TE') AND dc.pos_rank IS NOT NULL
         AND dc.pos_abb = COALESCE(p.position, dc.pos_abb)`,
    )
    .all(season, season, season, season) as Array<{
    playerId: string; name: string; team: string; pos: string; depthRank: number;
    age: number | null; usageGrade: number | null;
    volumeShare: number; rzShare: number; goalLineShare: number;
  }>;

  // Group by team and position so blockers are the players genuinely in front.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.team}|${r.pos}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out = new Map<string, Contingency>();
  for (const list of groups.values()) {
    list.sort((a, b) => a.depthRank - b.depthRank);

    for (const player of list) {
      const ahead = list.filter((x) => x.depthRank < player.depthRank);
      if (!ahead.length) {
        out.set(player.playerId, {
          playerId: player.playerId, blockers: [], contingentShare: 0, note: null,
        });
        continue;
      }

      const blockers: Blocker[] = ahead.map((b) => {
        const v = vulnerabilityOf(risk.get(b.playerId)?.expectedGames ?? null, b.age, b.pos, b.usageGrade);
        return {
          playerId: b.playerId, name: b.name, depthRank: b.depthRank,
          age: b.age, expectedGames: risk.get(b.playerId)?.expectedGames ?? null,
          volumeShare: b.volumeShare, rzShare: b.rzShare, goalLineShare: b.goalLineShare,
          vulnerability: v.p, reason: v.reason,
        };
      });

      /*
       * Work he stands to inherit, contested rather than assumed.
       *
       * Counting each blocker's volume in full gave every back behind the same
       * starter an identical claim on it — Rico Dowdle and Jaylen Warren, both
       * Pittsburgh backs competing for the same carries, came out as equally
       * strong opportunities. They cannot both inherit the job.
       *
       * So a freed role is split among the players in line for it, weighted by
       * how close they are to the front. The man immediately behind takes most
       * of it; the third-stringer takes a sliver.
       */
      const queue = list.filter((x) => x.depthRank > Math.max(...ahead.map((a) => a.depthRank)));
      const placeInQueue = queue.findIndex((x) => x.playerId === player.playerId);
      const CLAIM = [0.6, 0.25, 0.15];
      const claim = placeInQueue >= 0 ? (CLAIM[placeInQueue] ?? 0.05) : 0.05;

      const contingentShare =
        blockers.reduce((sum, b) => sum + b.volumeShare * b.vulnerability, 0) * claim;

      const worst = [...blockers].sort(
        (a, b) => b.volumeShare * b.vulnerability - a.volumeShare * a.vulnerability,
      )[0];

      const note =
        worst && worst.volumeShare * worst.vulnerability >= 0.08
          ? `behind ${worst.name}` +
            (worst.reason ? ` (${worst.reason})` : '') +
            ` — ${Math.round(worst.volumeShare * 100)}% of the work at ` +
            `${Math.round(worst.vulnerability * 100)}% risk`
          : null;

      out.set(player.playerId, { playerId: player.playerId, blockers, contingentShare, note });
    }
  }

  return out;
}
