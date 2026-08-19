import { sqlite } from '../lib/db/index';

/**
 * Every player on the board with no NFL history, and what the tool currently
 * knows about them.
 *
 * Rookies are where the market-only approach is thinnest: there is no usage to
 * lean on, so any category a book does not price falls back to a positional
 * average that treats a first-round starter and a camp body identically.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const rookies = sqlite
  .prepare(
    `SELECT a.name, a.position, a.team, a.adp, a.player_id,
            p.rookie_season, p.status,
            v.signal, v.implied_points AS pts, v.slot_gap AS gap,
            v.market_stats AS m, v.extrapolated_stats AS x, v.derived_stats AS d,
            (SELECT COUNT(*) FROM player_stats_week s
             WHERE s.player_id = a.player_id AND s.season_type = 'REG') AS careerGames
     FROM adp_raw a
     JOIN players p ON p.gsis_id = a.player_id
     LEFT JOIN value_scores v ON v.player_id = a.player_id AND v.season = a.year
      AND v.format = a.format AND v.teams = a.teams
     WHERE a.year = ? AND a.format = ? AND a.teams = ?
     ORDER BY a.adp`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{
  name: string; position: string; team: string | null; adp: number; player_id: string;
  rookie_season: number | null; status: string | null; signal: string | null;
  pts: number | null; gap: number | null; m: number; x: number; d: number;
  careerGames: number;
}>;

const noHistory = rookies.filter((r) => r.careerGames === 0);

console.log(`board: ${rookies.length} players | no NFL regular-season history: ${noHistory.length}\n`);
console.log('  ADP   pos team  player                 signal   pts   gap    provenance');
for (const r of noHistory) {
  console.log(
    `  ${String(r.adp).padStart(5)} ${r.position.padEnd(3)} ${(r.team ?? '-').padEnd(4)} ` +
      `${r.name.padEnd(22)} ${(r.signal ?? '-').padEnd(8)} ${String(r.pts?.toFixed(0) ?? '-').padStart(4)}  ` +
      `${(r.gap === null ? '-' : (r.gap > 0 ? '+' : '') + r.gap.toFixed(1)).padStart(6)}  ` +
      `${r.m}m/${r.x}wk1/${r.d}der`,
  );
}

console.log('\n=== how much of a rookie projection rests on a positional average? ===');
const basis = sqlite.prepare(
  `SELECT stat, source, basis, mu FROM implied_stats
   WHERE player_id = ? AND scope = 'season' AND source <> 'market'`,
);
for (const r of noHistory.filter((r) => r.signal && r.signal !== 'none')) {
  const rows = basis.all(r.player_id) as Array<{
    stat: string; source: string; basis: string | null; mu: number;
  }>;
  if (!rows.length) continue;
  const parts = rows.map((b) => `${b.stat}=${b.mu.toFixed(0)} (${b.basis ?? b.source})`);
  console.log(`  ${r.name.padEnd(22)} ${parts.join('  ')}`);
}

console.log('\n=== second-year players (one season of history, small sample) ===');
const soph = rookies.filter((r) => r.careerGames > 0 && r.rookie_season === CURRENT - 1);
for (const r of soph) {
  console.log(
    `  ${String(r.adp).padStart(5)} ${r.position.padEnd(3)} ${r.name.padEnd(22)} ` +
      `${r.careerGames} career games  signal=${r.signal}`,
  );
}
