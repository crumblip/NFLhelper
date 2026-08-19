/**
 * Turning prices into projections.
 *
 * A posted line is not a projection. It is roughly the median outcome, and the
 * two prices tell you how the book thinks the distribution sits around it. A
 * line of 1250 juiced -135/+110 implies a mean meaningfully above 1250, and
 * reading the line alone would systematically understate every player the
 * market likes.
 */

/** American odds -> implied probability, vig included. */
export function americanToProb(odds: number): number {
  if (odds === 0) return 0;
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

export interface Devigged {
  pOver: number;
  hold: number;
}

/**
 * Removes the bookmaker's margin proportionally.
 *
 * Proportional (rather than additive or power) devigging is the standard choice
 * for two-way markets and is well behaved near even money, which is where
 * almost every season-total line sits.
 */
export function devigTwoWay(overOdds: number, underOdds: number): Devigged {
  const qOver = americanToProb(overOdds);
  const qUnder = americanToProb(underOdds);
  const total = qOver + qUnder;
  if (total <= 0) return { pOver: 0.5, hold: 0 };
  return { pOver: qOver / total, hold: total - 1 };
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Accurate to ~1e-9 across the range, which is far tighter than the prices
 * feeding it deserve.
 */
export function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
             3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
           ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
            ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
         (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export interface ImpliedMean {
  mu: number;
  sigma: number;
  pOver: number;
  hold: number;
}

/**
 * Recovers the mean implied by a line and its two prices.
 *
 * Treats the outcome as roughly normal around the line: at a fair 50/50 the
 * line is the mean, and price skew shifts it by however many standard
 * deviations the devigged probability implies. Over a full season the central
 * limit theorem makes normality a reasonable working assumption even for
 * counting stats like touchdowns.
 *
 * `cv` is the coefficient of variation for this stat, calibrated from history
 * rather than guessed.
 */
export function impliedMean(
  line: number,
  overOdds: number | null,
  underOdds: number | null,
  cv: number,
): ImpliedMean {
  const sigma = Math.max(1e-6, Math.abs(line) * cv);

  // A one-sided or missing price gives no information about skew, so the line
  // stands as the best estimate rather than being adjusted on a guess.
  if (overOdds === null || underOdds === null) {
    return { mu: line, sigma, pOver: 0.5, hold: 0 };
  }

  const { pOver, hold } = devigTwoWay(overOdds, underOdds);
  // Clamp before the probit so a badly-priced outlier cannot produce infinities.
  const clamped = Math.min(0.999, Math.max(0.001, pOver));
  return { mu: line + sigma * probit(clamped), sigma, pOver, hold };
}

/** Median — the consensus across books, robust to one book hanging a stale line. */
export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
