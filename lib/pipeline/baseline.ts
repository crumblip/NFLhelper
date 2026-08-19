/**
 * The ADP baseline: what a draft pick has historically been worth.
 *
 * Fit purely from outcomes — each past season's ADP joined to what those
 * players actually scored, injuries and busts included. No projections, no
 * rankings, no analyst input. The curve answers one question: "a player taken
 * here returned this much, on average."
 *
 * Value is measured in points over replacement rather than raw points, because
 * raw points are not comparable across positions. A QB scoring 300 and a TE
 * scoring 300 are wildly different assets, and drafters already price that in,
 * so the baseline has to speak the same language.
 */

export interface RosterSettings {
  teams: number;
  qb: number;
  rb: number;
  wr: number;
  te: number;
  flex: number;
}

/**
 * The actual starting lineup: 1 QB, 3 WR, 2 RB, 1 TE, 1 W/R/T flex.
 *
 * The receiver count drives everything downstream. Starting three plus a flex
 * that usually goes receiver means roughly 43 are rostered as starters
 * league-wide, so replacement level at the position sits far lower than in a
 * two-receiver league — and every receiver's value over replacement rises.
 * Understating this understates exactly the position that matters most.
 */
export const DEFAULT_ROSTER: RosterSettings = {
  teams: 12,
  qb: 1,
  rb: 2,
  wr: 3,
  te: 1,
  flex: 1,
};

/**
 * How a FLEX slot gets filled in practice. Roughly the observed split in
 * redraft leagues: mostly RB and WR, TE only occasionally.
 */
const FLEX_SHARE = { rb: 0.4, wr: 0.55, te: 0.05 } as const;

/**
 * The rank at each position that counts as freely available. A 12-team league
 * starting 2 RB plus flex exhausts roughly the top 29 RBs, so RB30 is what you
 * can always get.
 */
export function replacementRanks(r: RosterSettings): Record<string, number> {
  return {
    QB: Math.round(r.teams * r.qb),
    RB: Math.round(r.teams * (r.rb + r.flex * FLEX_SHARE.rb)),
    WR: Math.round(r.teams * (r.wr + r.flex * FLEX_SHARE.wr)),
    TE: Math.round(r.teams * (r.te + r.flex * FLEX_SHARE.te)),
  };
}

export interface Observation {
  adp: number;
  points: number;
  vorp: number;
  /** Draft sample size behind this ADP — thin years should count for less. */
  weight: number;
}

export interface GridPoint {
  adpSlot: number;
  expectedPoints: number;
  expectedVorp: number;
  /**
   * Observations actually near this slot (within +/-25%), not the width of the
   * regression window. The top of the draft is genuinely thin — a handful of
   * player-seasons with enormous variance — and the board needs to be able to
   * say so rather than presenting a confident-looking number.
   */
  sampleN: number;
}

/**
 * Tricube-weighted local linear regression over log(ADP).
 *
 * Log space because value falls away steeply early — the gap between picks 1
 * and 10 is worth far more than between 110 and 120 — and local linear rather
 * than a global polynomial so the shape is driven by the data instead of by a
 * chosen functional form.
 */
function loessAt(
  x0: number,
  xs: number[],
  ys: number[],
  ws: number[],
  span: number,
): { value: number; n: number } {
  const n = xs.length;
  const k = Math.max(4, Math.min(n, Math.ceil(span * n)));

  const distances = xs.map((x, i) => ({ d: Math.abs(x - x0), i }));
  distances.sort((a, b) => a.d - b.d);
  const bandwidth = distances[k - 1]!.d || 1e-9;

  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0, used = 0;
  for (let j = 0; j < k; j++) {
    const { d, i } = distances[j]!;
    const u = d / bandwidth;
    if (u >= 1) continue;
    const tricube = (1 - u ** 3) ** 3;
    const w = tricube * ws[i]!;
    if (w <= 0) continue;

    const x = xs[i]!, y = ys[i]!;
    sw += w;
    swx += w * x;
    swy += w * y;
    swxx += w * x * x;
    swxy += w * x * y;
    used++;
  }
  if (sw === 0) return { value: 0, n: 0 };

  const meanX = swx / sw;
  const meanY = swy / sw;
  const varX = swxx / sw - meanX * meanX;
  const covXY = swxy / sw - meanX * meanY;
  const slope = Math.abs(varX) < 1e-12 ? 0 : covXY / varX;

  return { value: meanY + slope * (x0 - meanX), n: used };
}

/**
 * Pool-adjacent-violators, forcing the curve to be non-increasing.
 *
 * Local regression on noisy data will happily produce a bump where pick 40
 * looks better than pick 35. That is sampling noise, not signal: a later pick
 * is never genuinely worth more in expectation, and an unenforced bump would
 * show up as fake value on every player sitting in it.
 */
function enforceNonIncreasing(values: number[]): number[] {
  const out = [...values];
  const blockSum: number[] = [];
  const blockLen: number[] = [];

  for (const v of out) {
    blockSum.push(v);
    blockLen.push(1);
    while (blockSum.length > 1) {
      const last = blockSum.length - 1;
      const prevMean = blockSum[last - 1]! / blockLen[last - 1]!;
      const curMean = blockSum[last]! / blockLen[last]!;
      if (prevMean >= curMean) break;
      blockSum[last - 1] = blockSum[last - 1]! + blockSum[last]!;
      blockLen[last - 1] = blockLen[last - 1]! + blockLen[last]!;
      blockSum.pop();
      blockLen.pop();
    }
  }

  const result: number[] = [];
  for (let b = 0; b < blockSum.length; b++) {
    const mean = blockSum[b]! / blockLen[b]!;
    for (let i = 0; i < blockLen[b]!; i++) result.push(mean);
  }
  return result;
}

