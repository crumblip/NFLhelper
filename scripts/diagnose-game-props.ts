import { sqlite } from '../lib/db/index';

/**
 * What per-game props actually exist, and are they usable?
 *
 * Preseason lines are worthless for a season projection — starters play a
 * series or two — so the date breakdown decides whether this path is viable
 * at all right now.
 */

console.log('game-scope rows by date:');
for (const r of sqlite
  .prepare(
    `SELECT game_date, COUNT(*) n, COUNT(DISTINCT player_id) players,
            COUNT(DISTINCT stat) stats
     FROM prop_lines WHERE scope = 'game' AND player_id IS NOT NULL
     GROUP BY game_date ORDER BY game_date`,
  )
  .all() as Array<{ game_date: string; n: number; players: number; stats: number }>) {
  console.log(`  ${r.game_date ?? 'null'}  rows=${String(r.n).padStart(4)}  players=${String(r.players).padStart(3)}  stats=${r.stats}`);
}

console.log('\nby stat (all dates):');
for (const r of sqlite
  .prepare(
    `SELECT stat, COUNT(*) n, COUNT(DISTINCT player_id) players
     FROM prop_lines WHERE scope = 'game' AND player_id IS NOT NULL
     GROUP BY stat ORDER BY n DESC`,
  )
  .all() as Array<{ stat: string; n: number; players: number }>) {
  console.log(`  ${r.stat.padEnd(16)} rows=${String(r.n).padStart(4)}  players=${r.players}`);
}

/*
 * The calibration question: for players who have BOTH a season line and a
 * per-game line on the same stat, what is season / per-game?
 *
 * That ratio is the market's own effective game count. Assuming 17 would
 * overstate every extrapolation, because a season line already prices in the
 * chance a player misses time while a single-game line does not.
 */
console.log('\nplayers with BOTH scopes on the same stat (the calibration set):');
const both = sqlite
  .prepare(
    `SELECT s.stat, p.display_name AS name, a.position,
            s.mu AS season_mu, g.mu AS game_mu, s.mu / g.mu AS ratio
     FROM implied_stats s
     JOIN implied_stats g ON g.player_id = s.player_id AND g.stat = s.stat AND g.scope = 'game'
     JOIN players p ON p.gsis_id = s.player_id
     LEFT JOIN adp_raw a ON a.player_id = s.player_id AND a.year = 2026
     WHERE s.scope = 'season' AND s.source = 'market' AND g.source = 'market' AND g.mu > 0
     ORDER BY s.stat, ratio`,
  )
  .all() as Array<{
  stat: string; name: string; position: string | null;
  season_mu: number; game_mu: number; ratio: number;
}>;

const byStat = new Map<string, number[]>();
for (const b of both) {
  const list = byStat.get(b.stat) ?? [];
  list.push(b.ratio);
  byStat.set(b.stat, list);
}

if (!both.length) {
  console.log('  none — no player has a season and a game line on the same stat');
} else {
  for (const [stat, ratios] of byStat) {
    ratios.sort((a, b) => a - b);
    const med = ratios[Math.floor(ratios.length / 2)]!;
    console.log(
      `  ${stat.padEnd(16)} n=${String(ratios.length).padStart(3)}  ` +
        `median ratio=${med.toFixed(1)}  range ${ratios[0]!.toFixed(1)}..${ratios[ratios.length - 1]!.toFixed(1)}`,
    );
  }
  console.log('\n  samples:');
  for (const b of both.slice(0, 10)) {
    console.log(
      `    ${b.name.padEnd(22)} ${b.stat.padEnd(15)} season=${b.season_mu.toFixed(0).padStart(5)}  ` +
        `game=${b.game_mu.toFixed(1).padStart(6)}  ratio=${b.ratio.toFixed(1)}`,
    );
  }
}

console.log('\nRBs on the 2026 board missing season receiving, and whether game props could fill it:');
const rbs = sqlite
  .prepare(
    `SELECT a.adp, a.name, a.player_id,
            EXISTS(SELECT 1 FROM implied_stats i WHERE i.player_id = a.player_id
                   AND i.scope='game' AND i.stat='receivingYards') AS has_game
     FROM adp_raw a
     WHERE a.year = 2026 AND a.format = 'half-ppr' AND a.teams = 12 AND a.position = 'RB'
       AND EXISTS (SELECT 1 FROM implied_stats i WHERE i.player_id = a.player_id
                   AND i.scope='season' AND i.stat='rushingYards')
       AND NOT EXISTS (SELECT 1 FROM implied_stats i WHERE i.player_id = a.player_id
                   AND i.scope='season' AND i.stat='receivingYards')
     ORDER BY a.adp`,
  )
  .all() as Array<{ adp: number; name: string; has_game: number }>;

const fillable = rbs.filter((r) => r.has_game).length;
for (const r of rbs.slice(0, 20)) {
  console.log(`  ${String(r.adp).padStart(5)}  ${r.name.padEnd(22)} ${r.has_game ? 'game line available' : '-'}`);
}
console.log(`  ${fillable} of ${rbs.length} could be filled from a per-game line`);
