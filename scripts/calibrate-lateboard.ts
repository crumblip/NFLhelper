import { sqlite } from '../lib/db/index';

/**
 * Should the late board be split by whether a player held a role?
 *
 * `diagnose-deadband` found that past pick 120 the draft order ranks established
 * players at rho .307 and unproven ones at .345, against .193 pooled. Both
 * subgroups beat the mixture, which is the signature of two populations being
 * interleaved on an ordering that cannot compare them.
 *
 * That was one split, one threshold and four seasons, chosen after looking at
 * the data. Before it ships, three things need checking:
 *
 *   1. WHERE does splitting start helping? The boundary was picked from the
 *      band table, and `diagnose-deadband` has already shown once that a band
 *      edge chosen after the fact is not a measurement.
 *   2. WHAT counts as holding a role? "10+ games and 80+ points" was typed, not
 *      measured. A threshold that fires on almost everyone or almost nobody
 *      carries no information (family #2).
 *   3. Does it survive leave-one-season-out? An improvement found and scored on
 *      the same four seasons is not an improvement.
 */

const SEASONS = [2022, 2023, 2024, 2025];
const POS = ['WR', 'RB', 'TE', 'QB'] as const;

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
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
  season: number; name: string; pos: string; adp: number;
  actual: number; vorp: number; priorGames: number; priorPts: number; priorShare: number;
}
const panel: Row[] = [];
for (const S of SEASONS) {
  for (const a of sqlite
    .prepare(
      `SELECT a.player_id pid, a.name, a.position pos, a.adp,
              COALESCE(u.target_share,0) ts, COALESCE(u.rush_share,0) rs
       FROM adp_raw a
       LEFT JOIN player_usage u ON u.player_id = a.player_id AND u.season = ? - 1
       WHERE a.year=? AND a.format='half-ppr' AND a.teams=12 AND a.player_id IS NOT NULL`,
    )
    .all(S, S) as Array<{ pid: string; name: string; pos: string; adp: number; ts: number; rs: number }>) {
    const actual = pts.get(`${a.pid}|${S}`);
    if (actual === undefined) continue;
    panel.push({
      season: S, name: a.name, pos: a.pos, adp: a.adp, actual,
      vorp: actual - (repl.get(`${S}|${a.pos}`) ?? 0),
      priorGames: games.get(`${a.pid}|${S - 1}`) ?? 0,
      priorPts: pts.get(`${a.pid}|${S - 1}`) ?? 0,
      priorShare: a.pos === 'RB' ? a.rs : a.ts,
    });
  }
}

/** Spearman of draft order against points, pooled over position-season groups. */
function rank(rows: Row[]): number {
  let s = 0, t = 0;
  for (const S of SEASONS) for (const pos of POS) {
    const g = rows.filter((r) => r.season === S && r.pos === pos);
    if (g.length < 5) continue;
    s += spearman(g.map((r) => -r.adp), g.map((r) => r.actual)) * g.length;
    t += g.length;
  }
  return t ? s / t : NaN;
}
/** Weighted mean of the within-group rankings — what splitting the board buys. */
function split(rows: Row[], held: (r: Row) => boolean): { pooled: number; split: number; nA: number; nB: number } {
  const a = rows.filter(held), b = rows.filter((r) => !held(r));
  const ra = rank(a), rb = rank(b);
  const wa = Number.isNaN(ra) ? 0 : a.length, wb = Number.isNaN(rb) ? 0 : b.length;
  return {
    pooled: rank(rows),
    split: wa + wb ? ((Number.isNaN(ra) ? 0 : ra * wa) + (Number.isNaN(rb) ? 0 : rb * wb)) / (wa + wb) : NaN,
    nA: a.length, nB: b.length,
  };
}

console.log(`${panel.length} drafted player-seasons, ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}.\n`);

/* -- 1. where does splitting start helping? -------------------------------- */

const HELD = (r: Row) => r.priorGames >= 10 && r.priorPts >= 80;

