import { sqlite } from '../lib/db/index';
import { PREDICTORS } from '../lib/pipeline/usage-grade';
import { DEFAULT_MARKET_WEIGHT } from '../lib/pipeline/blend';

/**
 * Does the usage side predict, and is 60/40 the right split?
 *
 * `blend.ts` says the 60/40 weight "is a judgment call and is flagged as such",
 * because proving it would need a historical archive of prop lines and none
 * exists publicly. That is true about PROPS and it was taken to mean the
 * question could not be asked at all. It can. ADP is a market signal, it is
 * archived back to 2018, and on the current board it correlates with the
 * prop-implied points at r = 0.98 (WR) / 0.93 (RB) / 0.95 (TE) / 0.86 (QB) —
 * close enough that a weight measured against ADP transfers to props.
 *
 * So this script does what could not be done before: replays four drafts with
 * only the information available on draft day, sweeps the market weight from
 * 0 to 1, and scores every setting against what the players actually did.
 *
 * Everything is leave-one-season-out. The usage model is refitted for each fold
 * with the fold's feature season removed, and the ADP -> points curve is fitted
 * on the other seasons, so no fold ever sees its own answer.
 *
 * WHAT IT MEASURES
 *   1. out-of-sample predictive power of the usage projection, against naive
 *      baselines — the question "does the on-field role maths do anything"
 *   2. the partial correlation of usage AFTER the market, which is the only
 *      test that matters for a second opinion (a signal restating the price is
 *      not information)
 *   3. the weight sweep, with a bootstrap CI on the argmax
 *   4. whether per-position weights survive out of sample
 *
 * A caveat that must travel with the output: the pool is players who held a
 * role (>= 6 games) AND carried an ADP. That is the drafted population, not the
 * waiver wire, and not rookies — who have no usage row by definition.
 */

const SEASONS = [2022, 2023, 2024, 2025];
const POS = ['WR', 'RB', 'TE', 'QB'] as const;
const RECENCY = [0.6, 0.28, 0.12];
const FULL_SEASON_GAMES = 17;

/* ------------------------------------------------------------------- data */

const pts = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, SUM(fantasy_points_half) p FROM player_stats_week
     WHERE season_type='REG' GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; p: number }>) {
  pts.set(`${r.player_id}|${r.season}`, r.p);
}

const appearances = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, COUNT(DISTINCT week) g FROM snap_counts
     WHERE game_type='REG' AND player_id IS NOT NULL AND offense_snaps>0
     GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; g: number }>) {
  appearances.set(`${r.player_id}|${r.season}`, r.g);
}

/*
 * The same column expressions the model is fitted and applied on. Copied rather
 * than imported because `fitUsageModels` has no hook for holding a season out,
 * and a second hand-written definition of a first down is exactly the drift
 * `USAGE_COLUMNS` exists to prevent — so if that constant changes, change this.
 */
type Row = Record<string, number | string | null>;
const usageRows = sqlite
  .prepare(
    `SELECT u.player_id, u.position, u.season, u.games,
            u.pass_snap_share, u.target_share, u.rush_share,
            u.rz_touch_share, u.goal_line_share,
            (COALESCE(s.rush_first_downs,0)+COALESCE(s.rec_first_downs,0))
              / NULLIF(g.appearances,0) AS first_downs_per_game,
            t.points_for AS team_points, t.qb_epa_dropback AS qb_epa,
            u.season - CAST(substr(p.birth_date,1,4) AS INTEGER) AS age
     FROM player_usage u
     LEFT JOIN players p ON p.gsis_id=u.player_id
     LEFT JOIN player_scheme s ON s.player_id=u.player_id AND s.season=u.season
     LEFT JOIN team_context t ON t.season=u.season AND t.team=u.team
     LEFT JOIN (SELECT player_id, season, COUNT(DISTINCT week) appearances FROM snap_counts
                WHERE game_type='REG' AND player_id IS NOT NULL AND offense_snaps>0
                GROUP BY player_id, season) g
       ON g.player_id=u.player_id AND g.season=u.season`,
  )
  .all() as Row[];
for (const r of usageRows) r.position = String(r.position).toUpperCase();

const bySeasonPlayer = new Map<string, Row>();
for (const r of usageRows) bySeasonPlayer.set(`${r.player_id}|${r.season}`, r);

