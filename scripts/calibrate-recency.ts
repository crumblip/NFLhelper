import { sqlite } from '../lib/db/index';

/**
 * In-season: how should current-year usage be read?
 *
 * `calibrate-inseason.ts` answered when this season overtakes last season. It
 * did not answer the question that matters once this season has taken over:
 * given N games played, is the best read of a player's role his season-to-date
 * average, or only his most recent few games?
 *
 * This is the central question for a waiver wire. The classic pickup is a backup
 * whose role changed three weeks ago — his season-to-date numbers still carry
 * the weeks he barely played, and averaging them understates what he is now. But
 * the project has already measured that year-over-year *change* does not predict
 * (−0.24 for WR route share), so a recency bias cannot simply be assumed to help
 * here either. It has to be measured.
 *
 * Three things are tested, per position, pooling every cut week with enough
 * games either side:
 *
 *   1. season-to-date opportunity per game    vs rest-of-season points per game
 *   2. last-3-game opportunity per game       vs the same
 *   3. the *delta* between them, after the level is removed — does "his role
 *      just changed" add anything beyond "his role is good"?
 *
 * Snap share is tested alongside opportunity because it is the cleaner signal of
 * a role change: a back who takes over gets the snaps immediately, while the
 * touches can lag a week behind game script.
 */

const MIN_REST_GAMES = 4;
const MIN_PRIOR_GAMES = 2;
const RECENT_WINDOW = 3;

interface Week {
  week: number;
  opportunity: number;
  snapPct: number | null;
  points: number;
}

const rows = sqlite
  .prepare(
    `SELECT s.player_id, s.season, s.week, s.position,
            COALESCE(s.targets, 0) + COALESCE(s.carries, 0) AS opportunity,
            -- nflverse ships snap share as a 0-1 fraction; scaled here so the
            -- thresholds below read as percentage points.
            sc.offense_pct * 100 AS snapPct,
            COALESCE(s.fantasy_points_half, 0) AS points
     FROM player_stats_week s
     LEFT JOIN snap_counts sc
       ON sc.player_id = s.player_id AND sc.season = s.season AND sc.week = s.week
     WHERE s.season_type = 'REG' AND s.position IN ('WR','RB','TE')
     ORDER BY s.player_id, s.season, s.week`,
  )
  .all() as Array<{
  player_id: string; season: number; week: number; position: string;
  opportunity: number; snapPct: number | null; points: number;
}>;

