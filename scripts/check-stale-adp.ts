import { sqlite } from '../lib/db/index';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const latest = sqlite
  .prepare(`SELECT MAX(fetched_at) mx FROM adp_raw WHERE format=? AND teams=? AND year=?`)
  .get(FORMAT, TEAMS, CURRENT) as { mx: number };

const rows = sqlite
  .prepare(
    `SELECT name, position, adp, fetched_at FROM adp_raw
     WHERE format=? AND teams=? AND year=? ORDER BY fetched_at, adp`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{
  name: string; position: string; adp: number; fetched_at: number;
}>;

const stale = rows.filter((r) => r.fetched_at < latest.mx);
console.log(`2026 rows: ${rows.length}  |  from latest fetch: ${rows.length - stale.length}  |  stale: ${stale.length}`);
if (stale.length) {
  console.log('\nstale rows — dropped out of FFC but still on the board:');
  for (const s of stale) {
    console.log(
      `  ${String(s.adp).padStart(6)}  ${s.position}  ${s.name.padEnd(24)} ` +
        `last seen ${new Date(s.fetched_at).toISOString().slice(0, 16)}`,
    );
  }
}
