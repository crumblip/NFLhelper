import { sqlite } from '../lib/db/index';

/**
 * How well can availability be predicted, and from what?
 *
 * The project already knows durability repeats (r≈0.42) and that a receiver who
 * missed four or more games misses again 73% of the time. What it never checked
 * is how that estimate should be formed:
 *
 *   1. Should games played be shrunk toward the positional mean for a player
 *      with little history? `expectedGames` is currently a raw weighted average,
 *      so a rookie who played 17 games is recorded as certainly durable and one
 *      who played 9 as certainly fragile — both on a single season. Shares do
 *      NOT need shrinking (measured, k≈0) because a share is a coaching
 *      decision; games missed is a count with real binomial noise, so the
 *      answer may differ.
 *
 *   2. Is injury proneness a property of the TEAM as well as the player? San
 *      Francisco is the standing example. If it is real it must (a) persist year
 *      to year and (b) survive controlling for the players themselves, or it is
 *      just a roster of fragile individuals being re-counted.
 */

const FULL = 17;
const FROM = 2018;

interface Season {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  season: number;
  games: number;
  nextGames: number | null;
}

/** Appearances from snap counts — a healthy backup still played (bug #40). */
const appearances = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, COUNT(DISTINCT week) g FROM snap_counts
     WHERE game_type='REG' AND player_id IS NOT NULL AND offense_snaps > 0
     GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; g: number }>) {
  appearances.set(`${r.player_id}|${r.season}`, r.g);
}

const seasonsPresent = new Set(
  (
    sqlite
      .prepare(`SELECT DISTINCT season FROM player_stats_week WHERE season_type='REG'`)
      .all() as Array<{ season: number }>
  ).map((r) => r.season),
);

const rows: Season[] = [];
for (const r of sqlite
  .prepare(
    `SELECT u.player_id AS playerId, p.display_name AS name, u.position, u.team, u.season
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.season >= ? AND u.position IN ('QB','RB','WR','TE')`,
  )
  .all(FROM) as Array<{ playerId: string; name: string; position: string; team: string | null; season: number }>) {
  const g = appearances.get(`${r.playerId}|${r.season}`) ?? 0;
  if (g < 1) continue;
  const next = seasonsPresent.has(r.season + 1)
    ? appearances.get(`${r.playerId}|${r.season + 1}`) ?? 0
    : null;
  rows.push({ ...r, games: Math.min(g, FULL), nextGames: next === null ? null : Math.min(next, FULL) });
}

const pearson = (x: number[], y: number[]) => {
  const n = x.length;
  if (n < 4) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let s = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    s += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  return s / Math.sqrt(dx * dy || 1);
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

/* ------------------------------------------------- 1. shrinkage for games */

console.log('='.repeat(74));
console.log('1. SHOULD EXPECTED GAMES BE SHRUNK TOWARD THE POSITIONAL MEAN?');
console.log('='.repeat(74));
console.log('\nEstimate = (observed games + k * positional mean) / (seasons + k).');
console.log('k=0 is the current behaviour: whatever he played is what he is.\n');

const posMean = new Map<string, number>();
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  posMean.set(pos, mean(rows.filter((r) => r.position === pos).map((r) => r.games)));
}
console.log(
  'mean games by position: ' +
    [...posMean].map(([p, m]) => `${p} ${m.toFixed(1)}`).join('  '),
);

// History available BEFORE the season being predicted, so nothing leaks.
const history = new Map<string, number[]>();
for (const r of [...rows].sort((a, b) => a.season - b.season)) {
  const key = r.playerId;
  const prior = history.get(key) ?? [];
  history.set(key, [...prior, r.games]);
}

function priorGames(playerId: string, before: number): number[] {
  return rows
    .filter((r) => r.playerId === playerId && r.season < before)
    .sort((a, b) => b.season - a.season)
    .map((r) => r.games);
}

