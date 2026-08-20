import { sqlite } from '../db/index';
import { resolveUsageSeason } from './usage-grade';

/**
 * The advanced read on a player: what he does per opportunity, and what offence
 * he does it in.
 *
 * Everything here survived `npm run calibrate:advanced`, which measures each
 * candidate against next-season points BOTH raw and after removing what the
 * position's dominant volume metric already explains. That second number is the
 * one that matters — a metric restating target share is not a second opinion,
 * however good its raw correlation looks.
 *
 * WHAT SURVIVED (partial r against next season, after target/rush share):
 *   first-down touches   WR .387  RB .338  TE .320  QB .360  <- strongest everywhere
 *   yards per carry             RB .274
 *   EPA per touch        WR .189  RB .261  TE .140  (QB: DEAD at .113)
 *   RB target share             RB .259
 *   RB yards per route          RB .257
 *   age                  WR .254
 *   team points scored   WR .204
 *   QB EPA per dropback  WR .193
 *   first-down rate      WR .184  RB .209  TE .154  (QB: DEAD at .055)
 *   yards per route run  WR .152
 *   yards after contact         RB .153
 *
 * WHAT DID NOT (measured, not assumed):
 *   scheme fit                  RB .090, and a back's outside-vs-inside edge does
 *                               not persist year to year at all (r=-0.010), so
 *                               there is no stable trait for a scheme to fit
 *   outside-run share           RB .173 raw .124 — nothing once volume is known
 *   team outside-run tendency   RB .021
 *   YAC per reception    WR .089
 *   pass rate over expected  WR .144 RB -.079
 *   TE yards per route   TE .034 — target share absorbs it entirely
 *   QB EPA per dropback  QB .460 — the strongest quarterback signal of all, and
 *                        stronger than his own volume control (.418)
 */

/** A single graded indicator, carrying its own evidence. */
export interface Indicator {
  id: string;
  label: string;
  /** The raw figure. */
  value: number | null;
  /** Formatted for display, including its unit. */
  display: string;
  /** Percentile within position among qualified players, 0-100. */
  percentile: number | null;
  /**
   * Measured partial correlation with next season, after the position's volume
   * metric is removed.
   *
   * **Null means it was not measured for THIS position, or was measured and
   * found dead.** It is not a missing value to be filled with a neighbour's:
   * tight ends and quarterbacks used to be shown the receiver's figure, which
   * is how a QB's first-down rate advertised .184 when its real number is .055.
   */
  weight: number | null;
  detail: string;
}

export interface TeamEnvironment {
  team: string | null;
  pointsFor: number | null;
  pointsRank: number | null;
  qbEpaDropback: number | null;
  qbEpaRank: number | null;
  primaryQbName: string | null;
  /** Share of team dropbacks he took, the EPA below is the TEAM's, not his. */
  primaryQbShare: number | null;
  passOe: number | null;
  outsideRunShare: number | null;
  offEpaRank: number | null;
  /** Head coach, not the coordinator; nflverse publishes no coordinator table. */
  headCoach: string | null;
  /** Mean share of team carries his lead back takes. Null under two seasons. */
  coachTopBackShare: number | null;
  /** Run and pass blocking, ranked 1-32 where 1 is best. */
  ybcPerCarry: number | null;
  ybcRank: number | null;
  passBlockRank: number | null;
  sackRateAllowed: number | null;
}

/**
 * The five-filter receiver screen.
 *
 * Reported with the precision actually measured rather than as a law. Of the
 * five WR1 seasons on record here, three cleared all five filters — Jefferson
 * 2022 missed only on his quarterback ranking 12th rather than top-10, and Chase
 * 2024 missed only on 2.27 yards per route against a 2.30 line. So the profile
 * describes the WR1 archetype well and the hard cutoffs are not a law.
 *
 * The number that makes it worth running is the forward test: receivers clearing
 * all five in one season averaged 228 half-PPR points the NEXT season with 62%
 * finishing top-12, against 142 points and 20% for receivers who held a real
 * role (18%+ target share) and did not clear. That is a three-fold lift in the
 * probability of a startable season, and it is the strongest single screen in
 * this project.
 *
 * Individually the five are modest — team points and QB EPA carry partial
 * correlations near 0.20 on their own. Together they are not redundant, which is
 * the finding.
 */
