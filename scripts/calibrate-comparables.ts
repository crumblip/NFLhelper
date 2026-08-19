import { sqlite } from '../lib/db/index';
import { buildCoverageProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

/**
 * Does the comparables lookup actually describe what happened next?
 *
 * The panel claims a floor, a median and a ceiling from the outcomes of the 40
 * most similar historical seasons. That claim is testable: run the same lookup
 * on a season whose following year is already known, and check whether the truth
 * landed where the method said it would. A 20th-to-80th percentile band should
 * contain the actual outcome 60% of the time. If it contains it 40% of the time
 * the band is too narrow; if it contains 85% the band is not saying anything.
 *
 * Each variant below changes exactly one thing, so the table reads as an ablation
 * rather than a redesign. Nothing here is asserted — the numbers printed are the
 * argument.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/* ---------------------------------------------------------------- outcomes */

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

/** Appearances from snap counts, not from stat lines — a healthy backup who
 *  never touched the ball still played the game (bug #40). */
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

/** Seasons the league actually played, so a 2021 17-game year is not compared
 *  against a 2020 16-game one on availability. */
const seasonLength = new Map<number, number>();
for (const r of sqlite
  .prepare(`SELECT season, MAX(week) w FROM player_stats_week WHERE season_type='REG' GROUP BY season`)
  .all() as Array<{ season: number; w: number }>) {
  seasonLength.set(r.season, r.w);
}

/* ---------------------------------------------------------------- the pool */

interface Season {
  playerId: string;
  name: string;
  season: number;
  position: string;
  targetShare: number;
  routeShare: number;
  rzShare: number;
  goalLineShare: number;
  rushShare: number;
  age: number;
  /** Half-PPR per game in THIS season — how productive the role actually was. */
  ppg: number;
  /** Games he was on the field for, as a share of the season. */
  availability: number;
  /** What he scored the FOLLOWING season. Zero when he never played again. */
  nextPoints: number;
  nextPpg: number;
  nextPlayed: boolean;
}

const raw = sqlite
  .prepare(
    `SELECT u.player_id AS playerId, p.display_name AS name, u.season, u.position,
            COALESCE(u.target_share, 0) AS targetShare,
            COALESCE(u.pass_snap_share, 0) AS routeShare,
            COALESCE(u.rz_touch_share, 0) AS rzShare,
            COALESCE(u.goal_line_share, 0) AS goalLineShare,
            COALESCE(u.rush_share, 0) AS rushShare,
            u.season - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.games >= 6 AND u.season < ? AND u.position IN ('QB','WR','RB','TE')`,
  )
  .all(CURRENT - 1) as Array<Omit<Season, 'ppg' | 'availability' | 'nextPoints' | 'nextPpg' | 'nextPlayed'>>;

const pool: Season[] = [];
for (const r of raw) {
  if (r.age === null || !Number.isFinite(r.age)) continue;
  const g = appearances.get(`${r.playerId}|${r.season}`) ?? 0;
  if (g < 6) continue;
  const own = points.get(`${r.playerId}|${r.season}`) ?? 0;
  const nextG = appearances.get(`${r.playerId}|${r.season + 1}`) ?? 0;
  const nextPts = points.get(`${r.playerId}|${r.season + 1}`) ?? 0;
  // A season with no following year at all cannot teach anything. A player who
  // HAD a following year and did not play in it is the most important row in
  // the table, and the current code throws it away.
  if (!seasonLength.has(r.season + 1)) continue;
  pool.push({
    ...r,
    ppg: own / g,
    availability: g / (seasonLength.get(r.season) ?? 17),
    nextPoints: nextPts,
    nextPpg: nextG > 0 ? nextPts / nextG : 0,
    nextPlayed: nextG > 0,
  });
}

/* ---------------------------------------------------------------- variants */

type FeatureKey =
  | 'targetShare' | 'routeShare' | 'rzShare' | 'goalLineShare' | 'rushShare'
  | 'age' | 'ppg' | 'availability';

const BASE: Record<string, Partial<Record<FeatureKey, number>>> = {
  WR: { targetShare: 3.0, routeShare: 1.6, rzShare: 2.2, goalLineShare: 1.0, rushShare: 0.2, age: 1.2 },
  TE: { targetShare: 3.0, routeShare: 1.8, rzShare: 2.0, goalLineShare: 1.0, rushShare: 0.1, age: 0.9 },
  RB: { targetShare: 1.8, routeShare: 1.4, rzShare: 2.4, goalLineShare: 1.6, rushShare: 3.0, age: 1.4 },
  QB: { targetShare: 0.0, routeShare: 3.0, rzShare: 1.4, goalLineShare: 1.2, rushShare: 2.4, age: 1.0 },
};

interface Variant {
  label: string;
  weights: Record<string, Partial<Record<FeatureKey, number>>>;
  k: number;
  /** Take only neighbours within this multiple of the nearest distance floor. */
  radius?: number;
  minK?: number;
  distanceWeighted?: boolean;
  excludeSelf?: boolean;
  /** Include seasons where the player never played again, as a zero. */
  includeVanished?: boolean;
  /**
   * Keep the vanished in the pool (so the hit and bust rates are honest) but
   * draw the floor/median/ceiling from the ones who kept playing.
   *
   * "His floor is 40" when 40 means "was out of the league" is not a floor a
   * reader can use — it answers a different question from the one the bar is
   * asking, and mixing the two makes the low end unreadable.
   */
  bandOverSurvivors?: boolean;
}

const withPpg = (w: number, a = 0) =>
  Object.fromEntries(
    Object.entries(BASE).map(([p, v]) => [p, { ...v, ppg: w, availability: a }]),
  ) as Record<string, Partial<Record<FeatureKey, number>>>;

const VARIANTS: Variant[] = [
  { label: 'A  as shipped (k=40, self allowed, vanished dropped)', weights: BASE, k: 40 },
  { label: 'B  + exclude the player himself', weights: BASE, k: 40, excludeSelf: true },
  { label: 'C  + count players who never played again', weights: BASE, k: 40, excludeSelf: true, includeVanished: true },
  { label: 'D  + production (ppg weight 1.5)', weights: withPpg(1.5), k: 40, excludeSelf: true, includeVanished: true },
  { label: 'E  + production (ppg weight 3.0)', weights: withPpg(3.0), k: 40, excludeSelf: true, includeVanished: true },
  { label: 'F  + production (ppg 3.0) + availability 1.0', weights: withPpg(3.0, 1.0), k: 40, excludeSelf: true, includeVanished: true },
  { label: 'G  E, distance-weighted quantiles', weights: withPpg(3.0), k: 40, excludeSelf: true, includeVanished: true, distanceWeighted: true },
  { label: 'H  G, adaptive neighbourhood (k<=40, radius 2x)', weights: withPpg(3.0), k: 40, minK: 12, radius: 2.0, excludeSelf: true, includeVanished: true, distanceWeighted: true },
  { label: 'I  H, tighter radius 1.5x', weights: withPpg(3.0), k: 40, minK: 12, radius: 1.5, excludeSelf: true, includeVanished: true, distanceWeighted: true },
  { label: 'J  E + availability 0.5', weights: withPpg(3.0, 0.5), k: 40, excludeSelf: true, includeVanished: true },
  { label: 'K  E, band over survivors only', weights: withPpg(3.0), k: 40, excludeSelf: true, includeVanished: true, bandOverSurvivors: true },
  { label: 'L  J, band over survivors only', weights: withPpg(3.0, 0.5), k: 40, excludeSelf: true, includeVanished: true, bandOverSurvivors: true },
  { label: 'M  L, distance-weighted', weights: withPpg(3.0, 0.5), k: 40, excludeSelf: true, includeVanished: true, bandOverSurvivors: true, distanceWeighted: true },
];

/* ---------------------------------------------------------------- scoring */

function iqr(values: number[]): number {
  if (values.length < 4) return 1;
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.floor(s.length * p)]!;
  return q(0.75) - q(0.25) || 1;
}

