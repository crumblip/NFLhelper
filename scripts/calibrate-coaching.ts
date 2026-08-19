import { sqlite } from '../lib/db/index';

/**
 * Do play callers and offensive lines move fantasy points?
 *
 * Both are things everyone believes and almost nobody measures, and both are
 * easy to fool yourself about. A coach whose backs score well may simply have
 * been given good backs; a line that produces yards before contact may be
 * blocking for a runner defences respect. The tests below are built so a
 * believable story is not enough.
 *
 *   1. Are these team traits even STABLE year to year? An input that does not
 *      persist cannot forecast anything, whatever its correlation in-sample.
 *      This killed RB scheme fit already (r=-0.010).
 *   2. Do they predict next-season points once the player's own usage is
 *      accounted for? A line correlating with RB production is meaningless if
 *      good lines simply belong to teams that run more.
 *   3. Does a coach CHANGE move production? This is the closest thing to an
 *      experiment available: the same player, the same team, a different caller.
 *   4. Do individual coaches carry a repeatable signature — concentrating backfield
 *      work, or throwing to tight ends — that follows them between jobs?
 */

const FROM = 2021;

interface Season {
  playerId: string;
  name: string;
  season: number;
  position: string;
  team: string;
  points: number;
  games: number;
  rushShare: number;
  targetShare: number;
  next: number | null;
  ybcRank: number | null;
  ybc: number | null;
  stuffRate: number | null;
  passBlockRank: number | null;
  sackRate: number | null;
  coach: string | null;
  /** The coach in the FOLLOWING season, for the change test. */
  nextCoach: string | null;
  nextYbcRank: number | null;
}

const points = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, SUM(fantasy_points_half) p FROM player_stats_week
     WHERE season_type='REG' GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; p: number }>) {
  points.set(`${r.player_id}|${r.season}`, r.p);
}

const games = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, COUNT(DISTINCT week) g FROM snap_counts
     WHERE game_type='REG' AND player_id IS NOT NULL AND offense_snaps > 0
     GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; g: number }>) {
  games.set(`${r.player_id}|${r.season}`, r.g);
}

interface Ctx {
  coach: string | null; ybcRank: number | null; ybc: number | null;
  stuffRate: number | null; passBlockRank: number | null; sackRate: number | null;
  pointsRank: number | null;
}
const ctx = new Map<string, Ctx>();
for (const r of sqlite
  .prepare(
    `SELECT season, team, head_coach AS coach, ybc_rank AS ybcRank, ybc_per_carry AS ybc,
            stuff_rate AS stuffRate, pass_block_rank AS passBlockRank,
            sack_rate_allowed AS sackRate, points_rank AS pointsRank
     FROM team_context`,
  )
  .all() as Array<Ctx & { season: number; team: string }>) {
  ctx.set(`${r.team}|${r.season}`, r);
}

const seasonsPresent = new Set(
  (sqlite.prepare(`SELECT DISTINCT season FROM player_stats_week WHERE season_type='REG'`).all() as Array<{ season: number }>).map((r) => r.season),
);

const rows: Season[] = [];
for (const r of sqlite
  .prepare(
    `SELECT u.player_id AS playerId, p.display_name AS name, u.season, u.position, u.team,
            COALESCE(u.rush_share,0) rushShare, COALESCE(u.target_share,0) targetShare
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.season >= ? AND u.position IN ('QB','RB','WR','TE') AND u.team IS NOT NULL`,
  )
  .all(FROM) as Array<{
  playerId: string; name: string; season: number; position: string; team: string;
  rushShare: number; targetShare: number;
}>) {
  const g = games.get(`${r.playerId}|${r.season}`) ?? 0;
  if (g < 6) continue;
  const c = ctx.get(`${r.team}|${r.season}`);
  const nextG = games.get(`${r.playerId}|${r.season + 1}`) ?? 0;
  const next = seasonsPresent.has(r.season + 1)
    ? nextG > 0 ? points.get(`${r.playerId}|${r.season + 1}`) ?? 0 : 0
    : null;

  // The team he is on the FOLLOWING season, for the coach-change test.
  const nextTeam = (
    sqlite
      .prepare(`SELECT team FROM player_usage WHERE player_id=? AND season=?`)
      .get(r.playerId, r.season + 1) as { team: string } | undefined
  )?.team;
  const nextCtx = nextTeam ? ctx.get(`${nextTeam}|${r.season + 1}`) : undefined;

  rows.push({
    ...r,
    points: points.get(`${r.playerId}|${r.season}`) ?? 0,
    games: g,
    next,
    ybcRank: c?.ybcRank ?? null,
    ybc: c?.ybc ?? null,
    stuffRate: c?.stuffRate ?? null,
    passBlockRank: c?.passBlockRank ?? null,
    sackRate: c?.sackRate ?? null,
    coach: c?.coach ?? null,
    nextCoach: nextCtx?.coach ?? null,
    nextYbcRank: nextCtx?.ybcRank ?? null,
  });
}

