import { sqlite } from '../lib/db/index';
import { ComparableIndex, type ProfileFeatures } from '../lib/pipeline/comparables';

/**
 * Does UPSIDE actually outrank VALUE late, as the board claims?
 *
 * The board says VALUE "stops separating players late, where almost everyone
 * projects below replacement — use UPSIDE there", and the whole back half of the
 * read rests on that. It had never been tested, because `player_outlook` only
 * stores the current season and the rates live inside a JSON blob, so there was
 * no historical series to score.
 *
 * This rebuilds the comparables from scratch for each past season, using only
 * seasons before it, and scores the two rankings against what players actually
 * did. `ComparableIndex` already takes the season as a cut-off — its pool query
 * is `WHERE u.season < ?` — so the walk-forward is honest without touching it.
 *
 * SAMPLE LIMIT, stated up front because it bounds everything below. Usage rows
 * exist for 2021-2025, and a comparable season is only usable once the FOLLOWING
 * season has been played. So the pool for 2024 is two seasons and for 2025 is
 * three, against the four the shipped board uses. That handicaps the model here
 * relative to what ships, and it leaves two testable drafts. Two folds cannot
 * settle a question; they can show whether the claim survives contact at all.
 */

const SEASONS = [2024, 2025];
const LATE = 100;

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
const repl = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT season, position, points FROM replacement_level WHERE format='half-ppr' AND teams=12`)
  .all() as Array<{ season: number; position: string; points: number }>) {
  repl.set(`${r.season}|${r.position}`, r.points);
}

interface Row {
  season: number; name: string; position: string; adp: number;
  breakout: number | null; bust: number | null; sparse: boolean;
  actual: number; vorp: number;
}
const panel: Row[] = [];

for (const S of SEASONS) {
  // Everything the index sees is from seasons strictly before S.
  const index = new ComparableIndex(pts, S, 'half-ppr', 12);

  const drafted = sqlite
    .prepare(
      `SELECT a.player_id AS pid, a.name, a.position, a.adp,
              COALESCE(u.target_share,0) targetShare, COALESCE(u.pass_snap_share,0) routeShare,
              COALESCE(u.rz_touch_share,0) rzShare, COALESCE(u.goal_line_share,0) goalLineShare,
              COALESCE(u.rush_share,0) rushShare,
              ? - CAST(substr(p.birth_date,1,4) AS INTEGER) age,
              u.games
       FROM adp_raw a
       JOIN players p ON p.gsis_id = a.player_id
       JOIN player_usage u ON u.player_id = a.player_id AND u.season = ? - 1
       WHERE a.year = ? AND a.format='half-ppr' AND a.teams=12 AND a.player_id IS NOT NULL
         AND u.games >= 6`,
    )
    .all(S, S, S) as Array<Record<string, never>>;

  for (const raw of drafted) {
    const r = raw as unknown as {
      pid: string; name: string; position: string; adp: number; age: number; games: number;
      targetShare: number; routeShare: number; rzShare: number; goalLineShare: number; rushShare: number;
    };
    const actual = pts.get(`${r.pid}|${S}`);
    if (actual === undefined || r.age === null) continue;

    const ownPoints = pts.get(`${r.pid}|${S - 1}`) ?? 0;
    const f: ProfileFeatures = {
      targetShare: r.targetShare, routeShare: r.routeShare, rzShare: r.rzShare,
      goalLineShare: r.goalLineShare, rushShare: r.rushShare, age: r.age,
      ppg: r.games ? ownPoints / r.games : 0,
      availability: Math.min(1, r.games / 17),
    };
    const o = index.outlook(r.position, f, r.pid);
    panel.push({
      season: S, name: r.name, position: r.position, adp: r.adp,
      breakout: o && !o.sparse ? o.breakoutRate : null,
      bust: o && !o.sparse ? o.bustRate : null,
      sparse: Boolean(o?.sparse),
      actual, vorp: actual - (repl.get(`${S}|${r.position}`) ?? 0),
    });
  }
  console.log(
    `${S}: rebuilt comparables from seasons before ${S}; ` +
      `${panel.filter((x) => x.season === S).length} drafted players scored, ` +
      `${panel.filter((x) => x.season === S && x.sparse).length} with no usable neighbourhood.`,
  );
}

/*
 * The percentile within position and draft band, which is what the board
 * actually shows. The raw rate is not comparable across positions — median
 * breakout is 35% for a QB and 7% for a receiver — so ranking the raw number
 * just sorts by position, which is the bug this column had for its whole life.
 */
const band = (adp: number) => (adp < 60 ? 'early' : 'late');
function pctileOf(r: Row, which: 'breakout' | 'bust'): number | null {
  const v = which === 'breakout' ? r.breakout : r.bust;
  if (v === null) return null;
  const pool = panel
    .filter((x) => x.season === r.season && x.position === r.position && band(x.adp) === band(r.adp))
    .map((x) => (which === 'breakout' ? x.breakout : x.bust))
    .filter((x): x is number => x !== null);
  if (pool.length < 5) return null;
  return (pool.filter((x) => x < v).length / pool.length) * 100;
}
for (const r of panel) {
  (r as Row & { bp: number | null; up: number | null }).bp = pctileOf(r, 'breakout');
  (r as Row & { bp: number | null; up: number | null }).up = pctileOf(r, 'bust');
}
type Scored = Row & { bp: number | null; up: number | null };
const scored = panel as Scored[];

console.log(`\n${scored.length} drafted player-seasons with a rebuilt outlook.\n`);

/* ------------------------------------------------------------------------ */

console.log('== does UPSIDE outrank the draft order, by band? ==');
console.log('   Spearman against what each player actually scored. ADP stands in for VALUE,');
console.log('   which tracks it at .905 on the live board.\n');
console.log('   band            n     draft order   UPSIDE (pctile)   BUST (pctile)   raw breakout');
for (const [label, lo, hi] of [
  ['rounds 1-3', 1, 36], ['rounds 4-6', 37, 72], ['rounds 7-10', 73, 120], ['rounds 11+', 121, 999],
] as Array<[string, number, number]>) {
  const g = scored.filter((r) => r.adp >= lo && r.adp <= hi && r.bp !== null);
  if (g.length < 15) { console.log(`   ${label.padEnd(14)} ${g.length} too few`); continue; }
  const a = g.map((r) => r.actual);
  console.log(
    `   ${label.padEnd(14)} ${String(g.length).padStart(3)}   ` +
      `${spearman(g.map((r) => -r.adp), a).toFixed(3).padStart(11)}   ` +
      `${spearman(g.map((r) => r.bp!), a).toFixed(3).padStart(15)}   ` +
      `${spearman(g.map((r) => r.up!), a).toFixed(3).padStart(13)}   ` +
      `${spearman(g.map((r) => r.breakout!), a).toFixed(3).padStart(12)}`,
  );
}

console.log('\n\n== the claim, stated as the board states it ==');
console.log(`   "VALUE stops separating players late — use UPSIDE there." Late = ADP ${LATE}+.\n`);
const late = scored.filter((r) => r.adp >= LATE && r.bp !== null);
if (late.length >= 20) {
  const a = late.map((r) => r.actual);
  const byAdp = spearman(late.map((r) => -r.adp), a);
  const byUp = spearman(late.map((r) => r.bp!), a);
  console.log(`   n=${late.length}   draft order ${byAdp.toFixed(3)}   UPSIDE ${byUp.toFixed(3)}   ` +
    `difference ${(byUp - byAdp >= 0 ? '+' : '') + (byUp - byAdp).toFixed(3)}`);

  // What a drafter actually does: take the top quarter by each and compare.
  const hitRate = (key: (r: Scored) => number) => {
    let hits = 0, total = 0;
    for (const S of SEASONS) {
      const g = late.filter((r) => r.season === S);
      if (g.length < 8) continue;
      const k = Math.max(3, Math.round(g.length * 0.25));
      const top = [...g].sort((x, y) => key(y) - key(x)).slice(0, k);
      hits += top.filter((r) => r.vorp > 0).length;
      total += k;
    }
    return { hits, total };
  };
  const base = late.filter((r) => r.vorp > 0).length / late.length;
  const byUpside = hitRate((r) => r.bp!);
  const byPrice = hitRate((r) => -r.adp);
  console.log(`\n   of the top quarter each one nominates, share that cleared replacement:`);
  console.log(`     by UPSIDE      ${byUpside.hits}/${byUpside.total} (${(byUpside.hits / byUpside.total * 100).toFixed(0)}%)`);
  console.log(`     by draft order ${byPrice.hits}/${byPrice.total} (${(byPrice.hits / byPrice.total * 100).toFixed(0)}%)`);
  console.log(`     base rate among all late picks: ${(base * 100).toFixed(0)}%`);
} else {
  console.log(`   only ${late.length} late picks have a usable outlook — not testable.`);
}

console.log('\n\n== who the sparse rows are ==');
console.log('   a player with no close analogue gets no upside number at all, and the');
console.log('   players with the fewest analogues are the best ones.\n');
for (const S of SEASONS) {
  const sp = scored.filter((r) => r.season === S && r.sparse).sort((a, b) => a.adp - b.adp);
  if (!sp.length) continue;
  console.log(`   ${S}: ${sp.length} of ${scored.filter((r) => r.season === S).length} — ` +
    sp.slice(0, 6).map((r) => `${r.name} (${Math.round(r.adp)})`).join(', '));
}

/* ------------------------------------------------------------------------ */

/*
 * The raw breakout rate looks strong in some bands, and it is an artefact.
 *
 * Pooled across positions, "raw breakout rate predicts points" is mostly
 * "quarterbacks have high breakout rates AND score more points than receivers".
 * Both sides of that correlation are driven by position, so the number measures
 * the position and not the player. Scoring WITHIN each position-season removes
 * it, and is the only version of this comparison that means anything — it is the
 * choice a drafter faces, which is between players at one position.
 */
console.log('\n\n== the same question, scored WITHIN position ==');
console.log('   pooled numbers above flatter the raw rate: quarterbacks have both the');
console.log('   highest breakout rates and the highest point totals, so a pooled');
console.log('   correlation is largely measuring which position a player plays.\n');
console.log('   band            n     draft order   UPSIDE (pctile)   raw breakout');
for (const [label, lo, hi] of [
  ['rounds 1-3', 1, 36], ['rounds 4-6', 37, 72], ['rounds 7-10', 73, 120], ['rounds 11+', 121, 999],
] as Array<[string, number, number]>) {
  const g = scored.filter((r) => r.adp >= lo && r.adp <= hi && r.bp !== null);
  if (g.length < 15) continue;
  const within = (key: (r: Scored) => number) => {
    let s = 0, t = 0;
    for (const S of SEASONS) {
      for (const pos of ['WR', 'RB', 'TE', 'QB']) {
        const gg = g.filter((r) => r.season === S && r.position === pos);
        if (gg.length < 5) continue;
        s += spearman(gg.map(key), gg.map((r) => r.actual)) * gg.length;
        t += gg.length;
      }
    }
    return t ? s / t : NaN;
  };
  const a = within((r) => -r.adp), b = within((r) => r.bp!), c = within((r) => r.breakout!);
  console.log(
    `   ${label.padEnd(14)} ${String(g.length).padStart(3)}   ` +
      `${(Number.isNaN(a) ? '—' : a.toFixed(3)).padStart(11)}   ` +
      `${(Number.isNaN(b) ? '—' : b.toFixed(3)).padStart(15)}   ` +
      `${(Number.isNaN(c) ? '—' : c.toFixed(3)).padStart(12)}`,
  );
}
console.log('\n   Within position the raw rate and the percentile are the same ordering,');
console.log('   so any gap between those two columns pooled was position, not signal.');

/* ------------------------------------------------------------------------ */

/*
 * Does BUST add anything to UPSIDE, or is it one measurement shown twice?
 *
 * The two correlate at −0.80 to −0.90 raw. That alone does not settle it —
 * `calibrate:blend` found two heavily correlated signals where one still carried
 * real independent information, and `calibrate:coaching` found two where one did
 * not. The test is the partial: does either survive once the other is known?
 *
 * This is the same test that demoted startability from a signal to a unit, and
 * the same one `calibrate:advanced` exists to apply. Everything is ranked WITHIN
 * position-season before pooling, because the raw rates are not comparable
 * across positions and a pooled correlation on them is mostly measuring which
 * position a player plays.
 */

/** Partial correlation of x with y, holding c fixed. */
function partial(x: number[], y: number[], c: number[]): number {
  const rxy = pearson(x, y), rxc = pearson(x, c), ryc = pearson(y, c);
  const d = Math.sqrt((1 - rxc ** 2) * (1 - ryc ** 2));
  return d ? (rxy - rxc * ryc) / d : 0;
}

/**
 * Ranks within position-season, standardised, then pooled.
 *
 * Comparing a quarterback's bust rate to a receiver's is meaningless, so every
 * quantity is turned into its rank inside the group a drafter actually chooses
 * from and only then stacked together.
 */
interface Z { band: string; up: number; bust: number; act: number }
const zPool: Z[] = [];
{
  const bandOf = (adp: number) =>
    adp <= 36 ? 'rounds 1-3' : adp <= 72 ? 'rounds 4-6' : adp <= 120 ? 'rounds 7-10' : 'rounds 11+';
  /*
   * Grouped by season, position AND BAND — not just season and position.
   *
   * A first pass ranked across every ADP inside a position-season and only then
   * sorted the rows into bands, which meant the "rounds 11+" column was scoring
   * late players on their rank against the whole position, not against the
   * players a drafter is choosing between at that point. It disagreed with the
   * within-position table above by a wide margin (0.122 against 0.412) and the
   * table above is the one that matches how `ratePctile` actually works in the
   * build: position AND draft band.
   */
  const groups = new Map<string, Scored[]>();
  for (const r of scored) {
    if (r.bp === null || r.up === null) continue;
    const k = `${r.season}|${r.position}|${bandOf(r.adp)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const z = (v: number[]) => {
    const rk = ranks(v);
    const m = mean(rk);
    const s = Math.sqrt(mean(rk.map((x) => (x - m) ** 2))) || 1;
    return rk.map((x) => (x - m) / s);
  };
  for (const [, g] of groups) {
    if (g.length < 5) continue;
    const zu = z(g.map((r) => r.bp!));
    const zb = z(g.map((r) => r.up!));
    const za = z(g.map((r) => r.actual));
    g.forEach((r, i) => zPool.push({ band: bandOf(r.adp), up: zu[i]!, bust: zb[i]!, act: za[i]! }));
  }
}

