/**
 * Combining the two signals into one number.
 *
 * The market and on-field usage answer different questions. Sportsbook props
 * price everything known before a snap is played — offseason moves, health,
 * depth chart, coaching change — which no historical usage row can see. Usage
 * prices what a player is actually being asked to do, which the market can be
 * slow to re-rate. Neither dominates, so the blend keeps both and always shows
 * its components.
 */

/**
 * How much weight this season's usage takes from last season's, given games
 * played so far.
 *
 * Calibrated, not guessed. Predicting rest-of-season points per game from
 * opportunity, season-to-date overtakes prior-season after only two games:
 *
 *   games in    prior season   season to date
 *      1            0.669           0.654
 *      2            0.659           0.702
 *      3            0.646           0.709
 *      6            0.601           0.684
 *
 * g/(g+k) with k=1.5 tracks that: even at one game, past the prior season by
 * two, and flattening near 0.85 once a real sample exists.
 */
const CURRENT_SEASON_SHRINKAGE = 1.5;

export function currentSeasonWeight(gamesPlayed: number): number {
  if (gamesPlayed <= 0) return 0;
  return gamesPlayed / (gamesPlayed + CURRENT_SEASON_SHRINKAGE);
}

/**
 * Market share of the final blend.
 *
 * This one is a judgment call and is flagged as such. Proving the right split
 * would need a historical archive of prop lines to test whether usage adds
 * anything the market did not already price, and no such archive exists
 * publicly. The default leans to the market because props incorporate
 * information usage cannot observe, and because they refresh weekly in-season
 * while a usage row is always looking backwards.
 */
export const DEFAULT_MARKET_WEIGHT = Number(process.env.MARKET_WEIGHT ?? 0.6);

/**
 * Weight on an uncovered player's OWN usage projection, against what his draft
 * slot has historically returned.
 *
 * The sibling of `DEFAULT_MARKET_WEIGHT`, and measured the same way: for a
 * player no book prices, the slot is the market, so the shrinkage step is just
 * a two-signal blend and can be swept. Leave-one-season-out over 2022-2025,
 * 509 player-seasons, scored against what the players actually did:
 *
 *   flat 0.30                              r 0.5065
 *   flat 0.20 / 0.40                       r 0.5057 / 0.5050
 *   always the slot (0)                    r 0.4979
 *   min(1, seasons/3) x min(1, games/12)   r 0.4891   <- the rule this replaced
 *   always his own number (1)              r 0.4500
 *
 * Seasons of history do not predict who beats their draft slot, and the rule
 * built on them lost to a constant in all four folds. Per position the optima
 * are WR 0.40 · RB 0.25 · TE 0.05 · QB 0.35 and 0.30 costs at most 0.009
 * against any of them, so it stays flat — per-position tuning failed to
 * generalise here exactly as it did for the market weight.
 *
 * Lives here rather than in the build script so the audit can check the receipt
 * against the number actually applied instead of against a second copy of it.
 */
export const USAGE_CONFIDENCE = Number(process.env.USAGE_CONFIDENCE ?? 0.3);

/**
 * The stretch of the draft where the price read is not worth acting on.
 *
 * THIS IS A CHOSEN CUT ON A SMOOTH DECLINE, NOT A MEASURED EDGE, and the
 * distinction matters because the first version of this constant was presented
 * as the latter. `diagnose-deadband` measured a rolling 60-pick window instead
 * of the fixed bands that produced the original figure, and there is no cliff
 * anywhere. Draft order against what players actually returned, within position:
 *
 *   picks   1-60  0.467      76-135  0.103
 *          16-75  0.250      91-150  0.108
 *          31-90  0.196     106-165  0.263
 *          46-105 0.149     121-180  0.193
 *
 * A smooth decay from pick one, a trough around 76-150, and a partial recovery
 * after that. The "rounds 7-10" figure of 0.041 was real for those band edges
 * and an artefact of choosing them — rounds 4-6 established players come out at
 * 0.010, worse still, and which band looks deadest flips between samples.
 *
 * So this range is where a line has to be drawn to gate a tag, drawn near the
 * bottom of the trough. Copy that quotes it must say "the middle rounds", never
 * "between picks 73 and 120", because the second implies an edge that is not
 * there.
 */
