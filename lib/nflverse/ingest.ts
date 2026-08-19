import { sql } from 'drizzle-orm';
import { db, sqlite } from '../db/index';
import { snapCounts, ingestLog } from '../db/schema';
import { normalizeName, normalizeTeam } from '../match/normalize';
import { NFLVERSE, download, streamCsv, str, num, int, pick } from './sources';

const DAY = 86_400_000;

/** Fantasy-relevant position labels. DEF/K never enter the database. */
const KEEP_POSITIONS = new Set(['QB', 'RB', 'FB', 'WR', 'TE']);

/**
 * A player's nflverse position is their *defensive-chart* position when they
 * play both ways — Travis Hunter is listed CB despite being a drafted WR2. So
 * stats rows are kept on evidence of offensive usage, not on the label.
 */
function hasOffensiveUsage(r: Record<string, string>): boolean {
  return (
    (int(r.targets) ?? 0) > 0 ||
    (int(r.carries) ?? 0) > 0 ||
    (int(r.attempts) ?? 0) > 0 ||
    (int(r.receptions) ?? 0) > 0
  );
}

function logIngest(key: string, url: string, rows: number, status: string) {
  db.insert(ingestLog)
    .values({ key, url, rows, status, fetchedAt: Date.now() })
    .onConflictDoUpdate({
      target: ingestLog.key,
      set: { rows, status, fetchedAt: Date.now(), url },
    })
    .run();
}

/**
 * Batched writer. Drizzle's insert builder is fine but slow row-by-row at this
 * volume, so batches go through one prepared statement inside a transaction.
 */
