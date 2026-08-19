import { sqlite } from '../db/index';

/**
 * The two things VALUE cannot say.
 *
 * VALUE is points above the freely available player at a position. It is
 * correctly built and it answers exactly one question, and measured against what
 * players went on to return it stops discriminating after round three — rho
 * 0.268 in rounds 1-3, then 0.080, 0.058, 0.217 by band. Two quantities are
 * missing, and they are missing for different reasons.
 *
 * 1. SCARCITY (`vona`). VALUE compares a player to a free replacement. A drafter
 *    is choosing among the players still on the board, so what decides the pick
 *    is the drop to the next man at the same position when his turn comes round
 *    again. That shape differs enormously by position — mean points by
 *    within-position finish, 2022-2025:
 *
 *        rank      QB    RB    WR    TE
 *           1     401   345   323   229
 *          12     272   215   199   119
 *          24     166   170   170    86
 *          43      54   101   125    46
 *
 *    Quarterback falls off a cliff after twelve; receiver is nearly flat from
 *    twelve to forty-three. One replacement line cannot express that, and it is
 *    the whole of "take the back now or wait".
 *
 * 2. STARTABLE WEEKS (`startableRate`). A season total hides how a weekly league
 *    is actually played. Among backs finishing 130-170 points the share of weeks
 *    spent startable runs from 90% to 24%.
 *
 *    BUT — and this decided how it is built — that spread is NOT predictable.
 *    `calibrate:startable`, 1,782 season pairs: startable rate repeats at r 0.68,
 *    but points per game repeats at 0.76 and DOMINATES it. The partial of rate
 *    against next season after points per game is −0.029 (WR), 0.056 (RB), 0.035
 *    (TE), 0.142 (QB) — nothing. Only 4-5% of players sit more than 15 points of
 *    rate away from what their scoring level implies.
 *
 *    So startable rate is a RE-EXPRESSION of points per game, not a second
 *    opinion, and it must never be blended into a projection or treated as a
 *    signal — that is precisely the mistake the advanced-metrics work exists to
 *    prevent. What it is good for is UNITS: turning "150 points" into "startable
 *    in about 55% of weeks" states the same forecast in the terms the league is
 *    played in, and lets two positions be compared in starter slots rather than
 *    in raw points. It is labelled as a restatement everywhere it appears.
 */

/** Weekly starters this league actually uses, by position. */
const STARTERS: Record<string, number> = { QB: 12, RB: 24, WR: 36, TE: 12 };
const MIN_GAMES = 8;

export interface StartableCurve {
  position: string;
  intercept: number;
  slope: number;
  n: number;
  /** How much of the rate the scoring level explains. High is the point. */
  r2: number;
}

/**
 * Fits startable rate on points per game, per position, from completed seasons.
 *
 * Refitted from the data rather than hard-coded so it tracks scoring changes —
 * and so the relationship it asserts can be checked rather than believed.
 */
export function fitStartableCurves(fromSeason = 2018, toSeason = 2025): Map<string, StartableCurve> {
  const weeks = sqlite
    .prepare(
      `SELECT s.player_id pid, s.season, s.week, s.fantasy_points_half p, pl.position pos
       FROM player_stats_week s
       JOIN players pl ON pl.gsis_id = s.player_id
       WHERE s.season_type='REG' AND s.season BETWEEN ? AND ?
         AND pl.position IN ('QB','RB','WR','TE')`,
    )
    .all(fromSeason, toSeason) as Array<{ pid: string; season: number; week: number; p: number; pos: string }>;

  // The bar is that week's actual scoring — a fixed points cutoff would be
  // measuring the schedule rather than the player.
  const byWeek = new Map<string, number[]>();
  for (const w of weeks) {
    const k = `${w.season}|${w.week}|${w.pos}`;
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k)!.push(w.p);
  }
  const bar = new Map<string, number>();
  for (const [k, list] of byWeek) {
    const pos = k.split('|')[2]!;
    const n = STARTERS[pos] ?? 24;
    const sorted = [...list].sort((a, b) => b - a);
    bar.set(k, sorted[Math.min(n, sorted.length) - 1] ?? 0);
  }

  const acc = new Map<string, { pos: string; games: number; startable: number; points: number }>();
  for (const w of weeks) {
    const k = `${w.pid}|${w.season}`;
    let e = acc.get(k);
    if (!e) { e = { pos: w.pos, games: 0, startable: 0, points: 0 }; acc.set(k, e); }
    e.games++;
    e.points += w.p;
    if (w.p >= (bar.get(`${w.season}|${w.week}|${w.pos}`) ?? 0)) e.startable++;
  }

  /*
   * Both sides of the fit are per SEASON WEEK, not per game played.
   *
   * The first version divided by games played on both sides, which is the
   * cleaner behavioural relationship — and it could not be applied. The
   * projection it gets fed is a season total that already accounts for missed
   * time, so dividing THAT by expected games charges the absence twice: Malik
   * Willis came out at 223 points over 4.3 expected games, 51 points a game, and
   * a 100% startable rate — a backup reading as more reliable than Josh Allen at
   * 59%. Anything that ranks Willis over Allen on availability has the
   * arithmetic backwards.
   *
   * Per season week is consistent for everyone, needs no assumption about what
   * the projection embeds, and means the more useful thing anyway: a week missed
   * is a week he was not startable, which is exactly how it feels to the manager
   * holding him.
   */
  const SEASON_WEEKS = 17;

  const out = new Map<string, StartableCurve>();
  for (const position of Object.keys(STARTERS)) {
    const g = [...acc.values()].filter((e) => e.pos === position && e.games >= MIN_GAMES);
    if (g.length < 40) continue;
    const x = g.map((e) => e.points / SEASON_WEEKS);
    const y = g.map((e) => e.startable / SEASON_WEEKS);
    const mx = x.reduce((a, b) => a + b, 0) / x.length;
    const my = y.reduce((a, b) => a + b, 0) / y.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < x.length; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const intercept = my - slope * mx;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < x.length; i++) {
      ssRes += (y[i]! - (intercept + slope * x[i]!)) ** 2;
      ssTot += (y[i]! - my) ** 2;
    }
    out.set(position, { position, intercept, slope, n: g.length, r2: ssTot ? 1 - ssRes / ssTot : 0 });
  }
  return out;
}

