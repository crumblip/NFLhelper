import { sqlite } from '../lib/db/index';
import { PlayerIndex, saveAliases } from '../lib/match/resolve';
import { YahooClient } from '../lib/providers/yahoo/client';
import {
  discoverLeagues,
  leagueMeta,
  leagueSettings,
  leagueTeams,
  teamRoster,
  waiverPlayers,
  statCategories,
  type YahooPlayerRow,
} from '../lib/providers/yahoo/league';

/**
 * Pulls one Yahoo league: its teams, their rosters, and who sits on waivers.
 *
 * What this writes is ownership, and ownership has one contract that everything
 * downstream depends on: **absence from `yahoo_ownership` means free**. That
 * makes a dropped row far more dangerous than a wrong one. A player whose name
 * fails to resolve must still be stored, with a null gsis id, because storing
 * nothing would quietly promote him to "available" — the single wrong answer
 * this table exists to prevent.
 *
 * The write is DELETE-then-INSERT per league rather than an upsert. Ownership is
 * the exact shape that breaks under upsert: a player who was dropped has no row
 * to update, only a row that should stop existing. Bugs #9 and #64 were both
 * orphans surviving a refresh, and both were upserts.
 */

const CURRENT = Number(process.env.SEASON ?? 2026);
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';

/** Positions this project models. Everything else is expected not to resolve. */
const MODELLED = new Set(['QB', 'RB', 'WR', 'TE']);

async function main(): Promise<void> {
  const client = new YahooClient();

  const leagueKey = await resolveLeagueKey(client);
  console.log(`league: ${leagueKey}\n`);

  const meta = await leagueMeta(client, leagueKey);
  const settings = await leagueSettings(client, leagueKey);
  const teams = await leagueTeams(client, leagueKey);

  console.log(`${meta.name} — ${meta.season}, ${meta.numTeams} teams, draft ${meta.draftStatus}`);
  console.log(`${teams.length} teams read\n`);

  /*
   * Rosters, one team at a time so the owner comes from the request rather than
   * from tree position. See the note in league.ts.
   */
  const rostered: Array<{ teamKey: string; player: YahooPlayerRow }> = [];
  for (const t of teams) {
    const players = await teamRoster(client, t.teamKey);
    for (const p of players) rostered.push({ teamKey: t.teamKey, player: p });
    console.log(`  ${t.name.padEnd(28)} ${String(players.length).padStart(2)} players`);
  }

  /*
   * Waivers are a separate state and a failure here must not take the run down.
   * A league that has not drafted has nothing on waivers, and Yahoo is not
   * consistent about whether that is an empty list or an error.
   */
  let waivers: Array<YahooPlayerRow & { waiverDate: string | null }> = [];
  try {
    waivers = await waiverPlayers(client, leagueKey);
  } catch (err) {
    console.log(`\n  waivers unavailable (${(err as Error).message.slice(0, 80)})`);
  }

  console.log(`\n${rostered.length} rostered · ${waivers.length} on waivers`);

  // ---- resolve names to gsis ids -------------------------------------------

  const index = PlayerIndex.load();
  const everyone = [
    ...rostered.map((r) => r.player),
    ...waivers.map((w) => w as YahooPlayerRow),
  ];

  const resolved = new Map<string, { playerId: string | null; method: string; confidence: number }>();
  for (const p of everyone) {
    if (resolved.has(p.playerKey)) continue;
    resolved.set(
      p.playerKey,
      index.resolve({
        rawName: p.name,
        position: p.position,
        team: p.nflTeam,
        season: CURRENT,
      }),
    );
  }

  const modelled = everyone.filter((p) => MODELLED.has((p.position ?? '').toUpperCase()));
  const missed = modelled.filter((p) => !resolved.get(p.playerKey)?.playerId);
  const rate = modelled.length ? 1 - missed.length / modelled.length : 1;

  console.log(
    `\nname resolution: ${modelled.length - missed.length}/${modelled.length} ` +
      `skill players matched (${(rate * 100).toFixed(1)}%)`,
  );
  if (missed.length) {
    // Named, never counted silently. An unmatched player is invisible to every
    // downstream join, so the miss list is the thing worth reading here.
    console.log('  unmatched:');
    for (const p of missed) console.log(`    ${p.name} (${p.position}, ${p.nflTeam ?? '?'})`);
  }

  saveAliases(
    'yahoo',
    everyone.map((p) => {
      const r = resolved.get(p.playerKey)!;
      return {
        rawName: p.name,
        position: p.position,
        team: p.nflTeam,
        playerId: r.playerId,
        method: r.method,
        confidence: r.confidence,
      };
    }),
  );

  // ---- write ---------------------------------------------------------------

  const now = Date.now();
  const write = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM yahoo_ownership WHERE league_key = ?`).run(leagueKey);
    sqlite.prepare(`DELETE FROM yahoo_team WHERE league_key = ?`).run(leagueKey);
    sqlite.prepare(`DELETE FROM yahoo_league WHERE league_key = ?`).run(leagueKey);

    sqlite
      .prepare(
        `INSERT INTO yahoo_league
         (league_key, league_id, name, season, num_teams, scoring_type, draft_status,
          current_week, roster_positions, stat_modifiers, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.leagueKey,
        meta.leagueId,
        meta.name,
        meta.season,
        meta.numTeams,
        meta.scoringType,
        meta.draftStatus,
        meta.currentWeek,
        JSON.stringify(settings.rosterPositions),
        JSON.stringify(settings.statModifiers),
        now,
      );

    const teamStmt = sqlite.prepare(
      `INSERT INTO yahoo_team
       (league_key, team_key, team_id, name, manager_name, logo_url, is_mine,
        waiver_priority, faab_balance, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of teams) {
      teamStmt.run(
        leagueKey,
        t.teamKey,
        t.teamId,
        t.name,
        t.managerName,
        t.logoUrl,
        t.isMine ? 1 : 0,
        t.waiverPriority,
        t.faabBalance,
        now,
      );
    }

    const ownStmt = sqlite.prepare(
      `INSERT OR REPLACE INTO yahoo_ownership
       (league_key, yahoo_player_key, player_id, name, position, nfl_team, status,
        team_key, selected_position, injury_status, waiver_date, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const { teamKey, player } of rostered) {
      ownStmt.run(
        leagueKey,
        player.playerKey,
        resolved.get(player.playerKey)?.playerId ?? null,
        player.name,
        player.position,
        player.nflTeam,
        'rostered',
        teamKey,
        player.selectedPosition,
        player.injuryStatus,
        null,
        now,
      );
    }

    for (const w of waivers) {
      ownStmt.run(
        leagueKey,
        w.playerKey,
        resolved.get(w.playerKey)?.playerId ?? null,
        w.name,
        w.position,
        w.nflTeam,
        'waivers',
        null,
        null,
        w.injuryStatus,
        w.waiverDate,
        now,
      );
    }
  });
  write();

  // ---- does this league match what the board was tuned for? ----------------

  await reportSettings(client, settings, meta.numTeams);

  console.log(`\n${client.requests} Yahoo requests. Ownership written for ${leagueKey}.`);
  if (meta.draftStatus !== 'postdraft') {
    console.log(
      `\nNOTE: draft status is "${meta.draftStatus}", so rosters are empty or partial.\n` +
        '      The wire will keep using national ADP for availability until the draft\n' +
        '      is done, and will say so on the page. Re-run this after drafting.',
    );
  }
}

