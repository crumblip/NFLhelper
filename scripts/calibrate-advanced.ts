import { sqlite } from '../lib/db/index';

/**
 * Do the advanced metrics actually predict, or do they just describe?
 *
 * Two questions get confused constantly in fantasy analysis and this script
 * keeps them apart.
 *
 * DESCRIPTIVE: what did the players who finished WR1 look like in the season
 * they finished WR1? Every answer to this is true and almost none of it is
 * useful, because the traits are measured in the same season as the outcome. A
 * receiver with a 25% target share and 2.3 yards per route in a top-11 offence
 * IS having a WR1 season — the filter is a restatement of the result. It also
 * says nothing about how many players clear the same bar and finish 30th, which
 * is the number that decides whether a screen is worth running.
 *
 * PREDICTIVE: measured in season N, what does the metric say about season N+1?
 * This is the only version a draft board can use, and it is the harder test.
 *
 * Both are reported below, along with whether each metric adds anything once
 * target share (WR) or rush share (RB) is already known — because a metric that
 * only restates volume is not a second opinion.
 */

const FROM = 2021;

/* ------------------------------------------------------------------ frame */

interface Row {
  playerId: string;
  name: string;
  season: number;
  position: string;
  age: number;
  games: number;
  points: number;
  ppg: number;

  targetShare: number;
  rushShare: number;
  routeShare: number;
  rzShare: number;
  goalLineShare: number;
  passSnaps: number;

  /** Receiving yards per pass snap on the field — yards per route run. */
  yprr: number | null;
  yacPerRec: number | null;
  yardsAfterContact: number | null;

  carries: number;
  rushYards: number;
  outsideCarries: number;
  outsideYpc: number | null;
  insideCarries: number;
  insideYpc: number | null;
  /** His own carries run outside, as a share. */
  outsideShare: number | null;
  /** Yards per carry outside minus inside — which scheme he is better in. */
  schemeEdge: number | null;
  firstDownTouches: number;
  firstDownRate: number | null;
  epaPerTouch: number | null;

  teamPointsRank: number | null;
  teamPoints: number | null;
  qbEpaRank: number | null;
  qbEpa: number | null;
  teamOutsideShare: number | null;
  passOe: number | null;

  nextPoints: number | null;
  nextPpg: number | null;
  nextRankInPos: number | null;
}

const raw = sqlite
  .prepare(
    `SELECT u.player_id AS playerId, p.display_name AS name, u.season, u.position,
            u.season - CAST(substr(p.birth_date,1,4) AS INTEGER) AS age,
            COALESCE(u.target_share,0) targetShare, COALESCE(u.rush_share,0) rushShare,
            COALESCE(u.pass_snap_share,0) routeShare, COALESCE(u.rz_touch_share,0) rzShare,
            COALESCE(u.goal_line_share,0) goalLineShare,
            COALESCE(u.pass_snaps,0) passSnaps,
            u.yac_per_reception yacPerRec, u.yards_after_contact yardsAfterContact,
            s.carries, s.rush_yards rushYards, s.rush_epa rushEpa,
            s.rush_first_downs rushFd, s.outside_carries outsideCarries,
            s.outside_yards outsideYards, s.inside_carries insideCarries,
            s.inside_yards insideYards, s.targets, s.rec_yards recYards,
            s.rec_epa recEpa, s.rec_first_downs recFd,
            t.points_rank teamPointsRank, t.points_for teamPoints,
            t.qb_epa_rank qbEpaRank, t.qb_epa_dropback qbEpa,
            t.outside_run_share teamOutsideShare, t.pass_oe passOe
     FROM player_usage u
     JOIN players p ON p.gsis_id = u.player_id
     LEFT JOIN player_scheme s ON s.player_id = u.player_id AND s.season = u.season
     LEFT JOIN team_context t ON t.season = u.season AND t.team = u.team
     WHERE u.season >= ? AND u.position IN ('QB','WR','RB','TE') AND u.games >= 6`,
  )
  .all(FROM) as Array<Record<string, number | string | null>>;

const points = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season, SUM(fantasy_points_half) pts FROM player_stats_week
     WHERE season_type='REG' GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; pts: number }>) {
  points.set(`${r.player_id}|${r.season}`, r.pts);
}

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

