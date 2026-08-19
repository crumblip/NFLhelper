import { sqlite } from '../lib/db/index';

/**
 * Who actually inherits volume when a player leaves?
 *
 * `opportunity.ts` answers this with three judgment numbers and it has been
 * wrong twice. `ARRIVAL_CLAIM` gives every new name on a depth chart a fixed
 * share of the vacancy — 0.7 / 0.35 / 0.15 / 0.08 by listed rank — and SUMS
 * them. Philadelphia lists thirteen receivers and eight tight ends in camp, so
 * a rookie at WR2, another rookie at TE2 and two journeymen absorbed 83% of the
 * vacancy A.J. Brown left, and DeVonta Smith — the incumbent WR1, 24% target
 * share, listed first — came out with 7% of his team's targets open. The same
 * shape erases the six biggest vacancies in the league: MIA 53% -> 9%, WAS 52%
 * -> 5%, PHI 43% -> 7%, NYG 39% -> 4%, TEN 35% -> 4%, SF 34% -> 3%.
 *
 * Bug #12 already fixed one version of this and the numbers stayed guesses. So
 * measure them instead. Everything here is observable: who left, who arrived,
 * what each of them held before, and what the men who stayed ended up with.
 *
 * DEFINITIONAL NOTE. At calibration time "departed" means no usage row for that
 * team in season S — which folds in retirement, being cut, a trade and a lost
 * season. At apply time the only thing available in August is the depth chart.
 * The two do not coincide exactly, and the gap is one-directional: a player who
 * is on the camp roster and then misses the year reads as present here and
 * absent there. Worth remembering before treating these coefficients as exact.
 */

const FROM = 2021;
const TO = 2025;

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; dbb += (b[i]! - mb) ** 2;
  }
  return da && dbb ? n / Math.sqrt(da * dbb) : 0;
}
/** Partial correlation of x with y holding c fixed. */
function partial(x: number[], y: number[], c: number[]): number {
  const rxy = pearson(x, y), rxc = pearson(x, c), ryc = pearson(y, c);
  const d = Math.sqrt((1 - rxc ** 2) * (1 - ryc ** 2));
  return d ? (rxy - rxc * ryc) / d : 0;
}

interface U { pid: string; season: number; team: string; pos: string; ts: number; rs: number; games: number }
const usage: U[] = (
  sqlite
    .prepare(
      `SELECT player_id pid, season, team, position pos,
              COALESCE(target_share,0) ts, COALESCE(rush_share,0) rs, games
       FROM player_usage
       WHERE team IS NOT NULL AND season BETWEEN ? AND ? AND position IN ('QB','RB','WR','TE')`,
    )
    .all(FROM, TO) as U[]
).map((r) => ({ ...r, pos: String(r.pos).toUpperCase() }));

const byTeamSeason = new Map<string, U[]>();
const byPlayerSeason = new Map<string, U>();
for (const r of usage) {
  const k = `${r.team}|${r.season}`;
  if (!byTeamSeason.has(k)) byTeamSeason.set(k, []);
  byTeamSeason.get(k)!.push(r);
  byPlayerSeason.set(`${r.pid}|${r.season}`, r);
}
/** Any team he held a role on that season — used to tell "left" from "vanished". */
const teamsIn = new Map<string, Set<string>>();
for (const r of usage) {
  const k = `${r.pid}|${r.season}`;
  if (!teamsIn.has(k)) teamsIn.set(k, new Set());
  teamsIn.get(k)!.add(r.team);
}

const pts = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, SUM(fantasy_points_half) p FROM player_stats_week
            WHERE season_type='REG' GROUP BY player_id, season`)
  .all() as Array<{ player_id: string; season: number; p: number }>)
  pts.set(`${r.player_id}|${r.season}`, r.p);

const draft = new Map<string, { season: number; pick: number }>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, pick FROM draft_picks WHERE player_id IS NOT NULL`)
  .all() as Array<{ player_id: string; season: number; pick: number }>)
  draft.set(r.player_id, r);

/* ---------------------------------------------------------------------- */
/* 1. what an incumbent actually inherits                                   */
/* ---------------------------------------------------------------------- */

interface Incumbent {
  pid: string; team: string; season: number; pos: string;
  pool: 'target' | 'rush';
  vacated: number;        // share of the pool held by players who left
  priorShare: number;
  nextShare: number;
  gain: number;
  queue: number;          // rank among RETURNING players by prior share, 1 = first in line
  arrivalWeight: number;  // prior-team share the arrivals brought with them
  /** Largest single share that walked out — an alpha leaving is not the same as churn. */
  biggestDeparture: number;
}
const inc: Incumbent[] = [];