console.log('\n\n== do UPSIDE and BUST carry separate information? ==');
console.log('   ranked within position-season, then pooled. the partial is the test:');
console.log('   a signal that only restates the other one adds nothing to it.\n');
console.log('   band            n     UPSIDE   BUST     UPSIDE|BUST   BUST|UPSIDE   corr(U,B)');
for (const label of ['rounds 1-3', 'rounds 4-6', 'rounds 7-10', 'rounds 11+', 'ALL']) {
  const g = label === 'ALL' ? zPool : zPool.filter((r) => r.band === label);
  if (g.length < 25) { console.log(`   ${label.padEnd(14)} ${g.length} too few`); continue; }
  const u = g.map((r) => r.up), b = g.map((r) => r.bust), a = g.map((r) => r.act);
  console.log(
    `   ${label.padEnd(14)} ${String(g.length).padStart(3)}   ` +
      `${pearson(u, a).toFixed(3).padStart(6)}   ${pearson(b, a).toFixed(3).padStart(6)}   ` +
      `${partial(u, a, b).toFixed(3).padStart(11)}   ${partial(b, a, u).toFixed(3).padStart(11)}   ` +
      `${pearson(u, b).toFixed(3).padStart(9)}`,
  );
}
console.log('\n   BUST is signed so that negative means "more bust risk, fewer points".');

