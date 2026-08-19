import { sqlite } from '../db/index';
import { NFLVERSE_EXTRA, download, streamCsv, str, num, int } from './sources';
import { normalizeTeam } from '../match/normalize';
import { loadRedZone } from './redzone';

const DAY = 86_400_000;

/**
 * Per-player advanced usage, the forward-looking on-field signal.
 *
 * Weighted toward opportunity rather than efficiency on purpose: how often a
 * player is on the field for pass plays, and how often he is targeted when he
 * is, carry year to year far better than rate stats, which regress hard.
 *
 * Nothing here is charted opinion. Every figure is a count of what happened.
 */

interface SeasonAccum {
  passSnaps: Map<string, number>;
  /** Keyed `playerId|week`, so numerator and denominator cover the same games. */
  passSnapsByWeek: Map<string, number>;
  playerTeam: Map<string, Map<string, number>>;
  /**
   * Team totals keyed by `team|week`, not by team.
   *
   * Shares have to be measured against the games a player was actually
   * available for. Dividing his snaps by a *full season* of team plays charges
   * him for the weeks he was injured, which silently converts "hurt" into
   * "not trusted" — Tucker Kraft's 2025 route share read 39% that way when it
   * was 84% in the eight games he played.
   */
  teamDropbacksByWeek: Map<string, number>;
  teamPlaysByWeek: Map<string, number>;
  teamMotionByWeek: Map<string, number>;
}

/** nflverse game ids look like 2025_01_DAL_PHI. */
function weekOf(gameId: string | null): number | null {
  if (!gameId) return null;
  const parts = gameId.split('_');
  const w = Number(parts[1]);
  return Number.isFinite(w) ? w : null;
}

/** Sums team totals across only the weeks a player appeared. */
function sumWeeks(
  byWeek: Map<string, number>,
  team: string | null,
  weeks: number[],
): number | null {
  if (!team || !weeks.length) return null;
  let total = 0;
  let found = 0;
  for (const w of weeks) {
    const v = byWeek.get(`${team}|${w}`);
    if (v !== undefined) {
      total += v;
      found++;
    }
  }
  return found ? total : null;
}

/**
 * A dropback, identified by fields charted only when the defense actually
 * dropped into coverage.
 *
 * Explicitly NOT `number_of_pass_rushers` or `was_pressure`: both are populated
 * on 100% of plays (charted as zero/false on runs), so using them counts every
 * handoff as a dropback and roughly doubles the denominator — which showed up
 * as Justin Jefferson running routes on 78% of dropbacks and starting
 * quarterbacks capping out at 84%.
 *
 * Coverage type lands at ~690 per team per season, against ~606 pass attempts,
 * the difference being sacks and scrambles. That is the right denominator for
 * routes run.
 */
function isDropback(r: Record<string, string>): boolean {
  return (
    str(r.defense_man_zone_type) !== null ||
    str(r.defense_coverage_type) !== null ||
    str(r.time_to_throw) !== null ||
    str(r.route) !== null
  );
}

async function accumulateParticipation(season: number, maxAgeMs: number): Promise<SeasonAccum | null> {
  let path: string;
  try {
    path = await download(
      `pbp_participation_${season}.csv`,
      NFLVERSE_EXTRA.participation(season),
      maxAgeMs,
    );
  } catch {
    console.log(`  skip participation ${season} (not published)`);
    return null;
  }

  const acc: SeasonAccum = {
    passSnaps: new Map(),
    passSnapsByWeek: new Map(),
    playerTeam: new Map(),
    teamDropbacksByWeek: new Map(),
    teamPlaysByWeek: new Map(),
    teamMotionByWeek: new Map(),
  };

  // Play -> team, so FTN's play-level motion flag can be attributed to an
  // offense. FTN carries no team column of its own.
  const playTeam = new Map<string, string>();

  await streamCsv(path, (r) => {
    const team = normalizeTeam(str(r.possession_team));
    const gameId = str(r.nflverse_game_id);
    const playId = str(r.play_id);
    if (!team) return;

    const week = weekOf(gameId);
    const wk = `${team}|${week}`;
    if (week !== null) acc.teamPlaysByWeek.set(wk, (acc.teamPlaysByWeek.get(wk) ?? 0) + 1);
    if (gameId && playId) playTeam.set(`${gameId}|${playId}`, `${team}|${week}`);

    if (!isDropback(r)) return;
    if (week !== null) {
      acc.teamDropbacksByWeek.set(wk, (acc.teamDropbacksByWeek.get(wk) ?? 0) + 1);
    }

    const players = str(r.offense_players);
    if (!players) return;
    for (const id of players.split(';')) {
      if (!id) continue;
      /*
       * Snaps are kept per week so the numerator can be restricted to the same
       * weeks as the denominator.
       *
       * A player can be on the field without recording a stat line, so his
       * snaps covered weeks the team-dropback total did not, which produced
       * route shares above 100%.
       */
      const pw = `${id}|${week}`;
      acc.passSnapsByWeek.set(pw, (acc.passSnapsByWeek.get(pw) ?? 0) + 1);
      acc.passSnaps.set(id, (acc.passSnaps.get(id) ?? 0) + 1);
      const teams = acc.playerTeam.get(id) ?? new Map<string, number>();
      teams.set(team, (teams.get(team) ?? 0) + 1);
      acc.playerTeam.set(id, teams);
    }
  });

  // FTN motion, attributed to the offense via the play map above.
  try {
    const ftnPath = await download(
      `ftn_charting_${season}.csv`,
      NFLVERSE_EXTRA.ftnCharting(season),
      maxAgeMs,
    );
    await streamCsv(ftnPath, (r) => {
      const key = `${str(r.nflverse_game_id)}|${str(r.nflverse_play_id)}`;
      const teamWeek = playTeam.get(key);
      if (!teamWeek) return;
      const motion = str(r.is_motion);
      if (motion === 'TRUE' || motion === '1' || motion === 'true') {
        acc.teamMotionByWeek.set(teamWeek, (acc.teamMotionByWeek.get(teamWeek) ?? 0) + 1);
      }
    });
  } catch {
    console.log(`  no FTN charting for ${season}`);
  }

  return acc;
}

