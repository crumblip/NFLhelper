import { sqlite } from '../db/index';
import { NFLVERSE_EXTRA } from './sources';
import { download, streamCsv, str, num, int } from './sources';
import { normalizeTeam } from '../match/normalize';
import { PlayerIndex } from '../match/resolve';

const DAY = 86_400_000;

/**
 * Draft capital and depth chart — the two inputs that let a rookie be judged at
 * all.
 *
 * Neither is an opinion: one is what a team actually spent, the other is where
 * the team currently lists him. That keeps the no-expert-rankings rule intact
 * while giving rookies something better than a positional average.
 */

function bulk(table: string, columns: string[], rows: unknown[][]) {
  if (!rows.length) return;
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  );
  const run = sqlite.transaction((batch: unknown[][]) => {
    for (const r of batch) stmt.run(...(r as never[]));
  });
  for (let i = 0; i < rows.length; i += 5_000) run(rows.slice(i, i + 5_000));
}

/** Real gsis ids look like 00-0041037. Anything else is a placeholder. */
const isGsis = (id: string | null): boolean => id !== null && /^00-\d{7}$/.test(id);

export async function ingestDraftPicks(fromSeason: number, maxAgeMs = 7 * DAY) {
  console.log('draft picks:');
  const path = await download('draft_picks.csv', NFLVERSE_EXTRA.draftPicks, maxAgeMs);

  /*
   * The most recent class carries provisional ids ("LOV121782") rather than
   * gsis ones, which are assigned later. Those are exactly the players this
   * feature exists for, so they are resolved the same way sportsbook names are:
   * pfr_id where available, then the name index.
   */
  const byPfr = new Map(
    (
      sqlite
        .prepare(`SELECT pfr_id, gsis_id FROM players WHERE pfr_id IS NOT NULL`)
        .all() as Array<{ pfr_id: string; gsis_id: string }>
    ).map((r) => [r.pfr_id, r.gsis_id]),
  );
  const index = PlayerIndex.load();

  const rows: unknown[][] = [];
  const methods = new Map<string, number>();

  await streamCsv(path, (r) => {
    const season = int(r.season);
    const pick = int(r.pick);
    if (season === null || pick === null || season < fromSeason) return;

    const rawId = str(r.gsis_id);
    const team = normalizeTeam(str(r.team));
    const position = str(r.position);

    let playerId: string | null = null;
    let method = 'unresolved';

    if (isGsis(rawId)) {
      playerId = rawId;
      method = 'gsis';
    } else {
      const pfr = str(r.pfr_player_id);
      const viaPfr = pfr ? byPfr.get(pfr) : undefined;
      if (viaPfr) {
        playerId = viaPfr;
        method = 'pfr';
      } else {
        const name = str(r.pfr_player_name);
        if (name) {
          const res = index.resolve({ rawName: name, position, team, season });
          if (res.playerId && res.confidence >= 0.9) {
            playerId = res.playerId;
            method = `name:${res.method}`;
          }
        }
      }
    }

    methods.set(method, (methods.get(method) ?? 0) + 1);
    rows.push([season, int(r.round) ?? 0, pick, playerId, team, position, str(r.college)]);
  });

  bulk('draft_picks', ['season', 'round', 'pick', 'player_id', 'team', 'position', 'college'], rows);
  console.log(`  loaded ${rows.length} picks from ${fromSeason}`);
  for (const [m, n] of [...methods].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${m}`);
  }
  return rows.length;
}

/**
 * Depth charts ship as dated snapshots, so only the most recent row per
 * (player, position) is kept — an August chart supersedes a June one.
 */
export async function ingestDepthCharts(season: number, maxAgeMs = DAY) {
  console.log('depth charts:');
  let path: string;
  try {
    path = await download(
      `depth_charts_${season}.csv`,
      NFLVERSE_EXTRA.depthCharts(season),
      maxAgeMs,
    );
  } catch {
    console.log(`  skip ${season} (not published)`);
    return 0;
  }

  const latest = new Map<string, unknown[]>();
  let seen = 0;

  await streamCsv(path, (r) => {
    const playerId = str(r.gsis_id);
    const posAbb = str(r.pos_abb);
    if (!playerId || !posAbb) return;
    seen++;

    const dt = str(r.dt) ?? '';
    const key = `${playerId}|${posAbb}`;
    const existing = latest.get(key);
    // Keep the newest snapshot only.
    if (existing && String(existing[7]) >= dt) return;

    latest.set(key, [
      season, playerId, normalizeTeam(str(r.team)), posAbb, str(r.pos_name),
      int(r.pos_rank), int(r.pos_slot), dt,
    ]);
  });

  const rows = [...latest.values()];
  bulk(
    'depth_chart',
    ['season', 'player_id', 'team', 'pos_abb', 'pos_name', 'pos_rank', 'pos_slot', 'as_of'],
    rows,
  );

  const asOf = rows.length
    ? rows.map((r) => String(r[7])).sort().at(-1)
    : 'n/a';
  console.log(`  ${seen} snapshot rows -> ${rows.length} current entries (latest ${asOf})`);
  return rows.length;
}