const seasonsPresent = new Set(
  (sqlite.prepare(`SELECT DISTINCT season FROM player_stats_week WHERE season_type='REG'`).all() as Array<{ season: number }>)
    .map((r) => r.season),
);

const n = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

const rows: Row[] = [];
for (const r of raw) {
  const playerId = String(r.playerId);
  const season = Number(r.season);
  const age = n(r.age);
  const games = appearances.get(`${playerId}|${season}`) ?? 0;
  if (age === null || games < 6) continue;

  const pts = points.get(`${playerId}|${season}`) ?? 0;
  const carries = n(r.carries) ?? 0;
  const outsideCarries = n(r.outsideCarries) ?? 0;
  const insideCarries = n(r.insideCarries) ?? 0;
  const outsideYards = n(r.outsideYards) ?? 0;
  const insideYards = n(r.insideYards) ?? 0;
  const passSnaps = n(r.passSnaps) ?? 0;
  const recYards = n(r.recYards) ?? 0;

  const outsideYpc = outsideCarries >= 20 ? outsideYards / outsideCarries : null;
  const insideYpc = insideCarries >= 20 ? insideYards / insideCarries : null;

  const nextGames = appearances.get(`${playerId}|${season + 1}`) ?? 0;
  const nextPts = seasonsPresent.has(season + 1)
    ? nextGames > 0
      ? points.get(`${playerId}|${season + 1}`) ?? 0
      : 0
    : null;

  rows.push({
    playerId,
    name: String(r.name),
    season,
    position: String(r.position),
    age,
    games,
    points: pts,
    ppg: pts / games,
    targetShare: n(r.targetShare) ?? 0,
    rushShare: n(r.rushShare) ?? 0,
    routeShare: n(r.routeShare) ?? 0,
    rzShare: n(r.rzShare) ?? 0,
    goalLineShare: n(r.goalLineShare) ?? 0,
    passSnaps,
    yprr: passSnaps >= 100 ? recYards / passSnaps : null,
    yacPerRec: n(r.yacPerRec),
    yardsAfterContact: n(r.yardsAfterContact),
    carries,
    rushYards: n(r.rushYards) ?? 0,
    outsideCarries,
    outsideYpc,
    insideCarries,
    insideYpc,
    outsideShare: carries >= 50 ? outsideCarries / carries : null,
    schemeEdge: outsideYpc !== null && insideYpc !== null ? outsideYpc - insideYpc : null,
    firstDownTouches: (n(r.rushFd) ?? 0) + (n(r.recFd) ?? 0),
    firstDownRate:
      carries + (n(r.targets) ?? 0) >= 50
        ? ((n(r.rushFd) ?? 0) + (n(r.recFd) ?? 0)) / (carries + (n(r.targets) ?? 0))
        : null,
    epaPerTouch:
      carries + (n(r.targets) ?? 0) >= 50
        ? ((n(r.rushEpa) ?? 0) + (n(r.recEpa) ?? 0)) / (carries + (n(r.targets) ?? 0))
        : null,
    teamPointsRank: n(r.teamPointsRank),
    teamPoints: n(r.teamPoints),
    qbEpaRank: n(r.qbEpaRank),
    qbEpa: n(r.qbEpa),
    teamOutsideShare: n(r.teamOutsideShare),
    passOe: n(r.passOe),
    nextPoints: nextPts,
    nextPpg: nextPts !== null && nextGames > 0 ? nextPts / nextGames : nextPts === null ? null : 0,
    nextRankInPos: null,
  });
}

// Positional finish rank per season, so "WR1 overall" is well defined.
for (const season of new Set(rows.map((r) => r.season))) {
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    const at = rows
      .filter((r) => r.season === season && r.position === position)
      .sort((a, b) => b.points - a.points);
    at.forEach((r, i) => {
      r.nextRankInPos = i + 1;
    });
  }
}
/** Finish rank IN the season described, not the next one. */
const finishRank = new Map<string, number>();
for (const r of rows) finishRank.set(`${r.playerId}|${r.season}`, r.nextRankInPos!);

/* ------------------------------------------------------------------ stats */

