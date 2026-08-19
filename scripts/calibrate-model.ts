import { sqlite } from '../lib/db/index';

/**
 * Should the advanced metrics go into the projection itself?
 *
 * The scouting panel measures each one's partial correlation, which says a
 * metric carries information the volume shares do not. It does NOT say the
 * regression gets better when you add it — correlated predictors can each look
 * informative and jointly add nothing, and in-sample R² rises every single time
 * a column is added whether or not it helps. Judging on in-sample fit is how a
 * model gets worse while its scorecard improves.
 *
 * So this is leave-one-season-out: fit on every season but one, predict the one
 * held out, and score only those predictions. A feature earns its place by
 * improving what the model says about a season it has never seen.
 */

const FROM = 2021;

interface Row {
  playerId: string;
  season: number;
  position: string;
  next: number;
  f: Record<string, number | null>;
}

const points = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, SUM(fantasy_points_half) pts FROM player_stats_week
     WHERE season_type='REG' GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; pts: number }>) {
  points.set(`${r.player_id}|${r.season}`, r.pts);
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

const raw = sqlite
  .prepare(
    `SELECT u.player_id AS playerId, u.season, u.position,
            u.target_share AS targetShare, u.pass_snap_share AS routeShare,
            u.rz_touch_share AS rzShare, u.goal_line_share AS goalLineShare,
            u.rush_share AS rushShare, u.pass_snaps AS passSnaps,
            u.season - CAST(substr(p.birth_date,1,4) AS INTEGER) AS age,
            s.carries, s.rush_yards AS rushYards, s.rush_epa AS rushEpa,
            s.rush_first_downs AS rushFd, s.rec_yards AS recYards,
            s.rec_epa AS recEpa, s.rec_first_downs AS recFd, s.targets,
            t.points_for AS teamPoints, t.qb_epa_dropback AS qbEpa,
            t.sack_rate_allowed AS sackRate, t.ybc_per_carry AS ybc
     FROM player_usage u
     JOIN players p ON p.gsis_id = u.player_id
     LEFT JOIN player_scheme s ON s.player_id = u.player_id AND s.season = u.season
     LEFT JOIN team_context t ON t.season = u.season AND t.team = u.team
     WHERE u.games >= 6 AND u.season >= ? AND u.position IN ('QB','WR','RB','TE')`,
  )
  .all(FROM) as Array<Record<string, number | string | null>>;

const n = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

const rows: Row[] = [];
for (const r of raw) {
  const playerId = String(r.playerId);
  const season = Number(r.season);
  const next = points.get(`${playerId}|${season + 1}`);
  if (next === undefined) continue;
  const g = games.get(`${playerId}|${season}`) ?? 0;
  if (g < 6) continue;

  const carries = n(r.carries) ?? 0;
  const targets = n(r.targets) ?? 0;
  const touches = carries + targets;
  const fd = (n(r.rushFd) ?? 0) + (n(r.recFd) ?? 0);
  const passSnaps = n(r.passSnaps) ?? 0;

  rows.push({
    playerId,
    season,
    position: String(r.position).toUpperCase(),
    next,
    f: {
      targetShare: n(r.targetShare),
      routeShare: n(r.routeShare),
      rzShare: n(r.rzShare),
      goalLineShare: n(r.goalLineShare),
      rushShare: n(r.rushShare),
      age: n(r.age),
      firstDownsPerGame: g >= 6 ? fd / g : null,
      firstDownRate: touches >= 40 ? fd / touches : null,
      epaPerTouch: touches >= 40 ? ((n(r.rushEpa) ?? 0) + (n(r.recEpa) ?? 0)) / touches : null,
      yprr: passSnaps >= 100 ? (n(r.recYards) ?? 0) / passSnaps : null,
      ypc: carries >= 40 ? (n(r.rushYards) ?? 0) / carries : null,
      teamPoints: n(r.teamPoints),
      qbEpa: n(r.qbEpa),
      protection: r.sackRate === null ? null : -Number(r.sackRate),
      ybc: n(r.ybc),
    },
  });
}

/* ------------------------------------------------------------------ ridge */

function solve(X: number[][], y: number[], lambda: number): number[] | null {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const b: number[] = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a]! += X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += X[i]![a]! * X[i]![c]!;
    }
  }
  for (let a = 1; a < k; a++) A[a]![a]! += lambda;

  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-10) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= k; c++) M[r]![c]! -= factor * M[col]![c]!;
    }
  }
  // `row` IS M[i], so the diagonal element is row[i] — `row[i][i]` indexes a
  // number and yields undefined, which is how every fold came back NaN.
  return M.map((row, i) => row[k]! / row[i]!);
}

