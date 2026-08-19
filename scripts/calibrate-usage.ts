import { sqlite } from '../lib/db/index';
import { buildCoverageProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

/**
 * Which advanced stats actually predict next season?
 *
 * The premise behind adding them is that usage carries forward. This tests it:
 * correlate each season-t metric against season-t+1 points, per position, and
 * let the numbers decide the weights rather than assigning them by feel.
 *
 * Anything that does not predict does not get a weight, however fashionable.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const profile = buildCoverageProfile(FORMAT, TEAMS, CURRENT);
const rules = rulesFor(FORMAT);

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

const usage = sqlite
  .prepare(
    `SELECT player_id, season, position, games, pass_snap_share, target_share,
            air_yards_share, targets_per_route, adot, yac_per_reception,
            rush_share, yards_before_contact, yards_after_contact, broken_tackles,
            rz_carries, rz_targets, rz_touch_share, goal_line_carries,
            goal_line_targets, goal_line_share, rz_tds, total_tds
     FROM player_usage WHERE games >= 6`,
  )
  .all() as Array<Record<string, number | string | null>>;

const METRICS = [
  'pass_snap_share', 'target_share', 'air_yards_share', 'targets_per_route',
  'adot', 'yac_per_reception', 'rush_share', 'yards_before_contact',
  'yards_after_contact', 'broken_tackles',
  // Scoring opportunity. Chances are a coaching tendency and should persist;
  // the touchdowns themselves are far noisier and are included to show the
  // difference rather than because they are expected to predict.
  'rz_carries', 'rz_targets', 'rz_touch_share',
  'goal_line_carries', 'goal_line_targets', 'goal_line_share',
  'rz_tds', 'total_tds',
] as const;

/** Pearson correlation. */
function corr(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 12) return NaN;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

console.log('correlation of season-t usage with season t+1 points\n');
console.log('  (positive and large = the metric carries forward and deserves weight)\n');

for (const pos of ['WR', 'RB', 'TE']) {
  const rows = usage.filter((u) => String(u.position).toUpperCase() === pos);
  console.log(`  ${pos}`);
  console.log('    metric                    n    r(next yr)   r(same yr)');

  for (const m of METRICS) {
    const next: Array<[number, number]> = [];
    const same: Array<[number, number]> = [];
    for (const u of rows) {
      const v = u[m];
      if (v === null || typeof v !== 'number' || !Number.isFinite(v)) continue;
      const id = String(u.player_id);
      const season = Number(u.season);
      const nextPts = points.get(`${id}|${season + 1}`);
      const samePts = points.get(`${id}|${season}`);
      if (nextPts !== undefined) next.push([v, nextPts]);
      if (samePts !== undefined) same.push([v, samePts]);
    }
    const rn = corr(next);
    const rs = corr(same);
    if (Number.isNaN(rn) && Number.isNaN(rs)) continue;
    console.log(
      `    ${m.padEnd(24)} ${String(next.length).padStart(4)}   ` +
        `${(Number.isNaN(rn) ? '  -' : rn.toFixed(3)).padStart(9)}   ` +
        `${(Number.isNaN(rs) ? '  -' : rs.toFixed(3)).padStart(9)}`,
    );
  }

  // Baseline for comparison: how well does this season's points predict next?
  const ptsPairs: Array<[number, number]> = [];
  for (const u of rows) {
    const id = String(u.player_id);
    const season = Number(u.season);
    const a = points.get(`${id}|${season}`);
    const b = points.get(`${id}|${season + 1}`);
    if (a !== undefined && b !== undefined) ptsPairs.push([a, b]);
  }
  console.log(
    `    ${'(prior-season points)'.padEnd(24)} ${String(ptsPairs.length).padStart(4)}   ` +
      `${corr(ptsPairs).toFixed(3).padStart(9)}   ${'    1.000'}`,
  );
  console.log();
}

console.log('r(same yr) shows how much a metric describes the season it came from.');
console.log('r(next yr) is the one that matters for a forward projection — a metric');
console.log('that only explains the past is descriptive, not predictive.');
