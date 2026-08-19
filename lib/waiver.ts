import { sqlite } from './db/index';
import { fitUsageModels, projectUsage } from './pipeline/usage-grade';
import { buildCoverageProfile, maskStatLine } from './pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from './pipeline/scoring';
import { currentSeasonWeight, buildUsageScale } from './pipeline/blend';
import { loadGrids, gridFor, projectedReplacement } from './pipeline/value';
import { adpEquivalentDetail } from './pipeline/baseline';
import {
  buildVacancies,
  opportunityFor,
  buildAbsenceVacancies,
  absenceOpportunityFor,
} from './pipeline/opportunity';
import { buildRiskProfiles, riskNotes } from './pipeline/risk';
import { buildTrajectories, trajectoryNotes, type Trajectory } from './pipeline/trajectory';
import { buildContingencies } from './pipeline/depth';
import { buildUpside, type UpsideProjection } from './pipeline/upside';
import { resolveAvailability, type AvailabilitySource } from './pipeline/ownership';
import { normalizeName, unflipName } from './match/normalize';

/**
 * The waiver wire: everyone worth a look who is NOT being drafted.
 *
 * The draft board answers "is this player worth his price". Off the board there
 * is no price, so the question changes to "is a role opening up for him". That
 * makes opportunity the primary sort rather than a tiebreak — the profile behind
 * every late-season pickup that mattered is a backup on a team whose volume has
 * moved, not a player who suddenly improved.
 *
 * This is the shared implementation. `scripts/waiver.ts` prints it and the
 * `/waiver` route renders it; neither owns the logic, so the two cannot drift.
 *
 * In-season the same query gets sharper: once games are played, `player_usage`
 * carries the current year and a player trending up is visible directly.
 */

export interface WaiverRow {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  age: number | null;
  depthRank: number | null;
  /**
   * Fitted points from the usage model.
   *
   * Deliberately not turned into value over replacement. The model regresses
   * hard toward the positional mean, so its output is on a different scale from
   * the actual-points replacement level in `replacement_level` — subtracting one
   * from the other is the mistake that once put a third of the top hundred
   * "below replacement". Dylan Sampson came out at −61, which reads as a verdict
   * and is really a unit mismatch. Rank on `grade`.
   */
  points: number;
  /** Percentile of that projection within the position, 0-100. */
  grade: number;
  /**
   * What he is worth over replacement, in actual points — and the draft pick
   * that has historically returned the same thing.
   *
   * The comment above used to end "Rank on `grade`", because the usage scale and
   * the replacement level lived in different units and subtracting one from the
   * other produced nonsense. That is fixed: `buildUsageScale` converts by the
   * model's own compression, so the subtraction is now valid.
   *
   * This is the number that answers the actual question about a free player. A
   * grade of 78 says he is a good role among his position; "projects like pick
   * 96, and costs nothing" says whether to spend a waiver claim on him. Null
   * when the position has no curve or no projection to convert.
   */
  vorp: number | null;
  /** The ADP whose historical return matches his projection. */
  equivalentPick: number | null;
  /**
   * Share of the volume he competes for that is available to him.
   *
   * Before the season this is offseason departures net of arrivals. Once games
   * are played it becomes the share held by teammates who did not play last
   * week, which is where volume actually moves in-season.
   */
  vacated: number;
  opportunity: string | null;
  notes: string[];
  targetShare: number | null;
  rushShare: number | null;
  rzShare: number | null;
  games: number;
  /** In-season role state; null before the season starts. */
  trajectory: Trajectory | null;
  /** Recent snap share fell far enough below his season average to matter. */
  roleShrinking: boolean;
  /** Weeks since he last took an offensive snap. */
  weeksMissed: number;
  /**
   * Set when he is mid-waiver-claim rather than a straight add.
   *
   * Only ever populated from a connected league — the national ADP fallback
   * knows nothing about waiver periods, and inventing a date there would be a
   * default rendered as a fact.
   */
  onWaiversUntil: string | null;
  /**
   * What he is worth if the man ahead of him stops playing.
   *
   * The wire needs this more than the board does. Almost everyone here projects
   * below replacement in their current role — that is why they are undrafted —
   * so ranking on the expectation alone sorts by "how buried is he". The pickup
   * that wins a league is the backup whose starter goes down in week 6, and that
   * is a conditional, not an average.
   */
  upside: UpsideProjection | null;
  /** Volume has opened and he is listed to inherit it. */
  priority: boolean;
  /** Under 25, listed top two, volume open. */
  youngPath: boolean;
  /** Clears the evidence floor below — enough involvement and enough sample. */
  qualified: boolean;
}

