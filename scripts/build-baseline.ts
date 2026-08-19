import { sqlite } from '../lib/db/index';
import {
  DEFAULT_ROSTER,
  replacementRanks,
  fitBaseline,
  expectedAt,
  adpEquivalent,
  type Observation,
} from '../lib/pipeline/baseline';
import { buildCoverageProfile, describeProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

/**
 * Fits the ADP baseline from completed seasons and writes the grid.
 *
 * Every number here comes from what players actually did after being drafted
 * where they were drafted. Busts and injuries stay in the sample on purpose —
 * "what a pick returns" has to include the times it returned nothing.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const roster = { ...DEFAULT_ROSTER, teams: TEAMS };
const ranks = replacementRanks(roster);
const now = Date.now();

console.log(`baseline fit | ${FORMAT} | ${TEAMS}-team | seasons < ${CURRENT}`);
console.log(`replacement ranks: ${Object.entries(ranks).map(([p, r]) => `${p}${r}`).join(' ')}\n`);

/*
 * Historical points are re-scored using only the categories the market prices
 * for each position, rather than taken from the stored half-PPR total.
 *
 * Without this the two sides of the comparison are denominated differently: a
 * QB's implied line carries no interception penalty because no book posts one,
 * while their historical baseline does. That gap alone made every startable QB
 * look ~20 points better than the pick they were going at.
 */
const profile = buildCoverageProfile(FORMAT, TEAMS, CURRENT);
console.log(`market-priced categories:\n  ${describeProfile(profile)}\n`);

const rules = rulesFor(FORMAT);
const scoreFor = (position: string, line: StatLine): number => {
  const categories = profile.get(position.toUpperCase());
  return scoreStatLine(categories ? maskStatLine(line, categories) : line, rules);
};

const rawTotals = sqlite
  .prepare(
    `SELECT player_id, season, MAX(position) AS position,
            SUM(passing_yards) AS passingYards, SUM(passing_tds) AS passingTds,
            SUM(interceptions) AS interceptions,
            SUM(rushing_yards) AS rushingYards, SUM(rushing_tds) AS rushingTds,
            SUM(receptions) AS receptions, SUM(receiving_yards) AS receivingYards,
            SUM(receiving_tds) AS receivingTds,
            SUM(COALESCE(sack_fumbles_lost,0) + COALESCE(rushing_fumbles_lost,0)
                + COALESCE(receiving_fumbles_lost,0)) AS fumblesLost
     FROM player_stats_week
     WHERE season_type = 'REG' AND season < ?
     GROUP BY player_id, season`,
  )
  .all(CURRENT) as Array<
  { player_id: string; season: number; position: string | null } & StatLine
>;

const seasonTotals = rawTotals.map((r) => ({
  player_id: r.player_id,
  season: r.season,
  position: r.position,
  points: scoreFor(r.position ?? '', r),
}));

const scoredBySeason = new Map<string, number>();
for (const r of seasonTotals) scoredBySeason.set(`${r.player_id}|${r.season}`, r.points);

// Replacement level per (season, position): the Nth best total that year.
const bySeasonPos = new Map<string, number[]>();
for (const r of seasonTotals) {
  const pos = (r.position ?? '').toUpperCase();
  if (!(pos in ranks)) continue;
  const key = `${r.season}|${pos}`;
  const list = bySeasonPos.get(key) ?? [];
  list.push(r.points ?? 0);
  bySeasonPos.set(key, list);
}

const replacement = new Map<string, number>();
const insertReplacement = sqlite.prepare(
  `INSERT OR REPLACE INTO replacement_level
   (format, teams, season, position, rank_used, points, fitted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

sqlite.transaction(() => {
  for (const [key, list] of bySeasonPos) {
    const [seasonStr, pos] = key.split('|') as [string, string];
    const rank = ranks[pos]!;
    list.sort((a, b) => b - a);
    // If a position ran thin that year, fall back to the last real value
    // rather than inventing a zero.
    const points = list[Math.min(rank, list.length) - 1] ?? 0;
    replacement.set(key, points);
    insertReplacement.run(FORMAT, TEAMS, Number(seasonStr), pos, rank, points, now);
  }
})();

console.log('replacement level by season:');
const seasons = [...new Set(seasonTotals.map((r) => r.season))].sort();
for (const s of seasons) {
  const parts = Object.keys(ranks).map((p) => {
    const v = replacement.get(`${s}|${p}`);
    return `${p}${ranks[p]}=${v === undefined ? '-' : v.toFixed(0)}`;
  });
  console.log(`  ${s}  ${parts.join('  ')}`);
}

// Join ADP to that same season's outcome. A drafted player with no stats row
// scored nothing that year, which is a real outcome and belongs in the sample.
const drafted = (
  sqlite
    .prepare(
      `SELECT a.year, a.adp, a.position, a.times_drafted, a.player_id
       FROM adp_raw a
       WHERE a.format = ? AND a.teams = ? AND a.year < ? AND a.player_id IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, CURRENT) as Array<{
    year: number;
    adp: number;
    position: string;
    times_drafted: number | null;
    player_id: string;
  }>
).map((d) => ({
  ...d,
  points: scoredBySeason.get(`${d.player_id}|${d.year}`) ?? 0,
}));

