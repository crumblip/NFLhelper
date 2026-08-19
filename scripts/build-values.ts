import { sqlite } from '../lib/db/index';
import {
  computeValue, loadImplied, loadGrids, gridFor, projectedReplacement, saveValues,
  type ValueRow,
} from '../lib/pipeline/value';
import { buildCoverageProfile, describeProfile } from '../lib/pipeline/coverage';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const grids = loadGrids(FORMAT, TEAMS);
if (!grids.size) throw new Error('no baseline grid — run build:baseline first');
console.log(`baseline curves: ${[...grids.keys()].sort().join(', ')}`);

const replacement = projectedReplacement(FORMAT, TEAMS, CURRENT);
console.log(`value engine | ${FORMAT} | ${TEAMS}-team | ${CURRENT}`);
console.log(
  'projected replacement (3-season mean): ' +
    [...replacement].map(([p, v]) => `${p}=${v.toFixed(0)}`).join('  '),
);

const implied = loadImplied();
const board = sqlite
  .prepare(
    `SELECT player_id, name, position, adp FROM adp_raw
     WHERE year = ? AND format = ? AND teams = ? AND player_id IS NOT NULL
     ORDER BY adp`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{
  player_id: string;
  name: string;
  position: string;
  adp: number;
}>;

const profile = buildCoverageProfile(FORMAT, TEAMS, CURRENT);
console.log(`market-priced categories:\n  ${describeProfile(profile)}\n`);

const rows: ValueRow[] = board.map((p) => {
  const pi = implied.get(p.player_id) ?? {
    playerId: p.player_id,
    position: p.position,
    stats: new Map(),
  };
  // Each player is measured against his own position's curve.
  return computeValue(
    { ...pi, position: p.position }, p.adp, FORMAT, replacement,
    gridFor(grids, p.position), profile,
  );
});

saveValues(rows, FORMAT, TEAMS, CURRENT);

const bySignal = new Map<string, number>();
for (const r of rows) bySignal.set(r.signal, (bySignal.get(r.signal) ?? 0) + 1);
console.log(`\n${rows.length} players scored`);
for (const [s, n] of [...bySignal].sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);

const names = new Map(board.map((b) => [b.player_id, b.name]));

/*
 * Only fully-covered players are ranked.
 *
 * A partial player is missing a category the market prices for their position —
 * three quarters of RBs have no receiving line, worth about 77 half-PPR points.
 * Their total is a floor, not a projection, and ranking it against complete
 * players would put every early-down back at the top of the reach list purely
 * for having thinner markets. They are still computed and shown, just not
 * ranked.
 */
const scored = rows.filter((r) => r.signal === 'full' && r.slotGap !== null);

const show = (title: string, list: ValueRow[]) => {
  console.log(`\n${title}`);
  console.log('    ADP  pos  player                impl pts   ADP eq   slot gap');
  for (const r of list) {
    console.log(
      `  ${String(r.adp).padStart(5)}  ${r.position.padEnd(3)}  ${(names.get(r.playerId) ?? '?').padEnd(21)}` +
        `${r.impliedPoints!.toFixed(0).padStart(8)}   ${r.adpEquivalent!.toFixed(1).padStart(6)}   ` +
        `${(r.slotGap! > 0 ? '+' : '') + r.slotGap!.toFixed(1)}${r.signal === 'partial' ? '  (partial)' : ''}`,
    );
  }
};

show(
  'BEST VALUE — market prices them earlier than they are going',
  [...scored].sort((a, b) => b.slotGap! - a.slotGap!).slice(0, 15),
);
show(
  'BIGGEST REACHES — going earlier than the market prices them',
  [...scored].sort((a, b) => a.slotGap! - b.slotGap!).slice(0, 15),
);

const noSignal = rows.filter((r) => r.signal === 'none');
console.log(`\nno market signal (${noSignal.length}) — shown with ADP only, never a fabricated gap`);
for (const r of noSignal.slice(0, 10)) {
  console.log(`  ${String(r.adp).padStart(5)}  ${r.position}  ${names.get(r.playerId) ?? '?'}`);
}
