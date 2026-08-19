import { sqlite } from '../lib/db/index';

/**
 * Does week-to-week startability carry anything a season total does not?
 *
 * A season total is the draft-day unit and it hides the thing a weekly league is
 * actually played on. Among running backs finishing between 130 and 170 points,
 * the share of weeks spent startable runs from 90% (Jonathan Taylor 2023) to 24%
 * (Javonte Williams 2024). Same total, completely different asset.
 *
 * But "it looks different" is not "it predicts". Points per game and startable
 * rate are obviously correlated — a better player is startable more often — so
 * the test is the PARTIAL: does startable rate predict next season after prior
 * points per game is already known? If not, it is a restatement and does not
 * belong on the board, however good the anecdote is.
 *
 * Three questions, in the order that decides the build:
 *   1. is it repeatable year to year at all? (durability is r 0.42; shares 0.7+)
 *   2. does it beat points per game at predicting next season's startable rate?
 *   3. does it add anything to predicting next season's POINTS?
 *
 * STARTABLE is defined by this league: 12 teams, 1 QB / 2 RB / 3 WR / 1 TE. A
 * player counts as startable in a week if he finished inside the number of
 * starters the league actually uses at his position that week. The flex is
 * deliberately left out — assigning it would need an ordering across positions
 * that is itself a judgment call, and every position is measured on its own
 * bar either way.
 */

const FROM = 2018;
const TO = 2025;
const STARTERS: Record<string, number> = { QB: 12, RB: 24, WR: 36, TE: 12 };

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; dbb += (b[i]! - mb) ** 2;
  }
  return da && dbb ? n / Math.sqrt(da * dbb) : 0;
}
function partial(x: number[], y: number[], c: number[]): number {
  const rxy = pearson(x, y), rxc = pearson(x, c), ryc = pearson(y, c);
  const d = Math.sqrt((1 - rxc ** 2) * (1 - ryc ** 2));
  return d ? (rxy - rxc * ryc) / d : 0;
}

/* ------------------------------------------------------- weekly finishes */

interface Wk { pid: string; season: number; week: number; p: number; pos: string }
const weeks = sqlite
  .prepare(
    `SELECT s.player_id pid, s.season, s.week, s.fantasy_points_half p, p.position pos
     FROM player_stats_week s
     JOIN players p ON p.gsis_id = s.player_id
     WHERE s.season_type='REG' AND s.season BETWEEN ? AND ?
       AND p.position IN ('QB','RB','WR','TE')`,
  )
  .all(FROM, TO) as Wk[];

/*
 * The bar is set by that week's actual scoring, not by a fixed points total.
 * A 12-point week is a startable receiver in one week and a bench line in
 * another; a threshold that ignores the week is measuring the schedule.
 */
const byWeek = new Map<string, Wk[]>();
for (const w of weeks) {
  const k = `${w.season}|${w.week}|${w.pos}`;
  if (!byWeek.has(k)) byWeek.set(k, []);
  byWeek.get(k)!.push(w);
}
const bar = new Map<string, number>();
for (const [k, list] of byWeek) {
  const pos = k.split('|')[2]!;
  const n = STARTERS[pos] ?? 24;
  const sorted = list.map((w) => w.p).sort((a, b) => b - a);
  bar.set(k, sorted[Math.min(n, sorted.length) - 1] ?? 0);
}

interface Season {
  pid: string; season: number; pos: string;
  games: number; startable: number; rate: number; points: number; ppg: number;
}
const acc = new Map<string, Season>();
for (const w of weeks) {
  const k = `${w.pid}|${w.season}`;
  let e = acc.get(k);
  if (!e) {
    e = { pid: w.pid, season: w.season, pos: w.pos, games: 0, startable: 0, rate: 0, points: 0, ppg: 0 };
    acc.set(k, e);
  }
  e.games++;
  e.points += w.p;
  if (w.p >= (bar.get(`${w.season}|${w.week}|${w.pos}`) ?? 0)) e.startable++;
}
for (const e of acc.values()) {
  e.rate = e.games ? e.startable / e.games : 0;
  e.ppg = e.games ? e.points / e.games : 0;
}

/*
 * A rate over three games is not a rate. Eight is the floor everywhere below —
 * enough that one big week cannot carry it, low enough to keep the players who
 * missed half a season, who are exactly the interesting ones.
 */
const MIN_GAMES = 8;
const seasons = [...acc.values()].filter((e) => e.games >= MIN_GAMES);
console.log(`${seasons.length} player-seasons with ${MIN_GAMES}+ games, ${FROM}-${TO}.\n`);

/* ---- 1. repeatability -------------------------------------------------- */

