import { sqlite } from '../db/index';

/**
 * In-season role change, measured rather than assumed.
 *
 * The standard waiver instinct is to chase a snap-share spike: the backup who
 * played 70% last week after a month at 25% is the classic add. Tested across
 * 2018-2025 (`scripts/calibrate-recency.ts`), that instinct does not survive.
 *
 * Players whose last-three-game snap share sat 15 points or more ABOVE their
 * season-to-date average went on to score 6.77 points per game for the rest of
 * the season — against 6.84 for players whose role was flat. No edge at all, and
 * their rest-of-season correlation collapses to 0.25, the weakest of any group.
 * A snap spike is usually somebody else's one-week absence, and it reverts.
 *
 * The mirror image is real. Players whose recent snap share sat 15 points or
 * more BELOW their season average scored 5.62 — a genuine loss of 1.23 points
 * per game — and for them the recent window predicts better than the season
 * average (0.461 against 0.441), because the demotion is the true state and the
 * early-season weeks are stale.
 *
 * So this module reports a collapse and deliberately does not report a spike.
 * Surfacing both would be symmetric and wrong.
 */

/** Snap-share swing, in percentage points, that counts as a real change. */
export const COLLAPSE_THRESHOLD = 15;

/** Games in the recent window, matching the window the calibration used. */
const RECENT_WINDOW = 3;

/** Rest-of-season points per game lost by a collapsed role, from calibration. */
export const COLLAPSE_COST_PPG = 1.23;

export interface Trajectory {
  playerId: string;
  gamesPlayed: number;
  seasonSnapPct: number | null;
  recentSnapPct: number | null;
  /** Recent minus season-to-date, in percentage points. */
  snapDelta: number | null;
  /** Recent share fell far enough below the season average to matter. */
  collapsed: boolean;
  /** Weeks since he last recorded an offensive snap; 0 if he played the latest week. */
  weeksMissed: number;
  seasonOpportunityPerGame: number | null;
  recentOpportunityPerGame: number | null;
}

/**
 * Builds in-season trajectories for every player with weekly data this season.
 *
 * Returns an empty map before the season starts, which is what makes the caller
 * safe to leave unconditional.
 */
export function buildTrajectories(season: number): Map<string, Trajectory> {
  const out = new Map<string, Trajectory>();

  const latestWeek = (
    sqlite
      .prepare(
        `SELECT COALESCE(MAX(week), 0) AS w FROM player_stats_week
         WHERE season = ? AND season_type = 'REG'`,
      )
      .get(season) as { w: number }
  ).w;

  if (latestWeek === 0) return out;

  const rows = sqlite
    .prepare(
      `SELECT s.player_id, s.week,
              COALESCE(s.targets, 0) + COALESCE(s.carries, 0) AS opportunity,
              -- nflverse ships snap share as a 0-1 fraction.
              sc.offense_pct * 100 AS snapPct
       FROM player_stats_week s
       LEFT JOIN snap_counts sc
         ON sc.player_id = s.player_id AND sc.season = s.season AND sc.week = s.week
       WHERE s.season = ? AND s.season_type = 'REG'
       ORDER BY s.player_id, s.week`,
    )
    .all(season) as Array<{
    player_id: string; week: number; opportunity: number; snapPct: number | null;
  }>;

  const byPlayer = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byPlayer.get(r.player_id) ?? [];
    list.push(r);
    byPlayer.set(r.player_id, list);
  }

  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

  for (const [playerId, weeks] of byPlayer) {
    weeks.sort((a, b) => a.week - b.week);
    const recent = weeks.slice(-RECENT_WINDOW);

    const seasonSnaps = weeks.map((w) => w.snapPct).filter((v): v is number => v !== null);
    const recentSnaps = recent.map((w) => w.snapPct).filter((v): v is number => v !== null);

    const seasonSnapPct = mean(seasonSnaps);
    const recentSnapPct = mean(recentSnaps);
    const snapDelta =
      seasonSnapPct !== null && recentSnapPct !== null ? recentSnapPct - seasonSnapPct : null;

    const lastPlayed = weeks[weeks.length - 1]!.week;

    out.set(playerId, {
      playerId,
      gamesPlayed: weeks.length,
      seasonSnapPct,
      recentSnapPct,
      snapDelta,
      // A collapse needs a real sample behind it — two games cannot establish a
      // season average to fall away from.
      collapsed: snapDelta !== null && snapDelta <= -COLLAPSE_THRESHOLD && weeks.length >= 4,
      weeksMissed: Math.max(0, latestWeek - lastPlayed),
      seasonOpportunityPerGame: mean(weeks.map((w) => w.opportunity)),
      recentOpportunityPerGame: mean(recent.map((w) => w.opportunity)),
    });
  }

  return out;
}

/** Plain-language notes for the in-season state of a player's role. */
export function trajectoryNotes(t: Trajectory | undefined | null): string[] {
  if (!t) return [];
  const notes: string[] = [];

  if (t.collapsed && t.snapDelta !== null) {
    notes.push(
      `role shrinking, snap share down ${Math.abs(Math.round(t.snapDelta))} points over the last ` +
        `${RECENT_WINDOW} games`,
    );
  }

  if (t.weeksMissed === 1) notes.push('did not play last week');
  else if (t.weeksMissed > 1) notes.push(`has not played in ${t.weeksMissed} weeks`);

  return notes;
}
