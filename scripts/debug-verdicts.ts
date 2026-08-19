import { sqlite } from '../lib/db/index';

/** Why are early-round players labelled streamable, and why is everything "fairly priced"? */

const rows = sqlite
  .prepare(
    `SELECT a.name, v.position, v.adp, v.signal, v.implied_points mkt, v.usage_points up,
            v.blended_points bp, v.verdict, v.slot_gap sg, v.blended_slot_gap bsg,
            v.disagreement dis
     FROM value_scores v JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
      AND a.format=v.format AND a.teams=v.teams
     WHERE v.season=2026 AND v.position IN ('WR','RB') AND v.adp < 100
       AND v.blended_points IS NOT NULL
     ORDER BY v.adp`,
  )
  .all() as Array<Record<string, number | string | null>>;

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

console.log('\nsub-100 ADP WR/RB where the blend lands below replacement:\n');
console.log('   ADP pos player                signal    mkt  usage  blend  repl   verdict');
let bad = 0;
for (const r of rows) {
  const rp = repl.get(String(r.position)) ?? 0;
  if (Number(r.bp) >= rp) continue;
  bad++;
  console.log(
    `  ${String(r.adp).padStart(5)} ${String(r.position).padEnd(3)} ${String(r.name).padEnd(21)}` +
      `${String(r.signal).padEnd(9)}${r.mkt === null ? '   —' : Number(r.mkt).toFixed(0).padStart(5)}` +
      `${r.up === null ? '     —' : Number(r.up).toFixed(0).padStart(7)}` +
      `${Number(r.bp).toFixed(0).padStart(7)}${rp.toFixed(0).padStart(6)}   ${r.verdict}`,
  );
}
console.log(`\n${bad} of ${rows.length} sub-100 WR/RB project below replacement`);

console.log('\n=== verdict spread across ALL WR/RB ===');
for (const r of sqlite
  .prepare(
    `SELECT verdict, COUNT(*) n, ROUND(AVG(blended_slot_gap),1) avgGap,
            ROUND(AVG(disagreement),2) avgDis
     FROM value_scores WHERE season=2026 AND position IN ('WR','RB')
       AND verdict IS NOT NULL GROUP BY verdict ORDER BY n DESC`,
  )
  .all() as Array<Record<string, number | string>>) {
  console.log(
    `  ${String(r.n).padStart(3)}  ${String(r.verdict).padEnd(26)} ` +
      `avg gap ${String(r.avgGap).padStart(7)}  avg disagreement ${r.avgDis}`,
  );
}

console.log('\n=== how much do the two signals actually disagree? ===');
const dis = (
  sqlite
    .prepare(
      `SELECT ABS(disagreement) d FROM value_scores
       WHERE season=2026 AND disagreement IS NOT NULL ORDER BY d`,
    )
    .all() as Array<{ d: number }>
).map((r) => r.d);
if (dis.length) {
  const q = (p: number) => dis[Math.floor(p * (dis.length - 1))]!.toFixed(2);
  console.log(`  |disagreement| p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}`);
  console.log('  thresholds in use: 0.4 (mild) and 0.75 (strong)');
}