/**
 * Expected share of his games spent as a startable option, from the projection.
 *
 * A restatement of the projection in weekly units, never an independent input.
 * Clamped because a straight line has to be told where the ends are.
 */
export function startableRate(
  curves: Map<string, StartableCurve>,
  position: string,
  projectedPoints: number,
): number | null {
  const c = curves.get(position);
  if (!c) return null;
  // Per season week, matching the fit. NOT per game played — see the note there.
  return Math.max(0, Math.min(1, c.intercept + c.slope * (projectedPoints / 17)));
}

export interface ScarcityRow {
  playerId: string;
  position: string;
  adp: number;
  points: number;
  /**
   * Points he is worth over the best player at his position expected to survive
   * until the drafter's next turn. Null when nobody at his position is left.
   */
  vona: number | null;
  /** The same, over one round rather than a full snake turn. */
  vonaRound: number | null;
  /** The immediate next man at his position by ADP, and the drop to him. */
  nextName: string | null;
  dropToNext: number | null;
}

/**
 * The snake round-trip, in picks.
 *
 * In a 12-team snake the gap between a drafter's consecutive picks averages 24 —
 * it runs from 2 at the turn to 22 at the wall, and 24 is what a pick in the
 * middle of a round waits. This is the horizon the decision is actually made
 * over, so it is the default; `vonaRound` exposes the one-round view beside it
 * because a drafter at the turn faces a different question from one at the wall.
 */
const SNAKE_TURN = 24;
const ONE_ROUND = 12;

/**
 * Value over next available, per player.
 *
 * `points` must be on one scale across positions — the blended projection, not
 * VORP, because VORP has already subtracted a different constant per position
 * and the drop to the next man is a difference within one position anyway.
 */
export function buildScarcity(
  rows: Array<{ playerId: string; name: string; position: string; adp: number; points: number }>,
): Map<string, ScarcityRow> {
  const out = new Map<string, ScarcityRow>();
  const byPosition = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byPosition.has(r.position)) byPosition.set(r.position, []);
    byPosition.get(r.position)!.push(r);
  }

  for (const [position, group] of byPosition) {
    const sorted = [...group].sort((a, b) => a.adp - b.adp);
    for (const r of sorted) {
      /*
       * Who is still there when the pick comes round again: everyone at this
       * position going later than his ADP plus the horizon. The best of THOSE is
       * the real alternative — not the next name on the list, because a drafter
       * does not have to take them in ADP order.
       */
      const bestAfter = (horizon: number): number | null => {
        const left = sorted.filter((x) => x.adp > r.adp + horizon);
        if (!left.length) return null;
        return Math.max(...left.map((x) => x.points));
      };
      const turn = bestAfter(SNAKE_TURN);
      const round = bestAfter(ONE_ROUND);
      const next = sorted.find((x) => x.adp > r.adp) ?? null;

      out.set(r.playerId, {
        playerId: r.playerId,
        position,
        adp: r.adp,
        points: r.points,
        vona: turn === null ? null : r.points - turn,
        vonaRound: round === null ? null : r.points - round,
        nextName: next?.name ?? null,
        dropToNext: next ? r.points - next.points : null,
      });
    }
  }
  return out;
}
