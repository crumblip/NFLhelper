import { sqlite } from '../lib/db/index';
import { buildCoverageProfile } from '../lib/pipeline/coverage';

/** Which single missing category is keeping each RB out of the ranking? */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const profile = buildCoverageProfile(FORMAT, TEAMS, CURRENT);
const rbCats = [...(profile.get('RB') ?? [])];

const rbs = sqlite
  .prepare(
    `SELECT v.player_id, a.name, v.adp, v.signal
     FROM value_scores v JOIN adp_raw a ON a.player_id = v.player_id
      AND a.year = v.season AND a.format = v.format AND a.teams = v.teams
     WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.position = 'RB'
       AND v.signal = 'partial' ORDER BY v.adp`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{
  player_id: string; name: string; adp: number; signal: string;
}>;

const statsFor = sqlite.prepare(
  `SELECT stat, source FROM implied_stats WHERE player_id = ? AND scope = 'season'`,
);

const missingCounts = new Map<string, number>();
const blockedByOnly = new Map<string, string[]>();

for (const rb of rbs) {
  const have = new Set(
    (statsFor.all(rb.player_id) as Array<{ stat: string }>).map((r) => r.stat),
  );
  const missing = rbCats.filter((c) => !have.has(c));
  for (const m of missing) missingCounts.set(m, (missingCounts.get(m) ?? 0) + 1);
  if (missing.length === 1) {
    const list = blockedByOnly.get(missing[0]!) ?? [];
    list.push(`${rb.adp} ${rb.name}`);
    blockedByOnly.set(missing[0]!, list);
  }
}

console.log(`RB categories the market prices: ${rbCats.join(', ')}`);
console.log(`\npartial RBs: ${rbs.length}\n`);
console.log('missing category counts:');
for (const [c, n] of [...missingCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(16)} missing for ${n}`);
}

console.log('\nRBs blocked by exactly ONE category:');
for (const [cat, list] of blockedByOnly) {
  console.log(`  ${cat} (${list.length}):`);
  for (const l of list.slice(0, 25)) console.log(`     ${l}`);
}

const recTdCoverage = sqlite
  .prepare(
    `SELECT COUNT(DISTINCT i.player_id) n FROM implied_stats i
     JOIN adp_raw a ON a.player_id = i.player_id AND a.year = ? AND a.format = ? AND a.teams = ?
     WHERE a.position = 'RB' AND i.scope = 'season' AND i.stat = 'receivingTds'`,
  )
  .get(CURRENT, FORMAT, TEAMS) as { n: number };
const rbTotal = sqlite
  .prepare(
    `SELECT COUNT(*) n FROM adp_raw WHERE year = ? AND format = ? AND teams = ? AND position = 'RB'`,
  )
  .get(CURRENT, FORMAT, TEAMS) as { n: number };
console.log(`\nRB receivingTds coverage: ${recTdCoverage.n}/${rbTotal.n}`);

const avg = sqlite
  .prepare(
    `SELECT AVG(mu) m, MIN(mu) lo, MAX(mu) hi FROM implied_stats i
     JOIN adp_raw a ON a.player_id = i.player_id AND a.year = ? AND a.format = ? AND a.teams = ?
     WHERE a.position = 'RB' AND i.scope = 'season' AND i.stat = 'receivingTds'`,
  )
  .get(CURRENT, FORMAT, TEAMS) as { m: number; lo: number; hi: number };
console.log(
  `RB receivingTds: mean ${avg.m?.toFixed(1)} (${(avg.m * 6).toFixed(0)} pts), ` +
    `range ${avg.lo}-${avg.hi} (${(avg.lo * 6).toFixed(0)}-${(avg.hi * 6).toFixed(0)} pts spread)`,
);
