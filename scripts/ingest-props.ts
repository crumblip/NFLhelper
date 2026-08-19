import { sqlite } from '../lib/db/index';
import { ParlayProvider, summarise } from '../lib/providers/props/parlay';
import { classify, isUnknown } from '../lib/providers/props/markets';
import { PlayerIndex, saveAliases, lookupAlias } from '../lib/match/resolve';
import { buildImpliedStats, saveImpliedStats, calibrateGameRatios } from '../lib/pipeline/implied';

/**
 * Fetches props, classifies scope, resolves player names, and rebuilds the
 * implied stat lines.
 *
 * Names arriving from a sportsbook are resolved through the same index as ADP,
 * under their own alias source — books and FFC spell people differently, and a
 * silent miss here means a player simply has no market signal on the board.
 */

const apiKey = process.env.PARLAY_API_KEY ?? process.argv[2];
if (!apiKey) {
  console.error('set PARLAY_API_KEY or pass the key as an argument');
  process.exit(1);
}

const CURRENT = Number(process.env.SEASON ?? 2026);
const provider = new ParlayProvider(apiKey);

const before = await provider.usage();
console.log(`ParlayAPI ${before.tier} tier | ${before.creditsRemaining}/${before.creditsTotal} credits left\n`);

const raw = await provider.fetchNflProps();
const { books, markets, total } = summarise(raw);
console.log(`fetched ${total} prop rows from ${books.size} books`);

// Unrecognised markets are reported rather than silently dropped, so a new
// market key shows up as news instead of as missing data.
const unknown = [...markets.keys()].filter(isUnknown);
if (unknown.length) {
  console.log(`\nunmapped market keys (ignored, but worth a look):`);
  for (const k of unknown) console.log(`  ${String(markets.get(k)).padStart(5)}  ${k}`);
}

// Classify every row; anything unclassifiable is dropped rather than guessed.
const classified = raw.flatMap((r) => {
  const hasTeams = Boolean(r.homeTeam && r.awayTeam);
  const c = classify(r.marketKey, r.line, hasTeams);
  return c ? [{ ...r, ...c, line: r.line as number }] : [];
});

const seasonRows = classified.filter((c) => c.scope === 'season');
const gameRows = classified.filter((c) => c.scope === 'game');
console.log(`\nclassified ${classified.length} usable rows: ${seasonRows.length} season, ${gameRows.length} game`);

const byMethod = new Map<string, number>();
for (const c of classified) {
  const key = `${c.scope} via ${c.method}`;
  byMethod.set(key, (byMethod.get(key) ?? 0) + 1);
}
for (const [k, n] of [...byMethod].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}

// Resolve book names to gsis ids under their own alias source.
const index = PlayerIndex.load();
const distinct = [...new Set(classified.map((c) => c.rawPlayer))];
const resolutions = distinct.map((name) => ({
  rawName: name,
  position: null,
  team: null,
  ...index.resolve({ rawName: name, season: CURRENT }),
}));
saveAliases('book', resolutions);

const resolvedCount = resolutions.filter((r) => r.playerId).length;
console.log(
  `\nresolved ${resolvedCount}/${distinct.length} book names ` +
    `(${Math.round((resolvedCount / distinct.length) * 100)}%)`,
);

const unresolvedNames = resolutions.filter((r) => !r.playerId);
if (unresolvedNames.length) {
  console.log(`unresolved: ${unresolvedNames.slice(0, 12).map((r) => r.rawName).join(', ')}`);
}

// Append-only: a re-run adds a new snapshot so line movement is preserved.
const now = Date.now();
const insert = sqlite.prepare(
  `INSERT INTO prop_lines
   (player_id, raw_player, book, market_key, stat, scope, scope_method,
    line, over_price, under_price, event_id, game_date, provider, fetched_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

let written = 0;
sqlite.transaction(() => {
  for (const c of classified) {
    insert.run(
      lookupAlias('book', c.rawPlayer), c.rawPlayer, c.book, c.marketKey,
      c.stat, c.scope, c.method, c.line, c.overPrice, c.underPrice,
      c.eventId ?? null, c.gameDate ?? null, provider.name, now,
    );
    written++;
  }
})();
console.log(`\nwrote ${written} prop rows`);

// Game scope first: the season pass extrapolates from it, and the ratio it
// uses is calibrated against players holding lines in both scopes.
sqlite.prepare(`DELETE FROM implied_stats`).run();

for (const scope of ['game', 'season'] as const) {
  const implied = buildImpliedStats(scope, CURRENT);
  saveImpliedStats(implied);
  const count = (s: string) => implied.filter((i) => i.source === s).length;
  const playerCount = new Set(implied.map((s) => s.playerId)).size;
  console.log(
    `implied ${scope}: ${implied.length} stats across ${playerCount} players ` +
      `(${count('market')} market, ${count('extrapolated')} extrapolated, ${count('derived')} derived)`,
  );
}

const ratios = calibrateGameRatios();
if (ratios.size) {
  console.log('\nseason-to-game ratios (the market’s own effective game count):');
  for (const [stat, c] of ratios) {
    console.log(`  ${stat.padEnd(16)} ${c.ratio.toFixed(1)}  (n=${c.n})`);
  }
}

const after = await provider.usage();
console.log(
  `\ncredits used this run: ${provider.creditsUsed} | ` +
    `${after.creditsRemaining}/${after.creditsTotal} remaining until ${after.periodEnd.slice(0, 10)}`,
);