for (const [key, prior] of byTeamSeason) {
  const team = key.split('|')[0]!;
  const S = Number(key.split('|')[1]) + 1;
  if (S > TO) continue;
  const next = byTeamSeason.get(`${team}|${S}`);
  if (!next) continue;

  const nextIds = new Set(next.map((r) => r.pid));

  for (const pool of ['target', 'rush'] as const) {
    const share = (r: U) => (pool === 'target' ? r.ts : r.rs);
    // Only the positions that compete for this pool.
    const relevant = prior.filter((r) =>
      pool === 'target' ? r.pos === 'WR' || r.pos === 'TE' || r.pos === 'RB' : r.pos === 'RB',
    );
    if (!relevant.length) continue;

    const departed = relevant.filter((r) => !nextIds.has(r.pid));
    const vacated = departed.reduce((a, r) => a + share(r), 0);
    if (vacated <= 0.02) continue;
    const biggestDeparture = Math.max(0, ...departed.map(share));

    // Arrivals, weighted by what they held elsewhere the season before — the
    // thing a depth-chart rank is a poor proxy for. A rookie brings 0.
    const arrivals = next.filter(
      (r) => !prior.some((p) => p.pid === r.pid) &&
        (pool === 'target' ? r.pos === 'WR' || r.pos === 'TE' || r.pos === 'RB' : r.pos === 'RB'),
    );
    const arrivalWeight = arrivals.reduce((a, r) => {
      const before = byPlayerSeason.get(`${r.pid}|${S - 1}`);
      return a + (before ? share(before) : 0);
    }, 0);

    const returning = relevant
      .filter((r) => nextIds.has(r.pid))
      .sort((a, b) => share(b) - share(a));

    returning.forEach((r, idx) => {
      const after = next.find((n) => n.pid === r.pid)!;
      if ((after.games ?? 0) < 4 || (r.games ?? 0) < 4) return;
      inc.push({
        pid: r.pid, team, season: S, pos: r.pos, pool,
        vacated, priorShare: share(r), nextShare: share(after),
        gain: share(after) - share(r), queue: idx + 1, arrivalWeight, biggestDeparture,
      });
    });
  }
}

console.log(`${inc.length} incumbent player-seasons where a team lost 2%+ of a pool, ${FROM}-${TO}.\n`);

console.log('== 1. how much of a vacancy does the man in front of it inherit? ==');
console.log('   gain = his share the following season minus his share before it.');
console.log('   "inherited" = gain / vacated, i.e. the fraction of the freed pool he took.\n');
for (const pool of ['target', 'rush'] as const) {
  const g = inc.filter((r) => r.pool === pool);
  if (g.length < 30) continue;
  console.log(`   -- ${pool} pool (n=${g.length})`);
  console.log('      queue   n     mean gain   inherited share   r(vacated, gain)');
  for (const q of [1, 2, 3, 4]) {
    const s = g.filter((r) => (q === 4 ? r.queue >= 4 : r.queue === q));
    if (s.length < 10) { console.log(`      ${q === 4 ? '4+' : q}       ${s.length} too few`); continue; }
    const inherited = mean(s.map((r) => r.gain / r.vacated));
    console.log(
      `      ${(q === 4 ? '4+' : String(q)).padEnd(6)} ${String(s.length).padStart(3)}   ${mean(s.map((r) => r.gain)).toFixed(4).padStart(9)}   ` +
        `${inherited.toFixed(3).padStart(15)}   ${pearson(s.map((r) => r.vacated), s.map((r) => r.gain)).toFixed(3).padStart(16)}`,
    );
  }
  console.log();
}

console.log('   The shipped split is 60 / 25 / 15 by queue position, applied to a vacancy');
console.log('   that has already been cut by the arrival claim. Compare the fractions above.\n');

/* ---------------------------------------------------------------------- */
/* 2. what arrivals actually take                                           */
/* ---------------------------------------------------------------------- */

