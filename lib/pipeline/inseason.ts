import { sqlite } from '../db/index';
import { REPLACEMENT_RANK } from './blend';

/**
 * What a player has actually done this season, for the two questions that
 * replace "who do I draft" once games are played: who to add off the wire, and
 * who to start this week.
 *
 * THE CENTRAL DESIGN DECISION IS COUNTERINTUITIVE AND IT IS MEASURED.
 * **Season to date leads. Recent form is context and does not vote.**
 *
 * Every other tool in this category leads with last-three-games. On 22,405
 * samples (`calibrate:recency`) that is worse at every position and at every
 * stage of the season: season-to-date predicts the rest of the year at RB .749
 * against .730 for a last-3 window, WR .737 against .711, TE .715 against .693.
 * The optimal blend puts 0.2 on the recent window for a gain of 0.0007, which
 * is nothing. A hot streak is mostly noise and the eye is extremely bad at
 * telling it from a change in role.
 *
 * **The one exception is asymmetric and is honoured.** A snap-share SPIKE does
 * not predict anything: 15 points above his own average returns 6.77 points a
 * game against 6.84 for a flat role, and predictability collapses to r=0.25,
 * because a spike is usually somebody else's one-week absence. A snap-share
 * COLLAPSE is real: 15 points below returns 5.62, a loss of 1.23 a game, and
 * there the recent window genuinely predicts better than the season (.461
 * against .441). So the recent rows are shown for both players, and only a
 * collapse is allowed to count against anyone.
 *
 * That is the whole argument for this file existing rather than a `last3` column
 * being bolted onto the draft comparison.
 */

export interface LiveRead {
  playerId: string;
  /** Latest completed week in the data. */
  week: number;
  gamesPlayed: number;

  /** Half-PPR, season to date. The headline number in season. */
  points: number;
  ppg: number;

  /**
   * Weeks he actually finished inside his position's starter count.
   *
   * Note this is the REALISED rate, not the projected one. In season the fact
   * is available and the projection is not needed for it.
   */
  startableWeeks: number;
  startableRate: number | null;

  /* ---- usage this season, per game where a count, share where a share ---- */
  targetShare: number | null;
  rushShare: number | null;
  snapPct: number | null;
  /** Weighted opportunity: 1.5x target share + 0.7x air-yards share. */
  wopr: number | null;
  opportunitiesPerGame: number | null;
  targetsPerGame: number | null;
  carriesPerGame: number | null;

  /* ---- recent, for CONTEXT only. See the file comment. ---- */
  last3Ppg: number | null;
  last3SnapPct: number | null;
  /** Recent snap share minus season snap share, percentage points. */
  snapDelta: number | null;
  /**
   * True only when the recent window is far enough BELOW his own season average
   * to matter. There is deliberately no `spiked` flag: a spike was measured and
   * carries no signal.
   */
  collapsed: boolean;
  /** Weeks since his last offensive snap. 0 means he played the latest week. */
  weeksMissed: number;
}

/**
 * A collapse is 15 percentage points below his own season average, which is the
 * threshold the finding was measured at rather than a round number chosen here.
 */
const COLLAPSE_PP = 15;

/** How many at each position finish as startable in a week, in this league. */
const STARTERS: Record<string, number> = { QB: 12, RB: 24, WR: 36, TE: 12 };

/**
 * Builds the live read for every player with weekly data this season.
 *
 * Returns an empty map before the season starts, so every caller can be left
 * unconditional. Same contract as `buildTrajectories`.
 */