/** Weighted quantile over (value, weight) pairs sorted by value. */
function wq(sorted: Array<{ v: number; w: number }>, p: number): number {
  const total = sorted.reduce((a, b) => a + b.w, 0);
  let acc = 0;
  for (const s of sorted) {
    acc += s.w;
    if (acc >= p * total) return s.v;
  }
  return sorted[sorted.length - 1]!.v;
}

interface Result {
  n: number;
  mae: number;
  r: number;
  coverage: number;
  /** Share of actual outcomes that came in ABOVE the stated ceiling. */
  overCeiling: number;
  underFloor: number;
  medianNeighbourDistance: number;
  /** Share of the k neighbours that sit past the code's own "no analogue" line. */
  strangerShare: number;
  /** Mean predicted chance of not playing again, against what actually happened. */
  vanishPredicted: number;
  vanishActual: number;
  /** Every headline median produced, to see whether they differ from each other. */
  medians: number[];
}

function run(v: Variant): Map<string, Result> {
  const out = new Map<string, Result>();

  for (const position of POSITIONS) {
    const all = pool.filter((r) => r.position === position);
    const usable = all.filter((r) => (v.includeVanished ? true : r.nextPlayed));
    if (usable.length < 60) continue;

    const w = v.weights[position]!;
    const keys = Object.keys(w).filter((k) => (w[k as FeatureKey] ?? 0) > 0) as FeatureKey[];

    // Scales from role-holders, as the shipped code does.
    const primary = (r: Season) =>
      position === 'RB' ? r.rushShare : position === 'QB' ? r.routeShare : r.targetShare;
    const holders = usable.filter((r) => primary(r) >= (position === 'QB' ? 0.4 : 0.1));
    const scalePool = holders.length >= 30 ? holders : usable;
    const scale = {} as Record<FeatureKey, number>;
    for (const k of keys) scale[k] = iqr(scalePool.map((r) => r[k])) || 1;

    const preds: number[] = [];
    const acts: number[] = [];
    let inside = 0, over = 0, under = 0, graded = 0;
    let vanishPred = 0, vanishAct = 0;
    const dists: number[] = [];
    let strangers = 0, neighbours = 0;

    for (const target of usable) {
      const scored: Array<{ r: Season; d: number }> = [];
      for (const cand of usable) {
        if (cand === target) continue;
        if (v.excludeSelf && cand.playerId === target.playerId) continue;
        let sum = 0;
        for (const k of keys) {
          // route share is missing before participation data; never read a gap
          // as a zero (bug #50)
          if (k === 'routeShare' && (cand.routeShare <= 0 || target.routeShare <= 0)) continue;
          sum += w[k]! * ((cand[k] - target[k]) / scale[k]!) ** 2;
        }
        scored.push({ r: cand, d: Math.sqrt(sum) });
      }
      scored.sort((a, b) => a.d - b.d);

      let picked = scored.slice(0, v.k);
      if (v.radius) {
        const near = scored[0]!.d;
        const cut = Math.max(near * v.radius, 0.6);
        const within = scored.filter((s) => s.d <= cut).slice(0, v.k);
        picked = within.length >= (v.minK ?? 12) ? within : scored.slice(0, v.minK ?? 12);
      }

      const weightOf = (d: number) => (v.distanceWeighted ? 1 / (0.35 + d) : 1);

      const all = picked
        .map((s) => ({ v: s.r.nextPoints, w: weightOf(s.d) }))
        .sort((a, b) => a.v - b.v);
      const band = v.bandOverSurvivors
        ? picked
            .filter((s) => s.r.nextPlayed)
            .map((s) => ({ v: s.r.nextPoints, w: weightOf(s.d) }))
            .sort((a, b) => a.v - b.v)
        : all;
      if (!band.length) continue;

      const med = wq(band, 0.5);
      const floor = wq(band, 0.2);
      const ceil = wq(band, 0.8);

      preds.push(med);
      acts.push(target.nextPoints);

      const wTotal = picked.reduce((a, s) => a + weightOf(s.d), 0);
      vanishPred += picked.reduce((a, s) => a + (s.r.nextPlayed ? 0 : weightOf(s.d)), 0) / wTotal;
      if (!target.nextPlayed) vanishAct++;

      // The band answers "how well did he do", which only has an answer for the
      // players who took the field. Whether he took the field at all is the
      // separate number beside it.
      if (target.nextPlayed) {
        graded++;
        if (target.nextPoints >= floor && target.nextPoints <= ceil) inside++;
        else if (target.nextPoints > ceil) over++;
        else under++;
      }

      dists.push(picked[Math.floor(picked.length / 2)]!.d);
      neighbours += picked.length;
      strangers += picked.filter((s) => s.d > 1.6).length;
    }

    const n = preds.length;
    const mp = preds.reduce((a, b) => a + b, 0) / n;
    const ma = acts.reduce((a, b) => a + b, 0) / n;
    let num = 0, dp = 0, da = 0, mae = 0;
    for (let i = 0; i < n; i++) {
      num += (preds[i]! - mp) * (acts[i]! - ma);
      dp += (preds[i]! - mp) ** 2;
      da += (acts[i]! - ma) ** 2;
      mae += Math.abs(preds[i]! - acts[i]!);
    }
    dists.sort((a, b) => a - b);

    out.set(position, {
      n,
      mae: mae / n,
      r: num / Math.sqrt(dp * da || 1),
      coverage: inside / (graded || 1),
      overCeiling: over / (graded || 1),
      underFloor: under / (graded || 1),
      medianNeighbourDistance: dists[Math.floor(dists.length / 2)]!,
      strangerShare: strangers / neighbours,
      vanishPredicted: vanishPred / n,
      vanishActual: vanishAct / n,
      medians: preds,
    });
  }

  return out;
}

