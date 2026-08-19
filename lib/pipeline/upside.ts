import type { UsageFit, UsageProjection } from './usage-grade';
import type { Contingency, Blocker } from './depth';

/**
 * What a player is worth if the depth chart in front of him changes.
 *
 * Every other number on the board is an expectation. For a starter that is the
 * right summary; for a backup it is actively misleading, because his outcome is
 * not a bell curve around the mean but a branch — irrelevant if the man ahead
 * stays healthy, a starter the day he does not. Averaging those two describes
 * neither.
 *
 * The first version of this module got the arithmetic wrong in two ways that
 * both flattered deep backups, which is the exact population it was supposed to
 * assess honestly:
 *
 *   1. It identified the blocker by sorting depth rank ASCENDING and taking the
 *      first, which is the man furthest away. Raheim Sanders at RB3 was reported
 *      as blocked by Quinshon Judkins at RB1 — and therefore inherited Judkins'
 *      66% share rather than the 17% held by Dylan Sampson, who is actually in
 *      front of him.
 *
 *   2. It set the probability to "at least one blocker falls", 1 − Π(1−v). For a
 *      player two deep that is simply the wrong event. If only the RB1 goes down
 *      the RB2 becomes the lead and the RB3 has gained almost nothing. Sanders
 *      came out at 55% when the chance of actually reaching the job is 10%.
 *
 * Both are replaced here by enumerating the depth chart's states exactly. With
 * at most a handful of blockers the full 2^n enumeration is cheap, needs no
 * approximation, and cannot get the queue order wrong: for every combination of
 * who is available, the player's resulting rank and share are computed directly.
 */

/**
 * How the freed work splits among whoever is left.
 *
 * Two backs cannot both inherit the same carries. The man who ends up first in
 * the queue takes most of it, the next a quarter, the third the remainder —
 * the same contested split the vacancy calculation uses.
 */
const QUEUE_CLAIM = [0.6, 0.25, 0.15];

export interface UpsideState {
  /** Probability of this configuration of the depth chart. */
  probability: number;
  /** His rank once the absent players are removed, 1 = lead. */
  rank: number;
  /** Team volume share he takes on beyond his own. */
  inherited: number;
}

export interface UpsideProjection {
  playerId: string;
  position: string;
  /** Points from the role he holds today. */
  basePoints: number;
  /**
   * Points in the branch where he ends up leading the position group, and how
   * likely that branch is. This is the headline "if the job opens" figure.
   */
  leadPoints: number;
  leadChance: number;
  /**
   * Expected points across EVERY branch, weighted by probability — including
   * the most likely one, where nothing changes. This is the honest ranking
   * quantity; the lead branch alone is a ceiling, not a forecast.
   */
  expectedPoints: number;
  /** expectedPoints − basePoints. What the depth chart is worth to him. */
  expectedGain: number;
  /** The man directly in front, which is the one whose job he would take. */
  blockerName: string | null;
  blockerRank: number | null;
  blockers: number;
}

const PRIMARY: Record<string, string> = {
  RB: 'rush share',
  WR: 'target share',
  TE: 'target share',
  QB: 'starter share',
};

/** Applies the fitted model to a predictor vector. */
function pointsAt(fit: UsageFit, values: number[]): number {
  return Math.max(0, fit.intercept + values.reduce((a, v, i) => a + v * fit.coefficients[i]!, 0));
}