console.log('\n== 2. do arrivals really absorb the vacancy? ==');
console.log('   `arrivalWeight` is what the incoming players held on their OWN teams the');
console.log('   season before — 0 for a rookie. If absorption is real, an incumbent should');
console.log('   gain less when the arrivals brought volume with them.\n');
for (const pool of ['target', 'rush'] as const) {
  const g = inc.filter((r) => r.pool === pool && r.queue === 1);
  if (g.length < 30) continue;
  console.log(`   -- ${pool} pool, first in line (n=${g.length})`);
  console.log(`      r(arrival weight, gain) = ${pearson(g.map((r) => r.arrivalWeight), g.map((r) => r.gain)).toFixed(3)}   ` +
    `partial after vacated = ${partial(g.map((r) => r.arrivalWeight), g.map((r) => r.gain), g.map((r) => r.vacated)).toFixed(3)}`);
  for (const [label, f] of [
    ['no real arrivals (weight < 0.05)', (r: Incumbent) => r.arrivalWeight < 0.05],
    ['some (0.05 - 0.15)', (r: Incumbent) => r.arrivalWeight >= 0.05 && r.arrivalWeight < 0.15],
    ['heavy (0.15+)', (r: Incumbent) => r.arrivalWeight >= 0.15],
  ] as Array<[string, (r: Incumbent) => boolean]>) {
    const s = g.filter(f);
    if (s.length < 8) { console.log(`      ${label.padEnd(34)} n=${s.length} too few`); continue; }
    console.log(`      ${label.padEnd(34)} n=${String(s.length).padStart(3)}  mean gain ${mean(s.map((r) => r.gain)).toFixed(4).padStart(8)}  ` +
      `inherited ${mean(s.map((r) => r.gain / r.vacated)).toFixed(3)}`);
  }
  console.log();
}

/* ---------------------------------------------------------------------- */
/* 3. does a rookie arrival absorb anything?                                */
/* ---------------------------------------------------------------------- */

/*
 * The case the whole feature exists for: an ALPHA leaves, not a committee.
 *
 * Pooling every team that lost 2% of a pool answers a different question from
 * the one a drafter asks about DeVonta Smith. Churn at the bottom of a roster
 * and A.J. Brown walking out with 29.5% of the targets are not the same event,
 * and averaging them together would hide the second inside the first.
 */
console.log('\n== 2b. when a genuine alpha departs, does the man behind him gain? ==\n');
for (const pool of ['target', 'rush'] as const) {
  const g = inc.filter((r) => r.pool === pool && r.queue === 1);
  if (g.length < 30) continue;
  console.log(`   -- ${pool} pool, first in line (n=${g.length})`);
  console.log('      biggest single departure   n     mean gain   inherited share');
  for (const [label, lo, hi] of [
    ['under 10%', 0, 0.1], ['10-20%', 0.1, 0.2], ['20%+  (an alpha)', 0.2, 1],
  ] as Array<[string, number, number]>) {
    const s = g.filter((r) => r.biggestDeparture >= lo && r.biggestDeparture < hi);
    if (s.length < 8) { console.log(`      ${label.padEnd(26)} n=${s.length} too few`); continue; }
    console.log(`      ${label.padEnd(26)} ${String(s.length).padStart(3)}   ${mean(s.map((r) => r.gain)).toFixed(4).padStart(9)}   ${mean(s.map((r) => r.gain / r.vacated)).toFixed(3).padStart(15)}`);
  }
  const alpha = g.filter((r) => r.biggestDeparture >= 0.2);
  if (alpha.length >= 8) {
    console.log(`      r(size of that departure, gain) = ${pearson(g.map((r) => r.biggestDeparture), g.map((r) => r.gain)).toFixed(3)}`);
    console.log('      the biggest gainers when an alpha left:');
    const named = alpha
      .map((r) => ({ ...r, name: (sqlite.prepare(`SELECT display_name n FROM players WHERE gsis_id=?`).get(r.pid) as { n: string } | undefined)?.n ?? r.pid }))
      .sort((a, b) => b.gain - a.gain);
    for (const r of named.slice(0, 6))
      console.log(`        ${r.season} ${r.team} ${r.name.padEnd(22)} ${(r.priorShare * 100).toFixed(0)}% -> ${(r.nextShare * 100).toFixed(0)}%  (${r.gain >= 0 ? '+' : ''}${(r.gain * 100).toFixed(1)}pp, ${(r.biggestDeparture * 100).toFixed(0)}pp walked out)`);
    for (const r of named.slice(-3))
      console.log(`        ${r.season} ${r.team} ${r.name.padEnd(22)} ${(r.priorShare * 100).toFixed(0)}% -> ${(r.nextShare * 100).toFixed(0)}%  (${r.gain >= 0 ? '+' : ''}${(r.gain * 100).toFixed(1)}pp)`);
  }
  console.log();
}