export interface FitOptions {
  span?: number;
  maxSlot?: number;
  step?: number;
}

export function fitBaseline(obs: Observation[], opts: FitOptions = {}): GridPoint[] {
  const span = opts.span ?? 0.3;
  const maxSlot = opts.maxSlot ?? 200;
  const step = opts.step ?? 0.5;

  const usable = obs.filter((o) => o.adp > 0 && Number.isFinite(o.points));
  if (usable.length < 20) throw new Error(`too few observations to fit: ${usable.length}`);

  const xs = usable.map((o) => Math.log(o.adp));
  const vorps = usable.map((o) => o.vorp);
  const points = usable.map((o) => o.points);
  const ws = usable.map((o) => o.weight);

  const slots: number[] = [];
  for (let s = 1; s <= maxSlot; s += step) slots.push(Number(s.toFixed(2)));

  const rawVorp: number[] = [];
  const rawPoints: number[] = [];
  const counts: number[] = [];

  const adps = usable.map((o) => o.adp);
  for (const slot of slots) {
    const x0 = Math.log(slot);
    rawVorp.push(loessAt(x0, xs, vorps, ws, span).value);
    rawPoints.push(loessAt(x0, xs, points, ws, span).value);
    counts.push(adps.filter((a) => a >= slot * 0.75 && a <= slot * 1.25).length);
  }

  const smoothVorp = enforceNonIncreasing(rawVorp);
  const smoothPoints = enforceNonIncreasing(rawPoints);

  return slots.map((adpSlot, i) => ({
    adpSlot,
    expectedPoints: smoothPoints[i]!,
    expectedVorp: smoothVorp[i]!,
    sampleN: counts[i]!,
  }));
}

/** Expected value at an arbitrary ADP, linearly interpolated on the grid. */
export function expectedAt(grid: GridPoint[], adp: number): GridPoint {
  if (!grid.length) throw new Error('empty baseline grid');
  const first = grid[0]!;
  const last = grid[grid.length - 1]!;
  if (adp <= first.adpSlot) return first;
  if (adp >= last.adpSlot) return last;

  let lo = 0, hi = grid.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid]!.adpSlot <= adp) lo = mid;
    else hi = mid;
  }
  const a = grid[lo]!, b = grid[hi]!;
  const t = (adp - a.adpSlot) / (b.adpSlot - a.adpSlot);
  return {
    adpSlot: adp,
    expectedPoints: a.expectedPoints + t * (b.expectedPoints - a.expectedPoints),
    expectedVorp: a.expectedVorp + t * (b.expectedVorp - a.expectedVorp),
    sampleN: Math.round(a.sampleN + t * (b.sampleN - a.sampleN)),
  };
}

/**
 * The inverse: the draft slot at which this much value is the historical norm.
 *
 * This is what turns an abstract points gap into the headline the board is
 * built on — "the market prices him like a pick-24 player, he is going at 58".
 * Ties are resolved to the earliest qualifying slot since the curve is flat in
 * places, and a value above the curve's peak clamps to slot 1.
 */
/**
 * The pick a projection is worth, and whether the curve could actually answer.
 *
 * The baseline runs from pick 1 to pick 200, because that is the range players
 * are drafted in. A projection below what pick 200 has returned has no
 * equivalent — there is no such pick — and the old behaviour silently clamped to
 * 200 and returned it like any other answer. That is fine as arithmetic and
 * ruinous as a claim: **83% of the waiver wire** came back "projects like pick
 * 200", which reads as a measurement and means "off the end of the scale". Four
 * percent of the draft board has its slot gap measured against the same clamp.
 *
 * Callers get the saturation flag so they can say "below any drafted pick"
 * instead of inventing a number. `adpEquivalent` keeps its old signature and
 * clamping so the board's arithmetic is untouched; what changes is that nothing
 * has to guess any more.
 */
export function adpEquivalentDetail(
  grid: GridPoint[],
  vorp: number,
): { pick: number; clamped: 'top' | 'bottom' | null } {
  if (!grid.length) throw new Error('empty baseline grid');
  if (vorp >= grid[0]!.expectedVorp) return { pick: grid[0]!.adpSlot, clamped: 'top' };
  const last = grid[grid.length - 1]!;
  if (vorp <= last.expectedVorp) return { pick: last.adpSlot, clamped: 'bottom' };
  return { pick: adpEquivalent(grid, vorp), clamped: null };
}

export function adpEquivalent(grid: GridPoint[], vorp: number): number {
  if (!grid.length) throw new Error('empty baseline grid');
  if (vorp >= grid[0]!.expectedVorp) return grid[0]!.adpSlot;

  const last = grid[grid.length - 1]!;
  if (vorp <= last.expectedVorp) return last.adpSlot;

  for (let i = 1; i < grid.length; i++) {
    const prev = grid[i - 1]!;
    const cur = grid[i]!;
    if (vorp >= cur.expectedVorp) {
      const span = prev.expectedVorp - cur.expectedVorp;
      if (Math.abs(span) < 1e-9) return prev.adpSlot;
      const t = (prev.expectedVorp - vorp) / span;
      return prev.adpSlot + t * (cur.adpSlot - prev.adpSlot);
    }
  }
  return last.adpSlot;
}
