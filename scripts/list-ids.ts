import { sqlite } from '../lib/db/index';

const names = process.argv.slice(2);
const rows = sqlite
  .prepare(
    `SELECT a.name, a.player_id, v.signal, v.slot_gap
     FROM adp_raw a LEFT JOIN value_scores v ON v.player_id = a.player_id AND v.season = a.year
     WHERE a.year = 2026 AND a.format = 'half-ppr' AND a.teams = 12
     ORDER BY a.adp`,
  )
  .all() as Array<{ name: string; player_id: string; signal: string; slot_gap: number | null }>;

const wanted = names.length
  ? rows.filter((r) => names.some((n) => r.name.toLowerCase().includes(n.toLowerCase())))
  : rows.slice(0, 10);

for (const r of wanted) {
  console.log(`${r.player_id}  ${r.name.padEnd(24)} ${r.signal ?? '-'}  gap=${r.slot_gap?.toFixed(1) ?? '-'}`);
}