/* ------------------------------------------------------------------------ */

/*
 * If they are one measurement, what is the best single expression of it?
 *
 * Averaging two correlated readings of the same latent quantity cancels part of
 * the noise in each — that is the standard reason to combine rather than pick.
 * But the gain is only real if it shows up, so this scores the average against
 * each component instead of assuming it. The axis runs bust-to-breakout: high is
 * good, so bust is flipped before averaging.
 */
console.log('\n\n== one axis: is the average better than either half? ==');
console.log('   combined = (upside rank + reversed bust rank) / 2, all within position');
console.log('   and band. scored against what the player actually did.\n');
console.log('   band            n     UPSIDE only   BUST only (flipped)   COMBINED   best');
for (const label of ['rounds 1-3', 'rounds 4-6', 'rounds 7-10', 'rounds 11+', 'ALL']) {
  const g = label === 'ALL' ? zPool : zPool.filter((r) => r.band === label);
  if (g.length < 25) continue;
  const a = g.map((r) => r.act);
  const up = pearson(g.map((r) => r.up), a);
  // Bust is signed so that MORE bust means fewer points; flip it to face the
  // same way as upside before comparing or averaging.
  const bu = pearson(g.map((r) => -r.bust), a);
  const co = pearson(g.map((r) => (r.up - r.bust) / 2), a);
  const best = co >= up && co >= bu ? 'combined' : up >= bu ? 'upside' : 'bust';
  console.log(
    `   ${label.padEnd(14)} ${String(g.length).padStart(3)}   ${up.toFixed(3).padStart(11)}   ` +
      `${bu.toFixed(3).padStart(19)}   ${co.toFixed(3).padStart(8)}   ${best}`,
  );
}
console.log('\n   A combined axis that only ties its halves is still the honest surface —');
console.log('   two columns of one measurement invite double-counting. But it has to at');
console.log('   least not LOSE, or picking one half would be simpler and just as good.');
