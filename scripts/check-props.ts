import { sqlite } from '../lib/db/index';

/**
 * Sanity checks on the implied stat lines.
 *
 * The failure this is really watching for is a scope mix-up: a per-game line
 * banked as a season projection is wrong by roughly 17x and would look like an
 * enormous market edge rather than a bug.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

console.log('=== implied season stat lines, top of the board ===');
const board = sqlite
  .prepare(
    `SELECT a.name, a.position, a.adp, a.player_id
     FROM adp_raw a
     WHERE a.year = ? AND a.format = ? AND a.teams = ? AND a.player_id IS NOT NULL
     ORDER BY a.adp LIMIT 14`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{
  name: string;
  position: string;
  adp: number;
  player_id: string;
}>;

const statsFor = sqlite.prepare(
  `SELECT stat, mu, line, source FROM implied_stats
   WHERE player_id = ? AND scope = 'season' ORDER BY stat`,
);

const SHORT: Record<string, string> = {
  passingYards: 'passYd', passingTds: 'passTD', interceptions: 'int',
  rushingYards: 'rushYd', rushingTds: 'rushTD', receptions: 'rec',
  receivingYards: 'recYd', receivingTds: 'recTD',
};

for (const p of board) {
  const rows = statsFor.all(p.player_id) as Array<{
    stat: string; mu: number; line: number | null; source: string;
  }>;
  const parts = rows.map(
    (r) => `${SHORT[r.stat] ?? r.stat}=${r.mu.toFixed(r.mu < 20 ? 1 : 0)}${r.source === 'derived' ? '*' : ''}`,
  );
  console.log(
    `  ${String(p.adp).padStart(5)} ${p.position.padEnd(3)} ${p.name.padEnd(21)} ` +
      (parts.length ? parts.join(' ') : '(no market signal)'),
  );
}
console.log('  * = derived from a market line, not itself posted');

console.log('\n=== scope mix-up watch ===');
/*
 * A near-zero season line is not suspicious on its own — Travis Kelce really
 * does have a 0.5 season rushing yards prop. What would be suspicious is a
 * game-scale line banked as a season projection for the stat that defines a
 * player's role: a WR whose season receiving yards reads 65 has a per-game line
 * in the wrong bucket. So the bounds only apply where the stat is the position's
 * primary one, plus a ceiling that no real season reaches.
 */
const PRIMARY: Array<[string, string[], number]> = [
  ['passingYards', ['QB'], 1500],
  ['rushingYards', ['RB'], 300],
  ['receivingYards', ['WR', 'TE'], 300],
];
let flagged = 0;

for (const [stat, positions, floor] of PRIMARY) {
  const bad = sqlite
    .prepare(
      `SELECT p.display_name AS n, p.position AS pos, i.mu, i.source
       FROM implied_stats i
       JOIN players p ON p.gsis_id = i.player_id
       JOIN adp_raw a ON a.player_id = i.player_id AND a.year = ? AND a.format = ? AND a.teams = ?
       WHERE i.scope = 'season' AND i.stat = ? AND i.source = 'market'
         AND a.position IN (${positions.map(() => '?').join(',')})
         AND i.mu < ?
       ORDER BY i.mu LIMIT 5`,
    )
    .all(CURRENT, FORMAT, TEAMS, stat, ...positions, floor) as Array<{
    n: string; pos: string; mu: number; source: string;
  }>;
  for (const b of bad) {
    console.log(`  suspiciously low: ${b.n} (${b.pos}) season ${stat} = ${b.mu.toFixed(1)}`);
    flagged++;
  }
}

const CEILINGS: Array<[string, number]> = [
  ['passingYards', 6000], ['rushingYards', 2200], ['receivingYards', 2200],
  ['receptions', 160], ['passingTds', 60], ['rushingTds', 30], ['receivingTds', 25],
];
for (const [stat, hi] of CEILINGS) {
  const bad = sqlite
    .prepare(
      `SELECT p.display_name AS n, i.mu FROM implied_stats i
       JOIN players p ON p.gsis_id = i.player_id
       WHERE i.scope = 'season' AND i.stat = ? AND i.mu > ? ORDER BY i.mu DESC LIMIT 5`,
    )
    .all(stat, hi) as Array<{ n: string; mu: number }>;
  for (const b of bad) {
    console.log(`  above any real season: ${b.n} ${stat} = ${b.mu.toFixed(1)}`);
    flagged++;
  }
}
console.log(flagged ? `  ${flagged} flagged` : '  clean — no season value looks like a game line');

console.log('\n=== coverage against the 2026 board ===');
const cov = sqlite
  .prepare(
    `SELECT a.position,
            COUNT(*) AS total,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM implied_stats i
              WHERE i.player_id = a.player_id AND i.scope = 'season' AND i.source = 'market'
            ) THEN 1 ELSE 0 END) AS covered
     FROM adp_raw a
     WHERE a.year = ? AND a.format = ? AND a.teams = ? AND a.player_id IS NOT NULL
     GROUP BY a.position ORDER BY a.position`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{ position: string; total: number; covered: number }>;

let t = 0, c = 0;
for (const r of cov) {
  t += r.total;
  c += r.covered;
  console.log(`  ${r.position}: ${r.covered}/${r.total} (${Math.round((r.covered / r.total) * 100)}%)`);
}
console.log(`  overall: ${c}/${t} (${Math.round((c / t) * 100)}%)`);

console.log('\n=== top-60 ADP with no season market signal ===');
const gaps = sqlite
  .prepare(
    `SELECT a.adp, a.position, a.name FROM adp_raw a
     WHERE a.year = ? AND a.format = ? AND a.teams = ? AND a.adp <= 60
       AND NOT EXISTS (
         SELECT 1 FROM implied_stats i
         WHERE i.player_id = a.player_id AND i.scope = 'season' AND i.source = 'market')
     ORDER BY a.adp`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{ adp: number; position: string; name: string }>;
for (const g of gaps) console.log(`  ${String(g.adp).padStart(5)} ${g.position} ${g.name}`);
console.log(`  ${gaps.length} of the top 60 have no season line`);
