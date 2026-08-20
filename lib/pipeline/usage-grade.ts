import { sqlite } from '../db/index';
import { currentSeasonWeight } from './blend';

/**
 * The usage signal: a forward projection built from on-field opportunity,
 * standing beside the market rather than inside it.
 *
 * Weights are not chosen by feel. Each candidate metric was correlated against
 * the *following* season's points (scripts/calibrate-usage.ts), and only those
 * that carry forward are used:
 *
 *   WR   target share .71  air yards share .67  pass-snap share .63
 *        red-zone touch share .63  red-zone targets .63  goal-line share .47
 *   RB   rush share .72  red-zone touch share .72  goal-line share .67
 *        pass-snap share .65  red-zone carries .67  target share .62
 *   TE   target share .76  air yards share .75  pass-snap share .70
 *        red-zone targets .64  red-zone touch share .63  goal-line share .49
 *
 * Scoring opportunity earns its place: red-zone touch share matches rush share
 * as the single best RB predictor. Note the ordering within it — *chances*
 * predict better than *conversions*. Red-zone touch share (.72) beats total
 * touchdowns (.63) for RBs, because who a coach feeds near the goal line
 * persists while the scoring itself carries a lot of luck. So the models take
 * the opportunity and leave the touchdown totals out.
 *
 * Deliberately excluded, having measured near zero: aDOT (.11/.02/.15) and
 * yards after catch per reception (.01/.11/.09). Both describe the season they
 * came from and predict nothing about the next one. Rushing yards before and
 * after contact were dropped for the same reason (.14/.15).
 */

export interface UsagePredictor {
  column: string;
  label: string;
}

/**
 * Predictors per position, chosen to limit overlap. Target share and air-yards
 * share correlate heavily with each other, so only one of the pair carries the
 * receiving-volume load and pass-snap share supplies the independent part.
 */
/**
 * The projection used to see only shares and age — how OFTEN a player touched
 * the ball, never what happened when he did or whose offence it happened in.
 *
 * The additions below were chosen by leave-one-season-out cross validation
 * (`npm run calibrate:model`), not by partial correlation and not by in-sample
 * fit. That distinction is the whole point: in-sample R² rises every time a
 * column is added whether it helps or not, and a metric can carry genuine
 * independent information yet still fail to improve a regression that already
 * has correlated predictors. A feature earns a place here only by improving a
 * season the fit never saw.
 *
 *   WR  .529 -> .584   MAE 38.8 -> 36.6   + first downs per game, team points
 *   RB  .463 -> .483   MAE 49.6 -> 48.2   + first downs per game, team points
 *   TE  .545 -> .555   MAE 25.7 -> 25.3   + first downs per game
 *   QB  .181 -> .299   MAE 90.8 -> 82.6   + QB EPA per dropback
 *
 * Coverage was the second criterion and it eliminated more candidates than fit
 * did. Yards per route, EPA per touch and first-down RATE all carry real signal
 * and all have qualifying thresholds, so adding them drops 60-180 players per
 * position — and the players they drop are the low-volume ones nobody else is
 * projecting either, which is exactly where this tool is supposed to help. Every
 * predictor below exists for the entire graded pool.
 *
 * Quarterbacks gain the most by far. The position's usage model was the weakest
 * in the project at R²=0.18; what his offence does per dropback nearly doubles
 * it. That is the single largest improvement measured here.
 *
 * KNOWN LIMIT: the environment terms describe the offence a player was IN during
 * each measured season, joined on that season's team. For a player who has since
 * moved, that is last year's environment attached to this year's projection —
 * the stale-fact family (#14, #29). It is correct for the ~90% who stayed and
 * wrong for the movers, and fixing it properly means projecting the new team's
 * offence rather than reusing the old one's result.
 */