console.log('\n   k    n      r     MAE   (predicting next season\'s games)');
for (const k of [0, 0.5, 1, 2, 3, 5, 8]) {
  const preds: number[] = [];
  const acts: number[] = [];
  for (const r of rows) {
    if (r.nextGames === null) continue;
    const prior = priorGames(r.playerId, r.season + 1);
    if (!prior.length) continue;
    const m = posMean.get(r.position) ?? FULL;
    // Recent season weighted most, matching buildRiskProfiles.
    let sum = 0, w = 0;
    prior.forEach((g, i) => {
      const weight = i === 0 ? 0.6 : 0.4 / Math.max(1, prior.length - 1);
      sum += g * weight;
      w += weight;
    });
    const observed = w ? sum / w : m;
    const est = (observed * prior.length + m * k) / (prior.length + k);
    preds.push(est);
    acts.push(r.nextGames);
  }
  const mae = mean(preds.map((p, i) => Math.abs(p - acts[i]!)));
  console.log(
    `${String(k).padStart(4)} ${String(preds.length).padStart(5)} ${pearson(preds, acts).toFixed(3).padStart(6)} ${mae.toFixed(2).padStart(7)}`,
  );
}

console.log('\nSame, restricted to players with only ONE season of history —');
console.log('the case where the current estimate is most overconfident:');
console.log('   k    n      r     MAE');
for (const k of [0, 0.5, 1, 2, 3, 5]) {
  const preds: number[] = [];
  const acts: number[] = [];
  for (const r of rows) {
    if (r.nextGames === null) continue;
    const prior = priorGames(r.playerId, r.season + 1);
    if (prior.length !== 1) continue;
    const m = posMean.get(r.position) ?? FULL;
    const est = (prior[0]! * 1 + m * k) / (1 + k);
    preds.push(est);
    acts.push(r.nextGames);
  }
  if (preds.length < 20) continue;
  const mae = mean(preds.map((p, i) => Math.abs(p - acts[i]!)));
  console.log(
    `${String(k).padStart(4)} ${String(preds.length).padStart(5)} ${pearson(preds, acts).toFixed(3).padStart(6)} ${mae.toFixed(2).padStart(7)}`,
  );
}

/* --------------------------------------------- 2. is injury a team trait? */

console.log('\n' + '='.repeat(74));
console.log('2. IS INJURY PRONENESS A PROPERTY OF THE TEAM?');
console.log('='.repeat(74));
console.log('\nTeam availability = mean games played by its skill players that season,');
console.log('over players who were on the roster and took at least one snap.\n');

const teamSeason = new Map<string, { games: number[]; season: number; team: string }>();
for (const r of rows) {
  if (!r.team) continue;
  const key = `${r.team}|${r.season}`;
  const e = teamSeason.get(key) ?? { games: [], season: r.season, team: r.team };
  e.games.push(r.games);
  teamSeason.set(key, e);
}

const teamAvail = new Map<string, number>();
for (const [key, e] of teamSeason) {
  if (e.games.length < 6) continue;
  teamAvail.set(key, mean(e.games));
}

// (a) Does it persist?
const pa: number[] = [];
const pb: number[] = [];
for (const [key, v] of teamAvail) {
  const [team, s] = key.split('|');
  const nxt = teamAvail.get(`${team}|${Number(s) + 1}`);
  if (nxt !== undefined) { pa.push(v); pb.push(nxt); }
}
console.log(`(a) year-over-year persistence: r=${pearson(pa, pb).toFixed(3)} (n=${pa.length} team-season pairs)`);
console.log(`    compare: individual player durability repeats at r≈0.42`);

// (b) Does last year's team availability predict a player's NEXT season games,
//     after his own history is accounted for?
const xs: number[] = [];
const ys: number[] = [];
const cs: number[] = [];
for (const r of rows) {
  if (r.nextGames === null || !r.team) continue;
  const prior = priorGames(r.playerId, r.season + 1);
  if (!prior.length) continue;
  const teamPrior = teamAvail.get(`${r.team}|${r.season}`);
  if (teamPrior === undefined) continue;
  xs.push(teamPrior);
  ys.push(r.nextGames);
  cs.push(mean(prior));
}
const resid = (y: number[], c: number[]) => {
  const n = y.length;
  const mc = mean(c), my = mean(y);
  let s = 0, d = 0;
  for (let i = 0; i < n; i++) { s += (c[i]! - mc) * (y[i]! - my); d += (c[i]! - mc) ** 2; }
  const sl = d ? s / d : 0;
  return y.map((v, i) => v - (my + sl * (c[i]! - mc)));
};
console.log(
  `\n(b) team availability -> player's next-season games: r=${pearson(xs, ys).toFixed(3)}, ` +
    `after his own history r=${pearson(resid(xs, cs), resid(ys, cs)).toFixed(3)} (n=${xs.length})`,
);

