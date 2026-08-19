import { sqlite } from '../lib/db/index';
import { buildCoverageProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

/**
 * Is "late QB and TE are undervalued" a real historical pattern, or an artifact
 * of comparing low-variance positions against a pooled baseline that deep RBs
 * and WRs drag down?
 *
 * The value engine says a QB going at 110 beats what that pick returns. This
 * checks the same claim directly against eight seasons of outcomes, with no
 * props involved.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

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
     FROM player_stats_week WHERE season_type = 'REG' AND season < ?
     GROUP BY player_id, season`,
  )
  .all(CURRENT) as Array<{ player_id: string; season: number; position: string | null } & StatLine>;

const scored = new Map<string, number>();
for (const r of totals) {
  const pos = (r.position ?? '').toUpperCase();
  const cats = profile.get(pos);
  scored.set(`${r.player_id}|${r.season}`, scoreStatLine(cats ? maskStatLine(r, cats) : r, rules));
}

const repl = new Map<string, number>();
for (const r of sqlite
  .prepare(`SELECT season, position, points FROM replacement_level WHERE format = ? AND teams = ?`)
  .all(FORMAT, TEAMS) as Array<{ season: number; position: string; points: number }>) {
  repl.set(`${r.season}|${r.position}`, r.points);
}

const drafted = sqlite
  .prepare(
    `SELECT year, adp, position, player_id FROM adp_raw
     WHERE format = ? AND teams = ? AND year < ? AND player_id IS NOT NULL`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{
  year: number; adp: number; position: string; player_id: string;
}>;

const buckets: Array<[number, number]> = [
  [1, 24], [24, 48], [48, 72], [72, 100], [100, 140], [140, 200],
];
const positions = ['QB', 'RB', 'WR', 'TE'];

console.log('historical mean VORP by position and draft slot (2018-2025, no props involved)\n');
console.log('  slots        ' + positions.map((p) => p.padStart(10)).join(''));

for (const [lo, hi] of buckets) {
  const cells = positions.map((pos) => {
    const vals = drafted
      .filter((d) => d.adp >= lo && d.adp < hi && d.position.toUpperCase() === pos)
      .map((d) => {
        const pts = scored.get(`${d.player_id}|${d.year}`) ?? 0;
        return pts - (repl.get(`${d.year}|${pos}`) ?? 0);
      });
    if (vals.length < 5) return '     n/a  ';
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return `${mean.toFixed(0)} (${vals.length})`.padStart(10);
  });
  console.log(`  ${String(lo).padStart(3)}-${String(hi).padEnd(4)}    ${cells.join('')}`);
}

console.log('\nIf QB and TE really do hold up better at deep slots, these columns');
console.log('stay near zero while RB and WR fall away — and the signal is real.');

const counts = sqlite
  .prepare(
    `SELECT signal, position, COUNT(*) n FROM value_scores
     WHERE format = ? AND teams = ? AND season = ? GROUP BY signal, position`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{ signal: string; position: string; n: number }>;

console.log('\nranked coverage by signal tier:');
const grid = new Map<string, Map<string, number>>();
for (const c of counts) {
  const row = grid.get(c.signal) ?? new Map();
  row.set(c.position, c.n);
  grid.set(c.signal, row);
}
console.log('  signal    ' + positions.map((p) => p.padStart(6)).join(''));
for (const [sig, row] of grid) {
  console.log(`  ${sig.padEnd(9)} ` + positions.map((p) => String(row.get(p) ?? 0).padStart(6)).join(''));
}