/* ------------------------------------------------------------------ stats */

function pearson(xs: number[], ys: number[]): number {
  const k = xs.length;
  if (k < 4) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / k;
  const my = ys.reduce((a, b) => a + b, 0) / k;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < k; i++) {
    n += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return n / Math.sqrt(dx * dy || 1);
}
function residuals(ys: number[], cs: number[]): number[] {
  const k = ys.length;
  const mc = cs.reduce((a, b) => a + b, 0) / k;
  const my = ys.reduce((a, b) => a + b, 0) / k;
  let n = 0, d = 0;
  for (let i = 0; i < k; i++) { n += (cs[i]! - mc) * (ys[i]! - my); d += (cs[i]! - mc) ** 2; }
  const slope = d === 0 ? 0 : n / d;
  return ys.map((y, i) => y - (my + slope * (cs[i]! - mc)));
}
const partial = (xs: number[], ys: number[], cs: number[]) =>
  pearson(residuals(xs, cs), residuals(ys, cs));
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

/* ------------------------------------------- 1. are the traits stable? */

console.log('='.repeat(76));
console.log('1. STABILITY — does a team trait persist from one season to the next?');
console.log('='.repeat(76));
console.log('\nAn input that does not persist cannot forecast. This is the test that');
console.log('killed RB scheme fit (r=-0.010) and it is applied first every time now.\n');

const teamPairs = (field: keyof Ctx) => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [key, c] of ctx) {
    const [team, s] = key.split('|');
    const nxt = ctx.get(`${team}|${Number(s) + 1}`);
    const a = c[field];
    const b = nxt?.[field];
    if (typeof a === 'number' && typeof b === 'number') { xs.push(a); ys.push(b); }
  }
  return { r: pearson(xs, ys), n: xs.length };
};

for (const f of ['ybc', 'ybcRank', 'stuffRate', 'sackRate', 'passBlockRank', 'pointsRank'] as const) {
  const { r, n } = teamPairs(f);
  const verdict = Math.abs(r) >= 0.5 ? 'strongly persistent' : Math.abs(r) >= 0.3 ? 'persistent' : Math.abs(r) >= 0.15 ? 'weak' : 'NOT stable — cannot forecast';
  console.log(`  ${f.padEnd(15)} r=${r.toFixed(3)}  (n=${n})  ${verdict}`);
}

/* ----------------------------------- 2. does the line predict, net of usage */

console.log('\n' + '='.repeat(76));
console.log('2. THE LINE — does blocking predict next season, once usage is known?');
console.log('='.repeat(76));

for (const position of ['RB', 'QB']) {
  const pool = rows.filter((r) => r.position === position && r.next !== null);
  const control = position === 'RB' ? (r: Season) => r.rushShare : (r: Season) => r.rushShare;
  console.log(`\n  ${position} (n=${pool.length} season pairs, control = ${position === 'RB' ? 'rush share' : 'rush share'})`);
  console.log('  metric                     n      r    r|usage   verdict');

  const metrics: Array<[string, (r: Season) => number | null]> = [
    ['run block: yds before contact', (r) => r.ybc],
    ['run block rank (negated)', (r) => (r.ybcRank === null ? null : -r.ybcRank)],
    ['stuff rate (negated)', (r) => (r.stuffRate === null ? null : -r.stuffRate)],
    ['pass block rank (negated)', (r) => (r.passBlockRank === null ? null : -r.passBlockRank)],
    ['sack rate allowed (negated)', (r) => (r.sackRate === null ? null : -r.sackRate)],
  ];

  for (const [label, get] of metrics) {
    const usable = pool.filter((r) => get(r) !== null);
    if (usable.length < 40) { console.log(`  ${label.padEnd(28)} ${String(usable.length).padStart(3)}  too few`); continue; }
    const xs = usable.map((r) => get(r)!);
    const ys = usable.map((r) => r.next!);
    const cs = usable.map(control);
    const r = pearson(xs, ys);
    const pr = partial(xs, ys, cs);
    const verdict = Math.abs(pr) >= 0.25 ? 'STRONG' : Math.abs(pr) >= 0.18 ? 'real' : Math.abs(pr) >= 0.12 ? 'small' : 'nothing';
    console.log(`  ${label.padEnd(28)} ${String(usable.length).padStart(3)} ${r.toFixed(3).padStart(6)} ${pr.toFixed(3).padStart(8)}   ${verdict}`);
  }
}