export interface ReceiverScreen {
  clears: boolean;
  passed: number;
  filters: Array<{ id: string; label: string; ok: boolean; actual: string }>;
}

export interface Scouting {
  playerId: string;
  position: string;
  season: number;
  games: number;
  indicators: Indicator[];
  /**
   * The offence he will play in — keyed on his CURRENT team, not the one his
   * stats were earned at.
   *
   * These are present-tense claims: who calls the plays, who throws him the
   * ball, how the line blocks. Keying them on `player_usage.team` asserted last
   * season's roster as current, which is family #4 and the same bug as #14, #29
   * and #42 arriving through a different join. It hit 165 players and 31 board
   * rows — A.J. Brown at ADP 19, Kenneth Walker at 26, Travis Etienne at 39 —
   * and the tell was Jahan Dotson, traded to Atlanta and still reading Nick
   * Sirianni as his play caller, on a panel whose own copy says a coaching
   * change costs a back about 12 points.
   *
   * NOTE WHAT IT STILL IS. `team_context` only reaches the last season played,
   * so this is his NEW team measured LAST year, before he arrived. Right team,
   * past tense — and `movedFrom` is set so the page can say so rather than
   * implying he was part of it.
   */
  environment: TeamEnvironment;
  /** Where his usage was earned, when that is not where he plays now. */
  movedFrom: string | null;
  screen: ReceiverScreen | null;
  /** Run direction, for backs. Direction is not blocking scheme, see below. */
  runSplit: { outside: number; tackle: number; inside: number; outsideYpc: number | null; insideYpc: number | null } | null;
}

interface Raw {
  playerId: string;
  position: string;
  /** His team NOW, the key for the environment below. */
  team: string | null;
  /** The team his usage was earned at, which may not be the same one. */
  usageTeam: string | null;
  age: number | null;
  games: number;
  points: number;
  targetShare: number;
  passSnaps: number;
  carries: number;
  rushYards: number;
  rushEpa: number;
  rushFd: number;
  recYards: number;
  recEpa: number;
  recFd: number;
  targets: number;
  outsideCarries: number;
  outsideYards: number;
  insideCarries: number;
  insideYards: number;
  tackleCarries: number;
  yardsAfterContact: number | null;
  env: TeamEnvironment;
}

/** ".387", or "no measurable signal" when the metric is dead for a position. */
const fmtPartial = (w: number | null | undefined): string =>
  w === null || w === undefined ? 'no measurable signal' : w.toFixed(3).replace(/^0/, '');

const pct = (v: number, all: number[]): number | null => {
  const usable = all.filter((x) => Number.isFinite(x));
  if (usable.length < 12) return null;
  return Math.round((usable.filter((x) => x <= v).length / usable.length) * 100);
};

/**
 * Build the scouting read for every player with play-by-play in the season the
 * rest of the tool is using, so the board, the wire and the player page cannot
 * disagree about which season they are describing.
 */
