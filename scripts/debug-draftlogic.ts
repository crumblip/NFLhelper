import { sqlite } from '../lib/db/index';

/** What does the board look like ranked by value rather than by price gap? */

const repl = new Map(
  (
    sqlite
      .prepare(
        `SELECT position, AVG(points) p FROM replacement_level
         WHERE format='half-ppr' AND teams=12 AND season>=2023 GROUP BY position`,
      )
      .all() as Array<{ position: string; p: number }>
  ).map((r) => [r.position, r.p]),
);
console.log('replacement: ' + [...repl].map(([k, v]) => `${k}=${v.toFixed(0)}`).join('  '));

const rows = (
  sqlite
    .prepare(
      `SELECT a.name, v.position, v.adp, v.blended_points bp, v.blended_slot_gap gap, v.signal
       FROM value_scores v JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
        AND a.format=v.format AND a.teams=v.teams
       WHERE v.season=2026 AND v.blended_points IS NOT NULL`,
    )
    .all() as Array<{
    name: string; position: string; adp: number; bp: number; gap: number; signal: string;
  }>
).map((r) => ({ ...r, vorp: r.bp - (repl.get(r.position) ?? 0) }));

console.log('\n=== TOP 20 BY SLOT GAP (what the board leads with today) ===');
console.log('    ADP pos player                 pts   VORP    gap');
for (const r of [...rows].sort((a, b) => b.gap - a.gap).slice(0, 20)) {
  console.log(
    `  ${String(r.adp).padStart(5)} ${r.position.padEnd(3)} ${r.name.padEnd(21)}` +
      `${r.bp.toFixed(0).padStart(5)} ${r.vorp.toFixed(0).padStart(6)} ${(r.gap > 0 ? '+' : '') + r.gap.toFixed(0)}`,
  );
}

console.log('\n=== TOP 20 BY VALUE OVER REPLACEMENT (real draft order) ===');
console.log('    ADP pos player                 pts   VORP    gap');
for (const r of [...rows].sort((a, b) => b.vorp - a.vorp).slice(0, 20)) {
  console.log(
    `  ${String(r.adp).padStart(5)} ${r.position.padEnd(3)} ${r.name.padEnd(21)}` +
      `${r.bp.toFixed(0).padStart(5)} ${r.vorp.toFixed(0).padStart(6)} ${(r.gap > 0 ? '+' : '') + r.gap.toFixed(0)}`,
  );
}

console.log('\n=== where the positions actually land by VORP ===');
const sorted = [...rows].sort((a, b) => b.vorp - a.vorp);
const counts = new Map<string, number>();
for (const [i, r] of sorted.entries()) {
  if (i >= 60) break;
  counts.set(r.position, (counts.get(r.position) ?? 0) + 1);
}
console.log('  in the top 60 by value: ' + [...counts].map(([k, v]) => `${k} ${v}`).join(', '));
const firstQb = sorted.findIndex((r) => r.position === 'QB');
console.log(`  first QB appears at value rank ${firstQb + 1}: ${sorted[firstQb]?.name}`);

console.log('\n=== the two players in question ===');
for (const name of ['Justin Herbert', 'Omar Cooper', 'Ja\'Marr Chase']) {
  const r = rows.find((x) => x.name.includes(name));
  if (!r) continue;
  const rank = sorted.findIndex((x) => x.name === r.name) + 1;
  console.log(
    `  ${r.name.padEnd(20)} ${r.position} ADP ${String(r.adp).padStart(5)}  ` +
      `pts ${r.bp.toFixed(0).padStart(4)}  VORP ${r.vorp.toFixed(0).padStart(5)}  ` +
      `gap ${(r.gap > 0 ? '+' : '') + r.gap.toFixed(0)}  -> value rank ${rank} (${r.signal})`,
  );
}