/**
 * Compares the connected league against the settings this board was calibrated
 * under, and reports rather than adopts.
 *
 * Every measured finding in this project — the 60/40 blend weight, the
 * replacement ranks, the bust bar — was fitted under half-PPR with these roster
 * slots. Quietly re-cutting them from whatever Yahoo returns would move numbers
 * that carry calibration behind them without anyone deciding to.
 */
async function reportSettings(
  client: YahooClient,
  settings: { rosterPositions: Record<string, number>; statModifiers: Record<string, number> },
  numTeams: number,
): Promise<void> {
  console.log('\nleague settings vs. this board:');

  const slots = Object.entries(settings.rosterPositions)
    .map(([k, v]) => `${v}x${k}`)
    .join(' · ');
  console.log(`  roster: ${slots}`);
  console.log(`  teams:  ${numTeams} (board configured for ${TEAMS})`);

  let receptionValue: number | null = null;
  try {
    const cats = await statCategories(client);
    for (const [id, value] of Object.entries(settings.statModifiers)) {
      if ((cats.get(id) ?? '').toLowerCase() === 'receptions') receptionValue = value;
    }
  } catch {
    // Non-fatal: the mapping is a convenience, not part of the ownership write.
  }

  if (receptionValue !== null) {
    const implied =
      receptionValue === 0 ? 'standard' : receptionValue === 0.5 ? 'half-ppr' : receptionValue === 1 ? 'ppr' : `${receptionValue}/reception`;
    console.log(`  scoring: ${receptionValue} per reception (${implied}), board configured for ${FORMAT}`);
    if (implied !== FORMAT) {
      console.log(
        '\n  WARNING: the scoring does not match. Replacement ranks, the baseline curve\n' +
          '  and the blend weight were all measured under ' + FORMAT + '. Ownership is\n' +
          '  unaffected — the wire will still be accurate — but the projections are\n' +
          '  describing a different league than the one you are in.',
      );
    }
  } else {
    console.log(`  scoring: reception value not identified (board configured for ${FORMAT})`);
  }

  if (numTeams !== TEAMS) {
    console.log(
      `\n  WARNING: this league has ${numTeams} teams, the board is built for ${TEAMS}.\n` +
        '  Replacement level moves with team count, so VALUE is off until LEAGUE_TEAMS matches.',
    );
  }
}

/** Explicit env wins; otherwise discover, and only auto-pick when unambiguous. */
async function resolveLeagueKey(client: YahooClient): Promise<string> {
  const configured = process.env.YAHOO_LEAGUE_KEY;
  if (configured) return configured;

  const leagues = await discoverLeagues(client);
  if (leagues.length === 0) {
    throw new Error('No NFL leagues found on this Yahoo account. Run: npm run yahoo:auth');
  }
  if (leagues.length === 1) return leagues[0]!.leagueKey;

  console.error('Several NFL leagues on this account. Set YAHOO_LEAGUE_KEY in .env.local:\n');
  for (const l of leagues) console.error(`  ${l.leagueKey}  ${l.name} (${l.numTeams} teams)`);
  throw new Error('YAHOO_LEAGUE_KEY not set');
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