function bulkInsert(table: string, columns: string[], rows: unknown[][]) {
  if (!rows.length) return;
  const placeholders = `(${columns.map(() => '?').join(',')})`;
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`,
  );
  const run = sqlite.transaction((batch: unknown[][]) => {
    for (const r of batch) stmt.run(...(r as never[]));
  });
  const CHUNK = 5_000;
  for (let i = 0; i < rows.length; i += CHUNK) run(rows.slice(i, i + CHUNK));
}

export async function ingestPlayers(maxAgeMs = 7 * DAY) {
  console.log('players:');
  const path = await download('players.csv', NFLVERSE.players, maxAgeMs);

  const cols = [
    'gsis_id', 'display_name', 'football_name', 'short_name', 'first_name',
    'last_name', 'suffix', 'normalized_name', 'position', 'position_group',
    'latest_team', 'status', 'rookie_season', 'last_season', 'birth_date',
    'pfr_id', 'espn_id', 'pff_id', 'esb_id',
  ];
  const rows: unknown[][] = [];

  await streamCsv(path, (r) => {
    const gsis = str(r.gsis_id);
    const name = str(r.display_name);
    if (!gsis || !name) return; // no canonical id or no name -> unusable
    // No position filter here on purpose: the registry is the match target for
    // every external name, and filtering it drops two-way players entirely.

    rows.push([
      gsis, name, str(r.football_name), str(r.short_name), str(r.first_name),
      str(r.last_name), str(r.suffix), normalizeName(name),
      str(r.position), str(r.position_group),
      normalizeTeam(str(r.latest_team)), str(r.status),
      int(r.rookie_season), int(r.last_season), str(r.birth_date),
      str(r.pfr_id), str(r.espn_id), str(r.pff_id), str(r.esb_id),
    ]);
  });

  bulkInsert('players', cols, rows);
  logIngest('players', NFLVERSE.players, rows.length, 'ok');
  console.log(`  loaded ${rows.length} players`);
  return rows.length;
}

export async function ingestPlayerStats(seasons: number[], maxAgeMs = DAY) {
  console.log('player stats:');

  const cols = [
    'player_id', 'season', 'week', 'season_type', 'recent_team', 'position',
    'opponent_team', 'completions', 'attempts', 'passing_yards', 'passing_tds',
    'interceptions', 'sack_fumbles_lost', 'passing_air_yards',
    'passing_2pt_conversions', 'carries', 'rushing_yards', 'rushing_tds',
    'rushing_fumbles_lost', 'rushing_2pt_conversions', 'receptions', 'targets',
    'receiving_yards', 'receiving_tds', 'receiving_fumbles_lost',
    'receiving_air_yards', 'receiving_yards_after_catch',
    'receiving_2pt_conversions', 'target_share', 'air_yards_share', 'wopr',
    'racr', 'special_teams_tds', 'fantasy_points', 'fantasy_points_ppr',
    'fantasy_points_half',
  ];
  let total = 0;
  let skipped = 0;

  for (const season of seasons) {
    const url = NFLVERSE.playerStats(season);
    let path: string;
    try {
      path = await download(`stats_player_week_${season}.csv`, url, maxAgeMs);
    } catch {
      console.log(`  skip ${season} (not published yet)`);
      continue;
    }

    const rows: unknown[][] = [];
    await streamCsv(path, (r) => {
      const pid = str(r.player_id);
      const week = int(r.week);
      if (!pid || week === null) return;
      if (!KEEP_POSITIONS.has((str(r.position) ?? '').toUpperCase()) && !hasOffensiveUsage(r)) {
        skipped++;
        return;
      }

      const receptions = int(r.receptions) ?? 0;
      const standard = num(r.fantasy_points);
      // nflverse ships standard and PPR but not half, so derive it. Doing it
      // here means the baseline curve and the value engine can never disagree.
      const half = standard === null ? null : standard + 0.5 * receptions;

      rows.push([
        pid, season, week, str(r.season_type) ?? 'REG',
        normalizeTeam(str(pick(r, 'team', 'recent_team'))), str(r.position),
        normalizeTeam(str(r.opponent_team)),
        int(r.completions), int(r.attempts), num(r.passing_yards), int(r.passing_tds),
        int(pick(r, 'passing_interceptions', 'interceptions')),
        int(r.sack_fumbles_lost), num(r.passing_air_yards),
        int(r.passing_2pt_conversions), int(r.carries), num(r.rushing_yards),
        int(r.rushing_tds), int(r.rushing_fumbles_lost), int(r.rushing_2pt_conversions),
        receptions, int(r.targets), num(r.receiving_yards), int(r.receiving_tds),
        int(r.receiving_fumbles_lost), num(r.receiving_air_yards),
        num(r.receiving_yards_after_catch), int(r.receiving_2pt_conversions),
        num(r.target_share), num(r.air_yards_share), num(r.wopr), num(r.racr),
        int(r.special_teams_tds), standard, num(r.fantasy_points_ppr), half,
      ]);
    });

    bulkInsert('player_stats_week', cols, rows);
    total += rows.length;
    console.log(`  ${season}: ${rows.length} player-weeks`);
  }

  logIngest('player_stats', 'stats_player/stats_player_week_*', total, 'ok');
  console.log(`  loaded ${total} player-weeks (skipped ${skipped} with no offensive usage)`);
  return total;
}

/**
 * Snap counts key on PFR ids, not gsis, so they are bridged through
 * players.pfr_id after load. Players with no pfr_id keep a null player_id and
 * are simply absent from snap-share context rather than mismatched.
 */
export async function ingestSnapCounts(seasons: number[], maxAgeMs = DAY) {
  console.log('snap counts:');
  const cols = [
    'pfr_player_id', 'season', 'week', 'game_type', 'team', 'position',
    'offense_snaps', 'offense_pct',
  ];
  let total = 0;

  for (const season of seasons) {
    const url = NFLVERSE.snapCounts(season);
    let path: string;
    try {
      path = await download(`snap_counts_${season}.csv`, url, maxAgeMs);
    } catch {
      console.log(`  skip ${season} (not published)`);
      continue;
    }

    const rows: unknown[][] = [];
    await streamCsv(path, (r) => {
      const pfr = str(r.pfr_player_id);
      const week = int(r.week);
      if (!pfr || week === null) return;
      if (!KEEP_POSITIONS.has((str(r.position) ?? '').toUpperCase())) return;
      rows.push([
        pfr, season, week, str(r.game_type), normalizeTeam(str(r.team)),
        str(r.position), num(r.offense_snaps), num(r.offense_pct),
      ]);
    });

    bulkInsert('snap_counts', cols, rows);
    total += rows.length;
    console.log(`  ${season}: ${rows.length} rows`);
  }

  const bridged = sqlite
    .prepare(
      `UPDATE snap_counts SET player_id = (
         SELECT p.gsis_id FROM players p WHERE p.pfr_id = snap_counts.pfr_player_id
       ) WHERE player_id IS NULL`,
    )
    .run();

  const unbridged = db
    .select({ n: sql<number>`count(*)` })
    .from(snapCounts)
    .where(sql`player_id IS NULL`)
    .get();

  logIngest('snap_counts', 'multi', total, 'ok');
  console.log(`  bridged ${bridged.changes} rows to gsis ids; ${unbridged?.n ?? 0} still unmatched`);
  return total;
}