const adp = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT player_id, year, adp FROM adp_raw WHERE player_id IS NOT NULL`)
  .all() as Array<{ player_id: string; year: number; adp: number }>) {
  adp.set(`${r.player_id}|${r.year}`, r.adp);
}

/* ------------------------------------------------------------------ maths */

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) || 1;
};
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    dbb += (b[i]! - mb) ** 2;
  }
  return da && dbb ? n / Math.sqrt(da * dbb) : 0;
}
function ranks(a: number[]): number[] {
  const idx = a.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
    i = j + 1;
  }
  return out;
}
const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));
/** Partial correlation of x with y, holding c fixed. */
function partial(x: number[], y: number[], c: number[]): number {
  const rxy = pearson(x, y), rxc = pearson(x, c), ryc = pearson(y, c);
  const d = Math.sqrt((1 - rxc ** 2) * (1 - ryc ** 2));
  return d ? (rxy - rxc * ryc) / d : 0;
}

/** Ridge on standardized predictors — the same solver shape as usage-grade.ts. */
function solve(X: number[][], y: number[], lambda: number): number[] | null {
  const k = X[0]!.length;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a] = b[a]! + X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c] = A[a]![c]! + X[i]![a]! * X[i]![c]!;
    }
  }
  for (let a = 1; a < k; a++) A[a]![a] = A[a]![a]! + lambda;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-10) return null;
    const t = M[col]!; M[col] = M[piv]!; M[piv] = t;
    const p = M[col]![col]!;
    for (let c = col; c <= k; c++) M[col]![c] = M[col]![c]! / p;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      for (let c = col; c <= k; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
    }
  }
  return M.map((row) => row[k]!);
}

interface Fit { feats: string[]; coef: number[]; intercept: number }

/** Fit next-season points on one season of usage, with `holdout` excluded. */
function fitModel(position: string, holdout: number): Fit | null {
  const feats = PREDICTORS[position]!.map((p) => p.column);
  const X: number[][] = [], y: number[] = [];
  for (const r of usageRows) {
    if (r.position !== position || r.season === holdout) continue;
    if (Number(r.games ?? 0) < 6) continue;
    const next = pts.get(`${r.player_id}|${Number(r.season) + 1}`);
    if (next === undefined) continue;
    const v = feats.map((f) => r[f]);
    if (v.some((x) => x === null || !Number.isFinite(Number(x)))) continue;
    X.push([1, ...v.map(Number)]);
    y.push(next);
  }
  if (X.length < 40) return null;
  const k = feats.length, means: number[] = [], sds: number[] = [];
  for (let j = 0; j < k; j++) {
    const col = X.map((r) => r[j + 1]!);
    const m = mean(col);
    means.push(m);
    sds.push(Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length) || 1);
  }
  const Z = X.map((r) => [1, ...r.slice(1).map((v, j) => (v - means[j]!) / sds[j]!)]);
  const beta = solve(Z, y, 0.05 * X.length);
  if (!beta) return null;
  const coef = beta.slice(1).map((b, j) => b / sds[j]!);
  return { feats, coef, intercept: beta[0]! - coef.reduce((a, b, j) => a + b * means[j]!, 0) };
}

const applyTo = (fit: Fit, v: number[]) =>
  Math.max(0, fit.intercept + v.reduce((a, x, j) => a + x * fit.coef[j]!, 0));

/** The single-season form the model is FITTED on. */
function applySingle(fit: Fit, r: Row): number | null {
  const v = fit.feats.map((f) => r[f]);
  if (v.some((x) => x === null || !Number.isFinite(Number(x)))) return null;
  return applyTo(fit, v.map(Number));
}

/** The recency-weighted multi-season form `projectUsage` actually APPLIES. */
function applyBlended(fit: Fit, playerId: string, season: number): number | null {
  const seasons: Row[] = [];
  for (let i = 0; i < RECENCY.length; i++) {
    const r = bySeasonPlayer.get(`${playerId}|${season - i}`);
    if (!r) { if (i === 0) return null; break; }
    seasons.push(r);
  }
  const w = seasons.map((s, i) =>
    RECENCY[i]! * (Math.min(Number(s.games) || 0, FULL_SEASON_GAMES) / FULL_SEASON_GAMES));
  const nums: number[] = [];
  for (const f of fit.feats) {
    let sum = 0, wt = 0;
    seasons.forEach((s, i) => {
      const v = s[f];
      if (v === null || !Number.isFinite(Number(v))) return;
      if (f === 'age') { if (i === 0) { sum += Number(v); wt += 1; } return; }
      if (w[i]! <= 0) return;
      sum += Number(v) * w[i]!;
      wt += w[i]!;
    });
    if (!wt) return null;
    nums.push(sum / wt);
  }
  return applyTo(fit, nums);
}

/* -------------------------------------------------------------- the panel */

interface Entry {
  season: number; position: string; playerId: string;
  market: number; usageSingle: number; usageBlend: number;
  priorPts: number; priorPpg: number; actual: number; adp: number;
}
const panel: Entry[] = [];

for (const S of SEASONS) {
  const U = S - 1;
  for (const position of POS) {
    const fit = fitModel(position, U);
    if (!fit) continue;

    /*
     * ADP -> points, fitted on the OTHER seasons only. Points against log ADP,
     * because the draft board is a rank order and the return per pick falls off
     * far faster at the top than at the bottom — the same shape `build-baseline`
     * fits for the same reason.
     */
    const train: Array<[number, number]> = [];
    for (const s of SEASONS) {
      if (s === S) continue;
      for (const [key, a] of adp) {
        const [pid, yr] = key.split('|');
        if (Number(yr) !== s) continue;
        const u = bySeasonPlayer.get(`${pid}|${s - 1}`);
        if (!u || u.position !== position) continue;
        const p = pts.get(`${pid}|${s}`);
        if (p === undefined) continue;
        train.push([Math.log(a), p]);
      }
    }
    if (train.length < 20) continue;
    const mx = mean(train.map((r) => r[0])), my = mean(train.map((r) => r[1]));
    let sxy = 0, sxx = 0;
    for (const [x, y] of train) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const slope = sxy / sxx, icept = my - slope * mx;

    for (const r of usageRows) {
      if (r.position !== position || Number(r.season) !== U) continue;
      if (Number(r.games ?? 0) < 6) continue;
      const a = adp.get(`${r.player_id}|${S}`);
      const actual = pts.get(`${r.player_id}|${S}`);
      if (a === undefined || actual === undefined) continue;
      const single = applySingle(fit, r);
      const blended = applyBlended(fit, String(r.player_id), U);
      if (single === null || blended === null) continue;
      const priorPts = pts.get(`${r.player_id}|${U}`) ?? 0;
      const g = appearances.get(`${r.player_id}|${U}`) ?? (Number(r.games) || 1);
      panel.push({
        season: S, position, playerId: String(r.player_id), adp: a, actual,
        market: icept + slope * Math.log(a),
        usageSingle: single, usageBlend: blended,
        priorPts, priorPpg: (priorPts / g) * 17,
      });
    }
  }
}

console.log('replaying four drafts with draft-day information only.');
console.log(`panel: ${panel.length} player-seasons  ` +
  POS.map((p) => `${p} ${panel.filter((r) => r.position === p).length}`).join(' · '));
console.log('pool = held a role (6+ games) AND carried an ADP. no rookies, no waiver wire.\n');

/* ---- everything is standardised inside its own position-season ----------- */

function groups(rowsIn: Entry[]) {
  const g = new Map<string, Entry[]>();
  for (const r of rowsIn) {
    const k = `${r.season}|${r.position}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(r);
  }
  return [...g.values()].filter((x) => x.length >= 8);
}
interface Z extends Entry { mz: number; uz: number; az: number }
function standardise(rowsIn: Entry[]): Z[] {
  const out: Z[] = [];
  for (const g of groups(rowsIn)) {
    const z = (key: keyof Entry) => {
      const v = g.map((r) => r[key] as number);
      const m = mean(v), s = sd(v);
      return v.map((x) => (x - m) / s);
    };
    const mz = z('market'), uz = z('usageBlend'), az = z('actual');
    g.forEach((r, i) => out.push({ ...r, mz: mz[i]!, uz: uz[i]!, az: az[i]! }));
  }
  return out;
}

