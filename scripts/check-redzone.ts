import { sqlite } from '../lib/db/index';

const SEASON = Number(process.env.CHECK_SEASON ?? 2025);

console.log(`=== ${SEASON} goal-line carries (inside the 5) ===`);
console.log('  player                 team  pos  GL car  GL tgt  GL share  RZ car  RZ tgt  RZ TD  total TD');
for (const r of sqlite
  .prepare(
    `SELECT p.display_name n, u.team, u.position, u.goal_line_carries glc,
            u.goal_line_targets glt, u.goal_line_share gls, u.rz_carries rzc,
            u.rz_targets rzt, u.rz_tds rztd, u.total_tds td
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.season = ? AND u.goal_line_carries IS NOT NULL
     ORDER BY u.goal_line_carries DESC LIMIT 10`,
  )
  .all(SEASON) as Array<Record<string, number | string>>) {
  console.log(
    `  ${String(r.n).padEnd(22)} ${String(r.team).padEnd(4)} ${String(r.position).padEnd(3)} ` +
      `${String(r.glc).padStart(6)}  ${String(r.glt).padStart(6)}  ` +
      `${(Number(r.gls) * 100).toFixed(0).padStart(7)}%  ${String(r.rzc).padStart(6)}  ` +
      `${String(r.rzt).padStart(6)}  ${String(r.rztd).padStart(5)}  ${String(r.td).padStart(8)}`,
  );
}

console.log(`\n=== ${SEASON} red-zone target leaders (WR/TE) ===`);
console.log('  player                 team  pos  RZ tgt  GL tgt  RZ share  RZ TD  total TD');
for (const r of sqlite
  .prepare(
    `SELECT p.display_name n, u.team, u.position, u.rz_targets rzt,
            u.goal_line_targets glt, u.rz_touch_share rzs, u.rz_tds rztd, u.total_tds td
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.season = ? AND u.position IN ('WR','TE') AND u.rz_targets IS NOT NULL
     ORDER BY u.rz_targets DESC LIMIT 10`,
  )
  .all(SEASON) as Array<Record<string, number | string>>) {
  console.log(
    `  ${String(r.n).padEnd(22)} ${String(r.team).padEnd(4)} ${String(r.position).padEnd(3)} ` +
      `${String(r.rzt).padStart(6)}  ${String(r.glt).padStart(6)}  ` +
      `${(Number(r.rzs) * 100).toFixed(0).padStart(7)}%  ${String(r.rztd).padStart(5)}  ${String(r.td).padStart(8)}`,
  );
}

console.log('\n=== sanity ===');
const tot = sqlite
  .prepare(
    `SELECT SUM(total_tds) td, SUM(rz_tds) rztd, SUM(rz_carries) rzc, SUM(rz_targets) rzt
     FROM player_usage WHERE season = ?`,
  )
  .get(SEASON) as { td: number; rztd: number; rzc: number; rzt: number };
console.log(`  league TDs credited: ${tot.td} (of which ${tot.rztd} from inside the 20)`);
console.log(`  red-zone carries ${tot.rzc}, red-zone targets ${tot.rzt}`);
console.log('  a full season is roughly 1,300 offensive TDs across 32 teams.');