/*
 * The raw gain is confounded and cannot answer the question.
 *
 * Share is bounded and reverts: a back already holding 68% of the carries can
 * only fall, and one holding 16% has room. Dameon Pierce going 74% -> 39% is
 * regression from an extreme, not a failure to inherit, yet it lands in the same
 * average as Chase Brown going 16% -> 64%. That is why the pooled mean gain came
 * out NEGATIVE for every queue position while individual inheritances ran to
 * +48 points of share.
 *
 * The specification that answers it holds prior share fixed:
 *
 *     nextShare = a + b x priorShare + c x vacated
 *
 * `c` is the fraction of a freed pool that reaches this man once mean reversion
 * is accounted for. That is the number `opportunityFor` needs and the one the
 * 60/25/15 split was guessing at.
 */
console.log('\n== 2c. inheritance, holding prior share fixed ==');
console.log('   nextShare = a + b x priorShare + c x vacated.  c IS the inheritance rate.\n');

function ols2(rows: Array<{ x1: number; x2: number; y: number }>) {
  const n = rows.length;
  const mx1 = mean(rows.map((r) => r.x1)), mx2 = mean(rows.map((r) => r.x2)), my = mean(rows.map((r) => r.y));
  let s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0;
  for (const r of rows) {
    const a = r.x1 - mx1, b = r.x2 - mx2, c = r.y - my;
    s11 += a * a; s22 += b * b; s12 += a * b; s1y += a * c; s2y += b * c;
  }
  const det = s11 * s22 - s12 * s12;
  if (!det) return null;
  const b1 = (s22 * s1y - s12 * s2y) / det;
  const b2 = (s11 * s2y - s12 * s1y) / det;
  // standard error on b2, so a coefficient can be told from noise
  let sse = 0;
  for (const r of rows) sse += (r.y - (my + b1 * (r.x1 - mx1) + b2 * (r.x2 - mx2))) ** 2;
  const sigma2 = sse / Math.max(1, n - 3);
  const se2 = Math.sqrt((sigma2 * s11) / det);
  return { bPrior: b1, bVacated: b2, se: se2, n };
}

const INHERIT: Array<{ pool: string; queue: string; c: number; se: number; n: number }> = [];
for (const pool of ['target', 'rush'] as const) {
  console.log(`   -- ${pool} pool`);
  console.log('      queue    n    b(prior share)   c = INHERITANCE   std err   t');
  for (const [label, f] of [
    ['1', (r: Incumbent) => r.queue === 1],
    ['2', (r: Incumbent) => r.queue === 2],
    ['3', (r: Incumbent) => r.queue === 3],
    ['4+', (r: Incumbent) => r.queue >= 4],
  ] as Array<[string, (r: Incumbent) => boolean]>) {
    const g = inc.filter((r) => r.pool === pool && f(r));
    if (g.length < 20) { console.log(`      ${label.padEnd(7)} ${g.length} too few`); continue; }
    const fit = ols2(g.map((r) => ({ x1: r.priorShare, x2: r.vacated, y: r.nextShare })));
    if (!fit) continue;
    const t = fit.bVacated / (fit.se || 1);
    INHERIT.push({ pool, queue: label, c: fit.bVacated, se: fit.se, n: g.length });
    console.log(
      `      ${label.padEnd(7)} ${String(fit.n).padStart(3)}   ${fit.bPrior.toFixed(3).padStart(13)}   ${fit.bVacated.toFixed(3).padStart(15)}   ${fit.se.toFixed(3).padStart(7)}   ${t.toFixed(1).padStart(5)}${Math.abs(t) >= 2 ? '  *' : ''}`,
    );
  }
  console.log();
}
console.log('   * = the coefficient is at least two standard errors from zero.');
console.log('   The shipped rule assumes 0.60 / 0.25 / 0.15 of a vacancy reaches queue 1/2/3.\n');

