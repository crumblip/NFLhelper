import { sqlite } from '../lib/db/index';
import { PlayerIndex, saveAliases, REVIEW_FLOOR } from '../lib/match/resolve';
import { normalizeName, unflipName } from '../lib/match/normalize';

/**
 * Resolves ADP names to gsis ids and reports what did not land.
 *
 * Resolution is per (name, year), not per name: "Frank Gore" in 2018 and 2025
 * are different people, and collapsing them would hang one player's career on
 * another's baseline. Only the current season feeds player_aliases, since that
 * is the table sportsbook names will later join against.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const index = PlayerIndex.load();

const rows = sqlite
  .prepare(
    `SELECT DISTINCT name, position, team, year FROM adp_raw
     WHERE format = ? AND teams = ? ORDER BY year, name`,
  )
  .all(FORMAT, TEAMS) as Array<{
  name: string;
  position: string;
  team: string | null;
  year: number;
}>;

console.log(`resolving ${rows.length} ADP player-years against nflverse\n`);

const results = rows.map((r) => ({
  ...r,
  ...index.resolve({ rawName: r.name, position: r.position, team: r.team, season: r.year }),
}));

// Write the resolved id straight onto each ADP row for its own year.
const link = sqlite.prepare(
  `UPDATE adp_raw SET player_id = ?
   WHERE name = ? AND format = ? AND teams = ? AND year = ?`,
);
sqlite.transaction(() => {
  for (const r of results) {
    if (r.playerId) link.run(r.playerId, r.name, FORMAT, TEAMS, r.year);
  }
})();

// Aliases are the current board only — that is what props will resolve through.
const current = results.filter((r) => r.year === CURRENT);
const { written, skippedManual } = saveAliases(
  'ffc',
  current.map((r) => ({
    rawName: r.name,
    position: r.position,
    team: r.team,
    playerId: r.playerId,
    method: r.method,
    confidence: r.confidence,
  })),
);

const byMethod = new Map<string, number>();
for (const r of results) byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + 1);

console.log('resolution methods (all years):');
for (const [m, n] of [...byMethod].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${m}`);
}

const resolved = results.filter((r) => r.playerId);
console.log(
  `\nresolved ${resolved.length}/${results.length} ` +
    `(${Math.round((resolved.length / results.length) * 100)}%)  ` +
    `| ${CURRENT} aliases written ${written}, manual preserved ${skippedManual}`,
);

const review = results.filter((r) => r.playerId && r.confidence < REVIEW_FLOOR);
if (review.length) {
  const name = sqlite.prepare(
    `SELECT display_name, latest_team, rookie_season, last_season
     FROM players WHERE gsis_id = ?`,
  );
  console.log(`\nlow confidence (< ${REVIEW_FLOOR}):`);
  for (const r of review.slice(0, 25)) {
    const p = name.get(r.playerId) as
      | { display_name: string; latest_team: string | null; rookie_season: number | null; last_season: number | null }
      | undefined;
    console.log(
      `  ${r.confidence.toFixed(2)}  ${r.year} ${r.name} (${r.position} ${r.team ?? '-'}) -> ` +
        `${p?.display_name ?? '?'} [${p?.rookie_season ?? '?'}-${p?.last_season ?? '?'}] (${r.method})`,
    );
  }
}

const misses = sqlite
  .prepare(
    `SELECT name, position, team, adp FROM adp_raw
     WHERE format = ? AND teams = ? AND year = ? AND player_id IS NULL ORDER BY adp`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{
  name: string;
  position: string;
  team: string | null;
  adp: number;
}>;

if (misses.length) {
  console.log(`\nunresolved on the ${CURRENT} board:`);
  for (const m of misses) {
    console.log(`  ${String(m.adp).padStart(6)}  ${m.position}  ${m.name} (${m.team ?? '-'})`);
  }
} else {
  console.log(`\nevery ${CURRENT} ADP player resolved.`);
}