console.log('== 1. WHERE does splitting help? ==');
console.log('   swept over the cutoff rather than assuming pick 121, because the last band');
console.log('   edge chosen after the fact turned out to be an artefact.\n');
console.log('   from pick    n     pooled   split by role   gain      held / unproven');
for (const cut of [61, 73, 85, 97, 109, 121, 133]) {
  const g = panel.filter((r) => r.adp >= cut);
  if (g.length < 40) continue;
  const s = split(g, HELD);
  console.log(
    `   ${String(cut).padStart(9)} ${String(g.length).padStart(5)}   ${s.pooled.toFixed(3).padStart(6)}   ` +
      `${s.split.toFixed(3).padStart(13)}   ${((s.split - s.pooled >= 0 ? '+' : '') + (s.split - s.pooled).toFixed(3)).padStart(6)}      ${s.nA} / ${s.nB}`,
  );
}

/* -- 2. what should "held a role" mean? ------------------------------------ */

console.log('\n\n== 2. WHAT counts as holding a role? ==');
console.log('   a definition that fires on nearly everyone or nearly nobody carries no');
console.log('   information about anyone. late board only (pick 121+).\n');
const late = panel.filter((r) => r.adp >= 121);
const DEFS: Array<[string, (r: Row) => boolean]> = [
  ['10+ games AND 80+ points', (r) => r.priorGames >= 10 && r.priorPts >= 80],
  ['10+ games', (r) => r.priorGames >= 10],
  ['80+ points', (r) => r.priorPts >= 80],
  ['played at all last season', (r) => r.priorGames > 0],
  ['8+ games AND 60+ points', (r) => r.priorGames >= 8 && r.priorPts >= 60],
  ['12+ games AND 100+ points', (r) => r.priorGames >= 12 && r.priorPts >= 100],
  ['10%+ of his team\'s volume', (r) => r.priorShare >= 0.10],
];
console.log('   definition                       fires on   pooled   split   gain');
for (const [label, f] of DEFS) {
  const s = split(late, f);
  const fires = ((s.nA / late.length) * 100).toFixed(0);
  console.log(
    `   ${label.padEnd(32)} ${(fires + '%').padStart(8)}   ${s.pooled.toFixed(3).padStart(6)}   ` +
      `${s.split.toFixed(3).padStart(5)}   ${((s.split - s.pooled >= 0 ? '+' : '') + (s.split - s.pooled).toFixed(3)).padStart(6)}`,
  );
}

/* -- 3. does it survive leave-one-season-out? ------------------------------ */

console.log('\n\n== 3. LEAVE ONE SEASON OUT ==');
console.log('   the gain above was found and scored on the same four seasons. this scores');
console.log('   each season on its own, which is the only version that means anything.\n');
console.log('   season    n     pooled   split by role   gain');
let sp = 0, sl = 0, tot = 0;
for (const S of SEASONS) {
  const g = late.filter((r) => r.season === S);
  if (g.length < 15) { console.log(`   ${S}   ${g.length} too few`); continue; }
  const a = g.filter(HELD), b = g.filter((r) => !HELD(r));
  const one = (rows: Row[]) => {
    let s = 0, t = 0;
    for (const pos of POS) {
      const gg = rows.filter((r) => r.pos === pos);
      if (gg.length < 5) continue;
      s += spearman(gg.map((r) => -r.adp), gg.map((r) => r.actual)) * gg.length;
      t += gg.length;
    }
    return t ? { r: s / t, n: t } : null;
  };
  const pooled = one(g);
  const ra = one(a), rb = one(b);
  if (!pooled) continue;
  const splitR =
    (ra ? ra.r * ra.n : 0) + (rb ? rb.r * rb.n : 0);
  const splitN = (ra?.n ?? 0) + (rb?.n ?? 0);
  if (!splitN) continue;
  const sv = splitR / splitN;
  console.log(
    `   ${S}   ${String(g.length).padStart(4)}   ${pooled.r.toFixed(3).padStart(6)}   ${sv.toFixed(3).padStart(13)}   ` +
      `${((sv - pooled.r >= 0 ? '+' : '') + (sv - pooled.r).toFixed(3)).padStart(6)}`,
  );
  sp += pooled.r * g.length; sl += sv * g.length; tot += g.length;
}
console.log(`\n   weighted mean — pooled ${(sp / tot).toFixed(4)}  ·  split ${(sl / tot).toFixed(4)}  ·  ` +
  `${((sl - sp) / tot >= 0 ? '+' : '') + ((sl - sp) / tot).toFixed(4)}`);