export const PREDICTORS: Record<string, UsagePredictor[]> = {
  WR: [
    { column: 'target_share', label: 'target share' },
    { column: 'pass_snap_share', label: 'route share' },
    { column: 'rz_touch_share', label: 'red-zone share' },
    { column: 'goal_line_share', label: 'goal-line share' },
    { column: 'age', label: 'age' },
    { column: 'first_downs_per_game', label: 'first downs per game' },
    { column: 'team_points', label: 'team points scored' },
  ],
  TE: [
    { column: 'target_share', label: 'target share' },
    { column: 'pass_snap_share', label: 'route share' },
    { column: 'rz_touch_share', label: 'red-zone share' },
    { column: 'goal_line_share', label: 'goal-line share' },
    { column: 'age', label: 'age' },
    { column: 'first_downs_per_game', label: 'first downs per game' },
  ],
  RB: [
    { column: 'rush_share', label: 'rush share' },
    { column: 'target_share', label: 'target share' },
    { column: 'rz_touch_share', label: 'red-zone share' },
    { column: 'goal_line_share', label: 'goal-line share' },
    { column: 'age', label: 'age' },
    { column: 'first_downs_per_game', label: 'first downs per game' },
    { column: 'team_points', label: 'team points scored' },
  ],
  /*
   * Quarterbacks had no model at all, so all 26 on the board carried a blank
   * usage grade and were priced on the market alone. There were 240 usage rows
   * sitting unused.
   *
   * The predictors are not the receiving set. Target share is ~0 for every
   * quarterback by definition and carries no information about them, so it is
   * excluded rather than left in to read as "no role". What remains is the set
   * that actually separates quarterbacks from each other:
   *
   *   pass-snap share — the share of his team's dropbacks he was on the field
   *     for. For this position that is simply "is he the starter", which is the
   *     single largest fact about a quarterback's fantasy season, and it is the
   *     one thing a backup's row makes obvious.
   *   rush share, red-zone share, goal-line share — rushing volume is what
   *     separates quarterbacks who finish top five from those who throw for the
   *     same yardage and finish twelfth. Goal-line carries are the sneak.
   */
  /*
   * ... and what his offence produces per dropback, which turns out to matter
   * more than any of it. Adding `qb_epa` alone takes out-of-sample R² from 0.181
   * to 0.299 and cuts mean error by 8 points — the largest single gain measured
   * anywhere in this project. First downs per game were tested here too and made
   * it slightly WORSE (-0.004), which is why quarterbacks do not get them: a
   * quarterback's first downs are his team's, so the term is already inside
   * starter share.
   */
  QB: [
    { column: 'pass_snap_share', label: 'starter share' },
    { column: 'rush_share', label: 'rush share' },
    { column: 'qb_epa', label: 'offence EPA per dropback' },
    { column: 'rz_touch_share', label: 'red-zone share' },
    { column: 'goal_line_share', label: 'goal-line share' },
    { column: 'age', label: 'age' },
  ],
};

/**
 * Age is included and direction of travel is not, both on measurement.
 *
 * After removing a player's current role, year-over-year *change* correlates
 * with next season at 0.02 for WR target share and -0.24 for route share —
 * that is, a player who just gained ground tends to give some of it back. A
 * breakout is partly noise and regresses, so a trend term would add error.
 *
 * Age is the opposite: -0.27 for WR, -0.18 for RB, -0.14 for TE once the role
 * is accounted for. Two players with identical shares are not the same bet if
 * one is 24 and the other 37.
 *
 * The practical consequence is that a fading veteran is caught by his age and
 * by his red-zone role thinning, not by extrapolating a decline.
 */

export interface UsageFit {
  position: string;
  intercept: number;
  coefficients: number[];
  /** Predictor means and spreads, so a new player can be standardized the same way. */
  means: number[];
  sds: number[];
  /** Coefficients in standard-deviation units, directly comparable to each other. */
  standardized: number[];
  predictors: UsagePredictor[];
  n: number;
  r2: number;
}

/**
 * Ridge regression on standardized predictors.
 *
 * Plain least squares produced a *negative* coefficient on goal-line share for
 * receivers and tight ends, which cannot be right — more goal-line work does
 * not lower a projection. It is the classic symptom of overlapping predictors:
 * red-zone share and goal-line share measure much the same thing, so the fit
 * can trade one off against the other and still minimise error.
 *
 * A small ridge penalty splits the shared credit between them instead, keeping
 * the signs sane. Standardizing first means the penalty applies evenly and the
 * resulting coefficients are directly comparable — which is what makes them
 * explainable.
 */
