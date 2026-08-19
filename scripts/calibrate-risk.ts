import { sqlite } from '../lib/db/index';

/**
 * Two risks the tool cannot currently see.
 *
 * 1. Durability. A player who cannot stay on the field is worth less than his
 *    per-game rate implies, and missed time is the most common way a draft pick
 *    returns nothing. The question is whether past availability predicts future
 *    availability, or whether injuries are simply random.
 *
 * 2. Touchdown regression. Scoring rates bounce around far more than
 *    opportunity does. A player who scored well above what his red-zone volume
 *    supports is a candidate to fall back, and one who scored below it a
 *    candidate to rise. This measures whether that correction is real.
 */

const games = sqlite
  .prepare(
    `SELECT player_id, season, position, COUNT(*) AS g
     FROM player_stats_week WHERE season_type = 'REG' AND position IN ('WR','RB','TE')
     GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; position: string; g: number }>;

const gamesBy = new Map<string, number>();
for (const r of games) gamesBy.set(`${r.player_id}|${r.season}`, r.g);

function corr(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 25) return NaN;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

console.log('DURABILITY — does missing games in the past predict missing them again?\n');
console.log('  position   n     r(prior 1 yr)   r(prior 2 yr avg)');

for (const pos of ['WR', 'RB', 'TE']) {
  const one: Array<[number, number]> = [];
  const two: Array<[number, number]> = [];
  for (const r of games) {
    if (r.position !== pos) continue;
    const next = gamesBy.get(`${r.player_id}|${r.season + 1}`);
    if (next === undefined) continue;
    one.push([r.g, next]);
    const prior = gamesBy.get(`${r.player_id}|${r.season - 1}`);
    if (prior !== undefined) two.push([(r.g + prior) / 2, next]);
  }
  console.log(
    `  ${pos.padEnd(9)} ${String(one.length).padStart(4)}   ${corr(one).toFixed(3).padStart(12)}   ` +
      `${corr(two).toFixed(3).padStart(16)}`,
  );
}

console.log('\n  how often does a player who missed 4+ games repeat it next season?');
for (const pos of ['WR', 'RB', 'TE']) {
  let fragile = 0, fragileRepeat = 0, healthy = 0, healthyBreak = 0;
  for (const r of games) {
    if (r.position !== pos) continue;
    const next = gamesBy.get(`${r.player_id}|${r.season + 1}`);
    if (next === undefined) continue;
    if (r.g <= 13) {
      fragile++;
      if (next <= 13) fragileRepeat++;
    } else {
      healthy++;
      if (next <= 13) healthyBreak++;
    }
  }
  if (!fragile || !healthy) continue;
  console.log(
    `  ${pos}: missed time before -> ${((fragileRepeat / fragile) * 100).toFixed(0)}% miss again ` +
      `(n=${fragile})   |   stayed healthy -> ${((healthyBreak / healthy) * 100).toFixed(0)}% miss (n=${healthy})`,
  );
}

console.log('\n\nTOUCHDOWN REGRESSION — do TDs above red-zone volume fall back?\n');

const usage = sqlite
  .prepare(
    `SELECT player_id, season, position, games, rz_carries, rz_targets, total_tds
     FROM player_usage WHERE games >= 6 AND rz_carries IS NOT NULL`,
  )
  .all() as Array<{
  player_id: string; season: number; position: string; games: number;
  rz_carries: number; rz_targets: number; total_tds: number;
}>;

// League-average touchdowns per red-zone touch, per position — the yardstick
// for "how many should he have scored".
const rate = new Map<string, { td: number; touches: number }>();
for (const u of usage) {
  const e = rate.get(u.position) ?? { td: 0, touches: 0 };
  e.td += u.total_tds ?? 0;
  e.touches += (u.rz_carries ?? 0) + (u.rz_targets ?? 0);
  rate.set(u.position, e);
}

console.log('  position   TD per red-zone touch');
for (const [pos, e] of rate) {
  if (e.touches) console.log(`  ${pos.padEnd(9)}  ${(e.td / e.touches).toFixed(3)}`);
}

const tdBy = new Map<string, number>();
for (const u of usage) tdBy.set(`${u.player_id}|${u.season}`, u.total_tds ?? 0);

console.log('\n  does scoring above expectation this year predict next year?');
console.log('  position   n     r(TD over expected -> next-year TD over expected)');
for (const pos of ['WR', 'RB', 'TE']) {
  const e = rate.get(pos);
  if (!e || !e.touches) continue;
  const perTouch = e.td / e.touches;
  const pairs: Array<[number, number]> = [];
  for (const u of usage) {
    if (u.position !== pos) continue;
    const next = usage.find((x) => x.player_id === u.player_id && x.season === u.season + 1);
    if (!next) continue;
    const expA = ((u.rz_carries ?? 0) + (u.rz_targets ?? 0)) * perTouch;
    const expB = ((next.rz_carries ?? 0) + (next.rz_targets ?? 0)) * perTouch;
    pairs.push([(u.total_tds ?? 0) - expA, (next.total_tds ?? 0) - expB]);
  }
  console.log(`  ${pos.padEnd(9)} ${String(pairs.length).padStart(4)}   ${corr(pairs).toFixed(3).padStart(12)}`);
}

console.log('\n  Near zero means scoring above volume does NOT carry over — it is luck,');
console.log('  and a player who over-scored last year should be marked down.');
