import { ingestContext } from '../lib/nflverse/context';

/**
 * Team offence and run-direction splits from play-by-play.
 *
 * ~100 MB per season, cached. Separate from `ingest:usage` because that builds
 * shares of team volume and this builds the environment those shares sit in.
 */
const CURRENT = Number(process.env.SEASON ?? 2026);
const FROM = Number(process.env.CONTEXT_FROM_SEASON ?? 2021);

// The season in progress is refetched every 12 hours; completed ones are frozen.
await ingestContext(
  Array.from({ length: CURRENT - FROM }, (_, i) => FROM + i),
  CURRENT - 1,
);
console.log('\ndone');
