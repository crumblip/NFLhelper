import { sqlite } from '../lib/db/index';

/**
 * Why do quarterbacks flood the top of the board?
 *
 * The suspicion is population mismatch. Sportsbooks price only expected
 * starters — about 22 quarterbacks — while the historical baseline at a given
 * draft slot includes every quarterback taken there, most of whom never played.
 * Comparing a projected starter against a pool full of clipboard holders makes
 * every startable quarterback look underpriced.
 *
 * If that is the cause, restricting history to quarterbacks who actually held a
 * job should collapse the effect.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);

const rows = sqlite
  .prepare(
    `SELECT a.year, a.adp, a.position, a.player_id,
            (SELECT COUNT(*) FROM player_stats_week s
             WHERE s.player_id = a.player_id AND s.season = a.year AND s.season_type='REG') AS games,
            (SELECT COUNT(*) FROM adp_raw b
             WHERE b.year = a.year AND b.format = a.format AND b.teams = a.teams
               AND b.position = a.position AND b.adp <= a.adp) AS posRank
     FROM adp_raw a
     WHERE a.format = ? AND a.teams = ? AND a.year < 2026 AND a.player_id IS NOT NULL`,
  )
  .all(FORMAT, TEAMS) as Array<{
  year: number; adp: number; position: string; player_id: string;
  games: number; posRank: number;
}>;

console.log('how many drafted players at each position actually played?\n');
console.log('  pos  posRank band    n    played 0 games   played 1-7   played 8+');
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  for (const [lo, hi] of [[1, 13], [13, 25], [25, 41], [41, 200]] as Array<[number, number]>) {
    const g = rows.filter((r) => r.position === pos && r.posRank >= lo && r.posRank < hi);
    if (g.length < 8) continue;
    const none = g.filter((r) => r.games === 0).length;
    const few = g.filter((r) => r.games >= 1 && r.games <= 7).length;
    const most = g.filter((r) => r.games >= 8).length;
    console.log(
      `  ${pos.padEnd(4)} ${`${lo}-${hi - 1}`.padEnd(14)} ${String(g.length).padStart(4)}   ` +
        `${`${((none / g.length) * 100).toFixed(0)}%`.padStart(12)}   ` +
        `${`${((few / g.length) * 100).toFixed(0)}%`.padStart(9)}   ` +
        `${`${((most / g.length) * 100).toFixed(0)}%`.padStart(8)}`,
    );
  }
  console.log();
}

console.log('the market prices roughly this many players per position in 2026:');
for (const r of sqlite
  .prepare(
    `SELECT a.position, COUNT(DISTINCT i.player_id) n
     FROM implied_stats i JOIN adp_raw a ON a.player_id = i.player_id AND a.year = 2026
     WHERE i.scope = 'season' AND i.source = 'market' GROUP BY a.position`,
  )
  .all() as Array<{ position: string; n: number }>) {
  console.log(`  ${r.position}: ${r.n}`);
}