/* -- 4. what each group is actually worth ---------------------------------- */

console.log('\n\n== 4. what the two groups return, so the split says something useful ==\n');
console.log('   group                    n     mean pts   cleared replacement   top-24 at position');
for (const [label, f] of [['held a role', HELD], ['did not', (r: Row) => !HELD(r)]] as Array<[string, (r: Row) => boolean]>) {
  const g = late.filter(f);
  if (!g.length) continue;
  let top = 0;
  for (const r of g) {
    const peers = panel.filter((x) => x.season === r.season && x.pos === r.pos).sort((a, b) => b.actual - a.actual);
    if (peers.slice(0, 24).some((x) => x.name === r.name)) top++;
  }
  console.log(
    `   ${label.padEnd(22)} ${String(g.length).padStart(4)}   ${mean(g.map((r) => r.actual)).toFixed(0).padStart(8)}   ` +
      `${((g.filter((r) => r.vorp > 0).length / g.length) * 100).toFixed(0).padStart(19)}%   ` +
      `${((top / g.length) * 100).toFixed(0).padStart(17)}%`,
  );
}

/* -- 5. how much of this is one season? ------------------------------------ */

/*
 * 2025 alone moves from .393 to .886 on 24 players. A rank correlation of .886
 * over position groups of five or six is not a stable estimate of anything, and
 * a mean that leans on it is reporting that season rather than the effect. So:
 * drop each season in turn and see whether the finding survives without it.
 */
console.log('\n\n== 5. is it one season? ==');
console.log('   the gain, recomputed with each season dropped in turn.\n');
console.log('   dropping   n     pooled   split   gain');
for (const drop of [null, ...SEASONS] as Array<number | null>) {
  const g = late.filter((r) => drop === null || r.season !== drop);
  if (g.length < 40) continue;
  const s = split(g, HELD);
  console.log(
    `   ${(drop === null ? 'nothing' : String(drop)).padEnd(9)} ${String(g.length).padStart(4)}   ` +
      `${s.pooled.toFixed(3).padStart(6)}   ${s.split.toFixed(3).padStart(5)}   ` +
      `${((s.split - s.pooled >= 0 ? '+' : '') + (s.split - s.pooled).toFixed(3)).padStart(6)}`,
  );
}

/*
 * And the plainest version of the claim, which needs no correlation at all:
 * inside each group, does taking the earlier pick actually get you more? If the
 * split is real, the answer is yes within each group and muddier across them.
 */
console.log('\n   plainest form — mean points by half of the late board, within each group:\n');
console.log('   group            earlier half   later half   difference');
for (const [label, f] of [['held a role', HELD], ['did not', (r: Row) => !HELD(r)]] as Array<[string, (r: Row) => boolean]>) {
  const g = late.filter(f).sort((a, b) => a.adp - b.adp);
  if (g.length < 20) continue;
  const half = Math.floor(g.length / 2);
  const early = mean(g.slice(0, half).map((r) => r.actual));
  const later = mean(g.slice(half).map((r) => r.actual));
  console.log(
    `   ${label.padEnd(16)} ${early.toFixed(0).padStart(12)}   ${later.toFixed(0).padStart(10)}   ` +
      `${((early - later >= 0 ? '+' : '') + (early - later).toFixed(0)).padStart(10)}`,
  );
}
const allLate = [...late].sort((a, b) => a.adp - b.adp);
const h = Math.floor(allLate.length / 2);
console.log(
  `   ${'pooled'.padEnd(16)} ${mean(allLate.slice(0, h).map((r) => r.actual)).toFixed(0).padStart(12)}   ` +
    `${mean(allLate.slice(h).map((r) => r.actual)).toFixed(0).padStart(10)}   ` +
    `${(mean(allLate.slice(0, h).map((r) => r.actual)) - mean(allLate.slice(h).map((r) => r.actual))).toFixed(0).padStart(10)}`,
);