const byPlayerSeason = new Map<string, { position: string; weeks: Week[] }>();
for (const r of rows) {
  const key = `${r.player_id}|${r.season}`;
  const entry = byPlayerSeason.get(key) ?? { position: r.position, weeks: [] };
  entry.weeks.push({
    week: r.week,
    opportunity: r.opportunity,
    snapPct: r.snapPct,
    points: r.points,
  });
  byPlayerSeason.set(key, entry);
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

function corr(a: number[], b: number[]): number {
  if (a.length < 3) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

/** Correlation of a with c once b is removed from both — the marginal signal. */
function partial(a: number[], b: number[], c: number[]): number {
  const ab = corr(a, b);
  const ac = corr(a, c);
  const bc = corr(b, c);
  const denom = Math.sqrt((1 - ab * ab) * (1 - bc * bc));
  return denom ? (ac - ab * bc) / denom : NaN;
}

interface Sample {
  position: string;
  std: number;
  recent: number;
  delta: number;
  snapStd: number | null;
  snapRecent: number | null;
  snapDelta: number | null;
  restPpg: number;
}

const samples: Sample[] = [];

for (const { position, weeks } of byPlayerSeason.values()) {
  weeks.sort((a, b) => a.week - b.week);
  for (let cut = MIN_PRIOR_GAMES; cut <= weeks.length - MIN_REST_GAMES; cut++) {
    const prior = weeks.slice(0, cut);
    const rest = weeks.slice(cut);
    const recentWeeks = prior.slice(-RECENT_WINDOW);

    const std = mean(prior.map((w) => w.opportunity));
    const recent = mean(recentWeeks.map((w) => w.opportunity));

    const snapPrior = prior.map((w) => w.snapPct).filter((v): v is number => v !== null);
    const snapRecentArr = recentWeeks.map((w) => w.snapPct).filter((v): v is number => v !== null);
    const snapStd = snapPrior.length ? mean(snapPrior) : null;
    const snapRecent = snapRecentArr.length ? mean(snapRecentArr) : null;

    samples.push({
      position,
      std,
      recent,
      delta: recent - std,
      snapStd,
      snapRecent,
      snapDelta: snapStd !== null && snapRecent !== null ? snapRecent - snapStd : null,
      restPpg: mean(rest.map((w) => w.points)),
    });
  }
}

console.log('IN-SEASON RECENCY — what best predicts rest-of-season points per game?');
console.log(
  `${samples.length} player-season-week samples, ${MIN_PRIOR_GAMES}+ games played, ` +
    `${MIN_REST_GAMES}+ games remaining, recent window = last ${RECENT_WINDOW}.\n`,
);

const pad = (s: string | number, n: number) => String(s).padStart(n);

console.log('OPPORTUNITY (targets + carries per game)');
console.log('  pos      n   season-to-date   last-3   delta|level   better');
for (const pos of ['RB', 'WR', 'TE']) {
  const g = samples.filter((s) => s.position === pos);
  const rStd = corr(g.map((s) => s.std), g.map((s) => s.restPpg));
  const rRec = corr(g.map((s) => s.recent), g.map((s) => s.restPpg));
  const rDelta = partial(
    g.map((s) => s.std),
    g.map((s) => s.delta),
    g.map((s) => s.restPpg),
  );
  console.log(
    `  ${pos.padEnd(3)} ${pad(g.length, 6)}   ${pad(rStd.toFixed(3), 12)}   ${pad(rRec.toFixed(3), 6)}   ` +
      `${pad(rDelta.toFixed(3), 11)}   ${rStd >= rRec ? 'season-to-date' : 'last-3'}`,
  );
}

console.log('\nSNAP SHARE (offensive snap %)');
console.log('  pos      n   season-to-date   last-3   delta|level   better');
for (const pos of ['RB', 'WR', 'TE']) {
  const g = samples.filter(
    (s) => s.position === pos && s.snapStd !== null && s.snapRecent !== null,
  );
  const rStd = corr(g.map((s) => s.snapStd!), g.map((s) => s.restPpg));
  const rRec = corr(g.map((s) => s.snapRecent!), g.map((s) => s.restPpg));
  const rDelta = partial(
    g.map((s) => s.snapStd!),
    g.map((s) => s.snapDelta!),
    g.map((s) => s.restPpg),
  );
  console.log(
    `  ${pos.padEnd(3)} ${pad(g.length, 6)}   ${pad(rStd.toFixed(3), 12)}   ${pad(rRec.toFixed(3), 6)}   ` +
      `${pad(rDelta.toFixed(3), 11)}   ${rStd >= rRec ? 'season-to-date' : 'last-3'}`,
  );
}

/*
 * How the answer changes with how far into the season we are. A recency bias
 * could help early, when season-to-date is a tiny sample, and hurt later.
 */
console.log('\nBY GAMES PLAYED (all positions pooled, opportunity)');
console.log('  games      n   season-to-date   last-3   delta|level');
for (const [lo, hi] of [[2, 3], [4, 5], [6, 8], [9, 12], [13, 17]] as const) {
  const g: Sample[] = [];
  for (const { position, weeks } of byPlayerSeason.values()) {
    weeks.sort((a, b) => a.week - b.week);
    for (let cut = Math.max(MIN_PRIOR_GAMES, lo); cut <= Math.min(hi, weeks.length - MIN_REST_GAMES); cut++) {
      const prior = weeks.slice(0, cut);
      const rest = weeks.slice(cut);
      const std = mean(prior.map((w) => w.opportunity));
      const recent = mean(prior.slice(-RECENT_WINDOW).map((w) => w.opportunity));
      g.push({
        position, std, recent, delta: recent - std,
        snapStd: null, snapRecent: null, snapDelta: null,
        restPpg: mean(rest.map((w) => w.points)),
      });
    }
  }
  if (g.length < 50) continue;
  const rStd = corr(g.map((s) => s.std), g.map((s) => s.restPpg));
  const rRec = corr(g.map((s) => s.recent), g.map((s) => s.restPpg));
  const rDelta = partial(g.map((s) => s.std), g.map((s) => s.delta), g.map((s) => s.restPpg));
  console.log(
    `  ${`${lo}-${hi}`.padEnd(5)} ${pad(g.length, 6)}   ${pad(rStd.toFixed(3), 12)}   ` +
      `${pad(rRec.toFixed(3), 6)}   ${pad(rDelta.toFixed(3), 11)}`,
  );
}

/*
 * If neither pure view wins outright, the useful question is what mixture does.
 * Scanning the weight directly is more honest than assuming a shape.
 */
console.log('\nBLEND OF THE TWO (all positions, opportunity) — r by weight on last-3');
let best = { w: 0, r: -Infinity };
const line: string[] = [];
for (let w = 0; w <= 1.0001; w += 0.1) {
  const blended = samples.map((s) => s.std * (1 - w) + s.recent * w);
  const r = corr(blended, samples.map((s) => s.restPpg));
  line.push(`${w.toFixed(1)}:${r.toFixed(4)}`);
  if (r > best.r) best = { w, r };
}
console.log('  ' + line.join('  '));
console.log(`  best weight on last-3 = ${best.w.toFixed(1)} (r = ${best.r.toFixed(4)})`);

/*
 * The averages above pool every player-week, and the overwhelming majority saw
 * no change in role at all — which is exactly the population a recency bias
 * cannot help. The waiver wire lives in the tail: the back whose snap share went
 * from 25% to 70% because the starter went down. Whether recency wins *there* is
 * a different question, and it is the one that decides the design.
 */
console.log('\nCONDITIONAL ON A ROLE CHANGE (snap share, last-3 vs season-to-date)');
console.log('  snap delta      n   season-to-date   last-3   winner');
const withSnap = samples.filter((s) => s.snapDelta !== null);
for (const [lo, hi, label] of [
  [-100, -15, 'fell 15pp+'],
  [-15, -5, 'fell 5-15pp'],
  [-5, 5, 'stable ±5pp'],
  [5, 15, 'rose 5-15pp'],
  [15, 100, 'rose 15pp+'],
] as const) {
  const g = withSnap.filter((s) => s.snapDelta! > lo && s.snapDelta! <= hi);
  if (g.length < 40) continue;
  const rStd = corr(g.map((s) => s.snapStd!), g.map((s) => s.restPpg));
  const rRec = corr(g.map((s) => s.snapRecent!), g.map((s) => s.restPpg));
  console.log(
    `  ${label.padEnd(12)} ${pad(g.length, 5)}   ${pad(rStd.toFixed(3), 12)}   ${pad(rRec.toFixed(3), 6)}   ` +
      `${rRec > rStd ? 'LAST-3' : 'season-to-date'}`,
  );
}

/*
 * Same question asked of the thing being predicted rather than the predictor:
 * for players whose role visibly expanded, how much does rest-of-season output
 * actually rise? If the answer is "a lot", the wire should surface them even if
 * the correlation test cannot see it in the pooled average.
 */
console.log('\nWHAT A ROLE CHANGE IS WORTH (mean rest-of-season points per game)');
console.log('  snap delta      n   rest PPG   vs stable');
const stable = withSnap.filter((s) => Math.abs(s.snapDelta!) <= 5);
const stablePpg = mean(stable.map((s) => s.restPpg));
for (const [lo, hi, label] of [
  [-100, -15, 'fell 15pp+'],
  [-15, -5, 'fell 5-15pp'],
  [-5, 5, 'stable ±5pp'],
  [5, 15, 'rose 5-15pp'],
  [15, 100, 'rose 15pp+'],
] as const) {
  const g = withSnap.filter((s) => s.snapDelta! > lo && s.snapDelta! <= hi);
  if (g.length < 40) continue;
  const m = mean(g.map((s) => s.restPpg));
  console.log(
    `  ${label.padEnd(12)} ${pad(g.length, 5)}   ${pad(m.toFixed(2), 8)}   ${pad(((m - stablePpg) >= 0 ? '+' : '') + (m - stablePpg).toFixed(2), 8)}`,
  );
}
