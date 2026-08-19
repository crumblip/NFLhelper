import { sqlite } from '../lib/db/index';

const rows = sqlite
  .prepare(
    `SELECT p.display_name n, u.season, u.team, u.games, u.pass_snaps ps,
            u.team_pass_snaps tps, u.pass_snap_share s
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE p.display_name LIKE '%Adams%' AND u.position = 'WR'
     ORDER BY u.season DESC`,
  )
  .all() as Array<Record<string, number | string | null>>;

console.log('Adams usage rows:');
for (const r of rows) {
  console.log(
    `  ${r.season} ${String(r.n).padEnd(16)} ${String(r.team).padEnd(4)} ` +
      `${String(r.games).padStart(2)}g  snaps ${String(r.ps).padStart(4)}/${String(r.tps).padEnd(4)}  ` +
      `share ${((Number(r.s) || 0) * 100).toFixed(1)}%`,
  );
}

console.log('\nany pass_snap_share above 1.0 anywhere:');
const over = sqlite
  .prepare(
    `SELECT p.display_name n, u.season, u.position, u.team, u.games,
            u.pass_snaps ps, u.team_pass_snaps tps, u.pass_snap_share s
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.pass_snap_share > 1.0 ORDER BY u.pass_snap_share DESC LIMIT 15`,
  )
  .all() as Array<Record<string, number | string | null>>;
for (const r of over) {
  console.log(
    `  ${r.season} ${String(r.position).padEnd(3)} ${String(r.n).padEnd(20)} ${String(r.team).padEnd(4)} ` +
      `${String(r.games).padStart(2)}g  ${String(r.ps).padStart(4)}/${String(r.tps).padEnd(4)}  ` +
      `${((Number(r.s) || 0) * 100).toFixed(1)}%`,
  );
}
console.log(`  ${over.length} shown`);

console.log('\nwhat the tags currently say for Adams:');
for (const r of sqlite
  .prepare(
    `SELECT a.name, v.tags FROM value_scores v
     JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
      AND a.format = v.format AND a.teams = v.teams
     WHERE v.season = 2026 AND a.name LIKE '%Adams%'`,
  )
  .all() as Array<{ name: string; tags: string | null }>) {
  const tags = r.tags ? (JSON.parse(r.tags) as Array<{ label: string; detail: string }>) : [];
  console.log(`  ${r.name}`);
  for (const t of tags) console.log(`    ${t.label}: ${t.detail.slice(0, 90)}`);
}