function solve(X: number[][], y: number[], lambda = 0): number[] | null {
  const k = X[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);

  for (let i = 0; i < X.length; i++) {
    const row = X[i]!;
    for (let a = 0; a < k; a++) {
      xty[a] = xty[a]! + row[a]! * y[i]!;
      const xa = xtx[a]!;
      for (let b = 0; b < k; b++) xa[b] = xa[b]! + row[a]! * row[b]!;
    }
  }

  // Penalty on the slopes only — never on the intercept, which carries the mean.
  for (let a = 1; a < k; a++) xtx[a]![a] = xtx[a]![a]! + lambda;

  // Gauss-Jordan with partial pivoting.
  const m = xtx.map((row, i) => [...row, xty[i]!]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-10) return null;
    const tmp = m[col]!;
    m[col] = m[pivot]!;
    m[pivot] = tmp;

    const p = m[col]![col]!;
    for (let c = col; c <= k; c++) m[col]![c] = m[col]![c]! / p;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      for (let c = col; c <= k; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  return m.map((row) => row[k]!);
}

/**
 * Fits next-season points on this-season usage, per position.
 *
 * The target is deliberately the *following* season: a model fit on the same
 * season would just describe what already happened and would be useless for a
 * draft.
 */
/**
 * The predictor columns, defined once.
 *
 * The fit and the apply path read the same expressions from the same joins. Two
 * hand-written copies of this SQL is how a model ends up trained on one
 * definition of a first down and scored on another — the drift this project
 * already guards against in `lib/waiver.ts`.
 *
 * Games come from `snap_counts` appearances rather than `player_usage.games`,
 * which counts games with a stat line: a per-game rate divided by the wrong
 * denominator flatters anyone who was on the field without producing (bug #40).
 */
const USAGE_COLUMNS = `
       u.player_id, u.position, u.season, u.games,
       u.pass_snap_share, u.target_share, u.targets_per_route, u.rush_share,
       u.rz_touch_share, u.goal_line_share,
       (COALESCE(s.rush_first_downs, 0) + COALESCE(s.rec_first_downs, 0))
         / NULLIF(g.appearances, 0) AS first_downs_per_game,
       t.points_for AS team_points,
       t.qb_epa_dropback AS qb_epa`;

const USAGE_JOINS = `
       FROM player_usage u
       LEFT JOIN players p ON p.gsis_id = u.player_id
       LEFT JOIN player_scheme s ON s.player_id = u.player_id AND s.season = u.season
       LEFT JOIN team_context t ON t.season = u.season AND t.team = u.team
       LEFT JOIN (
         SELECT player_id, season, COUNT(DISTINCT week) AS appearances
         FROM snap_counts
         WHERE game_type = 'REG' AND player_id IS NOT NULL AND offense_snaps > 0
         GROUP BY player_id, season
       ) g ON g.player_id = u.player_id AND g.season = u.season`;

export function fitUsageModels(pointsBySeason: Map<string, number>): UsageFit[] {
  const rows = sqlite
    .prepare(
      `SELECT ${USAGE_COLUMNS},
              u.season - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age
       ${USAGE_JOINS}
       WHERE u.games >= 6`,
    )
    .all() as Array<Record<string, number | string | null>>;

  const fits: UsageFit[] = [];

  for (const [position, predictors] of Object.entries(PREDICTORS)) {
    const X: number[][] = [];
    const y: number[] = [];

    for (const r of rows) {
      if (String(r.position).toUpperCase() !== position) continue;
      const next = pointsBySeason.get(`${r.player_id}|${Number(r.season) + 1}`);
      if (next === undefined) continue;

      const values = predictors.map((p) => r[p.column]);
      if (values.some((v) => v === null || typeof v !== 'number' || !Number.isFinite(v))) continue;

      X.push([1, ...(values as number[])]);
      y.push(next);
    }

    if (X.length < 40) continue;

    // Standardize the slopes so the ridge penalty lands evenly on each.
    const k = predictors.length;
    const means: number[] = [];
    const sds: number[] = [];
    for (let j = 0; j < k; j++) {
      const col = X.map((row) => row[j + 1]!);
      const mean = col.reduce((a, b) => a + b, 0) / col.length;
      const sd = Math.sqrt(col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length) || 1;
      means.push(mean);
      sds.push(sd);
    }
    const Z = X.map((row) => [1, ...row.slice(1).map((v, j) => (v - means[j]!) / sds[j]!)]);

    const beta = solve(Z, y, 0.05 * X.length);
    if (!beta) continue;

    // Back to raw units so the model can be applied to a player's actual shares.
    const standardized = beta.slice(1);
    const coefficients = standardized.map((b, j) => b / sds[j]!);
    const intercept = beta[0]! - coefficients.reduce((a, b, j) => a + b * means[j]!, 0);

    const meanY = y.reduce((a, b) => a + b, 0) / y.length;
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < X.length; i++) {
      const pred = intercept + X[i]!.slice(1).reduce((a, v, j) => a + v * coefficients[j]!, 0);
      ssRes += (y[i]! - pred) ** 2;
      ssTot += (y[i]! - meanY) ** 2;
    }

    fits.push({
      position,
      intercept,
      coefficients,
      means,
      sds,
      standardized,
      predictors,
      n: X.length,
      r2: ssTot ? 1 - ssRes / ssTot : 0,
    });
  }

  return fits;
}

