import { ingestPlayers, ingestPlayerStats, ingestSnapCounts } from '../lib/nflverse/ingest';

/**
 * 2018 gives the ADP baseline curve seven completed seasons (2018-2025) while
 * staying inside the era where target share and air yards are reliable.
 */
const FROM_SEASON = Number(process.env.STATS_FROM_SEASON ?? 2018);
const CURRENT_SEASON = Number(process.env.SEASON ?? 2026);

const t0 = Date.now();

// Completed seasons only — the current one has no games played yet, and its
// files are not published until Week 1.
const seasons = Array.from(
  { length: CURRENT_SEASON - FROM_SEASON },
  (_, i) => FROM_SEASON + i,
);

await ingestPlayers();
await ingestPlayerStats(seasons);
await ingestSnapCounts(seasons);

console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