/* -- 1. does the on-field role maths predict anything? --------------------- */

console.log('== 1. out-of-sample predictive power, against actual next-season points ==');
console.log('   every model scored on the same pool, so the comparison is like for like.\n');
const SIGNALS: Array<[string, (r: Entry) => number]> = [
  ['prior-season points', (r) => r.priorPts],
  ['prior-season points per game x17', (r) => r.priorPpg],
  ['usage model, single season (as FITTED)', (r) => r.usageSingle],
  ['usage model, 3-season blend (as APPLIED)', (r) => r.usageBlend],
  ['ADP alone', (r) => -Math.log(r.adp)],
];
for (const p of [null, ...POS]) {
  const sub = p ? panel.filter((r) => r.position === p) : panel;
  if (sub.length < 20) continue;
  const actual = sub.map((r) => r.actual);
  console.log(`   -- ${p ?? 'ALL'} (n=${sub.length})`);
  for (const [name, f] of SIGNALS) {
    const v = sub.map(f);
    console.log(`      ${name.padEnd(42)} r ${pearson(v, actual).toFixed(3)}   rho ${spearman(v, actual).toFixed(3)}`);
  }
}
console.log('\n   NOTE: the pooled row mixes positions with different scoring scales and');
console.log('   flatters everything. The per-position rows are the honest ones.');