export function buildUpside(
  fits: UsageFit[],
  projections: UsageProjection[],
  contingencies: Map<string, Contingency>,
): Map<string, UpsideProjection> {
  const byPosition = new Map(fits.map((f) => [f.position, f]));
  const out = new Map<string, UpsideProjection>();

  for (const proj of projections) {
    const fit = byPosition.get(proj.position);
    const cont = contingencies.get(proj.playerId);
    if (!fit || !cont || cont.blockers.length === 0) continue;

    // A quarterback's job opens by being named starter, not by inheriting
    // volume. Modelling it as share transfer is the same category error as
    // handing him vacated targets.
    if (proj.position === 'QB') continue;

    /*
     * Only the men who can actually block him. More than three deep the
     * enumeration stops being meaningful — a fourth-string back needs three
     * simultaneous absences, which is not a plan.
     */
    const ahead: Blocker[] = [...cont.blockers]
      .sort((a, b) => b.depthRank - a.depthRank)
      .slice(0, 3);
    if (!ahead.length) continue;

    // Descending rank, so index 0 is the man directly in front of him.
    const direct = ahead[0]!;

    const primaryLabel = PRIMARY[proj.position];
    const basePoints = proj.points;

    /*
     * Enumerate every combination of blockers present or absent.
     *
     * For each state the player's rank is 1 + however many blockers remain, and
     * the volume freed by those who are gone is split by that new rank. This is
     * what makes an RB3 different from an RB2: he only reaches the front of the
     * queue in the single state where everyone ahead is gone, and that state
     * carries the product of their probabilities, not their union.
     */
    const states: UpsideState[] = [];
    for (let mask = 0; mask < 1 << ahead.length; mask++) {
      let probability = 1;
      let freedVolume = 0;
      let freedRz = 0;
      let freedGoalLine = 0;
      let remaining = 0;

      ahead.forEach((b, i) => {
        const isOut = (mask & (1 << i)) !== 0;
        probability *= isOut ? b.vulnerability : 1 - b.vulnerability;
        if (isOut) {
          freedVolume += b.volumeShare;
          freedRz += b.rzShare;
          freedGoalLine += b.goalLineShare;
        } else {
          remaining++;
        }
      });

      const rank = remaining + 1;
      const claim = QUEUE_CLAIM[Math.min(rank - 1, QUEUE_CLAIM.length - 1)]!;
      states.push({ probability, rank, inherited: freedVolume * claim });

      // Points in this state, evaluated at the shares he would actually hold.
      const values = proj.inputs.map((input) => {
        if (input.label === primaryLabel) return input.value + freedVolume * claim;
        if (input.label === 'red-zone share') return input.value + freedRz * claim;
        if (input.label === 'goal-line share') return input.value + freedGoalLine * claim;
        return input.value;
      });
      (states[states.length - 1] as UpsideState & { points: number }).points = pointsAt(fit, values);
    }

    const typed = states as Array<UpsideState & { points: number }>;
    const expectedPoints = typed.reduce((a, s) => a + s.probability * s.points, 0);

    // The branch where he ends up leading — every blocker absent.
    const leadStates = typed.filter((s) => s.rank === 1);
    const leadChance = leadStates.reduce((a, s) => a + s.probability, 0);
    const leadPoints = leadChance
      ? leadStates.reduce((a, s) => a + s.probability * s.points, 0) / leadChance
      : basePoints;

    out.set(proj.playerId, {
      playerId: proj.playerId,
      position: proj.position,
      basePoints,
      leadPoints,
      leadChance,
      expectedPoints,
      expectedGain: expectedPoints - basePoints,
      blockerName: direct.name,
      blockerRank: direct.depthRank,
      blockers: ahead.length,
    });
  }

  return out;
}

/**
 * How secure a player's own role is, from the same vulnerability model applied
 * to him rather than to the man in front.
 *
 * This is the other half of the depth-chart picture and the one the board never
 * showed. A projection assumes a player keeps his job; whether he keeps it is a
 * measurable thing, driven by the same three factors that make a blocker
 * vulnerable — how much time he misses, his age against the position curve, and
 * whether his role is weak enough to be taken.
 */
export interface RoleCertainty {
  playerId: string;
  /** 0-1. The chance he still holds this role, i.e. 1 − his own vulnerability. */
  certainty: number;
  reasons: string[];
  /** The most credible player behind him, if anyone is close. */
  challenger: string | null;
}
