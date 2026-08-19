import { sqlite } from '../lib/db/index';
import { buildCoverageProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

/**
 * Does the offence's motion rate predict a receiver's next season, once his own
 * role is accounted for?
 *
 * Worth testing properly. nflverse charts motion at play level with no player
 * attribution, so this is the scheme a player sits in rather than how often he
 * personally moves. If a high-motion offence genuinely lifts its receivers, it
 * should show up after the player's own target share is removed.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const profile = buildCoverageProfile(FORMAT, TEAMS, CURRENT);
const rules = rulesFor(FORMAT);

const totals = sqlite
  .prepare(
    `SELECT player_id, season, MAX(position) AS position,
            SUM(passing_yards) AS passingYards, SUM(passing_tds) AS passingTds,
            SUM(interceptions) AS interceptions,
            SUM(rushing_yards) AS rushingYards, SUM(rushing_tds) AS rushingTds,
            SUM(receptions) AS receptions, SUM(receiving_yards) AS receivingYards,
            SUM(receiving_tds) AS receivingTds
     FROM player_stats_week WHERE season_type = 'REG' GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; position: string | null } & StatLine>;

const points = new Map<string, number>();
for (const r of totals) {
  const pos = (r.position ?? '').toUpperCase();
  const cats = profile.get(pos);
  points.set(`${r.player_id}|${r.season}`, scoreStatLine(cats ? maskStatLine(r, cats) : r, rules));
}

const usage = sqlite
  .prepare(
    `SELECT player_id, season, position, target_share ts, rush_share rs,
            team_motion_rate motion, pass_snap_share pss, rz_touch_share rz
     FROM player_usage WHERE games >= 6 AND team_motion_rate IS NOT NULL`,
  )
  .all() as Array<Record<string, number | string | null>>;

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

/** Correlation of `key` with next-season points after removing `control`. */
function partial(rows: typeof usage, key: string, control: string): { r: number; n: number } {
  const data: Array<{ x: number; c: number; y: number }> = [];
  for (const u of rows) {
    const y = points.get(`${u.player_id}|${Number(u.season) + 1}`);
    const x = u[key];
    const c = u[control];
    if (y === undefined || typeof x !== 'number' || typeof c !== 'number') continue;
    data.push({ x, c, y });
  }
  if (data.length < 25) return { r: NaN, n: data.length };

  const mc = data.reduce((a, d) => a + d.c, 0) / data.length;
  const my = data.reduce((a, d) => a + d.y, 0) / data.length;
  let scy = 0, scc = 0;
  for (const d of data) {
    scy += (d.c - mc) * (d.y - my);
    scc += (d.c - mc) ** 2;
  }
  const slope = scc ? scy / scc : 0;
  const resid = data.map((d) => [d.x, d.y - (my + slope * (d.c - mc))] as [number, number]);
  return { r: corr(resid), n: data.length };
}

console.log('motion rate of the offence a player sits in, vs his next season\n');
console.log('  pos   n     raw r    r after removing his own role');
for (const pos of ['WR', 'RB', 'TE']) {
  const rows = usage.filter((u) => String(u.position).toUpperCase() === pos);
  const control = pos === 'RB' ? 'rs' : 'ts';

  const raw: Array<[number, number]> = [];
  for (const u of rows) {
    const y = points.get(`${u.player_id}|${Number(u.season) + 1}`);
    const m = u.motion;
    if (y === undefined || typeof m !== 'number') continue;
    raw.push([m, y]);
  }

  const p = partial(rows, 'motion', control);
  console.log(
    `  ${pos.padEnd(4)} ${String(p.n).padStart(4)}   ${corr(raw).toFixed(3).padStart(7)}   ` +
      `${(Number.isNaN(p.r) ? '  -' : p.r.toFixed(3)).padStart(12)}`,
  );
}

console.log('\nfor comparison, the same test on metrics already in the model:');
console.log('  pos   metric            r after removing his own role');
for (const pos of ['WR', 'RB']) {
  const rows = usage.filter((u) => String(u.position).toUpperCase() === pos);
  const control = pos === 'RB' ? 'rs' : 'ts';
  for (const key of ['rz', 'pss']) {
    const p = partial(rows, key, control);
    const label = key === 'rz' ? 'red-zone share' : 'route share';
    console.log(`  ${pos.padEnd(4)}  ${label.padEnd(18)} ${p.r.toFixed(3).padStart(7)}  (n=${p.n})`);
  }
}

console.log('\nA metric only earns a place if it still predicts once the player’s own');
console.log('role is removed. Otherwise it is just restating target or rush share.');