/* ------------------------------------------------ 3. does a coach change move it? */

console.log('\n' + '='.repeat(76));
console.log('3. COACH CHANGE — same player, same team, different caller');
console.log('='.repeat(76));
console.log('\nThe cleanest quasi-experiment available. Restricted to players who stayed');
console.log('with their team, so the only thing that moved is who is calling plays.\n');

const stayed = rows.filter(
  (r) => r.next !== null && r.coach && r.nextCoach && r.games >= 8,
);
const changed = stayed.filter((r) => r.coach !== r.nextCoach);
const kept = stayed.filter((r) => r.coach === r.nextCoach);

for (const position of ['RB', 'WR', 'TE', 'QB']) {
  const c = changed.filter((r) => r.position === position);
  const k = kept.filter((r) => r.position === position);
  if (c.length < 10 || k.length < 10) {
    console.log(`  ${position}: changed n=${c.length}, kept n=${k.length} — too few`);
    continue;
  }
  // Change in points, so a good player regressing is not mistaken for a coach
  // effect. Both groups are compared on the same quantity.
  const dChanged = mean(c.map((r) => r.next! - r.points));
  const dKept = mean(k.map((r) => r.next! - r.points));
  console.log(
    `  ${position}: new coach n=${String(c.length).padStart(3)} change ${dChanged >= 0 ? '+' : ''}${dChanged.toFixed(1)} pts  ·  ` +
      `same coach n=${String(k.length).padStart(3)} change ${dKept >= 0 ? '+' : ''}${dKept.toFixed(1)} pts  ·  ` +
      `difference ${(dChanged - dKept >= 0 ? '+' : '')}${(dChanged - dKept).toFixed(1)}`,
  );
}

/* ----------------------------------------- 4. do coaches have a signature? */

console.log('\n' + '='.repeat(76));
console.log('4. COACH SIGNATURE — is backfield concentration a property of the coach?');
console.log('='.repeat(76));
console.log('\nThe Canales question: does a caller reliably feed one back, and does that');
console.log('tendency travel with him? Measured as the top back\'s share of team carries.\n');

const backfield = new Map<string, { coach: string; team: string; season: number; top: number }>();
for (const r of rows.filter((x) => x.position === 'RB' && x.coach)) {
  const key = `${r.team}|${r.season}`;
  const cur = backfield.get(key);
  if (!cur || r.rushShare > cur.top) {
    backfield.set(key, { coach: r.coach!, team: r.team, season: r.season, top: r.rushShare });
  }
}

// Same coach, consecutive seasons: does his concentration repeat?
const sig: Array<[number, number]> = [];
for (const [key, a] of backfield) {
  const [team, s] = key.split('|');
  const nxt = backfield.get(`${team}|${Number(s) + 1}`);
  if (nxt && nxt.coach === a.coach) sig.push([a.top, nxt.top]);
}
console.log(
  `  same coach, consecutive years: r=${pearson(sig.map((p) => p[0]), sig.map((p) => p[1])).toFixed(3)} (n=${sig.length})`,
);

const diff: Array<[number, number]> = [];
for (const [key, a] of backfield) {
  const [team, s] = key.split('|');
  const nxt = backfield.get(`${team}|${Number(s) + 1}`);
  if (nxt && nxt.coach !== a.coach) diff.push([a.top, nxt.top]);
}
console.log(
  `  coach CHANGED, same team:      r=${pearson(diff.map((p) => p[0]), diff.map((p) => p[1])).toFixed(3)} (n=${diff.length})`,
);
console.log(
  '\n  If the first is much higher than the second, backfield concentration is a\n' +
    '  property of the coach. If they are similar, it is a property of the roster.',
);

// Coaches with the most concentrated backfields, for reference.
const byCoach = new Map<string, number[]>();
for (const b of backfield.values()) {
  const arr = byCoach.get(b.coach) ?? [];
  arr.push(b.top);
  byCoach.set(b.coach, arr);
}
const ranked = [...byCoach.entries()]
  .filter(([, v]) => v.length >= 2)
  .map(([c, v]) => ({ coach: c, n: v.length, top: mean(v) }))
  .sort((a, b) => b.top - a.top);
console.log('\n  most concentrated backfields (top back\'s mean share of carries, 2+ seasons):');
for (const c of ranked.slice(0, 6)) {
  console.log(`    ${c.coach.padEnd(22)} ${(c.top * 100).toFixed(1)}%  (${c.n} seasons)`);
}
console.log('  least concentrated:');
for (const c of ranked.slice(-6).reverse()) {
  console.log(`    ${c.coach.padEnd(22)} ${(c.top * 100).toFixed(1)}%  (${c.n} seasons)`);
}