/** PFR advanced stats, keyed on pfr_player_id and bridged through players. */
async function pfrAdvanced(season: number, maxAgeMs: number) {
  const byPfr = new Map(
    (
      sqlite
        .prepare(`SELECT pfr_id, gsis_id FROM players WHERE pfr_id IS NOT NULL`)
        .all() as Array<{ pfr_id: string; gsis_id: string }>
    ).map((r) => [r.pfr_id, r.gsis_id]),
  );

  const rec = new Map<string, { yac: number; broken: number; drops: number }>();
  const rush = new Map<string, { before: number; after: number; carries: number; broken: number }>();

  try {
    const p = await download(
      `advstats_week_rec_${season}.csv`,
      NFLVERSE_EXTRA.advstatsRec(season),
      maxAgeMs,
    );
    await streamCsv(p, (r) => {
      const id = byPfr.get(str(r.pfr_player_id) ?? '');
      if (!id) return;
      const e = rec.get(id) ?? { yac: 0, broken: 0, drops: 0 };
      e.broken += int(r.receiving_broken_tackles) ?? 0;
      e.drops += int(r.receiving_drop) ?? 0;
      rec.set(id, e);
    });
  } catch {
    /* not published for this season */
  }

  try {
    const p = await download(
      `advstats_week_rush_${season}.csv`,
      NFLVERSE_EXTRA.advstatsRush(season),
      maxAgeMs,
    );
    await streamCsv(p, (r) => {
      const id = byPfr.get(str(r.pfr_player_id) ?? '');
      if (!id) return;
      const e = rush.get(id) ?? { before: 0, after: 0, carries: 0, broken: 0 };
      e.before += num(r.rushing_yards_before_contact) ?? 0;
      e.after += num(r.rushing_yards_after_contact) ?? 0;
      e.carries += int(r.carries) ?? 0;
      e.broken += int(r.rushing_broken_tackles) ?? 0;
      rush.set(id, e);
    });
  } catch {
    /* not published for this season */
  }

  return { rec, rush };
}