/**
 * Which season's usage the projection should read, and how live it is.
 *
 * Shared so the draft board and the waiver wire cannot disagree about whether
 * the season has started. Both need the same two guards: games must have been
 * played, and `ingest:usage` must actually have written rows for the season —
 * otherwise a season that has kicked off without an ingest would project from
 * nothing instead of falling back to last year.
 */
export function resolveUsageSeason(season: number): {
  live: boolean;
  usageSeason: number;
  week: number;
} {
  const week = (
    sqlite
      .prepare(
        `SELECT COALESCE(MAX(week), 0) AS w FROM player_stats_week
         WHERE season = ? AND season_type = 'REG'`,
      )
      .get(season) as { w: number }
  ).w;

  const rows = (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM player_usage WHERE season = ?`).get(season) as {
      n: number;
    }
  ).n;

  const live = week > 0 && rows > 0;
  return { live, usageSeason: live ? season : season - 1, week };
}

export interface UsageProjection {
  playerId: string;
  position: string;
  season: number;
  /**
   * Fitted points. Read as a conditional expectation, not a projection to set
   * against the market's number directly: with R² near 0.53 this regresses
   * hard toward the positional mean, so an elite player's fitted total lands
   * well below what he will actually score. Compare `grade` instead.
   */
  points: number;
  /** Percentile of that projection within the position, 0-100. */
  grade: number;
  /**
   * Each predictor, what he measured on it, and how many points it contributed.
   *
   * `contribution` is the coefficient times the value — the actual number of
   * points that term added to his projection. Without it the panel can say "his
   * target share is 24%" but not "which is worth 31 points of this number",
   * which is the only form a reader can argue with.
   */
  inputs: Array<{
    label: string; value: number; coefficient: number;
    /** Points this fact moves him against the average player at his position. */
    contribution: number;
    /** That positional average, so the comparison is visible. */
    average: number;
  }>;
}

/**
 * Recency weights for blending a player's recent seasons.
 *
 * A single-season snapshot cannot tell a rising player from a fading one. Both
 * show the same shares this year; only the direction differs. Travis Kelce
 * still ran 86% of routes in 2025 while his red-zone targets fell from 30 to
 * 13 — a one-year view grades that as a healthy role.
 *
 * The most recent season dominates, but the two before it pull a player toward
 * or away from where he has been trending.
 */
const RECENCY = [0.6, 0.28, 0.12];

/**
 * Seasons are also weighted by how much of one the player actually played.
 *
 * Tucker Kraft's 2025 shares come from eight games; a full seventeen carries
 * more information than half a season and should count for more. Combined with
 * recency this shrinks a short breakout toward what the player has shown over
 * a longer run, which is the right treatment given that recent gains regress.
 */
const FULL_SEASON_GAMES = 17;

/**
 * An in-progress season is weighted on a different curve from a completed one.
 *
 * `games / 17` is the right shrink when comparing two finished seasons: eight
 * games of 2024 really do carry less than seventeen games of 2025. Applied to
 * the season currently being played it is badly wrong. Six games into a year it
 * would give the current season 0.6 × 6/17 = 0.21 against the prior season's
 * 0.28 — so the tool would still be describing last year in November.
 *
 * The measured crossover is far earlier than that. Predicting rest-of-season
 * points from opportunity, season-to-date passes the prior season after two
 * games (0.702 against 0.659) and keeps pulling away. `currentSeasonWeight`
 * tracks it with g/(g+1.5), which is the curve `calibrate-inseason.ts` fitted.
 *
 * That helper existed and was only ever used to print a log line claiming this
 * season carried most of the signal, while every projection ran on last season
 * alone. This is where the claim is made true.
 */

/**
 * Applies a fitted model to a recency-weighted blend of recent usage.
 *
 * `inProgressSeason` names the season currently being played, if any. Its usage
 * row is partial, so it is weighted by the in-season curve rather than by the
 * share of a full season it represents.
 */
export function projectUsage(
  fits: UsageFit[],
  season: number,
  lookback = 3,
  inProgressSeason: number | null = null,
): UsageProjection[] {
  const byPosition = new Map(fits.map((f) => [f.position, f]));

  const rows = sqlite
    .prepare(
      `SELECT ${USAGE_COLUMNS},
              ? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age
       ${USAGE_JOINS}
       WHERE u.season > ? AND u.season <= ?
         -- Four games is the right floor for a finished season, and impossible
         -- in September. The season being played is admitted on any sample and
         -- carries only the weight the in-season curve gives it.
         AND (u.games >= 4 OR u.season = ?)
       ORDER BY u.season DESC`,
    )
    .all(season + 1, season - lookback, season, inProgressSeason ?? -1) as Array<
    Record<string, number | string | null>
  >;

  // Group by player, most recent season first.
  const byPlayer = new Map<string, Array<Record<string, number | string | null>>>();
  for (const r of rows) {
    const id = String(r.player_id);
    const list = byPlayer.get(id) ?? [];
    list.push(r);
    byPlayer.set(id, list);
  }

  const out: UsageProjection[] = [];
  for (const [playerId, seasons] of byPlayer) {
    // A player must appear in the most recent season — an old role is not a
    // current one, however good it was.
    const latest = seasons[0]!;
    if (Number(latest.season) !== season) continue;

    const position = String(latest.position).toUpperCase();
    const fit = byPosition.get(position);
    if (!fit) continue;

    /*
     * Season weights, fixed once per player rather than per predictor.
     *
     * When the newest row is the season being played, it takes the calibrated
     * in-season share g/(g+1.5) and the remainder is split across the completed
     * seasons behind it in RECENCY proportion. Otherwise every season is a
     * finished one and the original rule applies — recency times the share of a
     * full season it covers.
     */
    const live =
      inProgressSeason !== null && Number(latest.season) === inProgressSeason;
    const seasonWeights = seasons.slice(0, RECENCY.length).map((s, i) => {
      const games = Math.min(Number(s.games) || 0, FULL_SEASON_GAMES);
      if (live) {
        if (i === 0) return currentSeasonWeight(games);
        const priorShare = 1 - currentSeasonWeight(Math.min(Number(latest.games) || 0, FULL_SEASON_GAMES));
        const priorTotal = RECENCY.slice(1).reduce((a, b) => a + b, 0);
        return priorTotal ? priorShare * (RECENCY[i]! / priorTotal) * (games / FULL_SEASON_GAMES) : 0;
      }
      return RECENCY[i]! * (games / FULL_SEASON_GAMES);
    });

    // Weighted blend of each predictor across the seasons available, with the
    // weights renormalised so a player with only one season is not penalised.
    const nums: number[] = [];
    let usable = true;
    for (const p of fit.predictors) {
      let sum = 0;
      let weight = 0;
      seasons.slice(0, RECENCY.length).forEach((s, i) => {
        const v = s[p.column];
        if (v === null || typeof v !== 'number' || !Number.isFinite(v)) return;
        // Age is a fact about the player, not a per-season measurement, so it
        // is never averaged across seasons.
        if (p.column === 'age') {
          if (i === 0) {
            sum += v;
            weight += 1;
          }
          return;
        }
        const w = seasonWeights[i]!;
        if (w <= 0) return;
        sum += v * w;
        weight += w;
      });
      if (!weight) {
        usable = false;
        break;
      }
      nums.push(sum / weight);
    }
    if (!usable) continue;

    const r = latest;
    const points = fit.intercept + nums.reduce((a, v, i) => a + v * fit.coefficients[i]!, 0);

    out.push({
      playerId: String(r.player_id),
      position,
      season: Number(r.season),
      points: Math.max(0, points),
      grade: 0,
      inputs: fit.predictors.map((p, i) => ({
        label: p.label,
        value: nums[i]!,
        coefficient: fit.coefficients[i]!,
        /*
         * Centred on the positional mean, not the raw product.
         *
         * `value x coefficient` is arithmetically part of the fit but is
         * nonsense to read: age has a negative weight and is never near zero, so
         * a 24-year-old back showed "age: -118 points" — a number the intercept
         * immediately cancels. What a reader wants is how far THIS fact moves
         * him against a typical player at his position, which is the deviation
         * from the mean times the weight. Those sum to his distance from the
         * average projection, which is the quantity actually being explained.
         */
        contribution: (nums[i]! - fit.means[i]!) * fit.coefficients[i]!,
        average: fit.means[i]!,
      })),
    });
  }

  // Grade is a within-position percentile, which is what makes it readable
  // next to a slot gap.
  for (const position of Object.keys(PREDICTORS)) {
    const group = out.filter((o) => o.position === position).sort((a, b) => a.points - b.points);
    group.forEach((o, i) => {
      o.grade = group.length > 1 ? Math.round((i / (group.length - 1)) * 100) : 50;
    });
  }

  return out;
}
