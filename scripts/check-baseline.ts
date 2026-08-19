import { sqlite } from '../lib/db/index';
import { expectedAt, adpEquivalent, type GridPoint } from '../lib/pipeline/baseline';

/** Sanity check: the fitted grid, read back the way the value engine will use it. */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const grid = sqlite
  .prepare(
    `SELECT adp_slot AS adpSlot, expected_points AS expectedPoints,
            expected_vorp AS expectedVorp, sample_n AS sampleN
     FROM adp_baseline WHERE format = ? AND teams = ? ORDER BY adp_slot`,
  )
  .all(FORMAT, TEAMS) as GridPoint[];

const board = sqlite
  .prepare(
    `SELECT adp, position, name FROM adp_raw
     WHERE year = ? AND format = ? AND teams = ? ORDER BY adp`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{ adp: number; position: string; name: string }>;

console.log(`=== ${CURRENT} board joined to the baseline (props arrive in section 4) ===`);
console.log('   ADP  pos  player                 exp VORP   exp pts   local n');
const sample = [...board.slice(0, 5), ...board.slice(58, 62), ...board.slice(-3)];
for (const r of sample) {
  const g = expectedAt(grid, r.adp);
  console.log(
    `  ${String(r.adp).padStart(5)}  ${r.position.padEnd(3)}  ${r.name.padEnd(22)}` +
      `${g.expectedVorp.toFixed(1).padStart(7)}   ${g.expectedPoints.toFixed(1).padStart(7)}   ${String(g.sampleN).padStart(5)}`,
  );
}

console.log(`\ngrid rows ${grid.length} | ${CURRENT} board players ${board.length}`);
console.log('\nworked inversions (what a projection would be worth):');
for (const v of [90, 60, 30, 0, -30]) {
  console.log(`  ${String(v).padStart(4)} VORP -> pick ${adpEquivalent(grid, v).toFixed(1)}`);
}