const observations: Observation[] = [];
for (const d of drafted) {
  const pos = d.position.toUpperCase();
  const repl = replacement.get(`${d.year}|${pos}`);
  if (repl === undefined) continue;
  observations.push({
    adp: d.adp,
    points: d.points,
    vorp: d.points - repl,
    // Thin years (2022 has a 2-day, 1107-draft window) should not carry the
    // same weight as a 4576-draft year.
    weight: Math.log1p(d.times_drafted ?? 1),
  });
}

console.log(`\nobservations: ${observations.length} player-seasons`);
const byYear = new Map<number, number>();
for (const d of drafted) byYear.set(d.year, (byYear.get(d.year) ?? 0) + 1);
console.log(`  ${[...byYear].sort().map(([y, n]) => `${y}:${n}`).join('  ')}`);

/*
 * Fitted per position, plus a pooled 'ALL' curve as a fallback.
 *
 * Receivers and backs decay differently with draft position and bust at
 * different rates, so a single pooled curve let the position mix at each slot
 * drive the answer. Positions too thin to fit on their own fall back to the
 * pooled curve rather than being fitted on noise.
 */
const MIN_OBSERVATIONS = 120;

const insertGrid = sqlite.prepare(
  `INSERT OR REPLACE INTO adp_baseline
   (format, teams, position, adp_slot, expected_points, expected_vorp, sample_n, fitted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

const byPosition = new Map<string, Observation[]>();
observations.forEach((o, i) => {
  const pos = drafted[i]!.position.toUpperCase();
  const list = byPosition.get(pos) ?? [];
  list.push(o);
  byPosition.set(pos, list);
});

const pooled = fitBaseline(observations);
sqlite.transaction(() => {
  for (const g of pooled) {
    insertGrid.run(FORMAT, TEAMS, 'ALL', g.adpSlot, g.expectedPoints, g.expectedVorp, g.sampleN, now);
  }
})();

const grids = new Map<string, ReturnType<typeof fitBaseline>>([['ALL', pooled]]);
console.log('\nper-position baseline fits:');
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const obs = byPosition.get(pos) ?? [];
  if (obs.length < MIN_OBSERVATIONS) {
    console.log(`  ${pos}: ${obs.length} observations — too thin, falls back to pooled`);
    continue;
  }
  // A wider span than the pooled fit, since each position has fewer points.
  const g = fitBaseline(obs, { span: 0.45 });
  grids.set(pos, g);
  sqlite.transaction(() => {
    for (const row of g) {
      insertGrid.run(FORMAT, TEAMS, pos, row.adpSlot, row.expectedPoints, row.expectedVorp, row.sampleN, now);
    }
  })();
  console.log(`  ${pos}: ${obs.length} observations, ${g.length} slots`);
}

console.log('\nexpected VORP by pick and position — where they diverge is the point');
console.log('  pick     ALL      QB      RB      WR      TE');
for (const slot of [6, 12, 24, 36, 50, 75, 100, 130, 160, 190]) {
  const cells = ['ALL', 'QB', 'RB', 'WR', 'TE'].map((p) => {
    const g = grids.get(p);
    return g ? expectedAt(g, slot).expectedVorp.toFixed(0).padStart(7) : '      -';
  });
  console.log(`  ${String(slot).padStart(4)}  ${cells.join(' ')}`);
}

const grid = pooled;

// Where the curve went flat, PAVA pooled non-monotonic noise. That is the
// right call statistically, but it means those slots are not distinguishable
// and the board must not imply otherwise.
const flat: Array<[number, number]> = [];
let runStart = 0;
for (let i = 1; i <= grid.length; i++) {
  const same = i < grid.length && Math.abs(grid[i]!.expectedVorp - grid[runStart]!.expectedVorp) < 1e-9;
  if (!same) {
    if (i - runStart >= 4) flat.push([grid[runStart]!.adpSlot, grid[i - 1]!.adpSlot]);
    runStart = i;
  }
}
if (flat.length) {
  console.log('\nflat regions (picks the history cannot tell apart):');
  for (const [a, b] of flat) console.log(`  picks ${a} - ${b}`);
}

// Round trip: expected value at a slot should invert back to that slot.
console.log('\ninversion check (slot -> VORP -> slot):');
let maxErr = 0;
for (const slot of [3, 15, 40, 80, 120, 170]) {
  const v = expectedAt(grid, slot).expectedVorp;
  const back = adpEquivalent(grid, v);
  maxErr = Math.max(maxErr, Math.abs(back - slot));
  console.log(`  ${String(slot).padStart(4)} -> ${v.toFixed(1).padStart(7)} -> ${back.toFixed(1)}`);
}
console.log(`  max round-trip error: ${maxErr.toFixed(2)} picks`);

console.log('\nmonotonicity:', grid.every((g, i) => i === 0 || g.expectedVorp <= grid[i - 1]!.expectedVorp + 1e-9) ? 'OK (non-increasing)' : 'VIOLATED');