export interface WaiverMeta {
  season: number;
  /** Latest regular-season week with stats; 0 before the season starts. */
  week: number;
  total: number;
  qualified: number;
  belowFloor: number;
  minInvolvement: number;
  minGames: number;
  /** True once the season is under way and current-year usage is driving. */
  live: boolean;
  /** The season whose usage rows the projection is reading. */
  usageSeason: number;
  /** Share of the usage signal coming from the season in progress, 0-1. */
  currentSeasonWeight: number;
  /**
   * Where availability came from: a connected Yahoo league, or the national ADP
   * proxy. The page states which, and must continue to — the two answer
   * genuinely different questions and only one of them is about this league.
   */
  availabilitySource: AvailabilitySource;
  leagueName: string | null;
  /** Yahoo rows whose name did not resolve to a player id. Zero is the target. */
  unresolvedOwnership: number;
  /** Players held across the league. Zero before a draft. */
  rosteredCount: number;
  /** Available players who must be claimed on waivers rather than simply added. */
  onWaivers: number;
}

export interface WaiverBoard {
  rows: WaiverRow[];
  meta: WaiverMeta;
}

/**
 * Minimum evidence before a player can be a priority add.
 *
 * Opportunity alone will surface anyone who happens to play for a team that
 * lost people, which put Ke'Shawn Williams — zero targets, zero projection — at
 * the top of the list purely because Pittsburgh's receivers left. Being next in
 * line requires having shown something first.
 *
 * Two separate problems needed catching. Some players have a depth-chart spot
 * and genuinely no offensive role: Patrick Ricard and Reggie Gilliam are
 * blocking fullbacks with 0.5% rush share. Others simply have no sample — Cam
 * Akers and Eric Gray played one or two games, which is neither evidence for nor
 * against them. So the floor covers both involvement and sample size.
 *
 * 3% sits just above the pool's 25th percentile (2.3%), which removes the dead
 * weight without cutting into genuine committee players. Four games is the point
 * where a share stops being one good afternoon.
 */
export const MIN_INVOLVEMENT = 0.03;
export const MIN_GAMES = 4;

/**
 * How far down a position's depth chart a real role still exists.
 *
 * A flat "listed first or second" cutoff looked position-neutral and was not.
 * Every WR1 and WR2 in the league is drafted, so only three qualified receivers
 * existed at that depth and the priority tier returned zero of them — while
 * twenty-two backup tight ends walked through it on an 8% target share. The
 * board surfaced five TE2s and no receivers at all, which is precisely backwards
 * for a league that starts three receivers and a flex.
 *
 * Base personnel is the honest boundary: three receivers are on the field, so a
 * WR3 is a starter and the first man off the bench besides. One tight end is on
 * the field, so a TE2 is not. Backs split work two deep.
 *
 * These are judgment, not backtested — the same status as the tag thresholds.
 */
const ROTATION_DEPTH: Record<string, number> = { RB: 2, WR: 3, TE: 1 };

/**
 * Fitting the usage model scans every player-season, so it costs far too much to
 * repeat on each request of a `force-dynamic` page. The result only changes when
 * an ingest writes, so the cache is keyed on the newest write it depends on and
 * clears itself the moment one lands.
 */
let cache: { stamp: string; key: string; board: WaiverBoard } | null = null;