/* ------------------------------------------------- neighbourhood quality */

/**
 * Is a thin neighbourhood actually worse, or does it just look worse?
 *
 * The shipped code decides a player is unprecedented from his single nearest
 * comp. That misses the case this whole exercise started from: Bijan Robinson's
 * nearest sits at 1.03 — a good match — while his 40th sits at 2.3, so 25 of the
 * 40 seasons setting his floor and ceiling are strangers. One close neighbour
 * says nothing about the other thirty-nine.
 *
 * This buckets every backtest target by the share of its neighbourhood that is
 * genuinely close, and reports whether the answer degrades. If it does not, the
 * quality label is decoration and should not ship.
 */
function qualityBuckets(v: Variant) {
  const CLOSE = 1.54; // the "loose match" line already used on the player page

  for (const position of POSITIONS) {
    const usable = pool.filter((r) => r.position === position);
    if (usable.length < 60) continue;

    const w = v.weights[position]!;
    const keys = Object.keys(w).filter((k) => (w[k as FeatureKey] ?? 0) > 0) as FeatureKey[];
    const primary = (r: Season) =>
      position === 'RB' ? r.rushShare : position === 'QB' ? r.routeShare : r.targetShare;
    const holders = usable.filter((r) => primary(r) >= (position === 'QB' ? 0.4 : 0.1));
    const scalePool = holders.length >= 30 ? holders : usable;
    const scale = {} as Record<FeatureKey, number>;
    for (const k of keys) scale[k] = iqr(scalePool.map((r) => r[k])) || 1;

    const buckets = new Map<string, { n: number; err: number; inside: number; graded: number }>();

    for (const target of usable) {
      const scored: Array<{ r: Season; d: number }> = [];
      for (const cand of usable) {
        if (cand.playerId === target.playerId) continue;
        let sum = 0;
        for (const k of keys) {
          if (k === 'routeShare' && (cand.routeShare <= 0 || target.routeShare <= 0)) continue;
          sum += w[k]! * ((cand[k] - target[k]) / scale[k]!) ** 2;
        }
        scored.push({ r: cand, d: Math.sqrt(sum) });
      }
      scored.sort((a, b) => a.d - b.d);
      const picked = scored.slice(0, v.k);
      const closeShare = picked.filter((s) => s.d <= CLOSE).length / picked.length;

      const band = picked
        .filter((s) => s.r.nextPlayed)
        .map((s) => ({ v: s.r.nextPoints, w: 1 / (0.35 + s.d) }))
        .sort((a, b) => a.v - b.v);
      if (!band.length) continue;

      const key =
        closeShare >= 0.9 ? '90-100% close' :
        closeShare >= 0.7 ? '70-89%  close' :
        closeShare >= 0.5 ? '50-69%  close' :
        closeShare >= 0.25 ? '25-49%  close' : '  0-24% close';

      const b = buckets.get(key) ?? { n: 0, err: 0, inside: 0, graded: 0 };
      b.n++;
      b.err += Math.abs(wq(band, 0.5) - target.nextPoints);
      if (target.nextPlayed) {
        b.graded++;
        if (target.nextPoints >= wq(band, 0.2) && target.nextPoints <= wq(band, 0.8)) b.inside++;
      }
      buckets.set(key, b);
    }

    console.log(`\n-- ${position}: does a thin neighbourhood hurt? --`);
    console.log('share of the 40 within 1.54     n     MAE   coverage');
    for (const key of ['90-100% close', '70-89%  close', '50-69%  close', '25-49%  close', '  0-24% close']) {
      const b = buckets.get(key);
      if (!b) continue;
      console.log(
        `${key.padEnd(28)} ${String(b.n).padStart(4)} ${(b.err / b.n).toFixed(1).padStart(7)} ` +
          `${(b.inside / (b.graded || 1)).toFixed(2).padStart(9)}`,
      );
    }
  }
}