export const GAP_DEAD_BAND = { from: 73, to: 120 };

/** Where replacement level sits in each position's rank order. */
export const REPLACEMENT_RANK: Record<string, number> = { QB: 12, RB: 29, WR: 43, TE: 13 };

/**
 * Put a usage projection on the actual-points scale.
 *
 * The usage model is a regressed conditional expectation: its fitted values have
 * standard deviation R x sd(actual), where R is the multiple correlation. So a
 * deviation from replacement measured on the fitted scale is exactly R times the
 * real one, and dividing by R undoes it. Anchored at replacement, because the
 * player at the replacement rank is worth replacement level on either scale.
 *
 * Shared rather than duplicated because the board and the waiver wire both need
 * it and must not disagree. The wire in particular could not express value over
 * replacement at all before this existed — its own doc comment said so — which
 * is why an undrafted player had a grade but no answer to "what is he worth".
 *
 * `projections` is the population the caller is ranking, so the wire can use the
 * whole league where the board uses the board. Board WR43 sits at 107.7 against
 * the league's 109.0, so the two agree closely, but each is internally correct.
 */
/** What the conversion is made of, per position, for logging and for the receipt. */
export interface UsageScalePart {
  /** Replacement-rank projection on the usage scale. */
  usageReplacement: number;
  /** Replacement level in actual points. */
  actualReplacement: number;
  /** The multiple correlation the deviation is divided by. */
  r: number;
}

export interface UsageScale {
  /** Usage-scale points to actual points. Null when the position has no fit. */
  convert: (position: string, usagePoints: number) => number | null;
  parts: Map<string, UsageScalePart>;
}

export function buildUsageScale(
  projections: Array<{ position: string; points: number }>,
  actualReplacement: Map<string, number>,
  fits: Array<{ position: string; r2: number }>,
): UsageScale {
  const compression = new Map<string, number>();
  for (const f of fits) {
    // R, not R². Clamped so a model explaining almost nothing cannot multiply
    // its own noise by an arbitrarily large factor.
    compression.set(f.position, Math.min(1, Math.max(0.45, Math.sqrt(Math.max(0, f.r2)))));
  }

  const usageReplacement = new Map<string, number>();
  for (const position of Object.keys(REPLACEMENT_RANK)) {
    const ranked = projections
      .filter((p) => p.position === position && Number.isFinite(p.points))
      .map((p) => p.points)
      .sort((a, b) => b - a);
    if (!ranked.length) continue;
    const rank = Math.min(REPLACEMENT_RANK[position]!, ranked.length) - 1;
    usageReplacement.set(position, ranked[rank]!);
  }

  const parts = new Map<string, UsageScalePart>();
  for (const position of Object.keys(REPLACEMENT_RANK)) {
    const uRepl = usageReplacement.get(position);
    const aRepl = actualReplacement.get(position);
    const r = compression.get(position);
    if (uRepl === undefined || aRepl === undefined || r === undefined) continue;
    parts.set(position, { usageReplacement: uRepl, actualReplacement: aRepl, r });
  }

  return {
    convert: (position, usagePoints) => {
      const p = parts.get(position);
      return p === undefined ? null : p.actualReplacement + (usagePoints - p.usageReplacement) / p.r;
    },
    parts,
  };
}

/**
 * One line of the arithmetic that produced a player's VALUE.
 *
 * The board's headline number is the end of a chain — a market read, a usage
 * model, a scale conversion, a shrinkage, a subtraction — and until now the page
 * showed only the answer. A reader who disagrees with +57 has nothing to point
 * at. Each step carries what it did, what it did it to, and why, so the
 * disagreement can land on the actual assumption rather than on the total.
 *
 * `running` is the number after this step, so the column reads downward like a
 * receipt.
 */
