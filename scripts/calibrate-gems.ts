import { sqlite } from '../lib/db/index';

/**
 * Can this board find a gem or a bust at all?
 *
 * Written because the board returned exactly one GEM (Charbonnet, and only
 * because Kenneth Walker left) and eighteen BUST RISKs that all carried high
 * VALUE, which is the same as having no opinion. Rather than retune the tags,
 * this asks the prior question: is there a signal to find, and is the board
 * looking in a place where one could be.
 *
 * THE TARGET VARIABLE IS THE WHOLE ARGUMENT. The tool defines a bust as
 * finishing below replacement. A drafter means "returned less than the pick
 * cost", and at the top of the draft those are wildly different: Brian Thomas
 * Jr went at pick 14 in 2025 and returned +5 VORP — a disaster at that price,
 * and a pass under the replacement definition. Austin Ekeler in 2023 went 3rd
 * and returned +6 against a slot that historically returns +129. Everything
 * below is measured against the SLOT, fitted per position on the other seasons.
 *
 * Everything is within position. Target share does not mean the same thing to a
 * back and a receiver, and pooling them is the cross-position family that has
 * already produced four bugs here.
 */

const SEASONS = [2022, 2023, 2024, 2025];
const POS = ['WR', 'RB', 'TE', 'QB'] as const;

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sdev = (a: number[]) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; dbb += (b[i]! - mb) ** 2;
  }
  return da && dbb ? n / Math.sqrt(da * dbb) : 0;
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

/* ------------------------------------------------------------------- load */

const pts = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, SUM(fantasy_points_half) p FROM player_stats_week
            WHERE season_type='REG' GROUP BY player_id, season`)
  .all() as Array<{ player_id: string; season: number; p: number }>)
  pts.set(`${r.player_id}|${r.season}`, r.p);

const appear = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, COUNT(DISTINCT week) g FROM snap_counts
            WHERE game_type='REG' AND player_id IS NOT NULL AND offense_snaps>0
            GROUP BY player_id, season`)
  .all() as Array<{ player_id: string; season: number; g: number }>)
  appear.set(`${r.player_id}|${r.season}`, r.g);

interface U { games: number; ts: number | null; rs: number | null; pss: number | null; rz: number | null; fd: number }
const usage = new Map<string, U>();
for (const r of sqlite
  .prepare(`SELECT u.player_id, u.season, u.games, u.target_share ts, u.rush_share rs,
                   u.pass_snap_share pss, u.rz_touch_share rz,
                   (COALESCE(s.rush_first_downs,0)+COALESCE(s.rec_first_downs,0)) fd
            FROM player_usage u
            LEFT JOIN player_scheme s ON s.player_id=u.player_id AND s.season=u.season`)
  .all() as Array<Record<string, never>>) {
  const x = r as unknown as { player_id: string; season: number } & U;
  usage.set(`${x.player_id}|${x.season}`, x);
}
const historyBefore = (pid: string, S: number) => {
  let n = 0;
  for (let y = 2021; y < S; y++) { const u = usage.get(`${pid}|${y}`); if (u && (u.games ?? 0) >= 4) n++; }
  return n;
};

const draft = new Map<string, { season: number; pick: number }>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, pick FROM draft_picks WHERE player_id IS NOT NULL`)
  .all() as Array<{ player_id: string; season: number; pick: number }>)
  draft.set(r.player_id, { season: r.season, pick: r.pick });

const birth = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT gsis_id, birth_date FROM players WHERE birth_date IS NOT NULL`)
  .all() as Array<{ gsis_id: string; birth_date: string }>)
  birth.set(r.gsis_id, Number(String(r.birth_date).slice(0, 4)));