function dataStamp(season: number): string {
  const usage = sqlite
    .prepare(`SELECT COALESCE(MAX(computed_at), 0) AS t, COUNT(*) AS n FROM player_usage`)
    .get() as { t: number; n: number };
  const depth = sqlite
    .prepare(`SELECT COALESCE(MAX(as_of), '') AS t, COUNT(*) AS n FROM depth_chart WHERE season = ?`)
    .get(season) as { t: string; n: number };
  const adp = sqlite
    .prepare(`SELECT COALESCE(MAX(fetched_at), 0) AS t, COUNT(*) AS n FROM adp_raw WHERE year = ?`)
    .get(season) as { t: number; n: number };
  // Ownership belongs in the stamp for the same reason the others do: an
  // `ingest:yahoo` that adds a roster must invalidate the board, or the wire
  // keeps serving the availability it computed before the draft.
  const own = sqlite
    .prepare(`SELECT COALESCE(MAX(fetched_at), 0) AS t, COUNT(*) AS n FROM yahoo_ownership`)
    .get() as { t: number; n: number };
  return `${usage.t}:${usage.n}|${depth.t}:${depth.n}|${adp.t}:${adp.n}|${own.t}:${own.n}`;
}

export function getWaiverBoard(format: string, teams: number, season: number): WaiverBoard {
  const key = `${format}|${teams}|${season}`;
  const stamp = dataStamp(season);
  if (cache && cache.key === key && cache.stamp === stamp) return cache.board;

  const board = computeWaiverBoard(format, teams, season);
  cache = { stamp, key, board };
  return board;
}