console.log('== 1. is startable rate repeatable year to year? ==');
console.log('   for reference: availability repeats at r 0.42, target share at 0.71.\n');
console.log('   pos    n     r(rate, next rate)   r(ppg, next ppg)   r(rate, next ppg)');
const pairs: Array<Season & { nextRate: number; nextPpg: number; nextPoints: number }> = [];
for (const e of seasons) {
  const nx = acc.get(`${e.pid}|${e.season + 1}`);
  if (!nx || nx.games < MIN_GAMES) continue;
  pairs.push({ ...e, nextRate: nx.rate, nextPpg: nx.ppg, nextPoints: nx.points });
}
for (const pos of [null, 'WR', 'RB', 'TE', 'QB']) {
  const g = pos ? pairs.filter((r) => r.pos === pos) : pairs;
  if (g.length < 30) continue;
  console.log(
    `   ${(pos ?? 'ALL').padEnd(5)} ${String(g.length).padStart(4)}   ` +
      `${pearson(g.map((r) => r.rate), g.map((r) => r.nextRate)).toFixed(3).padStart(18)}   ` +
      `${pearson(g.map((r) => r.ppg), g.map((r) => r.nextPpg)).toFixed(3).padStart(16)}   ` +
      `${pearson(g.map((r) => r.rate), g.map((r) => r.nextPpg)).toFixed(3).padStart(17)}`,
  );
}

/* ---- 2. the partial: does it beat the obvious baseline? ----------------- */

console.log('\n\n== 2. THE TEST — startable rate AFTER points per game ==');
console.log('   points per game and startable rate describe the same player, so the only');
console.log('   question that matters is whether either one survives the other.\n');
console.log('   pos    n     predicting NEXT STARTABLE RATE          predicting NEXT POINTS');
console.log('                rate    ppg     rate|ppg   ppg|rate     rate|ppg   ppg|rate');
for (const pos of [null, 'WR', 'RB', 'TE', 'QB']) {
  const g = pos ? pairs.filter((r) => r.pos === pos) : pairs;
  if (g.length < 30) continue;
  const rate = g.map((r) => r.rate), ppg = g.map((r) => r.ppg);
  const nr = g.map((r) => r.nextRate), np = g.map((r) => r.nextPoints);
  console.log(
    `   ${(pos ?? 'ALL').padEnd(5)} ${String(g.length).padStart(4)}   ` +
      `${pearson(rate, nr).toFixed(3).padStart(5)}  ${pearson(ppg, nr).toFixed(3).padStart(5)}  ` +
      `${partial(rate, nr, ppg).toFixed(3).padStart(9)}  ${partial(ppg, nr, rate).toFixed(3).padStart(8)}     ` +
      `${partial(rate, np, ppg).toFixed(3).padStart(8)}  ${partial(ppg, np, rate).toFixed(3).padStart(8)}`,
  );
}

/* ---- 3. what it looks like at a fixed level of production --------------- */

console.log('\n\n== 3. the spread that a season total hides ==');
console.log('   players banded by points per game, so production is held roughly fixed.\n');
console.log('   pos   ppg band      n     mean startable rate   10th pct   90th pct   spread');
for (const pos of ['RB', 'WR', 'TE', 'QB']) {
  for (const [lo, hi] of [[6, 9], [9, 12], [12, 15], [15, 30]] as Array<[number, number]>) {
    const g = seasons.filter((r) => r.pos === pos && r.ppg >= lo && r.ppg < hi);
    if (g.length < 15) continue;
    const rates = g.map((r) => r.rate).sort((a, b) => a - b);
    const p10 = rates[Math.floor(rates.length * 0.1)]!;
    const p90 = rates[Math.floor(rates.length * 0.9)]!;
    console.log(
      `   ${pos.padEnd(4)} ${String(lo).padStart(2)}-${String(hi).padEnd(3)} ppg  ${String(g.length).padStart(4)}   ` +
        `${(mean(rates) * 100).toFixed(0).padStart(17)}%   ${(p10 * 100).toFixed(0).padStart(7)}%   ${(p90 * 100).toFixed(0).padStart(7)}%   ` +
        `${((p90 - p10) * 100).toFixed(0).padStart(5)}pp`,
    );
  }
}

console.log('\n\n== 4. does a season total mislead about weekly usefulness? ==');
console.log('   share of players whose startable rate sits far from what their per-game');
console.log('   scoring would suggest, by position. Fitted within position, residual > 15pp.\n');
for (const pos of ['RB', 'WR', 'TE', 'QB']) {
  const g = seasons.filter((r) => r.pos === pos);
  if (g.length < 40) continue;
  const x = g.map((r) => r.ppg), y = g.map((r) => r.rate);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; }
  const slope = sxy / sxx;
  const resid = g.map((r, i) => y[i]! - (my + slope * (x[i]! - mx)));
  const off = resid.filter((v) => Math.abs(v) > 0.15).length;
  console.log(`   ${pos}  n=${String(g.length).padStart(4)}  ${off} players (${(off / g.length * 100).toFixed(0)}%) sit 15+ points of rate away from their scoring level`);
}