console.log('\n== 3. rookies: the players the shipped rule charges most heavily ==');
console.log('   a camp depth chart lists a rookie at WR2 and the rule hands him 35% of the');
console.log('   vacancy. what share do rookies actually take in their first season?\n');
const rookieShares: Array<{ pick: number; ts: number; rs: number; pos: string }> = [];
for (const r of usage) {
  const d = draft.get(r.pid);
  if (!d || d.season !== r.season) continue;
  rookieShares.push({ pick: d.pick, ts: r.ts, rs: r.rs, pos: r.pos });
}
console.log('   draft round    n     mean target share   mean rush share');
for (const [label, lo, hi] of [['1 (1-32)', 1, 32], ['2 (33-64)', 33, 64], ['3 (65-105)', 65, 105], ['4-7 (106+)', 106, 300]] as Array<[string, number, number]>) {
  const s = rookieShares.filter((r) => r.pick >= lo && r.pick <= hi);
  if (s.length < 5) continue;
  const wr = s.filter((r) => r.pos === 'WR' || r.pos === 'TE');
  const rb = s.filter((r) => r.pos === 'RB');
  console.log(`   ${label.padEnd(13)} ${String(s.length).padStart(3)}   ${(wr.length ? mean(wr.map((r) => r.ts)) : 0).toFixed(3).padStart(17)}   ${(rb.length ? mean(rb.map((r) => r.rs)) : 0).toFixed(3).padStart(15)}`);
}

/* ---------------------------------------------------------------------- */
/* 4. known gap #7 — does vacated share belong in the projection?           */
/* ---------------------------------------------------------------------- */

console.log('\n\n== 4. does vacated share predict next-season POINTS, after current role? ==');
console.log('   the question known-gap #7 asks. if the partial is near zero, opportunity');
console.log('   belongs on the tags and nowhere near the projection.\n');
for (const pool of ['target', 'rush'] as const) {
  const g = inc.filter(
    (r) => r.pool === pool && pts.has(`${r.pid}|${r.season}`) && (pool === 'target' ? r.pos !== 'RB' : true),
  );
  if (g.length < 40) continue;
  const y = g.map((r) => pts.get(`${r.pid}|${r.season}`)!);
  const vac = g.map((r) => r.vacated);
  const role = g.map((r) => r.priorShare);
  console.log(`   ${pool} pool (n=${g.length})  r(vacated, next points) ${pearson(vac, y).toFixed(3)}   ` +
    `PARTIAL after his own prior share ${partial(vac, y, role).toFixed(3)}`);
  const first = g.filter((r) => r.queue === 1);
  if (first.length >= 25) {
    const y1 = first.map((r) => pts.get(`${r.pid}|${r.season}`)!);
    console.log(`     first in line only (n=${first.length}): partial ${partial(first.map((r) => r.vacated), y1, first.map((r) => r.priorShare)).toFixed(3)}`);
  }
}

/* ---------------------------------------------------------------------- */
/* 5. can the two even be separated?                                        */
/* ---------------------------------------------------------------------- */

/*
 * A zero coefficient is only a finding if the design could have shown a
 * non-zero one. Within a team the two regressors are near-complements — if the
 * lead back walked out with 67% of the carries then the man behind him held
 * something small, by construction — so collinearity could be hiding a real
 * effect inside the prior-share term. This is the check that decides whether
 * section 2c means "no inheritance" or "cannot tell".
 */
console.log('\n\n== 5. is the zero real, or is it collinearity? ==\n');
for (const pool of ['target', 'rush'] as const) {
  for (const q of [1, 2]) {
    const g = inc.filter((r) => r.pool === pool && r.queue === q);
    if (g.length < 25) continue;
    const rc = pearson(g.map((r) => r.priorShare), g.map((r) => r.vacated));
    // Same question without the collinear term: does vacated explain the part of
    // next season's share that prior share does NOT?
    const my = mean(g.map((r) => r.nextShare)), mx = mean(g.map((r) => r.priorShare));
    let sxy = 0, sxx = 0;
    for (const r of g) { sxy += (r.priorShare - mx) * (r.nextShare - my); sxx += (r.priorShare - mx) ** 2; }
    const slope = sxy / sxx;
    const resid = g.map((r) => r.nextShare - (my + slope * (r.priorShare - mx)));
    console.log(
      `   ${pool} queue ${q} (n=${g.length}): corr(prior share, vacated) = ${rc.toFixed(3)}   ` +
        `r(vacated, residual after prior share) = ${pearson(g.map((r) => r.vacated), resid).toFixed(3)}`,
    );
  }
}
console.log('\n   A correlation near -1 would mean the design cannot separate them.');
console.log('   The residual correlation is the same test without the collinear term.');
