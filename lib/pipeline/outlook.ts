import { sqlite } from '../db/index';
import { ComparableIndex, archetype, type ProfileFeatures, type Outlook } from './comparables';
import { buildCoverageProfile, maskStatLine } from './coverage';
import { rulesFor, scoreStatLine, type StatLine } from './scoring';
import { resolveUsageSeason } from './usage-grade';

/**
 * Build the comparables read for every player who has a measured role.
 *
 * Shared between the build script and anything that reads it, on the same rule
 * as `lib/waiver.ts`: the logic lives here so `npm run build:outlook` and the
 * pages cannot drift apart.
 *
 * Two things this deliberately does NOT do:
 *
 * It does not start from the board. The board is `value_scores JOIN adp_raw`,
 * which is the ~180 players FantasyFootballCalculator prices — so building from
 * it left every undrafted player without an outlook, and undrafted players are
 * the entire waiver wire.
 *
 * It does not assume the offseason. When the season is live the profile is this
 * season's usage, not last season's, so a player who has changed role since
 * September is compared on the role he actually holds. Shares support that from
 * a small sample: a four-game rush share predicts the next season's at r=0.919,
 * and `calibrate:shrinkage` measured the best shrinkage constant at 0 for rush
 * share. Points per game is noisier over four games than a share is, which is
 * why `profileGames` is recorded and shown rather than hidden.
 */

/** Below this the sample behind the profile is too thin to describe a role. */
const MIN_PROFILE_GAMES = 4;

export interface PlayerOutlook {
  playerId: string;
  name: string;
  position: string;
  profileSeason: number;
  profileGames: number;
  features: ProfileFeatures;
  outlook: Outlook;
  archetype: string;
}

export interface OutlookBuild {
  season: number;
  live: boolean;
  week: number;
  profileSeason: number;
  rows: PlayerOutlook[];
  /** Players with a usage row who were skipped, and why. */
  skipped: Array<{ name: string; reason: string }>;
}

export function buildOutlooks(format: string, teams: number, season: number): OutlookBuild {
  const { live, usageSeason, week } = resolveUsageSeason(season);

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
   * Appearances from snap counts, matching how the historical pool is built.
   * Taking the profile's game count from `player_usage.games` and the pool's
   * from `snap_counts` would put the two on different definitions of a game —
   * the same mismatch as bug #40, one step upstream.
   */
  const appearances = new Map<string, number>();
  for (const r of sqlite
    .prepare(
      `SELECT player_id, season, COUNT(DISTINCT week) g FROM snap_counts
       WHERE game_type = 'REG' AND player_id IS NOT NULL AND offense_snaps > 0
       GROUP BY player_id, season`,
    )
    .all() as Array<{ player_id: string; season: number; g: number }>) {
    appearances.set(`${r.player_id}|${r.season}`, r.g);
  }

  /*
   * A player with NO snap rows at all falls back to weeks with a stat line.
   *
   * `?? 0` was reading "we have no snap data for this man" as "he did not
   * play", and then the games floor dropped him. **Chase Brown, ADP 15, 17
   * games and a 61% rush share, had no outlook at all** — nflverse's 2025 snap
   * counts carry two rows for the entire Cincinnati backfield while listing 23
   * for their quarterbacks and 82 for their receivers, so the gap is upstream
   * and nothing we can fix at the source.
   *
   * This does NOT reintroduce bug #40. That bug was about preferring the better
   * source: `player_usage.games` counts games with a stat line, so a healthy
   * backup who caught one pass looks like an injured starter, and snap
   * appearances are the honest measure of turning up. That argument still
   * holds and snap counts still win wherever they exist. It says nothing about
   * what to do when the source is *absent*, and treating absence as a measured
   * zero is family #6 — a missing reading rendered as a finding.
   *
   * Only whole-season absence falls back. A player with 3 snap rows genuinely
   * played 3 games, and taking the larger of the two numbers would quietly
   * restore #40 for everyone.
   */
  const statLineWeeks = sqlite
    .prepare(
      `SELECT player_id, season, COUNT(DISTINCT week) g FROM player_stats_week
       WHERE season_type = 'REG' GROUP BY player_id, season`,
    )
    .all() as Array<{ player_id: string; season: number; g: number }>;
  let recovered = 0;
  for (const r of statLineWeeks) {
    const key = `${r.player_id}|${r.season}`;
    if (appearances.has(key)) continue;
    appearances.set(key, r.g);
    recovered++;
  }
  void recovered;

  const weeksPlayed = (
    sqlite
      .prepare(
        `SELECT COALESCE(MAX(week), 17) w FROM player_stats_week
         WHERE season = ? AND season_type = 'REG'`,
      )
      .get(usageSeason) as { w: number }
  ).w;

  const index = new ComparableIndex(points, season, format, teams);

  /*
   * Every player with a role in the profile season, whatever the market thinks
   * of him. `players` is joined for the name and birth date only.
   */
  const candidates = sqlite
    .prepare(
      `SELECT u.player_id AS playerId, p.display_name AS name, u.position,
              COALESCE(u.target_share, 0) AS targetShare,
              COALESCE(u.pass_snap_share, 0) AS routeShare,
              COALESCE(u.rz_touch_share, 0) AS rzShare,
              COALESCE(u.goal_line_share, 0) AS goalLineShare,
              COALESCE(u.rush_share, 0) AS rushShare,
              u.adot,
              ? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age
       FROM player_usage u
       JOIN players p ON p.gsis_id = u.player_id
       WHERE u.season = ? AND u.position IN ('QB','WR','RB','TE')`,
    )
    .all(season, usageSeason) as Array<{
    playerId: string;
    name: string;
    position: string;
    targetShare: number;
    routeShare: number;
    rzShare: number;
    goalLineShare: number;
    rushShare: number;
    adot: number | null;
    age: number | null;
  }>;

  const rows: PlayerOutlook[] = [];
  const skipped: OutlookBuild['skipped'] = [];

  for (const c of candidates) {
    if (c.age === null || !Number.isFinite(c.age)) {
      skipped.push({ name: c.name, reason: 'no birth date' });
      continue;
    }

    const games = appearances.get(`${c.playerId}|${usageSeason}`) ?? 0;
    if (games < MIN_PROFILE_GAMES) {
      skipped.push({ name: c.name, reason: `only ${games} games in ${usageSeason}` });
      continue;
    }

    const scored = points.get(`${c.playerId}|${usageSeason}`) ?? 0;

    const features: ProfileFeatures = {
      targetShare: c.targetShare,
      routeShare: c.routeShare,
      rzShare: c.rzShare,
      goalLineShare: c.goalLineShare,
      rushShare: c.rushShare,
      age: c.age,
      ppg: scored / games,
      /*
       * Availability is measured against the games the season has actually
       * played, not a fixed 17. Mid-season a player who has started every week
       * is fully available; dividing by 17 in week 5 would rate the whole league
       * as chronically injured and match them all to broken seasons — the same
       * error as bug #17, one metric over.
       */
      availability: Math.min(1, games / Math.max(1, weeksPlayed)),
    };

    const o = index.outlook(c.position, features, c.playerId);
    if (!o) {
      skipped.push({ name: c.name, reason: `no ${c.position} pool` });
      continue;
    }

    rows.push({
      playerId: c.playerId,
      name: c.name,
      position: c.position,
      profileSeason: usageSeason,
      profileGames: games,
      features,
      outlook: o,
      archetype: archetype(c.position, features, c.adot),
    });
  }

  return { season, live, week, profileSeason: usageSeason, rows, skipped };
}