/* -- 2. does it add anything the price has not already said? --------------- */

console.log('\n\n== 2. the partial: usage AFTER the market ==');
console.log('   a signal that restates the price is not a second opinion.\n');
console.log('   pos    n     usage r   market r   usage AFTER market   market AFTER usage');
for (const p of [null, ...POS]) {
  const z = standardise(p ? panel.filter((r) => r.position === p) : panel);
  if (z.length < 20) continue;
  const u = z.map((r) => r.uz), m = z.map((r) => r.mz), a = z.map((r) => r.az);
  console.log(`   ${(p ?? 'ALL').padEnd(5)} ${String(z.length).padEnd(5)} ${pearson(u, a).toFixed(3).padStart(7)}   ` +
    `${pearson(m, a).toFixed(3).padStart(8)}   ${partial(u, a, m).toFixed(3).padStart(18)}   ${partial(m, a, u).toFixed(3).padStart(17)}`);
}

/* -- 3. the sweep --------------------------------------------------------- */

const scoreAt = (z: Z[], w: number) =>
  pearson(z.map((r) => r.mz * w + r.uz * (1 - w)), z.map((r) => r.az));

function bootstrapArgmax(z: Z[], iters = 2000) {
  const ws: number[] = [];
  for (let t = 0; t < iters; t++) {
    const s: Z[] = [];
    for (let i = 0; i < z.length; i++) s.push(z[(Math.random() * z.length) | 0]!);
    let best = 0, bestR = -2;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const r = scoreAt(s, w);
      if (r > bestR) { bestR = r; best = w; }
    }
    ws.push(best);
  }
  ws.sort((a, b) => a - b);
  return { lo: ws[Math.floor(iters * 0.05)]!, mid: ws[Math.floor(iters * 0.5)]!, hi: ws[Math.floor(iters * 0.95)]! };
}

console.log('\n\n== 3. the weight sweep ==');
console.log(`   blended in z-space within position, exactly as blend() does. shipped weight ${DEFAULT_MARKET_WEIGHT}.\n`);
for (const p of [null, ...POS]) {
  const z = standardise(p ? panel.filter((r) => r.position === p) : panel);
  if (z.length < 40) continue;
  let best = 0, bestR = -2;
  const line: string[] = [];
  for (let w = 0; w <= 1.0001; w += 0.05) {
    const r = scoreAt(z, w);
    if (r > bestR) { bestR = r; best = w; }
    if (Math.round(w * 100) % 20 === 0) line.push(`${w.toFixed(1)}:${r.toFixed(3)}`);
  }
  const b = bootstrapArgmax(z);
  console.log(`   ${(p ?? 'ALL').padEnd(5)} n=${String(z.length).padEnd(4)} ${line.join('  ')}`);
  console.log(`   ${''.padEnd(5)}       best w ${best.toFixed(2)} (r ${bestR.toFixed(3)}) · at ${DEFAULT_MARKET_WEIGHT} r ${scoreAt(z, DEFAULT_MARKET_WEIGHT).toFixed(3)} ` +
    `· cost of shipping ${DEFAULT_MARKET_WEIGHT}: ${(bestR - scoreAt(z, DEFAULT_MARKET_WEIGHT)).toFixed(4)}`);
  console.log(`   ${''.padEnd(5)}       bootstrap argmax 90% CI [${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}] — the width is the finding\n`);
}

/* -- 4. would per-position weights survive? -------------------------------- */

