import { sqlite } from '../lib/db/index';

/**
 * Why does nothing work between picks 73 and 120?
 *
 * Three separate measurements land on the same stretch of the draft: the slot
 * gap correlates 0.04 with what players returned against their price, UPSIDE
 * correlates −0.155 within position, and the draft order itself manages 0.066.
 * Every other band has at least one working signal. This asks what is different
 * about that one.
 *
 * The candidate explanations are mechanically different and imply opposite
 * responses, which is the reason to separate them rather than assert one:
 *
 *   RANGE RESTRICTION — the projections are all bunched, so even a perfect
 *     ranking has almost nothing to rank. Correlation is attenuated by
 *     arithmetic, not by the signal being wrong. Response: say so, do not fix.
 *   OUTCOME COMPRESSION — the outcomes are all bunched, so there is nothing to
 *     predict. Same conclusion, different cause.
 *   CENSORING / BINARY ROLE — the outcome is dominated by whether the player got
 *     on the field at all, which is a coin flip the continuous features cannot
 *     see. Response: model the binary event separately; the signal is fine
 *     CONDITIONAL on playing.
 *   MARKET NOISE — ADP itself is a weak ordering there, so anything correlated
 *     with ADP inherits the weakness. Testable directly: `adp_raw.stdev` is the
 *     disagreement between drafters, and it is already ingested.
 *   COMPOSITION — the band is full of one kind of player whose season turns on
 *     something not in the model.
 */

const SEASONS = [2022, 2023, 2024, 2025];
const BANDS: Array<[string, number, number]> = [
  ['rounds 1-3', 1, 36],
  ['rounds 4-6', 37, 72],
  ['rounds 7-10', 73, 120],
  ['rounds 11+', 121, 999],
];

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a: number[]) => (a.length < 2 ? 0 : Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2))));
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : 0;
}
function ranks(a: number[]): number[] {
  const idx = a.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const o = new Array<number>(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) o[idx[k]![1]] = r;
    i = j + 1;
  }
  return o;
}
const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

/* ------------------------------------------------------------------ data */

