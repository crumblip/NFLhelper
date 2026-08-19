import { sqlite } from '../lib/db/index';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

console.log('=== top-60 ADP: signal after the per-game path ===');
const rows = sqlite
  .prepare(
    `SELECT a.name, v.adp, v.position, v.signal, v.market_stats m,
            v.extrapolated_stats x, v.derived_stats d, v.slot_gap
     FROM value_scores v JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
      AND a.format=v.format AND a.teams=v.teams
     WHERE v.format=? AND v.teams=? AND v.season=? AND v.adp<=60 AND v.signal <> 'full'
     ORDER BY v.adp`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{
  name: string; adp: number; position: string; signal: string;
  m: number; x: number; d: number; slot_gap: number | null;
}>;
for (const r of rows) {
  console.log(
    `  ${String(r.adp).padStart(5)} ${r.position.padEnd(3)} ${r.name.padEnd(22)} ` +
      `${r.signal.padEnd(8)} market=${r.m} wk1=${r.x} derived=${r.d}`,
  );
}
console.log(`  ${rows.length} of the top 60 are still not fully ranked`);

console.log('\n=== players rescued from no-signal by the per-game path ===');
const rescued = sqlite
  .prepare(
    `SELECT a.name, v.adp, v.position, v.signal, v.slot_gap, v.extrapolated_stats x
     FROM value_scores v JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
      AND a.format=v.format AND a.teams=v.teams
     WHERE v.format=? AND v.teams=? AND v.season=? AND v.extrapolated_stats > 0
       AND v.signal='full' ORDER BY v.adp`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{
  name: string; adp: number; position: string; slot_gap: number; x: number;
}>;
for (const r of rescued) {
  console.log(
    `  ${String(r.adp).padStart(5)} ${r.position.padEnd(3)} ${r.name.padEnd(22)} ` +
      `slot gap=${(r.slot_gap > 0 ? '+' : '') + r.slot_gap.toFixed(1)}  (${r.x} from wk1)`,
  );
}
console.log(`  ${rescued.length} players`);

console.log('\n=== ranked totals by position ===');
for (const r of sqlite
  .prepare(
    `SELECT position, signal, COUNT(*) n FROM value_scores
     WHERE format=? AND teams=? AND season=? GROUP BY position, signal ORDER BY position, signal`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{ position: string; signal: string; n: number }>) {
  console.log(`  ${r.position}  ${r.signal.padEnd(8)} ${r.n}`);
}