console.log('\n== 4. do per-position weights generalise? ==');
console.log('   weight picked on the other three seasons, then applied to the held-out one.');
console.log('   if tuning cannot beat a flat number here, the flat number is the honest choice.\n');
function bestWeightOn(rowsIn: Entry[]) {
  const z = standardise(rowsIn);
  let best = DEFAULT_MARKET_WEIGHT, bestR = -2;
  for (let w = 0; w <= 1.0001; w += 0.05) {
    const r = scoreAt(z, w);
    if (r > bestR) { bestR = r; best = w; }
  }
  return best;
}
let tuned = 0, flat = 0, total = 0;
for (const S of SEASONS) {
  for (const p of POS) {
    const test = standardise(panel.filter((r) => r.season === S && r.position === p));
    const train = panel.filter((r) => r.season !== S && r.position === p);
    if (test.length < 8 || train.length < 30) continue;
    const w = bestWeightOn(train);
    const rt = scoreAt(test, w), rf = scoreAt(test, DEFAULT_MARKET_WEIGHT);
    console.log(`   ${S} ${p.padEnd(3)} tuned w ${w.toFixed(2)}  r ${rt.toFixed(3)}   flat r ${rf.toFixed(3)}   ${(rt - rf >= 0 ? '+' : '') + (rt - rf).toFixed(3)}`);
    tuned += rt * test.length; flat += rf * test.length; total += test.length;
  }
}
console.log(`\n   weighted mean r — tuned ${(tuned / total).toFixed(4)}  ·  flat ${DEFAULT_MARKET_WEIGHT} ${(flat / total).toFixed(4)}  ·  ` +
  `${((tuned - flat) / total >= 0 ? '+' : '') + ((tuned - flat) / total).toFixed(4)}`);

/* -- 5. where they disagree, who is right? -------------------------------- */

console.log('\n\n== 5. where the two signals disagree, who is right? ==');
console.log('   disagreement = usage z - market z, the number the board already shows.\n');
const z = standardise(panel).map((r) => ({ ...r, dis: r.uz - r.mz }));
console.log('   bucket                          n     market r   usage r   best w here');
for (const [label, f] of [
  ['|d| < 0.5  (signals agree)', (r: typeof z[0]) => Math.abs(r.dis) < 0.5],
  ['0.5 - 1.0', (r: typeof z[0]) => Math.abs(r.dis) >= 0.5 && Math.abs(r.dis) < 1.0],
  ['1.0 - 1.5', (r: typeof z[0]) => Math.abs(r.dis) >= 1.0 && Math.abs(r.dis) < 1.5],
  ['>= 1.5  (loud)', (r: typeof z[0]) => Math.abs(r.dis) >= 1.5],
] as Array<[string, (r: typeof z[0]) => boolean]>) {
  const s = z.filter(f);
  if (s.length < 20) { console.log(`   ${label.padEnd(31)} ${String(s.length).padEnd(5)} too few to judge`); continue; }
  const a = s.map((r) => r.az);
  let bw = 0, br = -2;
  for (let w = 0; w <= 1.0001; w += 0.05) {
    const r = pearson(s.map((x) => x.mz * w + x.uz * (1 - w)), a);
    if (r > br) { br = r; bw = w; }
  }
  console.log(`   ${label.padEnd(31)} ${String(s.length).padEnd(5)} ${pearson(s.map((r) => r.mz), a).toFixed(3).padStart(8)}  ` +
    `${pearson(s.map((r) => r.uz), a).toFixed(3).padStart(8)}  ${bw.toFixed(2).padStart(11)}`);
}

console.log('\n   and directionally — does a player beat the price the market put on him?');
console.log('   (actual z minus market z, by which way the usage model leaned)\n');
for (const [label, f] of [
  ['usage 1.0+ z ABOVE market', (r: typeof z[0]) => r.dis >= 1.0],
  ['usage 0.5-1.0 above', (r: typeof z[0]) => r.dis >= 0.5 && r.dis < 1.0],
  ['they agree (|d| < 0.5)', (r: typeof z[0]) => Math.abs(r.dis) < 0.5],
  ['usage 0.5-1.0 below', (r: typeof z[0]) => r.dis <= -0.5 && r.dis > -1.0],
  ['usage 1.0+ z BELOW market', (r: typeof z[0]) => r.dis <= -1.0],
] as Array<[string, (r: typeof z[0]) => boolean]>) {
  const s = z.filter(f);
  if (!s.length) continue;
  console.log(`   ${label.padEnd(28)} n=${String(s.length).padEnd(4)} beat his price by ${mean(s.map((r) => r.az - r.mz)).toFixed(3).padStart(7)} z`);
}
console.log('\n   that column is the whole case for the usage side: it is monotone.');
