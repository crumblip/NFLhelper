import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';

const RELEASE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const CACHE_DIR = process.env.NFLVERSE_CACHE ?? './.cache';

/**
 * nflverse publishes flat CSVs on GitHub releases, so we read them straight
 * from Node. That removes the Python/nflreadpy dependency entirely — the only
 * thing nflreadpy adds over this is caching, which we do here anyway.
 */
export const NFLVERSE = {
  players: `${RELEASE_BASE}/players/players.csv`,
  /**
   * The `stats_player` release, not the older `player_stats` one — that asset
   * is frozen at 2024 and silently returns a stale file rather than an error.
   * Per-season files also mean an in-season refresh only refetches this year.
   */
  playerStats: (season: number) =>
    `${RELEASE_BASE}/stats_player/stats_player_week_${season}.csv`,
  snapCounts: (season: number) => `${RELEASE_BASE}/snap_counts/snap_counts_${season}.csv`,
} as const;

/**
 * Forward-looking sources beyond the box score. Split out from NFLVERSE
 * because these feed the usage signal rather than the market pipeline.
 */
export const NFLVERSE_EXTRA = {
  draftPicks: `${RELEASE_BASE}/draft_picks/draft_picks.csv`,
  depthCharts: (season: number) => `${RELEASE_BASE}/depth_charts/depth_charts_${season}.csv`,
  participation: (season: number) =>
    `${RELEASE_BASE}/pbp_participation/pbp_participation_${season}.csv`,
  advstatsRec: (season: number) =>
    `${RELEASE_BASE}/pfr_advstats/advstats_week_rec_${season}.csv`,
  advstatsRush: (season: number) =>
    `${RELEASE_BASE}/pfr_advstats/advstats_week_rush_${season}.csv`,
  ftnCharting: (season: number) => `${RELEASE_BASE}/ftn_charting/ftn_charting_${season}.csv`,
  /** ~100 MB per season. The only source carrying field position per play. */
  pbp: (season: number) => `${RELEASE_BASE}/pbp/play_by_play_${season}.csv`,
} as const;

/** Downloads to .cache and reuses the file while it is younger than maxAgeMs. */
export async function download(key: string, url: string, maxAgeMs: number): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = `${CACHE_DIR}/${key}`;

  if (existsSync(path)) {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < maxAgeMs) {
      console.log(`  cached  ${key} (${Math.round(age / 3_600_000)}h old)`);
      return path;
    }
  }

  console.log(`  fetching ${key}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  if (!res.body) throw new Error(`empty body for ${url}`);

  // Write to a temp file first so an aborted download never poisons the cache.
  const tmp = `${path}.partial`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  const { renameSync } = await import('node:fs');
  renameSync(tmp, path);

  console.log(`  saved    ${key} (${(statSync(path).size / 1e6).toFixed(1)} MB)`);
  return path;
}

/**
 * Streams a CSV row-at-a-time. player_stats.csv is ~33 MB and hundreds of
 * thousands of rows, so nothing here loads a whole file into memory.
 */
export async function streamCsv(
  path: string,
  onRow: (row: Record<string, string>) => void,
): Promise<number> {
  let count = 0;
  const parser = createReadStream(path).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_quotes: true, trim: true }),
  );
  for await (const row of parser) {
    onRow(row as Record<string, string>);
    count++;
  }
  return count;
}

// nflverse writes missing values as "NA" (an R idiom), which would otherwise
// parse to NaN and silently land in the database.
export const str = (v: string | undefined): string | null =>
  v === undefined || v === '' || v === 'NA' ? null : v;

export const num = (v: string | undefined): number | null => {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export const int = (v: string | undefined): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/**
 * First present column among several names. nflverse renamed fields between
 * the legacy and current stats releases (recent_team -> team, interceptions ->
 * passing_interceptions), and this keeps the ingest readable across both.
 */
export const pick = (r: Record<string, string>, ...names: string[]): string | undefined => {
  for (const n of names) if (r[n] !== undefined) return r[n];
  return undefined;
};
