import { sqlite } from '../db/index';
import { buildCoverageProfile, maskStatLine } from './coverage';
import { rulesFor, scoreStatLine, type StatLine } from './scoring';

/**
 * What a rookie's situation is worth, measured rather than assumed.
 *
 * A rookie has no usage history, so the market-only pipeline falls back to a
 * positional average that treats a top-five pick starting on day one exactly
 * like a third-round receiver buried at WR4. Draft capital fixes most of that
 * and is not an opinion — it is what a team actually paid.
 *
 * Calibrated the same way as the ADP baseline: bucket historical rookies by
 * draft slot and measure what they really produced. Buckets rather than a
 * smooth fit because the per-position samples are small (14 top-15 WRs across
 * eight seasons) and a curve would imply precision that is not there.
 */

export interface DraftBucket {
  label: string;
  lo: number;
  hi: number;
}

export const DRAFT_BUCKETS: DraftBucket[] = [
  { label: 'top 15', lo: 1, hi: 16 },
  { label: 'rd 1 (16-32)', lo: 16, hi: 33 },
  { label: 'rd 2', lo: 33, hi: 65 },
  { label: 'rd 3', lo: 65, hi: 101 },
  { label: 'rd 4', lo: 101, hi: 140 },
  { label: 'rd 5-7', lo: 140, hi: 300 },
  { label: 'undrafted', lo: 300, hi: 10_000 },
];

export interface RookieBaseline {
  position: string;
  bucket: string;
  n: number;
  meanVorp: number;
  medianPoints: number;
  hitRate: number;
}

export function bucketFor(pick: number | null): DraftBucket {
  const p = pick ?? 999;
  return DRAFT_BUCKETS.find((b) => p >= b.lo && p < b.hi) ?? DRAFT_BUCKETS[DRAFT_BUCKETS.length - 1]!;
}

/** Historical rookie-season outcomes by position and draft bucket. */
export function calibrateRookieBaseline(
  format: string,
  teams: number,
  currentSeason: number,
): RookieBaseline[] {
  const profile = buildCoverageProfile(format, teams, currentSeason);
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

  const scored = new Map<string, number>();
  for (const r of totals) {
    const pos = (r.position ?? '').toUpperCase();
    const cats = profile.get(pos);
    scored.set(`${r.player_id}|${r.season}`, scoreStatLine(cats ? maskStatLine(r, cats) : r, rules));
  }

  const repl = new Map<string, number>();
  for (const r of sqlite
    .prepare(`SELECT season, position, points FROM replacement_level WHERE format=? AND teams=?`)
    .all(format, teams) as Array<{ season: number; position: string; points: number }>) {
    repl.set(`${r.season}|${r.position}`, r.points);
  }

  const picks = sqlite
    .prepare(
      `SELECT season, pick, player_id, position FROM draft_picks
       WHERE player_id IS NOT NULL AND season < ? AND position IN ('QB','RB','WR','TE')`,
    )
    .all(currentSeason) as Array<{
    season: number; pick: number; player_id: string; position: string;
  }>;

  const out: RookieBaseline[] = [];
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    for (const b of DRAFT_BUCKETS) {
      const group = picks
        .filter((p) => p.position === position && p.pick >= b.lo && p.pick < b.hi)
        .map((p) => {
          const pts = scored.get(`${p.player_id}|${p.season}`) ?? 0;
          return { pts, vorp: pts - (repl.get(`${p.season}|${position}`) ?? 0) };
        });
      if (group.length < 4) continue;

      const pts = group.map((g) => g.pts).sort((a, b2) => a - b2);
      out.push({
        position,
        bucket: b.label,
        n: group.length,
        meanVorp: group.reduce((a, g) => a + g.vorp, 0) / group.length,
        medianPoints: pts[Math.floor(pts.length / 2)]!,
        hitRate: group.filter((g) => g.vorp > 0).length / group.length,
      });
    }
  }
  return out;
}

export interface RookieSituation {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  adp: number;
  round: number | null;
  pick: number | null;
  depthRank: number | null;
  bucket: string;
  /** Historical mean VORP for this position and draft bucket. */
  baselineVorp: number | null;
  baselineHitRate: number | null;
  baselineN: number | null;
  baseline: RookieBaseline | undefined;
}

/**
 * A points projection for a player with no NFL usage to model.
 *
 * The base is empirical: what players at this position and draft slot actually
 * produced as rookies, taken as the median rather than the mean so one Bijan
 * Robinson does not lift a whole bucket.
 *
 * The depth-chart multiplier is a judgment call and is flagged as such — no
 * historical depth charts exist in nflverse to calibrate it against, so it is
 * set from the plain logic that a back listed third gets a fraction of the work
 * of one listed first. Vacated opportunity nudges it, since volume that has
 * left the roster has to go somewhere.
 */
const DEPTH_MULTIPLIER = [1.0, 0.72, 0.5, 0.35];

export function projectRookie(
  baseline: RookieBaseline | undefined,
  depthRank: number | null,
  vacatedShare: number,
): { points: number; basis: string } | null {
  if (!baseline) return null;

  const depth = depthRank === null ? 2 : Math.max(1, Math.min(4, depthRank));
  const depthFactor = DEPTH_MULTIPLIER[depth - 1]!;

  // Vacated volume raises the ceiling but cannot manufacture a role on its own,
  // so it is capped at a quarter above the base.
  const opportunityFactor = 1 + Math.min(0.25, vacatedShare * 0.5);

  const points = Math.max(0, baseline.medianPoints * depthFactor * opportunityFactor);
  return {
    points,
    basis:
      `${baseline.bucket} ${baseline.position} median ${baseline.medianPoints.toFixed(0)} pts ` +
      `(${(baseline.hitRate * 100).toFixed(0)}% hit rate, n=${baseline.n}) ` +
      `× depth ${depth} × opportunity`,
  };
}

/** Board rookies with their situation attached. */
export function getRookieSituations(
  format: string,
  teams: number,
  season: number,
): RookieSituation[] {
  const baselines = calibrateRookieBaseline(format, teams, season);
  const key = (pos: string, bucket: string) => `${pos}|${bucket}`;
  const lookup = new Map(baselines.map((b) => [key(b.position, b.bucket), b]));

  const rows = sqlite
    .prepare(
      `SELECT a.player_id AS playerId, a.name, a.position, a.team, a.adp,
              d.round, d.pick,
              (SELECT MIN(dc.pos_rank) FROM depth_chart dc
               WHERE dc.player_id = a.player_id AND dc.season = ?
                 AND dc.pos_abb = a.position) AS depthRank
       FROM adp_raw a
       LEFT JOIN draft_picks d ON d.player_id = a.player_id AND d.season = ?
       WHERE a.year = ? AND a.format = ? AND a.teams = ?
         AND a.player_id IS NOT NULL
         AND (SELECT COUNT(*) FROM player_stats_week s
              WHERE s.player_id = a.player_id AND s.season_type = 'REG') = 0
       ORDER BY a.adp`,
    )
    .all(season, season, season, format, teams) as Array<{
    playerId: string; name: string; position: string; team: string | null;
    adp: number; round: number | null; pick: number | null; depthRank: number | null;
  }>;

  return rows.map((r) => {
    const b = bucketFor(r.pick);
    const base = lookup.get(key(r.position.toUpperCase(), b.label));
    return {
      ...r,
      bucket: b.label,
      baselineVorp: base?.meanVorp ?? null,
      baselineHitRate: base?.hitRate ?? null,
      baselineN: base?.n ?? null,
      baseline: base,
    };
  });
}