export function buildScouting(season: number): Map<string, Scouting> {
  const { usageSeason } = resolveUsageSeason(season);

  const envRows = sqlite
    .prepare(
      `SELECT t.team, t.points_for AS pointsFor, t.points_rank AS pointsRank,
              t.qb_epa_dropback AS qbEpaDropback, t.qb_epa_rank AS qbEpaRank,
              t.pass_oe AS passOe, t.outside_run_share AS outsideRunShare,
              t.off_epa_rank AS offEpaRank, t.primary_qb_share AS primaryQbShare,
              t.head_coach AS headCoach, t.ybc_per_carry AS ybcPerCarry,
              t.ybc_rank AS ybcRank, t.pass_block_rank AS passBlockRank,
              t.sack_rate_allowed AS sackRateAllowed,
              p.display_name AS primaryQbName
       FROM team_context t
       LEFT JOIN players p ON p.gsis_id = t.primary_qb_id
       WHERE t.season = ?`,
    )
    .all(usageSeason) as Array<TeamEnvironment & { team: string }>;

  const concentration = coachBackfieldConcentration();
  const env = new Map<string, TeamEnvironment>();
  for (const e of envRows) {
    env.set(e.team, { ...e, coachTopBackShare: concentration.get(e.headCoach ?? "") ?? null });
  }

  /*
   * His team NOW, from the current depth chart, falling back to the roster
   * field and finally to the usage row.
   *
   * Position-matched listing first, exactly as `lib/waiver.ts` does it: a
   * MIN(pos_rank) across every listing picks a kick-return entry over the real
   * one (#3), and `team` has to come from the same row as the rank or it is
   * two different listings spliced together.
   */
  const rows = sqlite
    .prepare(
      `SELECT u.player_id AS playerId, u.position,
              COALESCE(dcp.team, dca.team, p.latest_team, u.team) AS team,
              u.team AS usageTeam,
              ? - CAST(substr(p.birth_date,1,4) AS INTEGER) AS age,
              COALESCE(u.target_share,0) AS targetShare,
              COALESCE(u.pass_snaps,0) AS passSnaps,
              u.yards_after_contact AS yardsAfterContact,
              COALESCE(s.carries,0) AS carries, COALESCE(s.rush_yards,0) AS rushYards,
              COALESCE(s.rush_epa,0) AS rushEpa, COALESCE(s.rush_first_downs,0) AS rushFd,
              COALESCE(s.rec_yards,0) AS recYards, COALESCE(s.rec_epa,0) AS recEpa,
              COALESCE(s.rec_first_downs,0) AS recFd, COALESCE(s.targets,0) AS targets,
              COALESCE(s.outside_carries,0) AS outsideCarries,
              COALESCE(s.outside_yards,0) AS outsideYards,
              COALESCE(s.inside_carries,0) AS insideCarries,
              COALESCE(s.inside_yards,0) AS insideYards,
              COALESCE(s.tackle_carries,0) AS tackleCarries
       FROM player_usage u
       JOIN players p ON p.gsis_id = u.player_id
       LEFT JOIN player_scheme s ON s.player_id = u.player_id AND s.season = u.season
       LEFT JOIN (SELECT player_id, pos_abb, team, MIN(pos_rank) AS rank
                  FROM depth_chart WHERE season = ?
                  GROUP BY player_id, pos_abb) dcp
         ON dcp.player_id = u.player_id AND dcp.pos_abb = u.position
       LEFT JOIN (SELECT player_id, team, MIN(pos_rank) AS rank
                  FROM depth_chart WHERE season = ?
                  GROUP BY player_id) dca
         ON dca.player_id = u.player_id
       WHERE u.season = ? AND u.position IN ('QB','WR','RB','TE')`,
    )
    .all(usageSeason, season, season, usageSeason) as Array<
      Omit<Raw, 'games' | 'points' | 'env'> & { usageTeam: string | null }
    >;

  const games = new Map<string, number>();
  for (const r of sqlite
    .prepare(
      `SELECT player_id, COUNT(DISTINCT week) g FROM snap_counts
       WHERE season = ? AND game_type='REG' AND player_id IS NOT NULL AND offense_snaps > 0
       GROUP BY player_id`,
    )
    .all(usageSeason) as Array<{ player_id: string; g: number }>) {
    games.set(r.player_id, r.g);
  }

  const points = new Map<string, number>();
  for (const r of sqlite
    .prepare(
      `SELECT player_id, SUM(fantasy_points_half) pts FROM player_stats_week
       WHERE season = ? AND season_type='REG' GROUP BY player_id`,
    )
    .all(usageSeason) as Array<{ player_id: string; pts: number }>) {
    points.set(r.player_id, r.pts);
  }

  const full: Raw[] = rows.map((r) => ({
    ...r,
    games: games.get(r.playerId) ?? 0,
    points: points.get(r.playerId) ?? 0,
    env: env.get(r.team ?? '') ?? {
      team: r.team, pointsFor: null, pointsRank: null, qbEpaDropback: null,
      qbEpaRank: null, primaryQbName: null, primaryQbShare: null, passOe: null, outsideRunShare: null,
      headCoach: null, coachTopBackShare: null, ybcPerCarry: null, ybcRank: null,
      passBlockRank: null, sackRateAllowed: null,
      offEpaRank: null,
    },
  }));

  /* ----------------------------------------------------------- derivations */

  const touches = (r: Raw) => r.carries + r.targets;
  const yprr = (r: Raw) => (r.passSnaps >= 100 ? r.recYards / r.passSnaps : null);
  const fdPerGame = (r: Raw) => (r.games >= 4 ? (r.rushFd + r.recFd) / r.games : null);
  const fdRate = (r: Raw) => (touches(r) >= 40 ? (r.rushFd + r.recFd) / touches(r) : null);
  const epaTouch = (r: Raw) => (touches(r) >= 40 ? (r.rushEpa + r.recEpa) / touches(r) : null);
  const ypc = (r: Raw) => (r.carries >= 40 ? r.rushYards / r.carries : null);

  // Percentile pools are per position — the distributions are not the same
  // shape, and an absolute cutoff silently selects one position (family #3).
  const poolsFor = (position: string) => {
    const at = full.filter((r) => r.position === position && r.games >= 4);
    return {
      yprr: at.map(yprr).filter((v): v is number => v !== null),
      fdPerGame: at.map(fdPerGame).filter((v): v is number => v !== null),
      fdRate: at.map(fdRate).filter((v): v is number => v !== null),
      epaTouch: at.map(epaTouch).filter((v): v is number => v !== null),
      ypc: at.map(ypc).filter((v): v is number => v !== null),
      yac: at.map((r) => r.yardsAfterContact).filter((v): v is number => v !== null),
    };
  };
  const pools = new Map(['QB', 'WR', 'RB', 'TE'].map((p) => [p, poolsFor(p)]));

  const out = new Map<string, Scouting>();

  /*
   * Measured partial correlations, PER POSITION.
   *
   * This used to be `isBack ? rbNumber : wrNumber`, which handed tight ends and
   * quarterbacks the receiver's figure — and said so out loud, since the tile
   * quotes the partial as its justification. A tight end's "first downs per
   * game" claimed **.387**, a number measured on 676 receiver-seasons and on no
   * tight end anywhere. Family #6 with a decimal place on it, and family #1 in
   * the dispatch that produced it.
   *
   * `calibrate:advanced` now reports all four positions and these are its
   * numbers. Two of them change what the page should say rather than just the
   * digits:
   *
   *   - a QUARTERBACK's first-down RATE is **dead** (.055) and his EPA per
   *     touch nearly so (.113). They were being shown at .184 and .189, i.e.
   *     as "real independent signals", which they are for a receiver and are
   *     not for him.
   *   - his single strongest signal is EPA per dropback at **.460**, stronger
   *     than the volume control itself — and it was not a tile at all.
   *
   * A null means the metric was measured for this position and found dead, or
   * was never measured for it. Either way the tile is shown as description with
   * no correlation attached, because a blank is honest and a borrowed number is
   * not.
   */
  const WEIGHTS: Record<string, Record<string, number | null>> = {
    //              first-downs  fd-rate  epa-touch  yprr
    WR: { 'first-downs': 0.387, 'fd-rate': 0.184, 'epa-touch': 0.189, yprr: 0.152 },
    RB: { 'first-downs': 0.338, 'fd-rate': 0.209, 'epa-touch': 0.261, yprr: 0.257 },
    TE: { 'first-downs': 0.320, 'fd-rate': 0.154, 'epa-touch': 0.140, yprr: null },
    QB: { 'first-downs': 0.360, 'fd-rate': null, 'epa-touch': null, yprr: null },
  };

  for (const r of full) {
    const p = pools.get(r.position)!;
    const isBack = r.position === 'RB';
    const w = WEIGHTS[r.position] ?? {};
    const indicators: Indicator[] = [];

    const add = (
      id: string, label: string, value: number | null, display: string,
      pool: number[], weight: number | null, detail: string,
    ) => {
      if (value === null) return;
      indicators.push({
        id, label, value, display,
        percentile: pct(value, pool), weight, detail,
      });
    };

    /*
     * First downs lead every position, and that is the headline result of the
     * whole exercise. Moving the chains correlates with next-season points at
     * .773 for a receiver — higher than target share itself — and still .387
     * once target share is removed, the largest independent signal measured
     * anywhere in this project. It is volume and effectiveness in one number:
     * a target that gains four yards on 3rd-and-8 is not the same event as one
     * that converts, and the box score cannot tell them apart.
     */
    add(
      'first-downs', 'First downs per game', fdPerGame(r),
      fdPerGame(r) === null ? '' : `${fdPerGame(r)!.toFixed(1)}/g`,
      p.fdPerGame, w['first-downs'] ?? null,
      'Chains moved per game, rushing and receiving. The strongest forward signal measured at ' +
        `every position: after removing what ${isBack ? 'rush share' : r.position === 'QB' ? 'pass-snap share' : 'target share'} ` +
        `already explains it still carries ${fmtPartial(w['first-downs'])} for a ${r.position}.`,
    );

    add(
      'fd-rate', 'First-down rate', fdRate(r),
      fdRate(r) === null ? '' : `${(fdRate(r)! * 100).toFixed(1)}%`,
      p.fdRate, w['fd-rate'] ?? null,
      'Share of his touches that moved the chains, the rate behind the count, so it is not ' +
        'just a restatement of workload. ' +
        (w['fd-rate'] === null
          ? `Measured for ${r.position}s and found dead, so it is here as description only.`
          : `Carries ${fmtPartial(w['fd-rate'])} for a ${r.position} once volume is removed.`),
    );

    add(
      'epa-touch', 'EPA per touch', epaTouch(r),
      epaTouch(r) === null ? '' : epaTouch(r)!.toFixed(3),
      p.epaTouch, w['epa-touch'] ?? null,
      'Expected points added per touch: value created rather than yards accumulated. Counts ' +
        'field position and down, so a 3-yard gain on 3rd-and-2 outranks an 8-yard gain on 3rd-and-15. ' +
        (w['epa-touch'] === null
          ? `Measured for ${r.position}s and found dead, so it is here as description only.`
          : `Carries ${fmtPartial(w['epa-touch'])} for a ${r.position}.`),
    );

    if (isBack) {
      add(
        'ypc', 'Yards per carry', ypc(r),
        ypc(r) === null ? '' : ypc(r)!.toFixed(2),
        p.ypc, 0.274,
        'Holds up better than expected: .296 raw and .274 after rush share. Efficiency is usually ' +
          'the first thing to regress, and for backs it does not entirely.',
      );
      add(
        'yac', 'Yards after contact', r.yardsAfterContact,
        r.yardsAfterContact === null ? '' : `${r.yardsAfterContact.toFixed(2)}/att`,
        p.yac, 0.153,
        'Weak but not nothing, .207 raw, .153 after rush share. Worth reading as a tiebreaker ' +
          'rather than a thesis.',
      );
      add(
        'yprr', 'Yards per route run', yprr(r),
        yprr(r) === null ? '' : yprr(r)!.toFixed(2),
        p.yprr, 0.257,
        'For a back this is pass-game involvement, and it carries real independent signal (.257) ' +
          'because receiving work is the least replaceable part of a backfield role.',
      );
    } else {
      add(
        'yprr', 'Yards per route run', yprr(r),
        yprr(r) === null ? '' : yprr(r)!.toFixed(2),
        p.yprr, w.yprr ?? null,
        r.position === 'TE'
          ? 'For tight ends this adds nothing once target share is known (.034), the volume is the story.'
          : 'Receiving yards per pass snap on the field. Adds a small genuine lift over target share (.152): ' +
            'it separates receivers earning their volume from receivers merely given it.',
      );
    }

    /* ------------------------------------------------------------- screen */

    let screen: ReceiverScreen | null = null;
    if (r.position === 'WR' && r.games >= 6) {
      const y = yprr(r);
      const filters = [
        {
          id: 'age', label: 'Under 30', ok: r.age !== null && r.age < 30,
          actual: r.age === null ? 'unknown' : `${r.age}`,
        },
        {
          id: 'target', label: '25%+ target share', ok: r.targetShare >= 0.25,
          actual: `${(r.targetShare * 100).toFixed(1)}%`,
        },
        {
          id: 'yprr', label: '2.3+ yards per route', ok: (y ?? 0) >= 2.3,
          actual: y === null ? 'no route data' : y.toFixed(2),
        },
        {
          id: 'offence', label: 'Top-11 scoring offence', ok: (r.env.pointsRank ?? 99) <= 11,
          actual: r.env.pointsRank === null ? 'unknown' : `${r.env.pointsRank}th`,
        },
        {
          id: 'qb', label: 'Top-10 QB by EPA/dropback', ok: (r.env.qbEpaRank ?? 99) <= 10,
          actual: r.env.qbEpaRank === null ? 'unknown' : `${r.env.qbEpaRank}th`,
        },
      ];
      const passed = filters.filter((f) => f.ok).length;
      screen = { clears: passed === 5, passed, filters };
    }

    /*
     * Run direction is reported and NOT scored.
     *
     * Two separate findings put it here rather than in the model. A back's
     * per-carry edge on outside runs over interior runs does not persist from
     * one season to the next at all (r=-0.010 across 104 consecutive-season
     * pairs), so there is no stable trait for a scheme to suit. And matching
     * that edge to his next team's tendency returns nothing: the best-fit third
     * scored 147.5 the following season against 146.7 for the worst-fit third.
     *
     * The league-level premise does not hold either — outside runs beat interior
     * runs by 0.16 and 0.11 yards in 2021-22, then LOST by 0.11 and 0.15 in
     * 2023-24 before turning positive again. It is not a stable edge.
     *
     * It stays on the page because it is real description of how a back is used,
     * and because a reader is entitled to see the thing that was tested.
     */
    const runSplit =
      isBack && r.carries >= 40
        ? {
            outside: r.outsideCarries,
            tackle: r.tackleCarries,
            inside: r.insideCarries,
            outsideYpc: r.outsideCarries >= 20 ? r.outsideYards / r.outsideCarries : null,
            insideYpc: r.insideCarries >= 20 ? r.insideYards / r.insideCarries : null,
          }
        : null;

    out.set(r.playerId, {
      playerId: r.playerId,
      position: r.position,
      season: usageSeason,
      games: r.games,
      indicators,
      environment: r.env,
      // Null unless he actually moved, so the page can branch on truthiness
      // instead of comparing two team strings at every call site.
      movedFrom: r.usageTeam && r.usageTeam !== r.team ? r.usageTeam : null,
      screen,
      runSplit,
    });
  }

  return out;
}