const repl = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT season, position, points FROM replacement_level WHERE format='half-ppr' AND teams=12`)
  .all() as Array<{ season: number; position: string; points: number }>)
  repl.set(`${r.season}|${r.position}`, r.points);

interface Row {
  season: number; pid: string; name: string; pos: string; adp: number;
  actual: number; vorp: number; slotExp: number | null; resid: number | null;
  age: number | null; isRookie: boolean; seasons: number; priorGames: number;
  ts: number | null; rs: number | null; pss: number | null; rz: number | null; fdpg: number | null;
}
const panel: Row[] = [];
for (const S of SEASONS)
  for (const a of sqlite
    .prepare(`SELECT player_id, name, position, adp FROM adp_raw
              WHERE year=? AND player_id IS NOT NULL AND format='half-ppr' AND teams=12`)
    .all(S) as Array<{ player_id: string; name: string; position: string; adp: number }>) {
    const actual = pts.get(`${a.player_id}|${S}`);
    if (actual === undefined) continue;
    const u = usage.get(`${a.player_id}|${S - 1}`);
    const dp = draft.get(a.player_id);
    const by = birth.get(a.player_id);
    const g = appear.get(`${a.player_id}|${S - 1}`) ?? 0;
    panel.push({
      season: S, pid: a.player_id, name: a.name, pos: a.position, adp: a.adp, actual,
      vorp: actual - (repl.get(`${S}|${a.position}`) ?? 0), slotExp: null, resid: null,
      age: by ? S - by : null, isRookie: dp ? dp.season === S : false,
      seasons: historyBefore(a.player_id, S), priorGames: g,
      ts: u?.ts ?? null, rs: u?.rs ?? null, pss: u?.pss ?? null, rz: u?.rz ?? null,
      fdpg: u && g >= 4 ? u.fd / g : null,
    });
  }

/* What the slot itself returns — fitted per position on the OTHER seasons. */
for (const r of panel) {
  const tr = panel.filter((x) => x.pos === r.pos && x.season !== r.season);
  if (tr.length < 20) continue;
  const X = tr.map((x) => Math.log(x.adp)), Y = tr.map((x) => x.vorp);
  const mx = mean(X), my = mean(Y);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < X.length; i++) { sxy += (X[i]! - mx) * (Y[i]! - my); sxx += (X[i]! - mx) ** 2; }
  const slope = sxy / sxx;
  r.slotExp = my - slope * mx + slope * Math.log(r.adp);
  r.resid = r.vorp - r.slotExp;
}

console.log(`${panel.length} drafted player-seasons with an outcome, ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}.\n`);

/* -- 1. is VALUE saying anything ADP does not? ----------------------------- */

console.log('== 1. how much of VALUE is just the draft board back again? ==\n');
const board = sqlite
  .prepare(`SELECT position, adp, blended_vorp v FROM value_scores
            WHERE season = (SELECT MAX(season) FROM value_scores) AND blended_vorp IS NOT NULL`)
  .all() as Array<{ position: string; adp: number; v: number }>;
console.log('   pos    n     spearman(VALUE, draft order)');
for (const p of [null, ...POS]) {
  const g = p ? board.filter((r) => r.position === p) : board;
  if (g.length < 8) continue;
  console.log(`   ${(p ?? 'ALL').padEnd(5)} ${String(g.length).padEnd(4)} ${spearman(g.map((r) => r.v), g.map((r) => -r.adp)).toFixed(3).padStart(24)}`);
}
console.log('\n   A board that reproduces ADP cannot disagree with it, and disagreeing');
console.log('   with it is the only way a gem or a bust can exist.');

/* -- 2. the two definitions of "bust" ------------------------------------- */

console.log('\n\n== 2. bust against replacement vs bust against the price ==\n');
const early = panel.filter((r) => r.adp <= 60 && r.resid !== null);
const hidden = early.filter((r) => r.vorp > 0 && r.resid! < -40);
console.log(`   ${early.length} early picks. ${early.filter((r) => r.vorp <= 0).length} finished below replacement.`);
console.log(`   ${hidden.length} cleared replacement while returning 40+ points LESS than their slot —`);
console.log('   invisible to any rule written against replacement, which is the rule shipped.\n');
console.log('   name                   season pos  adp    VORP   slot expects   vs price');
for (const r of [...early].sort((a, b) => a.resid! - b.resid!).slice(0, 10))
  console.log(`   ${r.name.padEnd(22)} ${r.season}  ${r.pos.padEnd(3)} ${String(Math.round(r.adp)).padStart(3)} ${r.vorp.toFixed(0).padStart(7)} ${r.slotExp!.toFixed(0).padStart(14)} ${r.resid!.toFixed(0).padStart(10)}`);

/* -- 3. what actually predicts a price-relative outcome ------------------- */

console.log('\n\n== 3. what predicts returning more or less than the pick cost? ==');
console.log('   within position, against the slot residual. NEGATIVE = predicts busting.\n');
for (const P of ['WR', 'RB', 'QB']) {
  const g = panel.filter((r) => r.pos === P && r.adp <= 60 && r.resid !== null);
  if (g.length < 25) continue;
  console.log(`   -- ${P} early picks (n=${g.length})`);
  for (const [label, f] of [
    ['prior pass-snap share', (r: Row) => r.pss], ['prior target share', (r: Row) => r.ts],
    ['prior rush share', (r: Row) => r.rs], ['prior red-zone share', (r: Row) => r.rz],
    ['prior first downs/game', (r: Row) => r.fdpg], ['prior games', (r: Row) => r.priorGames],
    ['age', (r: Row) => r.age], ['seasons of history', (r: Row) => r.seasons],
  ] as Array<[string, (r: Row) => number | null]>) {
    const rows = g.map((r) => ({ v: f(r), y: r.resid! })).filter((x) => x.v !== null && Number.isFinite(x.v));
    if (rows.length < 20) continue;
    const rr = pearson(rows.map((x) => x.v as number), rows.map((x) => x.y));
    console.log(`      ${label.padEnd(24)} ${rr >= 0 ? '+' : ''}${rr.toFixed(3)}  (n=${rows.length})`);
  }
  console.log();
}
console.log('   Everything lands inside +/-0.15. Predicting WHICH early pick busts, from');
console.log('   prior role and within position, is close to a coin flip on this sample.');
console.log('   Any tag claiming to do it is claiming more than the data supports.');

/* -- 4. the age reason inside the bust tag -------------------------------- */

console.log('\n\n== 4. the bust tag fires on "aging and already missing time" ==\n');
for (const P of ['WR', 'RB']) {
  const g = panel.filter((r) => r.pos === P && r.adp <= 60 && r.resid !== null && r.age !== null);
  const cut = P === 'RB' ? 28 : 30;
  const old = g.filter((r) => r.age! >= cut), young = g.filter((r) => r.age! < cut);
  if (old.length < 4) continue;
  console.log(`   ${P}  age>=${cut}: n=${old.length}, returns ${mean(old.map((r) => r.resid!)).toFixed(0)} vs price · ` +
    `younger: n=${young.length}, returns ${mean(young.map((r) => r.resid!)).toFixed(0)} · r(age, residual) ${pearson(g.map((r) => r.age!), g.map((r) => r.resid!)).toFixed(3)}`);
}
console.log('\n   For backs the sign is the wrong way round entirely.');

/* -- 5. where the late hits come from ------------------------------------- */

console.log('\n\n== 5. where do late-round hits actually come from? ==\n');
const late = panel.filter((r) => r.adp >= 100);
console.log(`   ${late.length} picks at ADP 100+, ${late.filter((r) => r.vorp > 0).length} cleared replacement.\n`);
console.log('   group              n     clears replacement    mean vs price');
for (const [label, f] of [
  ['rookie', (r: Row) => r.isRookie],
  ['0-1 prior seasons', (r: Row) => !r.isRookie && r.seasons <= 1],
  ['2 prior seasons', (r: Row) => !r.isRookie && r.seasons === 2],
  ['3+ prior seasons', (r: Row) => !r.isRookie && r.seasons >= 3],
] as Array<[string, (r: Row) => boolean]>) {
  const s = late.filter(f);
  if (s.length < 5) continue;
  console.log(`   ${label.padEnd(18)} ${String(s.length).padStart(3)}   ${((s.filter((r) => r.vorp > 0).length / s.length) * 100).toFixed(0).padStart(17)}%   ` +
    `${mean(s.filter((r) => r.resid !== null).map((r) => r.resid!)).toFixed(0).padStart(13)}`);
}
console.log('\n   the biggest late hits in the sample:');
for (const h of [...late].sort((a, b) => b.vorp - a.vorp).slice(0, 10))
  console.log(`     ${h.season} ${h.name.padEnd(22)} ${h.pos} adp ${String(Math.round(h.adp)).padStart(3)}  VORP ${h.vorp.toFixed(0).padStart(4)}  ` +
    `${h.isRookie ? 'ROOKIE' : h.seasons <= 1 ? '2nd yr' : 'vet   '}`);

/* -- 6. the confidence shrinkage, on its own terms ------------------------ */

console.log('\n\n== 6. the confidence shrinkage ==');
console.log('   build-blend keeps min(1, seasons/3) x min(1, games/12) of an uncovered');
console.log('   player\'s own projection and replaces the rest with his draft slot.');
console.log('   Its premise is not "young players are worse" — it is "we know less about');
console.log('   them". So: is the spread of outcomes around the slot actually wider?\n');
for (const [label, lo, hi] of [['early 1-60', 1, 60], ['middle 61-119', 61, 119], ['late 120+', 120, 999]] as Array<[string, number, number]>) {
  const g = panel.filter((r) => r.adp >= lo && r.adp <= hi && r.resid !== null);
  console.log(`   ${label}`);
  for (const [bl, f] of [
    ['rookie', (r: Row) => r.isRookie], ['0-1 seasons', (r: Row) => !r.isRookie && r.seasons <= 1],
    ['2 seasons', (r: Row) => !r.isRookie && r.seasons === 2], ['3+ seasons', (r: Row) => !r.isRookie && r.seasons >= 3],
  ] as Array<[string, (r: Row) => boolean]>) {
    const s = g.filter(f);
    if (s.length < 5) { console.log(`      ${bl.padEnd(14)} n=${s.length} too few`); continue; }
    console.log(`      ${bl.padEnd(14)} n=${String(s.length).padStart(3)}  mean vs price ${mean(s.map((r) => r.resid!)).toFixed(0).padStart(5)}   spread ${sdev(s.map((r) => r.resid!)).toFixed(0).padStart(4)}`);
  }
  console.log();
}
console.log('   The spread does not fall with experience — early it RISES (43 -> 77) and');
console.log('   late it is flat. A 67-100% haircut is not supported by that.');