/* ---------------------------------------------------------------- report */

console.log(`comparables backtest — ${pool.length} player-seasons, ${Math.min(...pool.map((p) => p.season))}-${Math.max(...pool.map((p) => p.season))}\n`);
console.log('coverage is the share of actual outcomes that landed inside the stated');
console.log('20th-80th band. It should be 0.60. below that the band is too confident;');
console.log('far above it the band is too wide to mean anything.\n');

for (const position of POSITIONS) {
  console.log(`\n== ${position} ==`);
  console.log('variant                                                  n    MAE     r   cover  >ceil  <floor  medDist  stranger  vanP  vanA');
  for (const v of VARIANTS) {
    const res = run(v).get(position);
    if (!res) continue;
    console.log(
      `${v.label.padEnd(52)} ${String(res.n).padStart(4)} ${res.mae.toFixed(1).padStart(6)} ` +
        `${res.r.toFixed(3).padStart(6)} ${res.coverage.toFixed(2).padStart(6)} ` +
        `${res.overCeiling.toFixed(2).padStart(6)} ${res.underFloor.toFixed(2).padStart(7)} ` +
        `${res.medianNeighbourDistance.toFixed(2).padStart(8)} ${res.strangerShare.toFixed(2).padStart(9)} ` +
        `${res.vanishPredicted.toFixed(2).padStart(5)} ${res.vanishActual.toFixed(2).padStart(5)}`,
    );
  }
}

