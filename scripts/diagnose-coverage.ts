import { sqlite } from '../lib/db/index';

/**
 * Which stats does the market actually post, per position?
 *
 * Scoring an absent category as zero deflates a player's total, and if absence
 * correlates with position the deflation looks exactly like a market edge. This
 * is the check for that.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const STATS = [
  'passingYards', 'passingTds', 'interceptions',
  'rushingYards', 'rushingTds',
  'receivingYards', 'receivingTds', 'receptions',
];

const board = sqlite
  .prepare(
    `SELECT player_id, position FROM adp_raw
     WHERE year = ? AND format = ? AND teams = ? AND player_id IS NOT NULL`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{ player_id: string; position: string }>;

const has = sqlite.prepare(
  `SELECT stat, source FROM implied_stats WHERE player_id = ? AND scope = 'season'`,
);

const byPos = new Map<string, { total: number; counts: Map<string, number>; withAny: number }>();
for (const p of board) {
  const pos = p.position.toUpperCase();
  const entry = byPos.get(pos) ?? { total: 0, counts: new Map(), withAny: 0 };
  entry.total++;
  const rows = has.all(p.player_id) as Array<{ stat: string; source: string }>;
  if (rows.length) entry.withAny++;
  for (const r of rows) entry.counts.set(r.stat, (entry.counts.get(r.stat) ?? 0) + 1);
  byPos.set(pos, entry);
}

console.log('stat coverage as % of players at each position (of those with ANY market signal)\n');
console.log('  pos   n   ' + STATS.map((s) => s.slice(0, 7).padStart(8)).join(''));
for (const [pos, e] of [...byPos].sort()) {
  const cells = STATS.map((s) => {
    const pct = e.withAny ? Math.round(((e.counts.get(s) ?? 0) / e.withAny) * 100) : 0;
    return `${pct}%`.padStart(8);
  }).join('');
  console.log(`  ${pos.padEnd(4)} ${String(e.withAny).padStart(3)}  ${cells}`);
}

console.log('\nwhat a missing category costs, in half-PPR points:');
const cost = sqlite
  .prepare(
    `SELECT a.position, i.stat, AVG(i.mu) AS avg_mu
     FROM implied_stats i
     JOIN adp_raw a ON a.player_id = i.player_id AND a.year = ? AND a.format = ? AND a.teams = ?
     WHERE i.scope = 'season' GROUP BY a.position, i.stat`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{ position: string; stat: string; avg_mu: number }>;

const PTS: Record<string, number> = {
  passingYards: 0.04, passingTds: 4, interceptions: -2,
  rushingYards: 0.1, rushingTds: 6,
  receivingYards: 0.1, receivingTds: 6, receptions: 0.5,
};
const impact = new Map<string, string[]>();
for (const c of cost) {
  const pts = c.avg_mu * (PTS[c.stat] ?? 0);
  if (Math.abs(pts) < 5) continue;
  const list = impact.get(c.position) ?? [];
  list.push(`${c.stat}=${pts.toFixed(0)}`);
  impact.set(c.position, list);
}
for (const [pos, list] of [...impact].sort()) {
  console.log(`  ${pos}: ${list.sort().join('  ')}`);
}

console.log('\nRBs missing a receiving line (their totals are understated):');
const rbGap = sqlite
  .prepare(
    `SELECT a.adp, a.name FROM adp_raw a
     WHERE a.year = ? AND a.format = ? AND a.teams = ? AND a.position = 'RB'
       AND EXISTS (SELECT 1 FROM implied_stats i WHERE i.player_id = a.player_id
                   AND i.scope='season' AND i.stat='rushingYards')
       AND NOT EXISTS (SELECT 1 FROM implied_stats i WHERE i.player_id = a.player_id
                   AND i.scope='season' AND i.stat='receivingYards')
     ORDER BY a.adp LIMIT 15`,
  )
  .all(CURRENT, FORMAT, TEAMS) as Array<{ adp: number; name: string }>;
for (const r of rbGap) console.log(`  ${String(r.adp).padStart(5)}  ${r.name}`);
console.log(`  ${rbGap.length} shown`);