function computeWaiverBoard(format: string, teams: number, season: number): WaiverBoard {
  const profile = buildCoverageProfile(format, teams, season);
  const rules = rulesFor(format);

  const totals = sqlite
    .prepare(
      `SELECT player_id, season, MAX(position) AS position,
              SUM(passing_yards) AS passingYards, SUM(passing_tds) AS passingTds,
              SUM(interceptions) AS interceptions,
              SUM(rushing_yards) AS rushingYards, SUM(rushing_tds) AS rushingTds,
              SUM(receptions) AS receptions, SUM(receiving_yards) AS receivingYards,
              SUM(receiving_tds) AS receivingTds
       FROM player_stats_week WHERE season_type = 'REG' GROUP BY player_id, season`,
    )
    .all() as Array<{ player_id: string; season: number; position: string | null } & StatLine>;

  const points = new Map<string, number>();
  for (const r of totals) {
    const pos = (r.position ?? '').toUpperCase();
    const cats = profile.get(pos);
    points.set(`${r.player_id}|${r.season}`, scoreStatLine(cats ? maskStatLine(r, cats) : r, rules));
  }

  /*
   * Which season's usage to read.
   *
   * Before kickoff there is only last season. Once games are played the current
   * year takes over on the calibrated curve — but only if `ingest:usage` has
   * actually written rows for it, so a season that has started without an ingest
   * falls back rather than emptying the board.
   */
  const week = (
    sqlite
      .prepare(
        `SELECT COALESCE(MAX(week), 0) AS w FROM player_stats_week
         WHERE season = ? AND season_type = 'REG'`,
      )
      .get(season) as { w: number }
  ).w;

  const currentUsageRows = (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM player_usage WHERE season = ?`)
      .get(season) as { n: number }
  ).n;

  const live = week > 0 && currentUsageRows > 0;
  const usageSeason = live ? season : season - 1;

  /*
   * The evidence floor has to scale with how much season there has been.
   *
   * Four games is the point where a share stops being one good afternoon, and
   * that reasoning holds for a completed season. Applied in week two it asks for
   * more games than exist and empties the board in exactly the weeks a waiver
   * wire is most active. In-season the floor becomes "played about half the
   * weeks so far", capped at the original four.
   */
  const minGames = live ? Math.min(MIN_GAMES, Math.max(1, Math.round(week / 2))) : MIN_GAMES;

  const allProjections = projectUsage(
    fitUsageModels(points),
    usageSeason,
    3,
    live ? season : null,
  );
  const projections = new Map(allProjections.map((p) => [p.playerId, p]));

  const vacancies = buildVacancies(season - 1, season);
  const absences = live ? buildAbsenceVacancies(season) : new Map();
  const trajectories = live ? buildTrajectories(season) : new Map<string, Trajectory>();

  const fitted = fitUsageModels(points);
  const upsides = buildUpside(
    fitted,
    projectUsage(fitted, usageSeason, 3, live ? season : null),
    buildContingencies(season),
  );
  const risk = buildRiskProfiles(season - 1);

  /*
   * What a free player is worth, expressed the way the board expresses it.
   *
   * The usage scale is converted to actual points, replacement is subtracted,
   * and the result is read back off the ADP baseline curve to answer "which pick
   * has historically returned this?". For an undrafted player that comparison is
   * the whole point: he costs a waiver claim rather than a pick, so knowing he
   * projects like the 96th selection is the decision.
   *
   * The whole-league projection set is used for the replacement anchor, not the
   * wire's filtered rows — replacement is a rank in the league, and taking it
   * from a pool that already excludes every drafted player would put it far too
   * low and make every free agent look like a starter.
   */
  const { convert: toActual } = buildUsageScale(
    allProjections,
    projectedReplacement(format, teams, season),
    fitted,
  );
  const replacementByPos = projectedReplacement(format, teams, season);
  const grids = loadGrids(format, teams);

  /*
   * Who cannot be added.
   *
   * This used to be "anyone the national market drafts", read straight from
   * `adp_raw`. That is a proxy for a fact, and with a Yahoo league connected the
   * fact itself is available — so `resolveAvailability` returns real ownership
   * when there is a drafted roster to read and falls back to the ADP proxy when
   * there is not. Which one answered is carried on the meta and stated on the
   * page, because a fallback that looks like a measurement is exactly the
   * failure this project keeps rediscovering.
   */
  const availability = resolveAvailability(format, teams, season);

  /*
   * The team must come from the CURRENT depth chart, not from last season's
   * usage row.
   *
   * Taking `u.team` put 112 players on the roster they have already left, and
   * then graded each against that team's vacancy — so Dontayvion Wicks, now
   * Philadelphia's WR3, was listed at Green Bay and credited with 38% of the
   * targets vacated there. Those are the targets he vacated by leaving. He was
   * the top priority add in the league on the strength of his own departure.
   *
   * Position-matched listing wins, as in the kick-returner case; a player listed
   * only on special teams keeps the +2 rank penalty rather than being dropped.
   * SQLite returns the bare columns from the MIN() row, so `team` and `rank`
   * come from the same listing.
   */
  const pool = sqlite
    .prepare(
      `SELECT u.player_id, p.display_name AS name, u.position, u.games,
              COALESCE(dcp.team, dca.team, u.team) AS team,
              COALESCE(dcp.rank, dca.rank + 2) AS depthRank,
              u.target_share ts, u.rush_share rs, u.rz_touch_share rz,
              ? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age
       FROM player_usage u
       JOIN players p ON p.gsis_id = u.player_id
       LEFT JOIN (SELECT player_id, pos_abb, team, MIN(pos_rank) AS rank
                  FROM depth_chart WHERE season = ?
                  GROUP BY player_id, pos_abb) dcp
         ON dcp.player_id = u.player_id AND dcp.pos_abb = u.position
       LEFT JOIN (SELECT player_id, team, MIN(pos_rank) AS rank
                  FROM depth_chart WHERE season = ?
                  GROUP BY player_id) dca
         ON dca.player_id = u.player_id
       WHERE u.season = ? AND u.position IN ('WR','RB','TE')`,
    )
    .all(season, season, season, usageSeason) as Array<{
    player_id: string; name: string; position: string; team: string | null;
    games: number; ts: number | null; rs: number | null; rz: number | null;
    age: number | null; depthRank: number | null;
  }>;

  const rows: WaiverRow[] = [];
  for (const p of pool) {
    if (availability.unavailable.has(p.player_id)) continue;
    // The id-miss fallback: a Yahoo row whose name never resolved has no id to
    // exclude by, and the cost of missing one is a rostered player shown as a
    // free add. See `unavailableNameSet`.
    if (availability.unavailableNames.size && availability.unavailableNames.has(normalizeName(unflipName(p.name)))) continue;
    const proj = projections.get(p.player_id);
    if (!proj) continue;
    // Still on someone's depth chart — a player with no listing is not available
    // in any meaningful sense.
    if (p.depthRank === null) continue;

    /*
     * Opportunity changes meaning once the season starts.
     *
     * In August the question is who left in the offseason. By November that
     * roster has been settled for months and the volume that moves is moving
     * because somebody is hurt, so the in-season measure replaces it rather than
     * being averaged with it — they are answers to different questions and the
     * stale one should not dilute the live one.
     */
    const traj = trajectories.get(p.player_id) ?? null;
    const opp = live
      ? absenceOpportunityFor(
          p.team ? absences.get(p.team) : undefined,
          p.position,
          p.player_id,
        )
      : opportunityFor(p.team ? vacancies.get(p.team) : undefined, p.position);

    const involvement = p.position === 'RB' ? Math.max(p.rs ?? 0, p.ts ?? 0) : (p.ts ?? 0);
    const qualified = involvement >= MIN_INVOLVEMENT && p.games >= minGames;
    const inRotation = p.depthRank <= (ROTATION_DEPTH[p.position] ?? 2);

    const notes = [...riskNotes(risk.get(p.player_id)), ...trajectoryNotes(traj)];

    rows.push({
      playerId: p.player_id,
      name: p.name,
      position: p.position,
      team: p.team,
      age: p.age,
      depthRank: p.depthRank,
      points: proj.points,
      grade: proj.grade,
      ...(() => {
        const actual = toActual(p.position, proj.points);
        if (actual === null) return { vorp: null, equivalentPick: null };
        const v = actual - (replacementByPos.get(p.position) ?? 0);
        // Null when he projects below anything the draft curve covers. "Pick 200"
        // there is the curve running out, not a comparison — and it was 83% of
        // the wire.
        const eq = adpEquivalentDetail(gridFor(grids, p.position), v);
        return { vorp: v, equivalentPick: eq.clamped === 'bottom' ? null : eq.pick };
      })(),
      vacated: opp.share,
      opportunity: opp.note,
      notes,
      targetShare: p.ts,
      rushShare: p.rs,
      rzShare: p.rz,
      games: p.games,
      trajectory: traj,
      upside: upsides.get(p.player_id) ?? null,
      roleShrinking: traj?.collapsed ?? false,
      weeksMissed: traj?.weeksMissed ?? 0,
      onWaiversUntil: availability.waiverUntil.get(p.player_id) ?? null,
      /*
       * A shrinking role disqualifies a priority add: a player whose own snap
       * share is falling 15 points is being taken off the field, not put on it,
       * and that carries a measured 1.23 points per game.
       *
       * Note what this tier does and does not claim. In season it rests on an
       * absence — someone ahead of him did not play last week — which is a
       * direct causal step. In the offseason it rests on `buildVacancies`, and
       * there the inheritance is measured at roughly ZERO (`calibrate:opportunity`:
       * −0.022 for the first receiver in line, −0.027 for the first back, across
       * 1,117 cases). Preseason this tier is therefore "closest to open volume",
       * not "getting it", and the heading says so.
       */
      priority: qualified && inRotation && opp.share >= 0.25 && !(traj?.collapsed ?? false),
      youngPath:
        qualified && inRotation && (p.age ?? 99) <= 25 && opp.share >= 0.15 &&
        !(traj?.collapsed ?? false),
      qualified,
    });
  }

  const qualified = rows.filter((r) => r.qualified).length;

  return {
    rows: rows.sort((a, b) => b.grade - a.grade),
    meta: {
      season,
      week,
      total: rows.length,
      qualified,
      belowFloor: rows.length - qualified,
      minInvolvement: MIN_INVOLVEMENT,
      minGames,
      live,
      usageSeason,
      currentSeasonWeight: live ? currentSeasonWeight(week) : 0,
      availabilitySource: availability.source,
      leagueName: availability.leagueName,
      unresolvedOwnership: availability.unresolved,
      rosteredCount: availability.rosteredCount,
      onWaivers: rows.filter((r) => r.onWaiversUntil !== null).length,
    },
  };
}