export interface DerivationStep {
  label: string;
  /** The quantity this step introduced, where that makes sense. */
  value: number | null;
  /** The projection after applying it. */
  running: number | null;
  /** Plain-English explanation, including the arithmetic. */
  detail: string;
  /**
   * `availability` is its own kind rather than another `shrink` because the
   * audit has to be able to find it. It is the one step that must be a pure
   * multiplication on the actual-points scale, and a check cannot assert that
   * about a step it can only identify by its label.
   */
  kind: 'market' | 'usage' | 'blend' | 'scale' | 'availability' | 'shrink' | 'replacement' | 'result';
  /** For the usage step: which inputs produced it. */
  inputs?: Array<{ label: string; value: number; contribution: number; average: number }>;
}

export interface BlendInput {
  marketPoints: number | null;
  usagePoints: number | null;
  /** Distribution of each signal within this position, for scale matching. */
  marketMean: number;
  marketSd: number;
  usageMean: number;
  usageSd: number;
  marketWeight?: number;
}

export interface BlendResult {
  points: number;
  marketZ: number | null;
  usageZ: number | null;
  marketWeight: number;
  usageWeight: number;
  /** Which signal drove the result, in standard deviations. */
  disagreement: number | null;
}

/**
 * Blends in standard-deviation space, then maps back onto the market's scale.
 *
 * Averaging the two point totals directly would be wrong: the usage model has
 * R² near 0.55, so its fitted totals are shrunk toward the positional mean and
 * an elite player's usage number sits well below what he will score. Averaging
 * raw points would drag every star down by construction. Standardising first
 * compares each signal against its own distribution — where a player ranks
 * within that signal — and rebuilding on the market's scale keeps the output in
 * units that mean something.
 */
export function blend(input: BlendInput): BlendResult {
  const w = input.marketWeight ?? DEFAULT_MARKET_WEIGHT;

  const marketZ =
    input.marketPoints !== null && input.marketSd > 0
      ? (input.marketPoints - input.marketMean) / input.marketSd
      : null;
  const usageZ =
    input.usagePoints !== null && input.usageSd > 0
      ? (input.usagePoints - input.usageMean) / input.usageSd
      : null;

  // A missing signal hands its weight to the other rather than counting as zero.
  let z: number;
  let marketWeight: number;
  let usageWeight: number;
  if (marketZ !== null && usageZ !== null) {
    marketWeight = w;
    usageWeight = 1 - w;
    z = marketZ * marketWeight + usageZ * usageWeight;
  } else if (marketZ !== null) {
    marketWeight = 1;
    usageWeight = 0;
    z = marketZ;
  } else if (usageZ !== null) {
    /*
     * Usage-only players keep the usage projection in its own units rather than
     * being mapped onto the market's scale.
     *
     * The market distribution is built from players with complete prop
     * coverage, which is a self-selecting elite — RB market mean 230 against a
     * usage mean of 134 across the full pool. Standardising one onto the other
     * lifted every uncovered player by roughly forty points and made a dozen
     * backups look like steals.
     */
    return {
      points: input.usagePoints!,
      marketZ: null,
      usageZ,
      marketWeight: 0,
      usageWeight: 1,
      disagreement: null,
    };
  } else {
    return {
      points: NaN, marketZ: null, usageZ: null,
      marketWeight: 0, usageWeight: 0, disagreement: null,
    };
  }

  return {
    points: input.marketMean + z * input.marketSd,
    marketZ,
    usageZ,
    marketWeight,
    usageWeight,
    disagreement: marketZ !== null && usageZ !== null ? usageZ - marketZ : null,
  };
}

export interface Distribution {
  mean: number;
  sd: number;
}

/** Mean and spread of a signal within one position. */
export function distributionOf(values: number[]): Distribution {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return { mean: clean[0] ?? 0, sd: 0 };
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const sd = Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1));
  return { mean, sd };
}

/**
 * Plain-language read on a player, from where the two signals sit and how far
 * apart they are. This is the line the board shows.
 */