/** Fit on `train`, score on `test`. Returns out-of-sample R² and MAE. */
function evaluate(train: Row[], test: Row[], features: string[]) {
  const usable = (r: Row) => features.every((k) => r.f[k] !== null);
  const tr = train.filter(usable);
  const te = test.filter(usable);
  if (tr.length < 40 || te.length < 8) return null;

  const build = (set: Row[]) => set.map((r) => [1, ...features.map((k) => r.f[k]!)]);
  const X = build(tr);
  const y = tr.map((r) => r.next);

  const means = features.map((_, j) => {
    const col = X.map((row) => row[j + 1]!);
    return col.reduce((a, b) => a + b, 0) / col.length;
  });
  const sds = features.map((_, j) => {
    const col = X.map((row) => row[j + 1]!);
    return Math.sqrt(col.reduce((a, b) => a + (b - means[j]!) ** 2, 0) / col.length) || 1;
  });
  const Z = X.map((row) => [1, ...row.slice(1).map((v, j) => (v - means[j]!) / sds[j]!)]);

  const beta = solve(Z, y, 0.05 * X.length);
  if (!beta) return null;

  const predict = (r: Row) =>
    beta[0]! +
    features.reduce((a, k, j) => a + beta[j + 1]! * ((r.f[k]! - means[j]!) / sds[j]!), 0);

  const actual = te.map((r) => r.next);
  const pred = te.map(predict);
  const meanY = actual.reduce((a, b) => a + b, 0) / actual.length;
  let ssRes = 0, ssTot = 0, mae = 0;
  for (let i = 0; i < actual.length; i++) {
    ssRes += (actual[i]! - pred[i]!) ** 2;
    ssTot += (actual[i]! - meanY) ** 2;
    mae += Math.abs(actual[i]! - pred[i]!);
  }
  return { r2: ssTot ? 1 - ssRes / ssTot : 0, mae: mae / actual.length, n: te.length };
}

/** Leave-one-season-out across every season present. */
function crossValidate(position: string, features: string[]) {
  const pool = rows.filter((r) => r.position === position);
  const seasons = [...new Set(pool.map((r) => r.season))].sort();
  let sumR2 = 0, sumMae = 0, folds = 0, tested = 0;
  for (const s of seasons) {
    const res = evaluate(
      pool.filter((r) => r.season !== s),
      pool.filter((r) => r.season === s),
      features,
    );
    if (!res) continue;
    sumR2 += res.r2;
    sumMae += res.mae;
    tested += res.n;
    folds++;
  }
  return folds ? { r2: sumR2 / folds, mae: sumMae / folds, folds, tested } : null;
}

/* ------------------------------------------------------------------ sets */

const BASE: Record<string, string[]> = {
  WR: ['targetShare', 'routeShare', 'rzShare', 'goalLineShare', 'age'],
  TE: ['targetShare', 'routeShare', 'rzShare', 'goalLineShare', 'age'],
  RB: ['rushShare', 'targetShare', 'rzShare', 'goalLineShare', 'age'],
  QB: ['routeShare', 'rushShare', 'rzShare', 'goalLineShare', 'age'],
};

const CANDIDATES: Record<string, string[][]> = {
  WR: [
    ['firstDownsPerGame'],
    ['firstDownRate'],
    ['epaPerTouch'],
    ['yprr'],
    ['teamPoints'],
    ['qbEpa'],
    ['firstDownsPerGame', 'yprr'],
    ['firstDownsPerGame', 'teamPoints'],
    ['firstDownsPerGame', 'yprr', 'teamPoints'],
    ['firstDownsPerGame', 'yprr', 'teamPoints', 'qbEpa'],
    ['firstDownsPerGame', 'teamPoints', 'qbEpa'],
    ['firstDownsPerGame', 'firstDownRate', 'epaPerTouch', 'yprr', 'teamPoints', 'qbEpa'],
  ],
  RB: [
    ['firstDownsPerGame'],
    ['firstDownRate'],
    ['epaPerTouch'],
    ['ypc'],
    ['yprr'],
    ['teamPoints'],
    ['firstDownsPerGame', 'ypc'],
    ['firstDownsPerGame', 'teamPoints'],
    ['firstDownsPerGame', 'epaPerTouch'],
    ['firstDownsPerGame', 'ypc', 'yprr'],
    ['firstDownsPerGame', 'ypc', 'yprr', 'epaPerTouch'],
    ['ybc'],
    ['firstDownsPerGame', 'ybc'],
    ['firstDownsPerGame', 'firstDownRate', 'epaPerTouch', 'ypc', 'yprr', 'teamPoints'],
  ],
  TE: [
    ['firstDownsPerGame'],
    ['firstDownRate'],
    ['yprr'],
    ['teamPoints'],
    ['firstDownsPerGame', 'teamPoints'],
    ['firstDownsPerGame', 'yprr', 'teamPoints'],
  ],
  QB: [
    ['firstDownsPerGame'],
    ['epaPerTouch'],
    ['teamPoints'],
    ['qbEpa'],
    ['firstDownsPerGame', 'teamPoints'],
    ['firstDownsPerGame', 'qbEpa', 'teamPoints'],
    ['protection'],
    ['qbEpa', 'protection'],
    ['qbEpa', 'protection', 'teamPoints'],
  ],
};