export function buildLiveReads(season: number): Map<string, LiveRead> {
  const out = new Map<string, LiveRead>();

  const week = (
    sqlite
      .prepare(
        `SELECT COALESCE(MAX(week), 0) AS w FROM player_stats_week
         WHERE season = ? AND season_type = 'REG'`,
      )
      .get(season) as { w: number }
  ).w;
  if (week === 0) return out;

  /*
   * The startable bar is set by what actually happened that week, not by a
   * fixed points total. A 12-point week is a startable RB in one week and the
   * 30th back in another, and using a constant would make the rate a measure of
   * league-wide scoring rather than of the player.
   */
  const weekly = sqlite
    .prepare(
      `SELECT player_id AS id, week, position, COALESCE(fantasy_points_half, 0) AS pts,
              targets, carries, receptions, target_share AS ts, air_yards_share AS ays, wopr
       FROM player_stats_week
       WHERE season = ? AND season_type = 'REG' AND position IN ('QB','RB','WR','TE')`,
    )
    .all(season) as Array<{
    id: string; week: number; position: string; pts: number;
    targets: number | null; carries: number | null; receptions: number | null;
    ts: number | null; ays: number | null; wopr: number | null;
  }>;

  // Rank within position within week, so "startable" means what it means.
  const cutoff = new Map<string, number>();
  for (const pos of Object.keys(STARTERS)) {
    for (let w = 1; w <= week; w++) {
      const scores = weekly
        .filter((r) => r.position === pos && r.week === w)
        .map((r) => r.pts)
        .sort((a, b) => b - a);
      const n = STARTERS[pos]!;
      if (scores.length >= n) cutoff.set(`${pos}|${w}`, scores[n - 1]!);
    }
  }

  const snaps = sqlite
    .prepare(
      `SELECT player_id AS id, week, offense_pct AS pct FROM snap_counts
       WHERE season = ? AND game_type = 'REG' AND player_id IS NOT NULL
         AND offense_snaps > 0`,
    )
    .all(season) as Array<{ id: string; week: number; pct: number | null }>;

  const snapsBy = new Map<string, Array<{ week: number; pct: number | null }>>();
  for (const s of snaps) {
    const list = snapsBy.get(s.id) ?? [];
    list.push({ week: s.week, pct: s.pct });
    snapsBy.set(s.id, list);
  }

  /*
   * Team rush attempts per week, so a rush share can be computed in season.
   * `player_usage` only carries the finished-season figure and is rebuilt by an
   * ingest, so an in-season page reading it would be a week or more behind.
   */
  const teamRush = new Map<string, number>();
  for (const r of sqlite
    .prepare(
      `SELECT recent_team AS team, week, SUM(COALESCE(carries,0)) AS n
       FROM player_stats_week WHERE season = ? AND season_type = 'REG'
       GROUP BY recent_team, week`,
    )
    .all(season) as Array<{ team: string; week: number; n: number }>) {
    teamRush.set(`${r.team}|${r.week}`, r.n);
  }

  const teamOf = sqlite
    .prepare(
      `SELECT player_id AS id, week, recent_team AS team FROM player_stats_week
       WHERE season = ? AND season_type = 'REG'`,
    )
    .all(season) as Array<{ id: string; week: number; team: string | null }>;
  const teamByWeek = new Map<string, string | null>();
  for (const t of teamOf) teamByWeek.set(`${t.id}|${t.week}`, t.team);

  const byPlayer = new Map<string, typeof weekly>();
  for (const r of weekly) {
    const list = byPlayer.get(r.id) ?? [];
    list.push(r);
    byPlayer.set(r.id, list);
  }

  for (const [id, games] of byPlayer) {
    games.sort((a, b) => a.week - b.week);
    const played = games.length;
    if (played === 0) continue;

    const position = games[games.length - 1]!.position;
    const points = games.reduce((a, g) => a + g.pts, 0);

    let startableWeeks = 0;
    for (const g of games) {
      const bar = cutoff.get(`${g.position}|${g.week}`);
      if (bar !== undefined && g.pts >= bar) startableWeeks++;
    }

    const mean = (vals: Array<number | null | undefined>) => {
      const ok = vals.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
      return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
    };

    const targets = games.reduce((a, g) => a + (g.targets ?? 0), 0);
    const carries = games.reduce((a, g) => a + (g.carries ?? 0), 0);

    // Rush share is computed per week and averaged over weeks he appeared,
    // which is the same convention as `player_usage` (bug #2).
    const rushShares: number[] = [];
    for (const g of games) {
      const team = teamByWeek.get(`${g.id}|${g.week}`);
      const teamCarries = team ? teamRush.get(`${team}|${g.week}`) : undefined;
      if (teamCarries && teamCarries > 0) rushShares.push((g.carries ?? 0) / teamCarries);
    }

    const mySnaps = (snapsBy.get(id) ?? []).sort((a, b) => a.week - b.week);
    const seasonSnap = mean(mySnaps.map((s) => s.pct));
    const recentSnap = mean(mySnaps.slice(-3).map((s) => s.pct));
    const snapDelta =
      seasonSnap !== null && recentSnap !== null ? (recentSnap - seasonSnap) * 100 : null;

    const last3 = games.slice(-3);
    const lastPlayed = mySnaps.length ? mySnaps[mySnaps.length - 1]!.week : games[games.length - 1]!.week;

    out.set(id, {
      playerId: id,
      week,
      gamesPlayed: played,
      points,
      ppg: points / played,
      startableWeeks,
      startableRate: played > 0 ? startableWeeks / played : null,
      /*
       * Receiving metrics are null for a quarterback rather than zero.
       * A QB's target share is 0% by definition and printing it invites the
       * reader to compare it with a receiver's 24% — family #1 wearing a
       * percentage. Same for WOPR, which is built from target and air-yards
       * share and is structurally zero for him.
       */
      targetShare: position === 'QB' ? null : mean(games.map((g) => g.ts)),
      rushShare: rushShares.length ? rushShares.reduce((a, b) => a + b, 0) / rushShares.length : null,
      snapPct: seasonSnap,
      wopr: position === 'QB' ? null : mean(games.map((g) => g.wopr)),
      opportunitiesPerGame: (targets + carries) / played,
      targetsPerGame: position === 'QB' ? null : targets / played,
      carriesPerGame: carries / played,
      last3Ppg: last3.length ? last3.reduce((a, g) => a + g.pts, 0) / last3.length : null,
      last3SnapPct: recentSnap,
      snapDelta,
      // Only a fall counts. A spike was measured and carries no signal.
      collapsed: snapDelta !== null && snapDelta <= -COLLAPSE_PP,
      weeksMissed: Math.max(0, week - lastPlayed),
    });
  }

  return out;
}

/** Position pools of the live figures, for ranking one player against his own. */
export function liveePools(reads: Map<string, LiveRead>, positionOf: Map<string, string>) {
  const pools = new Map<string, { ppg: number[]; opp: number[]; snap: number[]; startable: number[] }>();
  for (const [id, r] of reads) {
    const pos = positionOf.get(id);
    if (!pos) continue;
    const p = pools.get(pos) ?? { ppg: [], opp: [], snap: [], startable: [] };
    p.ppg.push(r.ppg);
    if (r.opportunitiesPerGame !== null) p.opp.push(r.opportunitiesPerGame);
    if (r.snapPct !== null) p.snap.push(r.snapPct);
    if (r.startableRate !== null) p.startable.push(r.startableRate);
    pools.set(pos, p);
  }
  return pools;
}

export { STARTERS as WEEKLY_STARTERS, REPLACEMENT_RANK };
