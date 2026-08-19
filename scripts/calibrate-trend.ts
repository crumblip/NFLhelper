import { sqlite } from '../lib/db/index';
import { buildCoverageProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

/**
 * Does direction of travel matter, on top of where a player currently is?
 *
 * A single-season snapshot cannot separate a 24-year-old climbing from a
 * 37-year-old fading — both can post the same shares. This measures whether
 * year-over-year change and age add anything beyond the level itself, so the
 * answer comes from the data rather than from intuition about ageing.
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
    `SELECT u.player_id, u.season, u.position, u.games,
            u.target_share, u.pass_snap_share, u.rush_share,
            u.rz_touch_share, u.goal_line_share, u.rz_targets, u.total_tds,
            p.birth_date
     FROM player_usage u LEFT JOIN players p ON p.gsis_id = u.player_id
     WHERE u.games >= 6`,
  )
  .all() as Array<Record<string, number | string | null>>;

const byKey = new Map<string, Record<string, number | string | null>>();
for (const u of usage) byKey.set(`${u.player_id}|${u.season}`, u);

function ageAt(birth: string | null, season: number): number | null {
  if (!birth) return null;
  const y = Number(String(birth).slice(0, 4));
  return Number.isFinite(y) ? season - y : null;
}

/** Pearson correlation. */
function corr(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 15) return NaN;
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

/**
 * The key test: within players at a similar current level, does the direction
 * they arrived from tell you anything about next season?
 *
 * Correlating change against next-season points on its own would just re-measure
 * level, since a player who improved is usually also good. So next-season points
 * are first residualised on the current level, and the change is correlated
 * against what is left over.
 */
const KEYS = ['target_share', 'rz_touch_share', 'pass_snap_share', 'rush_share'] as const;

console.log('does year-over-year change predict, after accounting for current level?\n');

for (const pos of ['WR', 'RB', 'TE']) {
  console.log(`  ${pos}`);
  console.log('    metric                 n    r(level)   r(change, level removed)');

  for (const k of KEYS) {
    const rows: Array<{ level: number; change: number; next: number }> = [];
    for (const u of usage) {
      if (String(u.position).toUpperCase() !== pos) continue;
      const season = Number(u.season);
      const prev = byKey.get(`${u.player_id}|${season - 1}`);
      const next = points.get(`${u.player_id}|${season + 1}`);
      const cur = u[k];
      const before = prev?.[k];
      if (next === undefined) continue;
      if (typeof cur !== 'number' || typeof before !== 'number') continue;
      rows.push({ level: cur, change: cur - before, next });
    }
    if (rows.length < 20) continue;

    const rLevel = corr(rows.map((r) => [r.level, r.next] as [number, number]));

    // Residualise next-season points on level, then correlate the change.
    const mx = rows.reduce((a, r) => a + r.level, 0) / rows.length;
    const my = rows.reduce((a, r) => a + r.next, 0) / rows.length;
    let sxy = 0, sxx = 0;
    for (const r of rows) {
      sxy += (r.level - mx) * (r.next - my);
      sxx += (r.level - mx) ** 2;
    }
    const slope = sxx ? sxy / sxx : 0;
    const resid = rows.map(
      (r) => [r.change, r.next - (my + slope * (r.level - mx))] as [number, number],
    );
    const rChange = corr(resid);

    console.log(
      `    ${k.padEnd(20)} ${String(rows.length).padStart(4)}   ${rLevel.toFixed(3).padStart(8)}   ` +
        `${rChange.toFixed(3).padStart(12)}`,
    );
  }

  // Age, same treatment: does it say anything once the current role is known?
  const ageRows: Array<{ level: number; age: number; next: number }> = [];
  for (const u of usage) {
    if (String(u.position).toUpperCase() !== pos) continue;
    const season = Number(u.season);
    const next = points.get(`${u.player_id}|${season + 1}`);
    const age = ageAt(u.birth_date as string | null, season);
    const level = u.target_share ?? u.rush_share;
    if (next === undefined || age === null || typeof level !== 'number') continue;
    ageRows.push({ level, age, next });
  }
  if (ageRows.length >= 20) {
    const mx = ageRows.reduce((a, r) => a + r.level, 0) / ageRows.length;
    const my = ageRows.reduce((a, r) => a + r.next, 0) / ageRows.length;
    let sxy = 0, sxx = 0;
    for (const r of ageRows) {
      sxy += (r.level - mx) * (r.next - my);
      sxx += (r.level - mx) ** 2;
    }
    const slope = sxx ? sxy / sxx : 0;
    const resid = ageRows.map(
      (r) => [r.age, r.next - (my + slope * (r.level - mx))] as [number, number],
    );
    console.log(
      `    ${'age'.padEnd(20)} ${String(ageRows.length).padStart(4)}   ${'   -'.padStart(8)}   ` +
        `${corr(resid).toFixed(3).padStart(12)}`,
    );
  }
  console.log();
}

console.log('r(change, level removed) is the number that matters. Positive means a');
console.log('player trending up beats one at the same level trending down. Negative');
console.log('age means older players fade relative to their current role.');