const pts = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, SUM(fantasy_points_half) p FROM player_stats_week
            WHERE season_type='REG' GROUP BY player_id, season`)
  .all() as Array<{ player_id: string; season: number; p: number }>) {
  pts.set(`${r.player_id}|${r.season}`, r.p);
}
const games = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, COUNT(DISTINCT week) g FROM snap_counts
            WHERE game_type='REG' AND player_id IS NOT NULL AND offense_snaps>0
            GROUP BY player_id, season`)
  .all() as Array<{ player_id: string; season: number; g: number }>) {
  games.set(`${r.player_id}|${r.season}`, r.g);
}
const repl = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT season, position, points FROM replacement_level WHERE format='half-ppr' AND teams=12`)
  .all() as Array<{ season: number; position: string; points: number }>) {
  repl.set(`${r.season}|${r.position}`, r.points);
}

interface Row {
  season: number; pid: string; name: string; pos: string; adp: number; stdev: number | null;
  actual: number; vorp: number; played: number; priorGames: number; priorPts: number;
}
const panel: Row[] = [];
for (const S of SEASONS) {
  for (const a of sqlite
    .prepare(`SELECT player_id, name, position, adp, stdev FROM adp_raw
              WHERE year=? AND format='half-ppr' AND teams=12 AND player_id IS NOT NULL`)
    .all(S) as Array<{ player_id: string; name: string; position: string; adp: number; stdev: number | null }>) {
    const actual = pts.get(`${a.player_id}|${S}`);
    if (actual === undefined) continue;
    panel.push({
      season: S, pid: a.player_id, name: a.name, pos: a.position, adp: a.adp, stdev: a.stdev,
      actual, vorp: actual - (repl.get(`${S}|${a.position}`) ?? 0),
      played: games.get(`${a.player_id}|${S}`) ?? 0,
      priorGames: games.get(`${a.player_id}|${S - 1}`) ?? 0,
      priorPts: pts.get(`${a.player_id}|${S - 1}`) ?? 0,
    });
  }
}
const inBand = (r: Row, lo: number, hi: number) => r.adp >= lo && r.adp <= hi;

console.log(`${panel.length} drafted player-seasons with an outcome, ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}.\n`);

/* -- 1. is there anything to predict? ------------------------------------- */

console.log('== 1. OUTCOME SPREAD — is there anything left to explain? ==');
console.log('   correlation needs variance in the outcome. if every player in a band lands');
console.log('   in the same place, nothing can correlate with it, however good the signal.\n');
console.log('   band            n     mean pts   sd(pts)   sd within position   coefficient of variation');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi));
  if (g.length < 20) continue;
  let s = 0, t = 0;
  for (const S of SEASONS) for (const pos of ['WR', 'RB', 'TE', 'QB']) {
    const gg = g.filter((r) => r.season === S && r.pos === pos);
    if (gg.length < 5) continue;
    s += sd(gg.map((r) => r.actual)) * gg.length; t += gg.length;
  }
  const withinSd = t ? s / t : 0;
  const m = mean(g.map((r) => r.actual));
  console.log(
    `   ${label.padEnd(14)} ${String(g.length).padStart(3)}   ${m.toFixed(0).padStart(8)}   ` +
      `${sd(g.map((r) => r.actual)).toFixed(0).padStart(7)}   ${withinSd.toFixed(0).padStart(18)}   ` +
      `${(withinSd / (m || 1)).toFixed(2).padStart(24)}`,
  );
}

/* -- 2. is the market itself confused there? ------------------------------ */

console.log('\n\n== 2. MARKET CONVICTION — do drafters themselves disagree most there? ==');
console.log('   `adp_raw.stdev` is the spread of where real drafters actually took him.');
console.log('   if the draft order is noisy in a band, everything built on it inherits that.\n');
console.log('   band            n     mean ADP stdev   stdev as % of ADP');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi) && r.stdev !== null && r.stdev > 0);
  if (g.length < 20) continue;
  const s = mean(g.map((r) => r.stdev!));
  console.log(
    `   ${label.padEnd(14)} ${String(g.length).padStart(3)}   ${s.toFixed(1).padStart(14)}   ` +
      `${((s / mean(g.map((r) => r.adp))) * 100).toFixed(0).padStart(17)}%`,
  );
}

/* -- 3. is the outcome really a coin flip on getting a role? -------------- */

console.log('\n\n== 3. CENSORING — is the season decided by whether he played at all? ==');
console.log('   if the outcome is mostly a binary "did he get a job", continuous features');
console.log('   cannot see it, and the fix would be to model that event separately.\n');
console.log('   band            n     played 10+ games   share of variance from the split*');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi));
  if (g.length < 20) continue;
  const on = g.filter((r) => r.played >= 10);
  const off = g.filter((r) => r.played < 10);
  /*
   * How much of the outcome spread is just "played or did not". The
   * between-group share of total variance — an eta squared. High means the
   * season was decided by getting on the field rather than by how good he was.
   */
  const grand = mean(g.map((r) => r.actual));
  const between =
    on.length && off.length
      ? (on.length * (mean(on.map((r) => r.actual)) - grand) ** 2 +
         off.length * (mean(off.map((r) => r.actual)) - grand) ** 2) / g.length
      : 0;
  const total = sd(g.map((r) => r.actual)) ** 2;
  console.log(
    `   ${label.padEnd(14)} ${String(g.length).padStart(3)}   ` +
      `${((on.length / g.length) * 100).toFixed(0).padStart(15)}%   ` +
      `${total ? ((between / total) * 100).toFixed(0).padStart(31) : '—'}%`,
  );
}
console.log('\n   * between-group share of total variance in points (eta squared).');

console.log('\n\n== 3b. does the signal come back among players who actually played? ==');
console.log('   restricting to 10+ games removes the binary event. if the draft order starts');
console.log('   working again, the band is not unpredictable — it is CENSORED.\n');
console.log('   band            all players   played 10+ games   difference');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi));
  if (g.length < 20) continue;
  const within = (rows: Row[]) => {
    let s = 0, t = 0;
    for (const S of SEASONS) for (const pos of ['WR', 'RB', 'TE', 'QB']) {
      const gg = rows.filter((r) => r.season === S && r.pos === pos);
      if (gg.length < 5) continue;
      s += spearman(gg.map((r) => -r.adp), gg.map((r) => r.actual)) * gg.length;
      t += gg.length;
    }
    return t ? s / t : NaN;
  };
  const all = within(g);
  const on = within(g.filter((r) => r.played >= 10));
  console.log(
    `   ${label.padEnd(14)} ${(Number.isNaN(all) ? '—' : all.toFixed(3)).padStart(11)}   ` +
      `${(Number.isNaN(on) ? '—' : on.toFixed(3)).padStart(16)}   ` +
      `${Number.isNaN(all) || Number.isNaN(on) ? '—' : ((on - all >= 0 ? '+' : '') + (on - all).toFixed(3)).padStart(10)}`,
  );
}

/* -- 4. who is actually in the band? -------------------------------------- */

console.log('\n\n== 4. COMPOSITION — who gets picked there? ==\n');
console.log('   band            WR   RB   TE   QB    held a real role last season');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi));
  if (g.length < 20) continue;
  const share = (p: string) => ((g.filter((r) => r.pos === p).length / g.length) * 100).toFixed(0).padStart(3);
  const withRole = g.filter((r) => r.priorGames >= 10 && r.priorPts >= 80).length;
  console.log(
    `   ${label.padEnd(14)} ${share('WR')}% ${share('RB')}% ${share('TE')}% ${share('QB')}%   ` +
      `${((withRole / g.length) * 100).toFixed(0).padStart(24)}%`,
  );
}

/* -- 5. the predictor's own spread ---------------------------------------- */

console.log('\n\n== 5. RANGE RESTRICTION — how much is there to rank? ==');
console.log('   correlation is attenuated when the PREDICTOR is bunched. a band 48 picks');
console.log('   wide holds players the market treats as nearly identical.\n');
console.log('   band            picks wide   mean gap between consecutive picks at a position');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi));
  if (g.length < 20) continue;
  let gaps: number[] = [];
  for (const S of SEASONS) for (const pos of ['WR', 'RB', 'TE', 'QB']) {
    const gg = g.filter((r) => r.season === S && r.pos === pos).sort((a, b) => a.adp - b.adp);
    for (let i = 1; i < gg.length; i++) gaps.push(gg[i]!.adp - gg[i - 1]!.adp);
  }
  console.log(
    `   ${label.padEnd(14)} ${String(hi === 999 ? '80+' : hi - lo + 1).padStart(10)}   ` +
      `${(gaps.length ? mean(gaps) : 0).toFixed(1).padStart(46)}`,
  );
}

/* -- 6. the mixture hypothesis -------------------------------------------- */

/*
 * The composition table is the lead. "Held a real role last season" runs 93%,
 * 85%, **67%**, 56% across the bands — picks 73-120 is where the board stops
 * being a list of established players and starts being a list of unknowns, and
 * it is the only band that is genuinely half of each.
 *
 * That matters because the two groups are ranked on incomparable evidence. An
 * established player's ADP prices a known role; an unproven one's prices a
 * guess about whether he gets a role at all. Interleaving them produces an
 * ordering that is not a ranking of anything in particular — and a correlation
 * computed across the mixture can be near zero even when the ordering inside
 * each group is fine. This separates the two.
 */
console.log('\n\n== 6. THE MIXTURE — does the signal work INSIDE each group? ==');
console.log('   splitting each band into players who held a real role last season (10+ games,');
console.log('   80+ points) and those who did not. if the draft order works within each but');
console.log('   not across them, the band is not unpredictable — it is two populations.\n');
console.log('   band            established n   rho    unproven n   rho    pooled rho');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi));
  if (g.length < 20) continue;
  const established = (r: Row) => r.priorGames >= 10 && r.priorPts >= 80;
  const within = (rows: Row[]) => {
    let s = 0, t = 0;
    for (const S of SEASONS) for (const pos of ['WR', 'RB', 'TE', 'QB']) {
      const gg = rows.filter((r) => r.season === S && r.pos === pos);
      if (gg.length < 5) continue;
      s += spearman(gg.map((r) => -r.adp), gg.map((r) => r.actual)) * gg.length;
      t += gg.length;
    }
    return t ? s / t : NaN;
  };
  const a = g.filter(established), b = g.filter((r) => !established(r));
  const fmt = (v: number) => (Number.isNaN(v) ? '  —  ' : v.toFixed(3).padStart(6));
  console.log(
    `   ${label.padEnd(14)} ${String(a.length).padStart(13)}  ${fmt(within(a))}   ` +
      `${String(b.length).padStart(10)}  ${fmt(within(b))}   ${fmt(within(g))}`,
  );
}

/*
 * And the other half of the same question: how far apart are the two groups?
 * If the unproven players systematically return less, the market is not
 * mispricing them — it is pricing a lottery, and the average ticket loses.
 */
console.log('\n   what each group actually returned, by band:\n');
console.log('   band            established: mean pts   unproven: mean pts   gap');
for (const [label, lo, hi] of BANDS) {
  const g = panel.filter((r) => inBand(r, lo, hi));
  if (g.length < 20) continue;
  const established = (r: Row) => r.priorGames >= 10 && r.priorPts >= 80;
  const a = mean(g.filter(established).map((r) => r.actual));
  const b = mean(g.filter((r) => !established(r)).map((r) => r.actual));
  console.log(
    `   ${label.padEnd(14)} ${a.toFixed(0).padStart(21)}   ${b.toFixed(0).padStart(18)}   ${(a - b).toFixed(0).padStart(4)}`,
  );
}

/* -- 7. where is the boundary, actually? ---------------------------------- */

/*
 * Every number so far came from bands I chose. Rounds 4-6 established players
 * sit at rho 0.010 — WORSE than the 7-10 band this whole investigation was
 * named after — and across three different samples the weakest band flips
 * between 4-6 and 7-10. That is the signature of a boundary that does not exist
 * where it was asserted.
 *
 * So stop asserting bands. A rolling window over ADP shows where the signal
 * actually lives, and it cannot be argued into a shape by the choice of cut
 * points.
 */
console.log('\n\n== 7. ROLLING WINDOW — where does the signal actually die? ==');
console.log('   Spearman of draft order against actual points, within position, over a');
console.log('   sliding 60-pick window. No bands chosen in advance.\n');
console.log('   window        n     rho(draft order, actual)   bar');
for (let start = 1; start <= 150; start += 15) {
  const lo = start, hi = start + 59;
  const g = panel.filter((r) => r.adp >= lo && r.adp <= hi);
  if (g.length < 40) continue;
  let s = 0, t = 0;
  for (const S of SEASONS) for (const pos of ['WR', 'RB', 'TE', 'QB']) {
    const gg = g.filter((r) => r.season === S && r.pos === pos);
    if (gg.length < 5) continue;
    s += spearman(gg.map((r) => -r.adp), gg.map((r) => r.actual)) * gg.length;
    t += gg.length;
  }
  if (!t) continue;
  const rho = s / t;
  const bar = rho > 0 ? '#'.repeat(Math.round(rho * 40)) : '.';
  console.log(`   ${String(lo).padStart(3)}-${String(hi).padEnd(4)} ${String(g.length).padStart(5)}   ${rho.toFixed(3).padStart(24)}   ${bar}`);
}

/*
 * And the same for the outcome's own predictability ceiling: how much of a
 * player's season is explained by the single best thing anyone knew about him
 * beforehand — what he did the year before. If THAT also collapses in the
 * middle, the problem is not the draft order, it is that the middle of the
 * draft is genuinely less forecastable by anything.
 */
console.log('\n   the same window, using PRIOR-SEASON POINTS instead of draft order —');
console.log('   the best single fact available before the season:\n');
console.log('   window        n     rho(prior points, actual)   bar');
for (let start = 1; start <= 150; start += 15) {
  const lo = start, hi = start + 59;
  const g = panel.filter((r) => r.adp >= lo && r.adp <= hi && r.priorGames >= 6);
  if (g.length < 40) continue;
  let s = 0, t = 0;
  for (const S of SEASONS) for (const pos of ['WR', 'RB', 'TE', 'QB']) {
    const gg = g.filter((r) => r.season === S && r.pos === pos);
    if (gg.length < 5) continue;
    s += spearman(gg.map((r) => r.priorPts), gg.map((r) => r.actual)) * gg.length;
    t += gg.length;
  }
  if (!t) continue;
  const rho = s / t;
  const bar = rho > 0 ? '#'.repeat(Math.round(rho * 40)) : '.';
  console.log(`   ${String(lo).padStart(3)}-${String(hi).padEnd(4)} ${String(g.length).padStart(5)}   ${rho.toFixed(3).padStart(25)}   ${bar}`);
}

/* -- 8. the slot gap, on the same rolling window --------------------------- */

/*
 * `GAP_DEAD_BAND = {from: 73, to: 120}` ships as a hard boundary and the tag
 * copy quotes it to the pick. Sections 6 and 7 say no such boundary exists: the
 * decay is smooth from pick 1, bottoms somewhere around 76-150, and recovers.
 * A sharp edge asserted on a smooth curve is a judgment number wearing a
 * measurement's clothes, which is the failure this project has the most history
 * with. So measure the gap the same way and set the band from the curve.
 */
console.log('\n\n== 8. THE SLOT GAP on a rolling window ==');
console.log('   the quantity the "price read unreliable" tag gates on, measured the same');
console.log('   way. correlation with what a player returned RELATIVE TO HIS SLOT.\n');

// Slot expectation per position, fitted leave-one-season-out.
for (const r of panel) {
  const tr = panel.filter((x) => x.pos === r.pos && x.season !== r.season);
  if (tr.length < 20) { (r as Row & { resid?: number }).resid = undefined; continue; }
  const X = tr.map((x) => Math.log(x.adp)), Y = tr.map((x) => x.vorp);
  const mx = mean(X), my = mean(Y);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < X.length; i++) { sxy += (X[i]! - mx) * (Y[i]! - my); sxx += (X[i]! - mx) ** 2; }
  const slope = sxy / sxx;
  (r as Row & { resid?: number }).resid = r.vorp - (my - slope * mx + slope * Math.log(r.adp));
}
type WithResid = Row & { resid?: number };

console.log('   window        n     rho(prior points, return vs slot)   bar');
for (let start = 1; start <= 150; start += 15) {
  const lo = start, hi = start + 59;
  const g = (panel as WithResid[]).filter(
    (r) => r.adp >= lo && r.adp <= hi && r.resid !== undefined && r.priorGames >= 6,
  );
  if (g.length < 40) continue;
  let s = 0, t = 0;
  for (const S of SEASONS) for (const pos of ['WR', 'RB', 'TE', 'QB']) {
    const gg = g.filter((r) => r.season === S && r.pos === pos);
    if (gg.length < 5) continue;
    s += spearman(gg.map((r) => r.priorPts), gg.map((r) => r.resid!)) * gg.length;
    t += gg.length;
  }
  if (!t) continue;
  const rho = s / t;
  console.log(
    `   ${String(lo).padStart(3)}-${String(hi).padEnd(4)} ${String(g.length).padStart(5)}   ` +
      `${rho.toFixed(3).padStart(32)}   ${rho > 0 ? '#'.repeat(Math.max(1, Math.round(rho * 40))) : '.'}`,
  );
}

console.log('\n   Read it as a curve, not a cliff. Any hard band drawn on this is a choice');
console.log('   about where to stop trusting a smooth decline, not a measured edge.');
