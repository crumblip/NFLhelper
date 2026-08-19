import { sqlite } from '../lib/db/index';

/** What does the undrafted pool actually look like, so a floor can be set on evidence? */

const CURRENT = Number(process.env.SEASON ?? 2026);

const drafted = new Set(
  (
    sqlite
      .prepare(`SELECT player_id FROM adp_raw WHERE year = ? AND player_id IS NOT NULL`)
      .all(CURRENT) as Array<{ player_id: string }>
  ).map((r) => r.player_id),
);

const pool = (
  sqlite
    .prepare(
      `SELECT u.player_id, p.display_name n, u.position, u.games,
              COALESCE(u.target_share,0) ts, COALESCE(u.rush_share,0) rs,
              COALESCE(u.pass_snap_share,0) pss,
              COALESCE(u.rz_carries,0) + COALESCE(u.rz_targets,0) rzTouches,
              (SELECT MIN(pos_rank) FROM depth_chart dc
               WHERE dc.player_id = u.player_id AND dc.season = ?) depthRank
       FROM player_usage u JOIN players p ON p.gsis_id = u.player_id
       WHERE u.season = ? AND u.position IN ('WR','RB','TE')`,
    )
    .all(CURRENT, CURRENT - 1) as Array<{
    player_id: string; n: string; position: string; games: number;
    ts: number; rs: number; pss: number; rzTouches: number; depthRank: number | null;
  }>
).filter((r) => !drafted.has(r.player_id) && r.depthRank !== null);

console.log(`undrafted, on a depth chart: ${pool.length}\n`);

// "Involvement" is the position-appropriate volume share.
const involvement = (r: (typeof pool)[number]) =>
  r.position === 'RB' ? Math.max(r.rs, r.ts) : r.ts;

const sorted = [...pool].sort((a, b) => involvement(a) - involvement(b));
console.log('involvement percentiles (rush share for RB, target share for WR/TE):');
for (const q of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const v = sorted[Math.floor(q * (sorted.length - 1))]!;
  console.log(`  p${String(Math.round(q * 100)).padStart(2)}  ${(involvement(v) * 100).toFixed(1)}%   e.g. ${v.n}`);
}

console.log('\nhow many clear each candidate floor?');
for (const floor of [0, 0.02, 0.03, 0.05, 0.08, 0.1]) {
  const n = pool.filter((r) => involvement(r) >= floor).length;
  const withSnaps = pool.filter((r) => involvement(r) >= floor && r.pss >= 0.15).length;
  console.log(
    `  involvement >= ${(floor * 100).toFixed(0)}%  ->  ${String(n).padStart(3)} players` +
      `   (${withSnaps} also on field for 15%+ of pass plays)`,
  );
}

console.log('\nplayers with zero involvement but a depth-chart spot (the noise to remove):');
for (const r of pool.filter((r) => involvement(r) < 0.02).slice(0, 8)) {
  console.log(
    `  ${r.position} ${String(r.n).padEnd(24)} games ${String(r.games).padStart(2)}  ` +
      `tgt ${(r.ts * 100).toFixed(1)}%  rush ${(r.rs * 100).toFixed(1)}%  rz touches ${r.rzTouches}`,
  );
}