console.log('\n\n================ neighbourhood quality (variant M) ================');
qualityBuckets(VARIANTS.find((v) => v.label.startsWith('M'))!);

/* ------------------------------------------------------------ how many? */

/**
 * k is a share of the pool, not an absolute.
 *
 * 40 neighbours is 6% of the 676 receiver seasons and 22% of the 179 quarterback
 * seasons, so the same number buys a tight neighbourhood at one position and
 * most of the position at another. Every starting quarterback was coming back
 * with the same median, which is a number carrying no information about him.
 */
console.log('\n\n================ how many neighbours? ================');
for (const position of POSITIONS) {
  console.log(`\n-- ${position} (pool ${pool.filter((r) => r.position === position).length}) --`);
  console.log('   k    MAE      r   cover   spread of medians   medDist');
  for (const k of [10, 15, 20, 25, 30, 40, 60]) {
    const v: Variant = {
      label: `k=${k}`, weights: withPpg(3.0, 0.5), k,
      excludeSelf: true, includeVanished: true, bandOverSurvivors: true, distanceWeighted: true,
    };
    const res = run(v).get(position);
    if (!res) continue;
    // How much the headline number actually varies between players. A method
    // that returns the same median for everyone has not distinguished anybody.
    const meds = res.medians;
    const mm = meds.reduce((a, b) => a + b, 0) / meds.length;
    const sdev = Math.sqrt(meds.reduce((a, b) => a + (b - mm) ** 2, 0) / meds.length);
    console.log(
      `${String(k).padStart(4)} ${res.mae.toFixed(1).padStart(6)} ${res.r.toFixed(3).padStart(6)} ` +
        `${res.coverage.toFixed(2).padStart(6)} ${sdev.toFixed(1).padStart(15)} ${res.medianNeighbourDistance.toFixed(2).padStart(9)}`,
    );
  }
}

/* ------------------------------------------------- the "no analogue" gate */