export type Tone = 'gem' | 'solid' | 'caution' | 'bust' | 'unknown';

export function verdict(
  slotGap: number | null,
  disagreement: number | null,
  source: 'both' | 'market-only' | 'usage-only' = 'both',
  vorp: number | null = null,
  /** Share of his team's prior volume that has left the roster. */
  opportunity = 0,
): { label: string; tone: Tone } {
  if (slotGap === null) return { label: 'no read', tone: 'unknown' };

  /*
   * Beating the baseline at your draft slot is not the same as being worth a
   * roster spot.
   *
   * Deep in the draft the historical return is deeply negative, so almost
   * anything clears it. Jordan Love projects 266 points against a replacement
   * quarterback of 296 — thirty points worse than a man available for nothing —
   * yet cleared the pick-148 baseline by 45 and showed a +59 gap. That is a
   * true statement about price and a useless one about whether to draft him.
   *
   * A player below replacement cannot be a gem however cheap he is, so the
   * verdict says what he is instead.
   */
  if (vorp !== null && vorp < 0) {
    /*
     * Below replacement is the normal state of a late pick, so on its own it
     * says nothing useful — of course the 140th player is worse than the 43rd
     * receiver.
     *
     * This used to split on vacated volume, calling a player with 35%+ open in
     * front of him "speculative — volume open" AND giving him the gem tone. That
     * is now measured to be unsupported: across 1,117 incumbent seasons the
     * share of a vacancy that reaches the man behind it is −0.022 for the first
     * receiver in line and −0.027 for the first back, neither within two
     * standard errors of zero. Teams sign and draft replacements instead of
     * promoting, so a big vacancy in front of a bench player is not a path.
     *
     * The vacancy still gets said — it belongs on the page as a widened range —
     * but it no longer upgrades the verdict, and it certainly no longer earns
     * the tone reserved for a bargain.
     */
    if (opportunity >= 0.2) {
      return { label: 'bench flier, volume open, but nobody is owed it', tone: 'caution' };
    }
    if (vorp < -25) return { label: 'no path', tone: 'caution' };
    return { label: 'streamable', tone: 'caution' };
  }

  // Each verdict names which evidence it rests on, so a read built on one
  // signal is never mistaken for one confirmed by both.
  if (source === 'usage-only') {
    if (slotGap > 15) return { label: 'cheap, role says yes', tone: 'solid' };
    if (slotGap < -15) return { label: 'pricey, role says no', tone: 'caution' };
    return { label: 'fair, role only', tone: 'solid' };
  }

  if (disagreement === null) {
    if (slotGap > 15) return { label: 'cheap, market only', tone: 'solid' };
    if (slotGap < -15) return { label: 'pricey, market only', tone: 'caution' };
    return { label: 'fair, market only', tone: 'solid' };
  }

  const cheap = slotGap > 15;
  const expensive = slotGap < -15;

  /*
   * Bands are contiguous so nothing falls between them. An earlier version left
   * a gap either side of −0.4 to −0.75, which labelled a player with a +70 slot
   * gap "fairly priced" purely because his disagreement landed in the hole.
   */
  if (cheap) {
    if (disagreement > 0.75) return { label: 'gem', tone: 'gem' };
    if (disagreement > -0.4) return { label: 'good value', tone: 'solid' };
    if (disagreement > -0.75) return { label: 'cheap, role unproven', tone: 'caution' };
    return { label: 'cheap for a reason', tone: 'caution' };
  }

  if (expensive) {
    if (disagreement < -0.75) return { label: 'bust risk', tone: 'bust' };
    if (disagreement < -0.4) return { label: 'overpriced', tone: 'caution' };
    if (disagreement > 0.75) return { label: 'pricey but earned', tone: 'solid' };
    return { label: 'overpriced', tone: 'caution' };
  }

  if (disagreement > 0.75) return { label: 'usage ahead of price', tone: 'solid' };
  if (disagreement < -0.75) return { label: 'usage warning', tone: 'caution' };
  return { label: 'fairly priced', tone: 'solid' };
}