function pearson(xs: number[], ys: number[]): number {
  const k = xs.length;
  if (k < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / k;
  const my = ys.reduce((a, b) => a + b, 0) / k;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < k; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return num / Math.sqrt(dx * dy || 1);
}

/** Residuals of y after removing a linear fit on c. */
function residuals(ys: number[], cs: number[]): number[] {
  const k = ys.length;
  const mc = cs.reduce((a, b) => a + b, 0) / k;
  const my = ys.reduce((a, b) => a + b, 0) / k;
  let num = 0, den = 0;
  for (let i = 0; i < k; i++) {
    num += (cs[i]! - mc) * (ys[i]! - my);
    den += (cs[i]! - mc) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return ys.map((y, i) => y - (my + slope * (cs[i]! - mc)));
}

/** Correlation of x with y once both have had `control` removed. */
function partial(xs: number[], ys: number[], cs: number[]): number {
  return pearson(residuals(xs, cs), residuals(ys, cs));
}

interface Metric {
  label: string;
  get: (r: Row) => number | null;
}

function report(position: string, control: Metric, metrics: Metric[]) {
  const pool = rows.filter((r) => r.position === position && r.nextPoints !== null);
  console.log(`\n== ${position} — predicting NEXT season (${pool.length} season pairs) ==`);
  console.log('metric                          n      r    r|control   verdict');

  for (const m of metrics) {
    const usable = pool.filter(
      (r) => m.get(r) !== null && control.get(r) !== null && r.nextPoints !== null,
    );
    if (usable.length < 40) {
      console.log(`${m.label.padEnd(30)} ${String(usable.length).padStart(4)}   too few`);
      continue;
    }
    const xs = usable.map((r) => m.get(r)!);
    const ys = usable.map((r) => r.nextPoints!);
    const cs = usable.map((r) => control.get(r)!);
    const r = pearson(xs, ys);
    const pr = m.label === control.label ? NaN : partial(xs, ys, cs);

    /*
     * The verdict keys on the PARTIAL correlation, not the raw one.
     *
     * Keying on raw r first called team points scored and QB EPA "dead" at
     * r=0.15 while both carry a partial of ~0.20 — a metric can be weakly
     * correlated with the outcome on its own and still add real information once
     * volume is accounted for, which is precisely the case for offensive
     * environment. Judging the second opinion by the first opinion's standard is
     * how a genuine signal gets thrown away.
     */
    const verdict = Number.isNaN(pr)
      ? 'the control'
      : Math.abs(pr) >= 0.25
        ? 'STRONG independent signal'
        : Math.abs(pr) >= 0.18
          ? 'real independent signal'
          : Math.abs(pr) >= 0.12
            ? 'small independent lift'
            : Math.abs(r) >= 0.4
              ? `absorbed by ${control.label.trim()}`
              : 'dead';

    console.log(
      `${m.label.padEnd(30)} ${String(usable.length).padStart(4)} ${r.toFixed(3).padStart(6)} ` +
        `${Number.isNaN(pr) ? '     —' : pr.toFixed(3).padStart(6)}     ${verdict}`,
    );
  }
}

/* ------------------------------------------------- 1. the WR1 filter set */

console.log('='.repeat(78));
console.log('THE FIVE-FILTER WR1 PROFILE — descriptive claim, tested both ways');
console.log('='.repeat(78));
console.log(
  '\nFilters: under 30 · 25%+ target share · 2.3+ yards per route ·\n' +
    'top-11 scoring offence · top-10 QB by EPA per dropback\n',
);

const wrSeasons = rows.filter((r) => r.position === 'WR' && r.yprr !== null);
const clears = (r: Row) =>
  r.age < 30 &&
  r.targetShare >= 0.25 &&
  (r.yprr ?? 0) >= 2.3 &&
  (r.teamPointsRank ?? 99) <= 11 &&
  (r.qbEpaRank ?? 99) <= 10;

console.log('season  WR1                     age   tgt%   yprr  ptsRk  qbRk  clears all five?');
for (const season of [...new Set(wrSeasons.map((r) => r.season))].sort()) {
  const wr1 = wrSeasons
    .filter((r) => r.season === season)
    .sort((a, b) => b.points - a.points)[0];
  if (!wr1) continue;
  console.log(
    `  ${season}  ${wr1.name.padEnd(22)} ${String(wr1.age).padStart(3)} ` +
      `${(wr1.targetShare * 100).toFixed(1).padStart(6)} ${(wr1.yprr ?? 0).toFixed(2).padStart(6)} ` +
      `${String(wr1.teamPointsRank ?? '—').padStart(6)} ${String(wr1.qbEpaRank ?? '—').padStart(5)}   ` +
      `${clears(wr1) ? 'YES' : 'NO  <-- breaks the rule'}`,
  );
}

console.log('\nWhich single filter does each WR1 fail?');
for (const season of [...new Set(wrSeasons.map((r) => r.season))].sort()) {
  const wr1 = wrSeasons.filter((r) => r.season === season).sort((a, b) => b.points - a.points)[0];
  if (!wr1 || clears(wr1)) continue;
  const fails = [
    wr1.age < 30 ? null : 'age',
    wr1.targetShare >= 0.25 ? null : `target share ${(wr1.targetShare * 100).toFixed(1)}%`,
    (wr1.yprr ?? 0) >= 2.3 ? null : `yprr ${(wr1.yprr ?? 0).toFixed(2)}`,
    (wr1.teamPointsRank ?? 99) <= 11 ? null : `offence rank ${wr1.teamPointsRank}`,
    (wr1.qbEpaRank ?? 99) <= 10 ? null : `QB rank ${wr1.qbEpaRank}`,
  ].filter(Boolean);
  console.log(`  ${season} ${wr1.name}: fails ${fails.join(', ')}`);
}

/*
 * The number that decides whether the screen is worth running. A filter every
 * WR1 passes is worthless if forty players pass it every year.
 */
console.log('\nPRECISION — of the seasons that cleared all five, where did they finish?');
const cleared = wrSeasons.filter(clears);
const finishOf = (r: Row) => finishRank.get(`${r.playerId}|${r.season}`) ?? 999;
const band = (lo: number, hi: number) =>
  cleared.filter((r) => finishOf(r) >= lo && finishOf(r) <= hi).length;
console.log(`  cleared all five: ${cleared.length} seasons across ${new Set(wrSeasons.map((r) => r.season)).size} years ` +
  `(${(cleared.length / new Set(wrSeasons.map((r) => r.season)).size).toFixed(1)} per season)`);
console.log(`    finished WR1:        ${band(1, 1)}`);
console.log(`    finished WR2-5:      ${band(2, 5)}`);
console.log(`    finished WR6-12:     ${band(6, 12)}`);
console.log(`    finished WR13-24:    ${band(13, 24)}`);
console.log(`    finished WR25+:      ${band(25, 999)}`);
console.log(
  `  so clearing all five gives a ${((band(1, 1) / cleared.length) * 100).toFixed(0)}% chance of WR1 ` +
    `and a ${((band(1, 12) / cleared.length) * 100).toFixed(0)}% chance of top-12.`,
);

console.log('\nAnd the same filters applied in season N, judged on season N+1 —');
console.log('which is the only version a draft board can act on:');
const forward = wrSeasons.filter((r) => r.nextPoints !== null);
const fCleared = forward.filter(clears);
const fRest = forward.filter((r) => !clears(r) && r.targetShare >= 0.18);
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const nextTop12 = (set: Row[]) =>
  set.filter((r) => {
    const nextSeasonRank = rows
      .filter((x) => x.season === r.season + 1 && x.position === 'WR')
      .sort((a, b) => b.points - a.points)
      .findIndex((x) => x.playerId === r.playerId);
    return nextSeasonRank >= 0 && nextSeasonRank < 12;
  }).length;
console.log(
  `  cleared all five (n=${fCleared.length}): next season mean ${mean(fCleared.map((r) => r.nextPoints!)).toFixed(0)} pts, ` +
    `${((nextTop12(fCleared) / fCleared.length) * 100).toFixed(0)}% finished top-12`,
);
console.log(
  `  did not clear but 18%+ target share (n=${fRest.length}): mean ${mean(fRest.map((r) => r.nextPoints!)).toFixed(0)} pts, ` +
    `${((nextTop12(fRest) / fRest.length) * 100).toFixed(0)}% finished top-12`,
);

/* ----------------------------------------------- 2. do they predict alone */

console.log('\n' + '='.repeat(78));
console.log('EACH METRIC AS A FORWARD PREDICTOR');
console.log('='.repeat(78));
console.log(
  '\nr = correlation with next-season half-PPR points.\n' +
    'r|control = the same after removing what the position\'s dominant volume\n' +
    'metric already explains. A metric that only restates volume is not a\n' +
    'second opinion, however good its raw correlation looks.',
);

const targetShare: Metric = { label: 'target share            ', get: (r) => r.targetShare };
const rushShare: Metric = { label: 'rush share              ', get: (r) => r.rushShare };

report('WR', targetShare, [
  targetShare,
  { label: 'yards per route run', get: (r) => r.yprr },
  { label: 'route share', get: (r) => r.routeShare },
  { label: 'red-zone share', get: (r) => r.rzShare },
  { label: 'team points rank (neg)', get: (r) => (r.teamPointsRank === null ? null : -r.teamPointsRank) },
  { label: 'team points scored', get: (r) => r.teamPoints },
  { label: 'QB EPA/dropback', get: (r) => r.qbEpa },
  { label: 'QB EPA rank (neg)', get: (r) => (r.qbEpaRank === null ? null : -r.qbEpaRank) },
  { label: 'age (neg)', get: (r) => -r.age },
  { label: 'first-down rate', get: (r) => r.firstDownRate },
  { label: 'first-down touches', get: (r) => r.firstDownTouches },
  { label: 'EPA per touch', get: (r) => r.epaPerTouch },
  { label: 'YAC per reception', get: (r) => r.yacPerRec },
  { label: 'pass rate over expected', get: (r) => r.passOe },
]);

report('RB', rushShare, [
  rushShare,
  { label: 'red-zone touch share', get: (r) => r.rzShare },
  { label: 'target share', get: (r) => r.targetShare },
  { label: 'yards per route run', get: (r) => r.yprr },
  { label: 'first-down touches', get: (r) => r.firstDownTouches },
  { label: 'first-down rate', get: (r) => r.firstDownRate },
  { label: 'EPA per touch', get: (r) => r.epaPerTouch },
  { label: 'yards after contact', get: (r) => r.yardsAfterContact },
  { label: 'yards per carry', get: (r) => (r.carries >= 50 ? r.rushYards / r.carries : null) },
  { label: 'outside-run share', get: (r) => r.outsideShare },
  { label: 'scheme edge (out-in ypc)', get: (r) => r.schemeEdge },
  { label: 'team outside-run share', get: (r) => r.teamOutsideShare },
  { label: 'team points rank (neg)', get: (r) => (r.teamPointsRank === null ? null : -r.teamPointsRank) },
  { label: 'pass rate over expected', get: (r) => r.passOe },
  { label: 'age (neg)', get: (r) => -r.age },
]);

report('TE', targetShare, [
  targetShare,
  { label: 'yards per route run', get: (r) => r.yprr },
  { label: 'red-zone share', get: (r) => r.rzShare },
  { label: 'team points rank (neg)', get: (r) => (r.teamPointsRank === null ? null : -r.teamPointsRank) },
  { label: 'QB EPA/dropback', get: (r) => r.qbEpa },
]);

/* ------------------------------------------- 3. is outside really better? */

console.log('\n' + '='.repeat(78));
console.log('RUN DIRECTION — the premise, checked at league level');
console.log('='.repeat(78));
console.log('\nNote: this is run DIRECTION, not blocking scheme. nflverse charts no');
console.log('zone/gap flag. Outside runs are heavily zone and interior runs heavily');
console.log('gap, so this is a proxy — a real one, but named for what it measures.\n');

for (const season of [...new Set(rows.map((r) => r.season))].sort()) {
  const at = rows.filter((r) => r.season === season && r.position === 'RB');
  const o = at.reduce((a, r) => a + r.outsideCarries, 0);
  const oy = at.reduce((a, r) => a + (r.outsideYpc !== null ? r.outsideYpc * r.outsideCarries : 0), 0);
  const i = at.reduce((a, r) => a + r.insideCarries, 0);
  const iy = at.reduce((a, r) => a + (r.insideYpc !== null ? r.insideYpc * r.insideCarries : 0), 0);
  console.log(
    `  ${season}  outside ${(oy / o).toFixed(2)} yds/carry on ${o} carries · ` +
      `inside ${(iy / i).toFixed(2)} on ${i}  ->  outside is ${(oy / o - iy / i > 0 ? '+' : '')}${(oy / o - iy / i).toFixed(2)}`,
  );
}

/* ------------------------------------------------ 4. does scheme FIT pay? */

console.log('\n' + '='.repeat(78));
console.log('SCHEME FIT — does a back landing in a scheme that suits him actually pay?');
console.log('='.repeat(78));
console.log(
  '\nThe test: take his per-carry edge on outside runs over inside runs in season\n' +
    'N, and his team\'s outside-run rate in season N+1. If fit matters, the backs\n' +
    'whose edge matches their new team\'s tendency should beat the ones it does\n' +
    'not. "Fit" is (his outside edge) x (his next team\'s outside tendency,\n' +
    'centred), so it is positive when a zone-leaning back lands in a zone-leaning\n' +
    'offence AND when a downhill back lands in a downhill one.\n',
);

const fitPool = rows.filter(
  (r) => r.position === 'RB' && r.schemeEdge !== null && r.nextPoints !== null && r.carries >= 80,
);
const nextTeamOutside = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT season, team, outside_run_share o FROM team_context`)
  .all() as Array<{ season: number; team: string; o: number }>) {
  nextTeamOutside.set(`${r.team}|${r.season}`, r.o);
}
const nextTeamOf = new Map<string, string>();
for (const r of sqlite
  .prepare(`SELECT player_id, season, team FROM player_usage WHERE team IS NOT NULL`)
  .all() as Array<{ player_id: string; season: number; team: string }>) {
  nextTeamOf.set(`${r.player_id}|${r.season}`, r.team);
}

const leagueOutside =
  [...nextTeamOutside.values()].reduce((a, b) => a + b, 0) / nextTeamOutside.size;

const withFit = fitPool.flatMap((r) => {
  const team = nextTeamOf.get(`${r.playerId}|${r.season + 1}`);
  if (!team) return [];
  const tend = nextTeamOutside.get(`${team}|${r.season + 1}`);
  if (tend === undefined) return [];
  return [{ r, fit: r.schemeEdge! * (tend - leagueOutside) }];
});

if (withFit.length >= 40) {
  const sorted = [...withFit].sort((a, b) => a.fit - b.fit);
  const third = Math.floor(sorted.length / 3);
  const bad = sorted.slice(0, third);
  const good = sorted.slice(-third);
  console.log(`  n=${withFit.length} backs who played the following season`);
  console.log(
    `  worst-fit third:  ${mean(bad.map((x) => x.r.nextPoints!)).toFixed(1)} next-season points ` +
      `(${mean(bad.map((x) => x.r.points)).toFixed(1)} the year before)`,
  );
  console.log(
    `  best-fit third:   ${mean(good.map((x) => x.r.nextPoints!)).toFixed(1)} next-season points ` +
      `(${mean(good.map((x) => x.r.points)).toFixed(1)} the year before)`,
  );
  const fr = pearson(withFit.map((x) => x.fit), withFit.map((x) => x.r.nextPoints!));
  const fp = partial(
    withFit.map((x) => x.fit),
    withFit.map((x) => x.r.nextPoints!),
    withFit.map((x) => x.r.rushShare),
  );
  console.log(`  correlation of fit with next-season points: r=${fr.toFixed(3)}, after rush share r=${fp.toFixed(3)}`);
} else {
  console.log(`  only ${withFit.length} usable backs — not enough to test`);
}

/* --------------------------------------- 5. is a back's edge even stable? */

console.log('\nIs a back\'s scheme edge even a property of the back?');
console.log('If it does not persist year to year it is noise, and fit cannot be real.');
const edgePairs = rows
  .filter((r) => r.position === 'RB' && r.schemeEdge !== null)
  .flatMap((r) => {
    const nxt = rows.find(
      (x) => x.playerId === r.playerId && x.season === r.season + 1 && x.schemeEdge !== null,
    );
    return nxt ? [[r.schemeEdge!, nxt.schemeEdge!] as const] : [];
  });
if (edgePairs.length >= 20) {
  console.log(
    `  n=${edgePairs.length} back-seasons with an edge in consecutive years: ` +
      `r=${pearson(edgePairs.map((p) => p[0]), edgePairs.map((p) => p[1])).toFixed(3)}`,
  );
} else {
  console.log(`  only ${edgePairs.length} pairs — not enough`);
}
