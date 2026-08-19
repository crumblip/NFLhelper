import { sqlite } from '../lib/db/index';
import { regularSeasonStart } from '../lib/pipeline/implied';

const CURRENT = Number(process.env.SEASON ?? 2026);
const cutoff = regularSeasonStart(CURRENT);

console.log(`=== preseason filter (cutoff ${cutoff}) ===`);
const spans = sqlite
  .prepare(
    `SELECT CASE WHEN game_date >= ? THEN 'regular' ELSE 'preseason' END AS era,
            COUNT(*) rows, COUNT(DISTINCT player_id) players
     FROM prop_lines WHERE scope='game' AND player_id IS NOT NULL GROUP BY era`,
  )
  .all(cutoff) as Array<{ era: string; rows: number; players: number }>;
for (const s of spans) console.log(`  ${s.era.padEnd(10)} rows=${s.rows}  players=${s.players}`);

/*
 * The check that matters: a preseason line and a regular-season line for the
 * same player differ enormously (a starter's August receiving line is a
 * fraction of their Week 1 one). If any implied game value matches a preseason
 * line, the filter leaked.
 */
const leaks = sqlite
  .prepare(
    `SELECT p.display_name AS name, i.stat, i.mu, pl.line, pl.game_date
     FROM implied_stats i
     JOIN players p ON p.gsis_id = i.player_id
     JOIN prop_lines pl ON pl.player_id = i.player_id AND pl.stat = i.stat
      AND pl.scope='game' AND pl.game_date < ?
     WHERE i.scope='game' AND i.source='market'
       AND ABS(i.mu - pl.line) < 0.01
       AND NOT EXISTS (
         SELECT 1 FROM prop_lines r WHERE r.player_id = i.player_id AND r.stat = i.stat
           AND r.scope='game' AND r.game_date >= ? AND ABS(r.line - i.mu) < 0.01)
     LIMIT 10`,
  )
  .all(cutoff, cutoff) as Array<{ name: string; stat: string; mu: number; line: number; game_date: string }>;

if (leaks.length) {
  console.log('\n  LEAK — implied game values traceable only to preseason lines:');
  for (const l of leaks) console.log(`    ${l.name} ${l.stat} mu=${l.mu} matches ${l.game_date} line ${l.line}`);
} else {
  console.log('\n  clean — no implied game value comes from a preseason-only line');
}

console.log('\n=== extrapolated season stats ===');
const ex = sqlite
  .prepare(
    `SELECT p.display_name AS name, a.position, a.adp, i.stat, i.mu,
            (SELECT mu FROM implied_stats g WHERE g.player_id=i.player_id
             AND g.stat=i.stat AND g.scope='game') AS game_mu
     FROM implied_stats i
     JOIN players p ON p.gsis_id = i.player_id
     LEFT JOIN adp_raw a ON a.player_id = i.player_id AND a.year = ?
     WHERE i.scope='season' AND i.source='extrapolated'
     ORDER BY a.adp LIMIT 20`,
  )
  .all(CURRENT) as Array<{
  name: string; position: string; adp: number; stat: string; mu: number; game_mu: number;
}>;
for (const e of ex) {
  console.log(
    `  ${String(e.adp ?? '-').padStart(5)} ${(e.position ?? '?').padEnd(3)} ${e.name.padEnd(22)} ` +
      `${e.stat.padEnd(15)} game=${e.game_mu?.toFixed(1).padStart(6)} -> season=${e.mu.toFixed(0).padStart(5)}`,
  );
}

console.log('\n=== RBs unlocked by the per-game path ===');
const unlocked = sqlite
  .prepare(
    `SELECT a.name, v.adp, v.implied_points, v.slot_gap
     FROM value_scores v JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
      AND a.format=v.format AND a.teams=v.teams
     WHERE v.position='RB' AND v.signal='full' AND v.season=?
       AND EXISTS (SELECT 1 FROM implied_stats i WHERE i.player_id=v.player_id
                   AND i.scope='season' AND i.source='extrapolated')
     ORDER BY v.adp`,
  )
  .all(CURRENT) as Array<{ name: string; adp: number; implied_points: number; slot_gap: number }>;
for (const u of unlocked) {
  console.log(
    `  ${String(u.adp).padStart(5)}  ${u.name.padEnd(22)} pts=${u.implied_points.toFixed(0).padStart(4)}  ` +
      `slot gap=${(u.slot_gap > 0 ? '+' : '') + u.slot_gap.toFixed(1)}`,
  );
}
console.log(`  ${unlocked.length} RBs became rankable via extrapolation`);