export async function ingestUsage(seasons: number[], maxAgeMs = 7 * DAY) {
  console.log('usage metrics:');

  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO player_usage
     (player_id, season, position, team, games, pass_snap_share, pass_snaps,
      team_pass_snaps, target_share, air_yards_share, targets_per_route, adot,
      yac_per_reception, team_motion_rate, rush_share, yards_before_contact,
      yards_after_contact, broken_tackles,
      rz_carries, rz_targets, rz_touch_share, goal_line_carries,
      goal_line_targets, goal_line_share, rz_tds, total_tds, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let total = 0;
  const now = Date.now();

  for (const season of seasons) {
    const acc = await accumulateParticipation(season, maxAgeMs);
    const { rec, rush } = await pfrAdvanced(season, maxAgeMs);
    const rz = await loadRedZone(season, maxAgeMs);

    // Box-score side: totals per player, plus team totals for the shares.
    const box = sqlite
      .prepare(
        `SELECT player_id, MAX(position) AS position, recent_team AS team,
                COUNT(*) AS games, SUM(targets) AS targets,
                SUM(receiving_air_yards) AS airYards,
                SUM(receiving_yards_after_catch) AS yac,
                SUM(receptions) AS receptions, SUM(carries) AS carries
         FROM player_stats_week
         WHERE season = ? AND season_type = 'REG'
         GROUP BY player_id, recent_team`,
      )
      .all(season) as Array<{
      player_id: string; position: string | null; team: string | null; games: number;
      targets: number | null; airYards: number | null; yac: number | null;
      receptions: number | null; carries: number | null;
    }>;

    // Team box-score totals per week, and the weeks each player appeared in.
    const teamTargetsByWeek = new Map<string, number>();
    const teamAirYardsByWeek = new Map<string, number>();
    const teamCarriesByWeek = new Map<string, number>();
    const playerWeeks = new Map<string, number[]>();

    for (const w of sqlite
      .prepare(
        `SELECT player_id, recent_team AS team, week, targets, receiving_air_yards AS airYards,
                carries
         FROM player_stats_week WHERE season = ? AND season_type = 'REG'`,
      )
      .all(season) as Array<{
      player_id: string; team: string | null; week: number;
      targets: number | null; airYards: number | null; carries: number | null;
    }>) {
      const key = `${w.team ?? ''}|${w.week}`;
      teamTargetsByWeek.set(key, (teamTargetsByWeek.get(key) ?? 0) + (w.targets ?? 0));
      teamAirYardsByWeek.set(key, (teamAirYardsByWeek.get(key) ?? 0) + (w.airYards ?? 0));
      teamCarriesByWeek.set(key, (teamCarriesByWeek.get(key) ?? 0) + (w.carries ?? 0));

      const list = playerWeeks.get(`${w.player_id}|${w.team ?? ''}`) ?? [];
      list.push(w.week);
      playerWeeks.set(`${w.player_id}|${w.team ?? ''}`, list);
    }

    const rows = box.filter((b) => ['QB', 'RB', 'FB', 'WR', 'TE'].includes((b.position ?? '').toUpperCase()));

    const run = sqlite.transaction(() => {
      for (const b of rows) {
        const team = b.team ?? null;
        // Every share below is measured against only the weeks this player was
        // on the field, so missing time never reads as losing his role.
        const weeks = playerWeeks.get(`${b.player_id}|${team ?? ''}`) ?? [];

        // Restricted to the same weeks as the denominator, so a snap taken in a
        // week with no stat line cannot push the share past 100%.
        const passSnaps = acc
          ? weeks.reduce(
              (sum, w) => sum + (acc.passSnapsByWeek.get(`${b.player_id}|${w}`) ?? 0),
              0,
            )
          : null;
        const teamDrop = acc ? sumWeeks(acc.teamDropbacksByWeek, team, weeks) : null;
        const share = passSnaps !== null && teamDrop ? passSnaps / teamDrop : null;

        const tgt = b.targets ?? 0;
        const teamTgt = sumWeeks(teamTargetsByWeek, team, weeks);
        const teamAy = sumWeeks(teamAirYardsByWeek, team, weeks);
        const teamCar = sumWeeks(teamCarriesByWeek, team, weeks);
        const tShare = teamTgt ? tgt / teamTgt : null;
        const ayShare = teamAy ? (b.airYards ?? 0) / teamAy : null;
        const rShare = teamCar ? (b.carries ?? 0) / teamCar : null;

        const motionPlays = acc ? sumWeeks(acc.teamMotionByWeek, team, weeks) : null;
        const plays = acc ? sumWeeks(acc.teamPlaysByWeek, team, weeks) : null;
        const motionRate = motionPlays !== null && plays ? motionPlays / plays : null;

        const r = rush.get(b.player_id);
        const rc = rec.get(b.player_id);

        const z = rz?.byPlayer.get(b.player_id);
        const teamRz = rz ? sumWeeks(rz.teamRzPlaysByWeek, team, weeks) : null;
        const teamGl = rz ? sumWeeks(rz.teamGoalLinePlaysByWeek, team, weeks) : null;
        const rzTouches = (z?.rzCarries ?? 0) + (z?.rzTargets ?? 0);
        const glTouches = (z?.goalLineCarries ?? 0) + (z?.goalLineTargets ?? 0);

        stmt.run(
          b.player_id, season, b.position, team, b.games,
          share, passSnaps, teamDrop,
          tShare, ayShare,
          passSnaps ? tgt / passSnaps : null,
          tgt ? (b.airYards ?? 0) / tgt : null,
          b.receptions ? (b.yac ?? 0) / b.receptions : null,
          motionRate, rShare,
          r && r.carries ? r.before / r.carries : null,
          r && r.carries ? r.after / r.carries : null,
          (rc?.broken ?? 0) + (r?.broken ?? 0),
          z?.rzCarries ?? null, z?.rzTargets ?? null,
          teamRz ? rzTouches / teamRz : null,
          z?.goalLineCarries ?? null, z?.goalLineTargets ?? null,
          teamGl ? glTouches / teamGl : null,
          z?.rzTds ?? null, z?.totalTds ?? null,
          now,
        );
        total++;
      }
    });
    run();

    console.log(
      `  ${season}: ${rows.length} player-seasons` +
        (acc ? ` | ${acc.passSnaps.size} with pass snaps` : ' | no participation data'),
    );
  }

  console.log(`  wrote ${total} usage rows`);
  return total;
}