/**
 * Mean share of team carries each coach's lead back has taken.
 *
 * Concentration follows the coach: it repeats at r=0.337 when he stays and only
 * r=0.107 when a team changes coach. Two to five seasons per coach in this
 * window, so it is a lean and never a projection input.
 */
export function coachBackfieldConcentration(): Map<string, number> {
  const topByTeamSeason = new Map<string, { coach: string; share: number }>();
  for (const r of sqlite
    .prepare(
      `SELECT u.season, u.team, MAX(COALESCE(u.rush_share, 0)) AS top, t.head_coach AS coach
       FROM player_usage u
       JOIN team_context t ON t.season = u.season AND t.team = u.team
       WHERE u.position = 'RB' AND u.team IS NOT NULL AND t.head_coach IS NOT NULL
       GROUP BY u.season, u.team`,
    )
    .all() as Array<{ season: number; team: string; top: number; coach: string }>) {
    topByTeamSeason.set(`${r.team}|${r.season}`, { coach: r.coach, share: r.top });
  }
  const byCoach = new Map<string, number[]>();
  for (const v of topByTeamSeason.values()) {
    const arr = byCoach.get(v.coach) ?? [];
    arr.push(v.share);
    byCoach.set(v.coach, arr);
  }
  const out = new Map<string, number>();
  for (const [coach, shares] of byCoach) {
    if (shares.length < 2) continue;
    out.set(coach, shares.reduce((a, b) => a + b, 0) / shares.length);
  }
  return out;
}