console.log('leave-one-season-out cross validation');
console.log('out-of-sample R2 and mean absolute error, averaged over held-out seasons.');
console.log('a feature earns its place by improving a season the fit never saw.\n');

for (const position of ['WR', 'RB', 'TE', 'QB']) {
  const base = crossValidate(position, BASE[position]!);
  if (!base) {
    console.log(`\n== ${position} == not enough data`);
    continue;
  }
  console.log(`\n== ${position} ==`);
  console.log(`  ${'shares + age (current model)'.padEnd(56)} R2 ${base.r2.toFixed(3)}  MAE ${base.mae.toFixed(1)}  n=${base.tested}`);

  /*
   * Every candidate is re-scored against a base restricted to the SAME rows.
   * Advanced metrics have qualifying thresholds, so a set including yards per
   * carry silently drops every back under 40 attempts — comparing it to a base
   * fit on the full pool would credit the feature for a change in population.
   */
  const results: Array<{ set: string[]; r2: number; mae: number; baseR2: number; baseMae: number; n: number }> = [];
  for (const extra of CANDIDATES[position]!) {
    const full = crossValidate(position, [...BASE[position]!, ...extra]);
    const matched = (() => {
      const pool = rows.filter(
        (r) => r.position === position && [...BASE[position]!, ...extra].every((k) => r.f[k] !== null),
      );
      const seasons = [...new Set(pool.map((r) => r.season))].sort();
      let sr = 0, sm = 0, f = 0;
      for (const s of seasons) {
        const res = evaluate(
          pool.filter((r) => r.season !== s),
          pool.filter((r) => r.season === s),
          BASE[position]!,
        );
        if (!res) continue;
        sr += res.r2; sm += res.mae; f++;
      }
      return f ? { r2: sr / f, mae: sm / f } : null;
    })();
    if (!full || !matched) continue;
    results.push({ set: extra, r2: full.r2, mae: full.mae, baseR2: matched.r2, baseMae: matched.mae, n: full.tested });
  }

  results.sort((a, b) => b.r2 - b.baseR2 - (a.r2 - a.baseR2));
  for (const r of results) {
    const dR2 = r.r2 - r.baseR2;
    const dMae = r.mae - r.baseMae;
    const verdict = dR2 > 0.015 && dMae < -0.5 ? '  <-- ADOPT' : dR2 < -0.005 ? '  worse' : '';
    console.log(
      `  + ${r.set.join(' + ').padEnd(54)} R2 ${r.r2.toFixed(3)} (${dR2 >= 0 ? '+' : ''}${dR2.toFixed(3)})  ` +
        `MAE ${r.mae.toFixed(1)} (${dMae >= 0 ? '+' : ''}${dMae.toFixed(1)})  n=${r.n}${verdict}`,
    );
  }
}

/*
 * Coverage is the other half of the decision. A feature that improves the fit
 * but exists for half the league makes the board worse, because the players it
 * drops are the ones nobody else is projecting either.
 */
console.log('\n\ncoverage — how many graded players would still have every input?');
for (const position of ['WR', 'RB', 'TE', 'QB']) {
  const pool = rows.filter((r) => r.position === position);
  const has = (k: string) => pool.filter((r) => r.f[k] !== null).length;
  console.log(
    `  ${position} (${pool.length}): firstDowns ${has('firstDownsPerGame')} · fdRate ${has('firstDownRate')} · ` +
      `epa ${has('epaPerTouch')} · yprr ${has('yprr')} · ypc ${has('ypc')} · team ${has('teamPoints')}`,
  );
}
