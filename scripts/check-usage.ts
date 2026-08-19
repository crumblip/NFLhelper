import { sqlite } from '../lib/db/index';

/**
 * Do the usage numbers survive contact with reality?
 *
 * Pass-snap share is the one to watch: if dropback detection is wrong the whole
 * metric is silently mis-scaled, and a plausible-looking 0.6 would be a bug
 * rather than a role.
 */

const SEASON = Number(process.env.CHECK_SEASON ?? 2025);

console.log(`=== ${SEASON} pass-snap share leaders (WR) ===`);
console.log('  player                 team  G   snaps/team   share   tgt%   tgt/route  aDOT  YAC/rec');
for (const r of sqlite
  .prepare(
    `SELECT p.display_name n, u.team, u.games, u.pass_snaps ps, u.team_pass_snaps tps,
            u.pass_snap_share s, u.target_share ts, u.targets_per_route tpr,
            u.adot, u.yac_per_reception yac
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.season = ? AND u.position = 'WR' AND u.pass_snap_share IS NOT NULL
     ORDER BY u.pass_snap_share DESC LIMIT 10`,
  )
  .all(SEASON) as Array<Record<string, number | string>>) {
  console.log(
    `  ${String(r.n).padEnd(22)} ${String(r.team).padEnd(4)} ${String(r.games).padStart(2)}  ` +
      `${String(r.ps).padStart(4)}/${String(r.tps).padEnd(4)}  ${(Number(r.s) * 100).toFixed(0).padStart(5)}%  ` +
      `${(Number(r.ts) * 100).toFixed(1).padStart(5)}%  ${Number(r.tpr).toFixed(3).padStart(8)}  ` +
      `${Number(r.adot).toFixed(1).padStart(4)}  ${Number(r.yac).toFixed(1).padStart(6)}`,
  );
}

console.log(`\n=== ${SEASON} RB rushing efficiency ===`);
console.log('  player                 team  rush%  before  after  broken');
for (const r of sqlite
  .prepare(
    `SELECT p.display_name n, u.team, u.rush_share rs, u.yards_before_contact ybc,
            u.yards_after_contact yac, u.broken_tackles bt
     FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
     WHERE u.season = ? AND u.position = 'RB' AND u.yards_after_contact IS NOT NULL
     ORDER BY u.rush_share DESC LIMIT 10`,
  )
  .all(SEASON) as Array<Record<string, number | string>>) {
  console.log(
    `  ${String(r.n).padEnd(22)} ${String(r.team).padEnd(4)} ` +
      `${(Number(r.rs) * 100).toFixed(0).padStart(4)}%  ${Number(r.ybc).toFixed(2).padStart(6)}  ` +
      `${Number(r.yac).toFixed(2).padStart(5)}  ${String(r.bt).padStart(6)}`,
  );
}

console.log('\n=== sanity: distribution of pass-snap share ===');
const dist = sqlite
  .prepare(
    `SELECT position, COUNT(*) n, MIN(pass_snap_share) lo,
            AVG(pass_snap_share) avg, MAX(pass_snap_share) hi
     FROM player_usage WHERE season = ? AND pass_snap_share IS NOT NULL
     GROUP BY position ORDER BY position`,
  )
  .all(SEASON) as Array<{ position: string; n: number; lo: number; avg: number; hi: number }>;
for (const d of dist) {
  console.log(
    `  ${d.position.padEnd(3)} n=${String(d.n).padStart(3)}  ` +
      `min=${(d.lo * 100).toFixed(0)}%  mean=${(d.avg * 100).toFixed(0)}%  max=${(d.hi * 100).toFixed(0)}%`,
  );
}
console.log('  a full-time WR should sit near 90%; anything above 100% means dropback');
console.log('  detection is over- or under-counting.');

console.log('\n=== team motion rate (scheme context, NOT personal) ===');
for (const r of sqlite
  .prepare(
    `SELECT team, MAX(team_motion_rate) m FROM player_usage
     WHERE season = ? AND team_motion_rate IS NOT NULL GROUP BY team ORDER BY m DESC LIMIT 6`,
  )
  .all(SEASON) as Array<{ team: string; m: number }>) {
  console.log(`  ${r.team.padEnd(4)} ${(r.m * 100).toFixed(1)}% of plays with pre-snap motion`);
}
