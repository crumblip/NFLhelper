import { sqlite } from '../lib/db/index';
import { fitUsageModels, projectUsage, resolveUsageSeason } from '../lib/pipeline/usage-grade';
import { currentSeasonWeight } from '../lib/pipeline/blend';
import { buildCoverageProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

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

const fits = fitUsageModels(points);

/*
 * Persist the fit quality. The blend needs R to undo the model's compression;
 * recomputing it there would mean fitting twice and risking the two copies
 * disagreeing about which model is live.
 */
{
  const stmt = sqlite.prepare(
    `INSERT INTO usage_model_fit (format, teams, season, position, r2, n, computed_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(format, teams, season, position) DO UPDATE SET
       r2 = excluded.r2, n = excluded.n, computed_at = excluded.computed_at`,
  );
  const now = Date.now();
  sqlite.transaction(() => {
    for (const f of fits) stmt.run(FORMAT, TEAMS, CURRENT, f.position, f.r2, f.n, now);
  })();
}
console.log('usage models — next-season points fitted on this-season opportunity\n');
for (const f of fits) {
  console.log(`  ${f.position}  n=${f.n}  R²=${f.r2.toFixed(3)}`);
  // Standardized weights are comparable to each other: how many points a
  // one-standard-deviation move in that metric is worth.
  const ranked = f.predictors
    .map((p, i) => ({ label: p.label, w: f.standardized[i]! }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  for (const r of ranked) {
    console.log(`      ${r.label.padEnd(16)} ${r.w >= 0 ? '+' : ''}${r.w.toFixed(1)} pts per SD`);
  }
  console.log();
}

/*
 * In-season the usage side must follow the season being played.
 *
 * This previously read `CURRENT - 1` unconditionally, so in week ten the board
 * was still describing last year's roles — while `build-blend` printed a line
 * claiming this season carried 87% of the usage signal. The weighting curve was
 * calibrated and the helper written; nothing ever called it.
 */
const { live, usageSeason, week } = resolveUsageSeason(CURRENT);
const projections = projectUsage(fits, usageSeason, 3, live ? CURRENT : null);
console.log(
  `projected ${projections.length} players from ${usageSeason} usage` +
    (live
      ? ` — week ${week}, this season carries ${(currentSeasonWeight(week) * 100).toFixed(0)}% of it\n`
      : ' (preseason)\n'),
);

// Compare the usage view with the market view on the current board.
const board = sqlite
  .prepare(
    `SELECT v.player_id, a.name, v.position, v.adp, v.implied_points AS market,
            v.signal, v.slot_gap AS gap
     FROM value_scores v JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
      AND a.format = v.format AND a.teams = v.teams
     WHERE v.format = ? AND v.teams = ? AND v.season = ?`,
  )
  .all(FORMAT, TEAMS, CURRENT) as Array<{
  player_id: string; name: string; position: string; adp: number;
  market: number | null; signal: string; gap: number | null;
}>;

/*
 * The two views are compared as within-position percentiles, not as raw points.
 *
 * The usage model has R² near 0.53, so its fitted totals regress hard toward
 * the positional mean — an elite receiver comes out well under what he will
 * really score. Subtracting that from the market's number would mostly measure
 * distance from average and would label every star "market too bullish".
 * Ranking each view inside its own position removes the scale problem and
 * leaves the actual disagreement.
 */
const byId = new Map(projections.map((p) => [p.playerId, p]));

/*
 * The usage grade is computed for every player with usage history, whatever the
 * market covers.
 *
 * It used to be gated on a complete market projection, which was backwards —
 * on-field usage has nothing to do with whether a sportsbook posts a line. The
 * effect was that Omarion Hampton, a first-round back with a 43% goal-line
 * share, showed a blank usage grade purely because Underdog does not price his
 * receiving. Six of the thirteen backs around his ADP were blank for the same
 * reason, which hollowed out the position that matters most here.
 */
const graded = board.filter((b) => byId.has(b.player_id));

// The market-versus-usage gap still needs both views measured on the same
// population, so that comparison keeps the stricter filter.
const eligible = graded.filter((b) => b.signal === 'full' && b.market !== null);

/*
 * Both percentiles must come from the same population. The stored usage grade
 * is ranked across every projected player in the league, while the market view
 * exists only for the board's fully-covered players — who are mostly good.
 * Mixing the two made usage look ahead of the market for almost everyone.
 */
const pct = (values: Array<[string, number]>) => {
  const sorted = [...values].sort((a, b) => a[1] - b[1]);
  const out = new Map<string, number>();
  sorted.forEach(([id], i) =>
    out.set(id, sorted.length > 1 ? Math.round((i / (sorted.length - 1)) * 100) : 50),
  );
  return out;
};

const marketPct = new Map<string, number>();
const usagePct = new Map<string, number>();
// Standalone usage grade, ranked across everyone on the board with usage data.
const usageGradeAll = new Map<string, number>();

// Quarterbacks were absent from this loop, so even once the model existed no QB
// ever received a stored grade — the whole position stayed blank on the board.
for (const position of ['QB', 'WR', 'RB', 'TE']) {
  const all = graded.filter((b) => b.position === position);
  if (all.length) {
    for (const [id, v] of pct(all.map((b) => [b.player_id, byId.get(b.player_id)!.points]))) {
      usageGradeAll.set(id, v);
    }
  }
  const group = eligible.filter((b) => b.position === position);
  if (!group.length) continue;
  for (const [id, v] of pct(group.map((b) => [b.player_id, b.market!]))) marketPct.set(id, v);
  for (const [id, v] of pct(group.map((b) => [b.player_id, byId.get(b.player_id)!.points])))
    usagePct.set(id, v);
}

const rows = eligible
  .filter((b) => marketPct.has(b.player_id) && usagePct.has(b.player_id))
  .map((b) => {
    const mp = marketPct.get(b.player_id)!;
    const up = usagePct.get(b.player_id)!;
    return { ...b, grade: up, marketPct: mp, diff: up - mp };
  });

const show = (title: string, list: typeof rows) => {
  console.log(`\n${title}`);
  console.log('    ADP  pos  player                market %ile  usage %ile   gap');
  for (const r of list) {
    console.log(
      `  ${String(r.adp).padStart(5)}  ${r.position.padEnd(3)}  ${r.name.padEnd(21)}` +
        `${String(r.marketPct).padStart(10)}  ${String(r.grade).padStart(10)}   ` +
        `${(r.diff > 0 ? '+' : '') + r.diff}`,
    );
  }
};

show(
  'USAGE AHEAD OF MARKET — on-field role the props have not priced',
  [...rows].sort((a, b) => b.diff - a.diff).slice(0, 12),
);
show(
  'MARKET AHEAD OF USAGE — priced for a role he has not held',
  [...rows].sort((a, b) => a.diff - b.diff).slice(0, 12),
);

const agree = rows.filter((r) => Math.abs(r.diff) <= 15).length;
console.log(
  `\n${rows.length} players have both views; ${agree} agree within 15 percentile points ` +
    `(${Math.round((agree / rows.length) * 100)}%)`,
);

// Persist onto the board. Written after build:values, which owns the row.
const update = sqlite.prepare(
  `UPDATE value_scores
   SET usage_grade = ?, usage_points = ?, market_pct = ?, usage_gap = ?, usage_inputs = ?
   WHERE player_id = ? AND format = ? AND teams = ? AND season = ?`,
);
sqlite.transaction(() => {
  // Clear first so a player who loses his usage row does not keep a stale grade.
  sqlite
    .prepare(
      `UPDATE value_scores SET usage_grade = NULL, usage_points = NULL,
       market_pct = NULL, usage_gap = NULL, usage_inputs = NULL
       WHERE format = ? AND teams = ? AND season = ?`,
    )
    .run(FORMAT, TEAMS, CURRENT);

  // Everyone with usage history gets a grade and a usage projection.
  for (const b of graded) {
    update.run(
      usageGradeAll.get(b.player_id) ?? null,
      byId.get(b.player_id)!.points,
      marketPct.get(b.player_id) ?? null,
      // The gap only exists where both views were measured together.
      usagePct.has(b.player_id) && marketPct.has(b.player_id)
        ? usagePct.get(b.player_id)! - marketPct.get(b.player_id)!
        : null,
      // Each predictor's contribution in points, kept so the player page can
      // show what the projection is made of rather than only its total.
      JSON.stringify(
        byId
          .get(b.player_id)!
          .inputs.map((i) => ({
            label: i.label,
            value: i.value,
            contribution: i.contribution,
            average: i.average,
          })),
      ),
      b.player_id, FORMAT, TEAMS, CURRENT,
    );
  }
})();
console.log(
  `wrote usage grades for ${graded.length} players ` +
    `(${rows.length} also have a market view to compare against)`,
);