// (c) The named example, and the actual ranking.
const byTeam = new Map<string, number[]>();
for (const [key, v] of teamAvail) {
  const team = key.split('|')[0]!;
  const arr = byTeam.get(team) ?? [];
  arr.push(v);
  byTeam.set(team, arr);
}
const ranked = [...byTeam.entries()]
  .filter(([, v]) => v.length >= 4)
  .map(([t, v]) => ({ team: t, avail: mean(v), n: v.length }))
  .sort((a, b) => a.avail - b.avail);
console.log('\n(c) fewest games played by skill players, mean per season:');
for (const t of ranked.slice(0, 6)) {
  console.log(`    ${t.team.padEnd(4)} ${t.avail.toFixed(2)} games (${t.n} seasons)`);
}
console.log('    most:');
for (const t of ranked.slice(-3).reverse()) {
  console.log(`    ${t.team.padEnd(4)} ${t.avail.toFixed(2)} games (${t.n} seasons)`);
}
const sf = ranked.find((t) => t.team === 'SF');
if (sf) {
  console.log(
    `\n    San Francisco: ${sf.avail.toFixed(2)} games, rank ${ranked.indexOf(sf) + 1} of ${ranked.length} ` +
      `(1 = fewest games played)`,
  );
}

/* ------------------------------- 2b. same test with a cleaner instrument */

console.log('\n' + '-'.repeat(74));
console.log('2b. Retested on ROLE-HOLDERS only, to remove roster churn.');
console.log('-'.repeat(74));
console.log('\n"Mean games by every skill player" moves with how many fringe bodies a');
console.log('team cycled through, which is not injury. This restricts each team-season');
console.log('to its top eight skill players by snaps — the ones whose absence is felt.\n');

const snapsBy = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, SUM(offense_snaps) s FROM snap_counts
     WHERE game_type='REG' AND player_id IS NOT NULL GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; s: number }>) {
  snapsBy.set(`${r.player_id}|${r.season}`, r.s);
}

const coreAvail = new Map<string, number>();
for (const [key, e] of teamSeason) {
  const members = rows.filter((r) => r.team && `${r.team}|${r.season}` === key);
  if (members.length < 8) continue;
  const top = members
    .map((r) => ({ g: r.games, s: snapsBy.get(`${r.playerId}|${r.season}`) ?? 0 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  coreAvail.set(key, mean(top.map((t) => t.g)));
}

const ca: number[] = [];
const cb: number[] = [];
for (const [key, v] of coreAvail) {
  const [team, s] = key.split('|');
  const nxt = coreAvail.get(`${team}|${Number(s) + 1}`);
  if (nxt !== undefined) { ca.push(v); cb.push(nxt); }
}
console.log(`persistence among core eight: r=${pearson(ca, cb).toFixed(3)} (n=${ca.length} pairs)`);

const xs2: number[] = [];
const ys2: number[] = [];
const cs2: number[] = [];
for (const r of rows) {
  if (r.nextGames === null || !r.team) continue;
  const prior = priorGames(r.playerId, r.season + 1);
  if (!prior.length) continue;
  const t = coreAvail.get(`${r.team}|${r.season}`);
  if (t === undefined) continue;
  xs2.push(t); ys2.push(r.nextGames); cs2.push(mean(prior));
}
console.log(
  `core-eight availability -> player's next games: r=${pearson(xs2, ys2).toFixed(3)}, ` +
    `after his own history r=${pearson(resid(xs2, cs2), resid(ys2, cs2)).toFixed(3)} (n=${xs2.length})`,
);

const byTeam2 = new Map<string, number[]>();
for (const [key, v] of coreAvail) {
  const t = key.split('|')[0]!;
  byTeam2.set(t, [...(byTeam2.get(t) ?? []), v]);
}
const ranked2 = [...byTeam2.entries()]
  .filter(([, v]) => v.length >= 4)
  .map(([t, v]) => ({ team: t, avail: mean(v), n: v.length }))
  .sort((a, b) => a.avail - b.avail);
console.log('\nfewest games among each team\'s core eight:');
for (const t of ranked2.slice(0, 5)) console.log(`  ${t.team.padEnd(4)} ${t.avail.toFixed(2)}`);
const sf2 = ranked2.find((t) => t.team === 'SF');
if (sf2) console.log(`\n  San Francisco: ${sf2.avail.toFixed(2)} games, rank ${ranked2.indexOf(sf2) + 1} of ${ranked2.length}`);
