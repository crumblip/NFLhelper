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
 * Depth charts ship as dated snapshots, and A SNAPSHOT IS A ROSTER AT A MOMENT,
 * NOT AN ACCUMULATION.
 *
 * This used to keep the newest row per (player, position), which sounds like the
 * same thing and is not. A player who was on Seattle's chart in July and cut in
 * August has no August row, so his July row was still the newest one he had — and
 * he stayed on the depth chart forever, listed at a team that had moved on. 610
 * of 3,792 rows were leftovers of that kind, including 41 skill players: Harrison
 * Bryant listed at Seattle while under contract in Houston, Mike Woods at Denver
 * with a status of CUT, Cam Akers on an April chart in August.
 *
 * That is not cosmetic. The waiver page requires a depth-chart listing, so a cut
 * player stayed claimable all season; the depth-chart room on the player page
 * showed team-mates who had left; and every consumer joining on `depth_chart`
 * inherited it. Same family as #9, #64 and #94 — a write path that only ever
 * upserts cannot express "this row should stop existing".
 *
 * So: take the newest snapshot date PER TEAM, and keep only the rows from it.
 * Per team rather than globally, because teams publish on their own days and a
 * global cut-off would erase whichever team had not posted that morning. A
 * player who moved has a row on both charts and keeps only the newer one; a
 * player who was cut appears on neither and is correctly gone.
 *
 * The season is deleted before the write for the same reason: a player who
 * should disappear has no row to update, only a row that should stop existing.
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

  /*
   * Two passes over the file. The first only learns each team's newest
   * snapshot date, because that cannot be known until the whole file has been
   * read — a single pass would have to guess, which is how the old version
   * ended up keeping whatever each player happened to have last.
   */
  const newestByTeam = new Map<string, string>();
  let seen = 0;

  await streamCsv(path, (r) => {
    const team = normalizeTeam(str(r.team));
    const dt = str(r.dt) ?? '';
    if (!team || !dt) return;
    seen++;
    if ((newestByTeam.get(team) ?? '') < dt) newestByTeam.set(team, dt);
  });

  const current = new Map<string, unknown[]>();
  let stale = 0;

  await streamCsv(path, (r) => {
    const playerId = str(r.gsis_id);
    const posAbb = str(r.pos_abb);
    const team = normalizeTeam(str(r.team));
    if (!playerId || !posAbb || !team) return;

    const dt = str(r.dt) ?? '';
    // Anything from an older chart than the team's current one is a player the
    // team has since moved on from, not a player whose row is merely old.
    if (dt !== newestByTeam.get(team)) {
      stale++;
      return;
    }

    current.set(`${playerId}|${posAbb}|${team}`, [
      season, playerId, team, posAbb, str(r.pos_name),
      int(r.pos_rank), int(r.pos_slot), dt,
    ]);
  });

  const rows = [...current.values()];

  /*
   * DELETE then INSERT, never upsert alone. A departed player is a row that
   * must stop existing, and an upsert has no way to say that — the exact shape
   * that left orphans behind in #9, #64 and #94.
   */
  sqlite.prepare(`DELETE FROM depth_chart WHERE season = ?`).run(season);
  bulk(
    'depth_chart',
    ['season', 'player_id', 'team', 'pos_abb', 'pos_name', 'pos_rank', 'pos_slot', 'as_of'],
    rows,
  );

  const dates = [...new Set(newestByTeam.values())].sort();
  console.log(
    `  ${seen} snapshot rows -> ${rows.length} current entries across ${newestByTeam.size} teams ` +
      `(${stale} from superseded charts dropped)`,
  );
  console.log(
    `  charts dated ${dates[0] ?? 'n/a'}${dates.length > 1 ? ` to ${dates.at(-1)}` : ''}`,
  );
  return rows.length;
}