/**
 * Does the range actually fail for the players the page refuses to draw one for?
 *
 * `comparables.ts` returns early — no floor, no median, no ceiling — whenever a
 * player's single nearest historical season sits past his position's
 * `noAnalogue` band. 41 of 511 players hit that branch, including Puka Nacua,
 * Jaxon Smith-Njigba, Christian McCaffrey and Rashee Rice, so four of the twelve
 * most expensive players on the board show a comparison list and no chart while
 * everyone else shows both.
 *
 * `qualityBuckets` above already tested the OTHER quality axis — the share of
 * the forty that are genuine matches — and found the midpoint degrades while
 * interval coverage holds, which is why the shipped conclusion is "report
 * support and read the spread, do not suppress the range". The suppression gate
 * is a different quantity and has never been tested against that standard. This
 * does it, replicating the shipped gate exactly: the same 95th-percentile
 * nearest-distance band, floored at the median neighbour, then MAE and coverage
 * either side of it.
 *
 * If coverage holds at ~0.60 for the suppressed group the branch is removing a
 * band that works, and the honest surface is the range plus a strong caveat.
 */
function noAnalogueBucket(v: Variant) {
  console.log('the gate the player page uses to suppress the range entirely.');
  console.log('coverage should be 0.60. MAE is the error on the MIDPOINT only.\n');
  console.log('pos  band   group                    n     MAE   coverage');

  for (const position of POSITIONS) {
    const usable = pool.filter((r) => r.position === position);
    if (usable.length < 60) continue;

    const w = v.weights[position]!;
    const keys = Object.keys(w).filter((k) => (w[k as FeatureKey] ?? 0) > 0) as FeatureKey[];
    const primary = (r: Season) =>
      position === 'RB' ? r.rushShare : position === 'QB' ? r.routeShare : r.targetShare;
    const holders = usable.filter((r) => primary(r) >= (position === 'QB' ? 0.4 : 0.1));
    const scalePool = holders.length >= 30 ? holders : usable;
    const scale = {} as Record<FeatureKey, number>;
    for (const k of keys) scale[k] = iqr(scalePool.map((r) => r[k])) || 1;

    const dist = (a: Season, b: Season) => {
      let sum = 0;
      for (const k of keys) {
        if (k === 'routeShare' && (a.routeShare <= 0 || b.routeShare <= 0)) continue;
        sum += w[k]! * ((a[k] - b[k]) / scale[k]!) ** 2;
      }
      return Math.sqrt(sum);
    };

    // Every target's neighbourhood, computed once and reused for both the band
    // calibration and the bucketing — the shipped code does the same, and a band
    // measured on a different set than it is applied to would not be the gate.
    const rows = usable.map((target) => {
      const scored = usable
        .filter((c) => c.playerId !== target.playerId)
        .map((c) => ({ r: c, d: dist(c, target) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, v.k);
      return { target, picked: scored, nearest: scored[0]!.d, mid: scored[Math.floor(scored.length / 2)]!.d };
    });

    const at = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]!;
    const close = at(rows.map((x) => x.mid).sort((a, b) => a - b), 0.5);
    const noAnalogue = Math.max(at(rows.map((x) => x.nearest).sort((a, b) => a - b), 0.95), close);

    const buckets = new Map<string, { n: number; err: number; inside: number; graded: number }>();
    for (const { target, picked, nearest } of rows) {
      const band = picked
        .filter((s) => s.r.nextPlayed)
        .map((s) => ({ v: s.r.nextPoints, w: 1 / (0.35 + s.d) }))
        .sort((a, b) => a.v - b.v);
      if (!band.length) continue;

      const key = nearest > noAnalogue ? 'SUPPRESSED (no analogue)' : 'shown (has an analogue)';
      const b = buckets.get(key) ?? { n: 0, err: 0, inside: 0, graded: 0 };
      b.n++;
      b.err += Math.abs(wq(band, 0.5) - target.nextPoints);
      if (target.nextPlayed) {
        b.graded++;
        if (target.nextPoints >= wq(band, 0.2) && target.nextPoints <= wq(band, 0.8)) b.inside++;
      }
      buckets.set(key, b);
    }

    for (const key of ['shown (has an analogue)', 'SUPPRESSED (no analogue)']) {
      const b = buckets.get(key);
      if (!b) continue;
      console.log(
        `${position.padEnd(4)} ${noAnalogue.toFixed(2)}   ${key.padEnd(24)} ${String(b.n).padStart(4)} ` +
          `${(b.err / b.n).toFixed(1).padStart(7)} ${(b.inside / (b.graded || 1)).toFixed(2).padStart(10)}`,
      );
    }
  }
}

console.log('\n\n================ does the no-analogue gate earn its suppression? ================');
noAnalogueBucket(VARIANTS.find((v) => v.label.startsWith('M'))!);
