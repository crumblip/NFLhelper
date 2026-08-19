import { sqlite } from '../lib/db/index';
import { blend, buildUsageScale, distributionOf, verdict, currentSeasonWeight, DEFAULT_MARKET_WEIGHT, USAGE_CONFIDENCE, REPLACEMENT_RANK, type DerivationStep } from '../lib/pipeline/blend';
import { loadGrids, gridFor, projectedReplacement } from '../lib/pipeline/value';
import { adpEquivalent, expectedAt } from '../lib/pipeline/baseline';
import { buildRiskProfiles, riskNotes } from '../lib/pipeline/risk';
import { buildVacancies, opportunityFor } from '../lib/pipeline/opportunity';
import { getRookieSituations, projectRookie } from '../lib/pipeline/rookie';
import { buildTags, type TagInput } from '../lib/pipeline/tags';
import { buildCase } from '../lib/pipeline/case';
import { buildScarcity, fitStartableCurves, startableRate } from '../lib/pipeline/scarcity';
import { categoryShares, completeMarket, coveredGroups } from '../lib/pipeline/completion';
import { buildContingencies } from '../lib/pipeline/depth';
import { buildUpside } from '../lib/pipeline/upside';
import { fitUsageModels, projectUsage, resolveUsageSeason } from '../lib/pipeline/usage-grade';
import { buildCoverageProfile, maskStatLine } from '../lib/pipeline/coverage';
import { rulesFor, scoreStatLine, type StatLine } from '../lib/pipeline/scoring';

/**
 * Combines the market and usage views into one projection and writes it to the
 * board, keeping every component so the number can be taken apart.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const MODEL_FROM = 2021;
const round1 = (v: number) => v.toFixed(1);
const grids = loadGrids(FORMAT, TEAMS);
const replacement = projectedReplacement(FORMAT, TEAMS, CURRENT);

// Games played so far this season decides how much of the usage signal comes
// from this year rather than last.
const played = sqlite
  .prepare(
    `SELECT COALESCE(MAX(week), 0) AS w FROM player_stats_week
     WHERE season = ? AND season_type = 'REG'`,
  )
  .get(CURRENT) as { w: number };

const weekNow = played.w;
console.log(`blend | ${FORMAT} | ${TEAMS}-team | ${CURRENT} | week ${weekNow}`);
console.log(
  `market weight ${(DEFAULT_MARKET_WEIGHT * 100).toFixed(0)}% / usage ${((1 - DEFAULT_MARKET_WEIGHT) * 100).toFixed(0)}%` +
    ` | this season's usage carries ${(currentSeasonWeight(weekNow) * 100).toFixed(0)}% of the usage side`,
);
if (weekNow === 0) {
  console.log('  preseason: usage comes entirely from prior seasons.\n');
}

const rows = sqlite
  .prepare(
    `SELECT v.player_id, a.name, v.position, v.adp, a.team, v.implied_points AS market,
            v.usage_points AS usage, v.signal, v.usage_grade AS usageGrade,
            v.extrapolated_stats AS extrapolated, v.usage_inputs AS usageInputsJson,
            ? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age,
            u.target_share AS ts, u.rush_share AS rs, u.pass_snap_share AS pss,
            u.rz_touch_share AS rz, u.goal_line_share AS gl, u.games AS gamesLast
     FROM value_scores v
     JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
      AND a.format = v.format AND a.teams = v.teams
     JOIN players p ON p.gsis_id = v.player_id
     LEFT JOIN player_usage u ON u.player_id = v.player_id AND u.season = ? - 1
     WHERE v.format = ? AND v.teams = ? AND v.season = ?`,
  )
  .all(CURRENT, CURRENT, FORMAT, TEAMS, CURRENT) as Array<{
  player_id: string; name: string; position: string; adp: number;
  team: string | null; market: number | null; usage: number | null; signal: string;
  usageGrade: number | null; extrapolated: number; age: number | null;
  usageInputsJson: string | null;
  ts: number | null; rs: number | null; pss: number | null;
  rz: number | null; gl: number | null; gamesLast: number | null;
}>;

// Distributions are per position: a tight end's points do not live on the same
// scale as a quarterback's, and standardising across them would be meaningless.
const dists = new Map<string, { market: ReturnType<typeof distributionOf>; usage: ReturnType<typeof distributionOf> }>();
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const group = rows.filter((r) => r.position === pos && r.signal === 'full');
  dists.set(pos, {
    market: distributionOf(group.map((r) => r.market ?? NaN)),
    usage: distributionOf(group.map((r) => r.usage ?? NaN)),
  });
}

const risk = buildRiskProfiles(CURRENT - 1);

const update = sqlite.prepare(
  `UPDATE value_scores
   SET blended_points = ?, blended_vorp = ?, upside_points = ?, upside_chance = ?,
       upside_gain = ?, blended_slot_gap = ?, blended_adp_equivalent = ?,
       market_z = ?, usage_z = ?, disagreement = ?, market_weight = ?, verdict = ?,
       expected_games = ?, td_over_expected = ?, risk_notes = ?,
       vacated_share = ?, opportunity_note = ?, tags = ?, derivation = ?, player_case = ?
   WHERE player_id = ? AND format = ? AND teams = ? AND season = ?`,
);

/*
 * Outcome rates ranked WITHIN position, among late picks only.
 *
 * "Top-12 at the position" is a fixed bar held up against pools of very
 * different size — replacement is TE13 but WR43 — so the raw rates are not
 * comparable across positions. Late tight ends run a 40% median breakout rate
 * against 8-10% for receivers and backs, and the best available receiver on the
 * board (25%) still scores below the worst tight end (28%). Any absolute cutoff
 * therefore returns a list of tight ends and calls it upside.
 *
 * Ranking each player against others at his own position, in the same stretch of
 * the draft, asks the question a drafter is actually facing: of the players I
 * could take here, which has the best chance of being startable.
 */
const LATE_ADP = 60;
const band = (adp: number) => (adp < LATE_ADP ? 'early' : 'late');
const rates = new Map<string, { breakout: number[]; bust: number[] }>();

/**
 * Percentile within position AND within the same stretch of the draft.
 *
 * Both halves of the draft need this, not just the late one. The early bust tag
 * used an absolute `bustRate >= 0.20`, and quarterbacks run a 33-40% bust rate
 * across the board because "bust" means failing to clear replacement —
 * and QB replacement is 296, the highest of any position. Every quarterback on
 * the board cleared the threshold, so all four early ones were tagged BUST RISK
 * including Lamar Jackson. A tag that fires on 100% of a position carries no
 * information about any member of it.
 */
function ratePctile(
  position: string,
  adp: number,
  which: 'breakout' | 'bust',
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const pool = rates.get(`${position}|${band(adp)}`)?.[which];
  if (!pool || pool.length < 5) return null;
  const below = pool.filter((v) => v < value).length;
  return Math.round((below / pool.length) * 100);
}

/*
 * Who calls the plays, and what that has been worth.
 *
 * `head_coach` comes from play-by-play — nflverse publishes no coordinator table
 * anywhere, so this is the head coach and is named that. For teams where he
 * calls the plays it is exact; elsewhere it stands for the staff he hired.
 *
 * A change is detected between the two most recent completed seasons, which is
 * the best available signal in August. It will misread a team that changed coach
 * two years running as stable — but the alternative, asserting a 2026 staff from
 * a source that only records games played, would be a stale fact dressed as a
 * current one.
 */
const currentCoach = new Map<string, string>();
const priorCoach = new Map<string, string>();
for (const r of sqlite
  .prepare(
    `SELECT season, team, head_coach FROM team_context
     WHERE head_coach IS NOT NULL AND season >= ? - 2`,
  )
  .all(CURRENT) as Array<{ season: number; team: string; head_coach: string }>) {
  if (r.season === CURRENT - 1) currentCoach.set(r.team, r.head_coach);
  if (r.season === CURRENT - 2) priorCoach.set(r.team, r.head_coach);
}
const coachChanged = (team: string) => {
  const now = currentCoach.get(team);
  const before = priorCoach.get(team);
  return now !== undefined && before !== undefined && now !== before;
};

/*
 * How concentrated each coach's backfield has been — the top back's mean share
 * of team carries across every season he has coached in the window.
 */
const coachConcentration = (() => {
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
    // One season is an anecdote. The finding rests on repetition across seasons.
    if (shares.length < 2) continue;
    out.set(coach, shares.reduce((a, b) => a + b, 0) / shares.length);
  }
  return out;
})();

const vacancies = buildVacancies(CURRENT - 1, CURRENT);
const shares = categoryShares(FORMAT);
const contingencies = buildContingencies(CURRENT);

/*
 * Contingent upside: the same fitted usage model, evaluated at the share vector
 * he would hold after inheriting the blocker's work. Not a second projection —
 * the existing one at a different, explicitly stated input.
 */
const upside = (() => {
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
  const pts = new Map<string, number>();
  for (const t of totals) {
    const cats = profile.get((t.position ?? '').toUpperCase());
    pts.set(`${t.player_id}|${t.season}`, scoreStatLine(cats ? maskStatLine(t, cats) : t, rules));
  }
  const fits = fitUsageModels(pts);
  const { live, usageSeason } = resolveUsageSeason(CURRENT);
  return buildUpside(fits, projectUsage(fits, usageSeason, 3, live ? CURRENT : null), contingencies);
})();
console.log(`contingent upside computed for ${upside.size} players with a blocker ahead`);

/*
 * Team offensive strength, ranked. Calibrated to matter: a team's offensive
 * touchdowns predict a player's next-season touchdown rate at +0.15 after his
 * own red-zone share is removed, consistently across all three positions.
 */
const offenseRank = new Map<string, number>();
{
  /*
   * One definition of "how good is this offence", read from `team_context`.
   *
   * This used to sum passing and rushing touchdowns out of the box scores while
   * the scouting panel ranked teams by actual points scored, so the same page
   * could call an offence 7th in one place and 12th in another. Points from the
   * final scores are also simply better: they count field goals, and they do not
   * depend on correctly attributing every touchdown to a team through a weekly
   * `recent_team` column.
   */
  for (const t of sqlite
    .prepare(
      `SELECT team, points_rank FROM team_context
       WHERE season = ? - 1 AND points_rank IS NOT NULL`,
    )
    .all(CURRENT) as Array<{ team: string; points_rank: number }>) {
    offenseRank.set(t.team, t.points_rank);
  }
}

/*
 * Outcome ranges from historical comparables, if build:outlook has run.
 *
 * A SPARSE outlook carries placeholder zeros, not measurements. When a player's
 * nearest historical analogue sits beyond his position's no-analogue band,
 * `comparables.ts` returns early with every rate set to 0 — its comment says
 * "the `sparse` flag is what gates display; these are never read", which was
 * true when it was written and stopped being true the moment the board started
 * ranking UPSIDE and BUST on them.
 *
 * It bit the players with the fewest analogues, which is to say the best ones:
 * Puka Nacua at ADP 3, Jaxon Smith-Njigba at 5 and Christian McCaffrey at 6 all
 * came out at the 0th percentile for upside AND the 0th for bust — a placeholder
 * read as "no upside and no risk", on 18 of 163 board players. Family #6, a
 * default shown as a measurement.
 *
 * Sparse rows are dropped here so every consumer sees null and renders "—".
 */
const outlooks = new Map<string, { breakoutRate: number; bustRate: number }>();
let sparseOutlooks = 0;
for (const r of sqlite
  .prepare(`SELECT player_id, outlook FROM value_scores WHERE season = ? AND outlook IS NOT NULL`)
  .all(CURRENT) as Array<{ player_id: string; outlook: string }>) {
  try {
    const o = JSON.parse(r.outlook) as { breakoutRate: number; bustRate: number; sparse?: boolean };
    if (o.sparse) { sparseOutlooks++; continue; }
    outlooks.set(r.player_id, o);
  } catch {
    /* stale row */
  }
}
if (sparseOutlooks) {
  console.log(
    `${sparseOutlooks} players have no usable comparable neighbourhood — their upside and bust ` +
      `read as unknown rather than as zero.`,
  );
}

// Populate the position/band pools that `ratePctile` ranks against.
for (const r of rows) {
  const o = outlooks.get(r.player_id);
  if (!o) continue;
  const key = `${r.position}|${band(r.adp)}`;
  const pool = rates.get(key) ?? { breakout: [], bust: [] };
  pool.breakout.push(o.breakoutRate);
  pool.bust.push(o.bustRate);
  rates.set(key, pool);
}

// Current depth-chart rank at the player's own position, so a role change since
// last season is visible. Matched to his position for the reason kick-return
// listings once hid Dylan Sampson entirely.
const depthRanks = new Map(
  (
    sqlite
      .prepare(
        `SELECT player_id, pos_abb, MIN(pos_rank) AS rank FROM depth_chart
          WHERE season = ? AND pos_abb IN ('QB','RB','WR','TE')
          GROUP BY player_id, pos_abb`,
      )
      .all(CURRENT) as Array<{ player_id: string; pos_abb: string; rank: number }>
  ).map((r) => [`${r.player_id}|${r.pos_abb}`, r.rank]),
);

/*
 * Where each player sat in his own team's pecking order last season.
 *
 * Compared against the current depth-chart rank, this is what actually shows a
 * promotion. Testing a share against a fixed threshold instead flagged 41
 * players — including team leaders like Kenneth Walker III, whose 44% rush share
 * simply reflects that most backfields are committees.
 */
const priorRoleRank = new Map<string, number>();
{
  const usage = sqlite
    .prepare(
      `SELECT player_id, team, position,
              CASE WHEN position = 'RB' THEN COALESCE(rush_share, 0)
                   -- Every quarterback has a ~0 target share, so ranking them
                   -- that way orders them arbitrarily. Starter share is the
                   -- pecking order that exists at the position.
                   WHEN position = 'QB' THEN COALESCE(pass_snap_share, 0)
                   ELSE COALESCE(target_share, 0) END AS share
       FROM player_usage
       WHERE season = ? - 1 AND team IS NOT NULL AND position IN ('QB','RB','WR','TE')
       ORDER BY team, position, share DESC`,
    )
    .all(CURRENT) as Array<{ player_id: string; team: string; position: string; share: number }>;
  const seen = new Map<string, number>();
  for (const u of usage) {
    const key = `${u.team}|${u.position}`;
    const rank = (seen.get(key) ?? 0) + 1;
    seen.set(key, rank);
    priorRoleRank.set(u.player_id, rank);
  }
}

// The team a player's usage shares were measured on. 27 board players changed
// teams, and a share earned elsewhere should say so rather than being reported
// as "his team's targets" about a roster he has just joined.
const usageTeamOf = new Map(
  (
    sqlite
      .prepare(`SELECT player_id, team FROM player_usage WHERE season = ? - 1 AND team IS NOT NULL`)
      .all(CURRENT) as Array<{ player_id: string; team: string }>
  ).map((r) => [r.player_id, r.team]),
);

const draftPicks = new Map(
  (
    sqlite
      .prepare(`SELECT player_id, pick FROM draft_picks WHERE player_id IS NOT NULL`)
      .all() as Array<{ player_id: string; pick: number }>
  ).map((r) => [r.player_id, r.pick]),
);

// Which category groups the market actually priced, per player.
const coveredByPlayer = new Map<string, Set<string>>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, stat FROM implied_stats
     WHERE scope = 'season' AND source IN ('market','extrapolated')`,
  )
  .all() as Array<{ player_id: string; stat: string }>) {
  const set = coveredByPlayer.get(r.player_id) ?? new Set<string>();
  set.add(r.stat);
  coveredByPlayer.set(r.player_id, set);
}

/*
 * Putting the usage projection back on the actual-points scale.
 *
 * The usage projection is a regressed conditional expectation, so its values
 * bunch between roughly 90 and 140 while actual points run far wider — WR43
 * sits at 122. Comparing the compressed scale against the uncompressed
 * threshold put a third of the top hundred "below replacement" (bugs #5, #15,
 * #19).
 *
 * That used to be handled by keeping a SECOND replacement level in usage units
 * and measuring usage-only players against it. That fixed the intercept and left
 * the slope wrong, which is why it broke the moment the model got better: at an
 * identical usage projection a covered receiver scored +57.4 of VALUE and an
 * uncovered one +32.0, and the gap was pure scale.
 *
 * The compression is not a mystery — it is a property of least squares. Fitted
 * values from a multiple regression have standard deviation R x sd(actual),
 * where R is the multiple correlation, so a deviation from replacement measured
 * on the fitted scale is exactly R times the deviation on the real one.
 * Dividing by R undoes it, and the correction re-derives itself whenever the
 * model is refit.
 *
 * This does re-introduce some of the variance the regression removed, which is
 * the trade the old comment declined to make. The difference is that it is now
 * applied where it belongs: to the SPREAD used for ranking, not to the point
 * estimate shown as a projection. `blended_points` stays regressed and honest;
 * only the comparison against replacement is put on a common footing, because
 * ranking two players against each other is meaningless when their numbers live
 * on scales of different widths.
 */

/*
 * One implementation, shared with the waiver wire.
 *
 * This file used to carry its own copy of the conversion, identical arithmetic
 * to `buildUsageScale` sitting a directory away — exactly the drift that
 * `lib/waiver.ts` exists to prevent, and the reason bug #67 could be fixed in
 * one place and survive in the other. The board's anchor still comes from the
 * board's own projections and the wire's from the league's, which is the one
 * thing that legitimately differs between them; that is a caller's argument
 * rather than a second implementation.
 */
const usageScale = buildUsageScale(
  sqlite
    .prepare(
      `SELECT position, usage_points AS points FROM value_scores
       WHERE format = ? AND teams = ? AND season = ? AND usage_points IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, CURRENT) as Array<{ position: string; points: number }>,
  replacement,
  sqlite
    .prepare(`SELECT position, r2 FROM usage_model_fit WHERE format = ? AND teams = ? AND season = ?`)
    .all(FORMAT, TEAMS, CURRENT) as Array<{ position: string; r2: number }>,
);

/** A position with no fitted model keeps its number rather than losing it. */
const toActualScale = (position: string, usagePoints: number): number =>
  usageScale.convert(position, usagePoints) ?? usagePoints;

console.log(
  'usage scale -> actual: ' +
    ['QB', 'RB', 'WR', 'TE']
      .filter((p) => usageScale.parts.has(p))
      .map((p) => {
        const s = usageScale.parts.get(p)!;
        return `${p} repl ${s.usageReplacement.toFixed(0)}->${s.actualReplacement.toFixed(0)} (R=${s.r.toFixed(2)})`;
      })
      .join('  '),
);

/*
 * Rookies have no usage to model, so draft capital stands in for it.
 *
 * Without this a first-round back listed RB1 and an undrafted camp body were
 * treated identically — both simply had no usage row. Draft capital is the
 * strongest rookie predictor there is (a top-15 receiver clears replacement
 * 64% of the time against 14% in round two) and it is a fact, not a forecast.
 */
const rookies = new Map(
  getRookieSituations(FORMAT, TEAMS, CURRENT).map((r) => [r.playerId, r]),
);
let rookiesProjected = 0;

interface Out {
  name: string; position: string; adp: number; points: number;
  slotGap: number; disagreement: number | null; label: string; signal: string;
  notes: string; opportunity: string | null; vacatedShare: number | null;
}
const out: Out[] = [];

sqlite.transaction(() => {
  for (const r of rows) {
    const d = dists.get(r.position);
    if (!d) continue;

    /*
     * A partial market projection is a floor, not a forecast — most commonly a
     * back with no receiving line, which understates him by roughly 77 points.
     * Feeding that into the blend would drag him down as if the market were
     * bearish, when really it just is not pricing him.
     *
     * So the market side is used only when complete. Otherwise the blend falls
     * back to usage alone, which needs no sportsbook at all. That is what gives
     * a read on the twenty-odd backs the market ignores.
     */
    /*
     * A partial market projection is completed, not discarded.
     *
     * Dropping it threw away the most specific evidence available — Love was
     * priced at 885 rushing yards and got replaced by a draft-capital median.
     * Scaling by the share of scoring the covered categories normally account
     * for keeps the sportsbook's number as the anchor.
     */
    let marketPoints = r.market;
    let marketCompleted = false;
    if (r.signal === 'partial' && r.market !== null) {
      const completed = completeMarket(
        r.market,
        r.position,
        coveredGroups(coveredByPlayer.get(r.player_id) ?? new Set()),
        shares,
      );
      if (completed) {
        marketPoints = completed.points;
        marketCompleted = true;
      }
    }

    const marketUsable = (r.signal === 'full' || marketCompleted) && marketPoints !== null;
    const rookie = rookies.get(r.player_id);

    // Draft capital fills in for a rookie who has no usage history at all.
    const vac = r.team ? vacancies.get(r.team) : undefined;
    // Same rule as opportunityFor: a quarterback inherits no vacated volume, so
    // a rookie QB must not have his baseline lifted by departing receivers.
    const vacShare =
      !vac || r.position === 'QB' ? 0 : r.position === 'RB' ? vac.carryShare : vac.targetShare;
    const rookieProj =
      r.usage === null && rookie
        ? projectRookie(rookie.baseline, rookie.depthRank, vacShare)
        : null;
    if (rookieProj) rookiesProjected++;

    const usageSource = r.usage ?? rookieProj?.points ?? null;
    if (!marketUsable && usageSource === null) continue;

    const rp = risk.get(r.player_id);

    /*
     * The scale conversion happens HERE, once, before anything else touches the
     * number — which is what the comment further down has always claimed and
     * what bug #67 was supposed to have settled.
     *
     * Only the ridge model's output is compressed. `projectRookie` returns the
     * MEDIAN ACTUAL POINTS of comparable draft picks, which is already on the
     * real scale, so stretching it by 1/R was inflating draft capital by up to
     * 15 points for a receiver and 47 for a quarterback before the slot
     * shrinkage clawed part of it back. Two different quantities were being fed
     * through one transform because both happened to be called "usage".
     */
    const usageActual =
      r.usage !== null ? toActualScale(r.position, r.usage) : rookieProj?.points ?? null;

    /*
     * Durability scales the usage side only. A per-game rate assumes a full
     * season; season-long props already discount for missed time, so applying
     * it to both would charge the same risk twice.
     *
     * It multiplies the ACTUAL-scale projection, never the compressed one. The
     * usage scale's zero is not "zero football" — it is wherever the regression's
     * intercept happens to sit — so `toActualScale(k x u)` has the wrong fixed
     * point: scaling a player all the way down to zero games landed him at
     * −17.0 points at WR, −20.8 at RB, −6.1 at TE and −85.4 at QB rather than at
     * 0. That the endpoint depends on his POSITION is the tell. A discount is a
     * statement about one player's availability and cannot know what position he
     * plays, so any version of it that does is arithmetic leaking through.
     *
     * `k x toActualScale(u)` is the same discount stated on a scale where zero
     * means zero. For a healthy player (k = 1) the two are identical, which is
     * why this moves only the players the discount was aimed at: 44 of 179 board
     * rows, all upward, by a mean of 5.2 points at QB and up to 19.9 for Daniel
     * Jones. The old ordering was a hidden second injury penalty.
     */
    const durability = rp ? Math.min(1, rp.durability / 0.88) : 1;
    const usageAdjusted = usageActual !== null ? usageActual * durability : null;
    const discounted =
      usageAdjusted !== null && usageActual !== null &&
      Math.abs(usageActual - usageAdjusted) > 0.5;

    /*
     * A rookie's draft capital does not deserve a usage model's weight.
     *
     * `projectRookie` stands in for usage when a player has never taken a snap,
     * and it was then blended at the normal 40% — the same share given to a
     * ridge model fitted on measured opportunity with R² near 0.60. Measured
     * against actual rookie-season points for 2021-2025 rookies who had both an
     * ADP and a draft pick:
     *
     *   WR (n=29)  ADP r=0.453 · draft pick r=0.419 · draft pick AFTER ADP 0.206
     *   RB (n=34)  ADP r=0.502 · draft pick r=0.244 · draft pick AFTER ADP -0.104
     *
     * So for backs draft capital adds nothing once the price is known, and for
     * receivers it adds about a fifth. The market already prices where a player
     * was drafted; blending capital back in at 40% counts it twice, which is how
     * Carnell Tate came out at 167 from draft capital against the market's 139
     * and finished 24 points above what any book will pay for him.
     *
     * Samples are small — 29 and 34 — so this is deliberately a blunt correction
     * rather than a fitted weight: capital keeps a minority voice for receivers
     * and tight ends, and none for backs, where it measured negative.
     */
    const rookieMarketWeight =
      rookieProj && marketUsable ? (r.position === 'RB' ? 1 : 0.85) : undefined;

    /*
     * The usage side is now standardised against the usage distribution stated
     * on the SAME scale it is measured on.
     *
     * `toActualScale` is affine, so converting the mean and spread through it is
     * exact — mean maps through the transform, spread divides by R — and for a
     * healthy player the resulting z is identical to the old one to the last
     * decimal. That is the point: comparing a converted numerator against an
     * unconverted reference would have been a fresh scale mismatch of its own,
     * and this way the only players whose z moves are the ones carrying an
     * availability discount, which is the whole intent of the change.
     */
    const R = usageScale.parts.get(r.position)?.r ?? 1;
    const usageMeanActual = toActualScale(r.position, d.usage.mean);
    const usageSdActual = d.usage.sd / R;

    const b = blend({
      marketWeight: rookieMarketWeight,
      marketPoints: marketUsable ? marketPoints : null,
      usagePoints: usageAdjusted,
      marketMean: d.market.mean,
      marketSd: d.market.sd,
      usageMean: usageMeanActual,
      usageSd: usageSdActual,
    });
    if (!Number.isFinite(b.points)) continue;

    /*
     * A usage-only projection is shrunk toward what the draft slot implies.
     *
     * The usage model was fitted on players with at least six games, so applied
     * to a backup it extrapolates, and it regresses everyone toward the
     * positional mean — which at deep ADP makes almost every bench player look
     * underpriced. With no market view and a thin usage sample there is little
     * to justify departing far from the pick's historical return, so confidence
     * in the usage number sets how far it is allowed to move.
     */
    /*
     * Both branches already speak actual points, so nothing is converted here.
     *
     * The covered branch comes back on the market's scale; the usage-only branch
     * returns the projection that `usageActual` put on the real scale before the
     * durability discount was applied to it. The conversion used to live on this
     * line, which meant it ran AFTER the discount — the bug this comment used to
     * describe while the code two hundred lines up quietly did the opposite.
     *
     * The shrinkage below mixes the player's own projection with the historical
     * return of his draft slot. That slot figure is built from actual points, so
     * blending it against a compressed usage projection was combining two
     * different units in one expression — the scale-mismatch family again, and
     * the reason a shrunk usage-only receiver came out at 139.7 from a
     * projection of 149.5. On one scale the shrinkage means what it says.
     */
    let points = b.points;

    /*
     * Rookies were exempt from this shrinkage, and that was backwards.
     *
     * The exemption assumed draft capital is strong enough to stand alone. It is
     * not: against actual rookie-season points, a draft pick correlates 0.419
     * for receivers and 0.244 for backs, and once ADP is known it adds 0.206 for
     * receivers and MINUS 0.104 for backs. ADP is the better predictor at both
     * positions. So a rookie with no usable market read was the one player
     * allowed to depart freely from his draft slot on the weakest evidence in
     * the system — Jeremiyah Love came out at 181.7 against a market read of
     * 121.5.
     *
     * Confidence comes from that measurement rather than from seasons played,
     * which a rookie has none of by definition: a fifth for receivers and tight
     * ends, nothing for backs, where capital measured negative after price.
     */
    if (!marketUsable && rookieProj) {
      const capitalConfidence = r.position === 'RB' ? 0 : 0.2;
      const slotPoints =
        (replacement.get(r.position) ?? 0) +
        expectedAt(gridFor(grids, r.position), r.adp).expectedVorp;
      points = slotPoints + (points - slotPoints) * capitalConfidence;
    }

    if (!marketUsable && !rookieProj) {
      /*
       * A flat weight, because seasons of history measurably do NOT earn one.
       *
       * This step is a two-signal blend like any other: the player's own usage
       * projection against what his draft slot has returned. Seeing it that way
       * makes it testable, and `calibrate:blend`'s machinery answers it directly
       * — sweep the weight, leave one season out, score against what the players
       * actually did (509 player-seasons, 2022-2025):
       *
       *   flat 0.30                                  r 0.5065
       *   flat 0.20                                  r 0.5057
       *   flat 0.40                                  r 0.5050
       *   w = 0, always the slot                     r 0.4979
       *   min(1, seasons/3) x min(1, games/12)       r 0.4891  <- what shipped
       *   w = 1, always his own number               r 0.4500
       *
       * The seasons-based rule loses to a constant in all four folds. Per
       * position the optimum runs WR 0.40 · RB 0.25 · TE 0.05 · QB 0.35, and
       * 0.30 costs at most 0.009 (TE) against any of them — the same shape as
       * the market weight, where per-position tuning also failed to generalise.
       *
       * The games term measured +0.0008 on top and is dropped: availability is
       * already taken off the usage side by the durability multiplier, and
       * charging it twice is the thing that step's own comment warns against.
       *
       * This does NOT reintroduce bug #68. That bug was an asymmetry — uncovered
       * players hauled toward their slot while covered players took no pull at
       * all. They do take one: 60% of a covered player's number is the market.
       * 70% slot here against 60% market there is the same structure, and the
       * old rule's 100%-own-number for a veteran was the real asymmetry, in the
       * opposite direction. Uncovered veterans were trusted more than covered
       * ones.
       */
      const confidence = USAGE_CONFIDENCE;
      const slotPoints =
        (replacement.get(r.position) ?? 0) +
        expectedAt(gridFor(grids, r.position), r.adp).expectedVorp;
      points = slotPoints + (points - slotPoints) * confidence;
    }

    // One scale, one replacement level. Whether a sportsbook happens to post a
    // line on a player is a fact about the sportsbook, not about the player, and
    // it must not change what he is measured against.
    const replLevel = replacement.get(r.position) ?? 0;
    const vorp = points - replLevel;

    /*
     * The receipt. Every step that moved the number, in the order it moved it.
     *
     * Rebuilt here rather than reconstructed on the page, because reproducing
     * one player's VALUE needs the whole positional distribution, the fitted
     * model and the baseline curve — and an explanation computed from different
     * inputs than the figure it explains is worse than no explanation.
     */
    const derivation: DerivationStep[] = [];
    const usageIn = ((): Array<{ label: string; value: number; contribution: number; average: number }> | null => {
      if (!r.usageInputsJson) return null;
      try {
        return JSON.parse(r.usageInputsJson);
      } catch {
        return null;
      }
    })();

    if (marketUsable && marketPoints !== null) {
      /*
       * The figure shown has to be the figure used.
       *
       * This printed `r.market`, the raw scored props — but for a partially
       * covered player the blend receives the COMPLETED number instead, scaled
       * up for the stat categories no book priced. Bhayshul Tuten's receipt read
       * "sportsbooks price him at 105.5" while the blend was working with 157.6,
       * which is why his line appeared to average 105.5 and 67.6 into 137.7. A
       * receipt showing an input the calculation did not use is worse than
       * showing nothing, and it is the same family as the missing rookie step
       * (#80) — the panel narrating a branch the number did not take.
       */
      derivation.push({
        kind: 'market',
        label: marketCompleted
          ? 'What sportsbooks price him at, completed'
          : 'What sportsbooks price him at',
        value: marketPoints,
        running: null,
        detail: marketCompleted
          ? `Only some of his stat categories are priced. The posted props score to ` +
            `${(r.market ?? 0).toFixed(0)} points, and those categories normally account for a ` +
            `known share of a ${r.position}'s scoring, so the number is scaled up to ` +
            `${marketPoints.toFixed(0)} rather than thrown away. The sportsbook's figure stays the ` +
            `anchor; what is added is the part it did not quote. Read it as a weaker market signal ` +
            `than a fully priced player's, because part of it is inferred.`
          : `His posted season props — yards, catches, touchdowns — scored under this league's rules ` +
            `come to ${marketPoints.toFixed(0)} points. The vig is removed first, so this is the ` +
            `books' honest midpoint rather than the price they are selling.`,
      });
    }

    /*
     * A rookie's second opinion is his draft capital, and it has to appear.
     *
     * The usage step was gated on `r.usage`, which is null for every rookie —
     * they have no NFL snaps to model. Their projection comes from
     * `projectRookie` instead, and because that never reached the receipt the
     * chain silently skipped the step that actually drives their number.
     * Jeremiyah Love's showed 121.5 going into a subtraction being performed on
     * 220.8: ninety-nine points from nowhere, on the one panel whose entire
     * purpose is that the number can be taken apart.
     */
    if (r.usage === null && rookieProj) {
      derivation.push({
        kind: 'usage',
        label: 'What his draft capital implies',
        value: rookieProj.points,
        running: null,
        detail:
          `He has never taken an NFL snap, so there is no usage to model. What stands in for it is ` +
          `where he was drafted and what the depth chart in front of him looks like: a top-15 ` +
          `receiver returns a startable season 64% of the time and a second-rounder 14%, so draft ` +
          `capital carries real information about opportunity. It is a weaker input than measured ` +
          `usage and should be read that way — it describes the situation a team has put him in, ` +
          `not anything he has done in it.`,
      });
    }

    if (r.usage !== null) {
      derivation.push({
        kind: 'usage',
        label: 'What his on-field role is worth',
        value: r.usage,
        running: null,
        detail:
          `A ridge regression fitted on every player-season since ${MODEL_FROM} predicts next-season ` +
          `points from opportunity. Each line below is how far he sits from the average ` +
          `${r.position} on one input, multiplied by the weight the model fitted for it; they sum ` +
          `to his distance from the average projection. His comes out at ${r.usage.toFixed(0)}. ` +
          `Read each row as "this fact is worth N points more than a typical ${r.position}" rather ` +
          `than as a share of the total.` +
          (!marketUsable || discounted
            ? ' This scale is deliberately compressed — the model hedges toward the positional ' +
              'average — which is why the next step stretches it back out.'
            : ''),
        inputs: usageIn ?? undefined,
      });
    }

    /*
     * The scale conversion is its own step and it comes BEFORE the availability
     * discount, because that is the order the arithmetic now runs in.
     *
     * Shown when it changes something: always for an uncovered player, where the
     * usage side is the whole projection, and for a covered one only when a
     * discount follows that needs a base to be stated on. A healthy covered
     * player's conversion is exactly z-neutral, and a step that moves nothing is
     * noise on a panel whose whole claim is that every row moved the number.
     */
    if (r.usage !== null && (!marketUsable || discounted)) {
      derivation.push({
        kind: 'scale',
        label: 'Stretched back onto the real points scale',
        value: usageActual,
        running: marketUsable ? null : usageActual,
        detail:
          `The usage model's output is compressed: a regression's predictions vary less than reality ` +
          `does, by exactly the model's correlation R (${(usageScale.parts.get(r.position)?.r ?? 1).toFixed(2)} ` +
          `at ${r.position}). Dividing his distance from replacement by R undoes that, taking ` +
          `${round1(r.usage)} to ${round1(usageActual ?? 0)}` +
          (marketUsable
            ? `, so the discount below is taken off a number that means points.`
            : `, so he can be compared against players the market does cover.`),
      });
    }

    if (discounted) {
      derivation.push({
        kind: 'availability',
        label: 'Discounted for expected missed time',
        value: usageAdjusted,
        running: marketUsable ? null : usageAdjusted,
        detail:
          `The usage side is scaled by his durability record — ${round1(usageActual ?? 0)} becomes ` +
          `${round1(usageAdjusted ?? 0)}, a ${Math.round(durability * 100)}% multiplier off an ` +
          `expectation of ${(rp?.expectedGames ?? 0).toFixed(1)} games. Availability is one of the ` +
          `most repeatable things in this data: a receiver who missed four or more games misses time ` +
          `again 73% of the time against 41% for one who did not. Only the usage side is scaled, ` +
          `because season-long props already discount for missed time and applying it to both would ` +
          `charge the same risk twice. It multiplies the real-points figure above rather than the ` +
          `compressed one, so a player expected to miss every game would reach zero rather than a ` +
          `negative number that depends on his position.`,
      });
    }

    // Gated on the usage side that was ACTUALLY blended, not on measured usage.
    // A rookie's input is his draft capital, so gating on `r.usage` skipped the
    // blend line for exactly the players whose blend moves the number most.
    if (marketUsable && usageAdjusted !== null && r.market !== null) {
      derivation.push({
        kind: 'blend',
        label: `Blended ${Math.round(b.marketWeight * 100)}% market / ${Math.round(b.usageWeight * 100)}% usage`,
        value: b.points,
        running: b.points,
        detail:
          `The two views are combined by rank within his position rather than by averaging the point ` +
          `totals — averaging would drag every star down, because the usage model's numbers are ` +
          `compressed and the market's are not. He sits ${b.marketZ === null ? '—' : b.marketZ.toFixed(2)} ` +
          `standard deviations from the positional mean on the market view and ` +
          `${b.usageZ === null ? '—' : b.usageZ.toFixed(2)} on the usage view. The 60/40 split was ` +
          `shipped as a judgment call and has since been measured against four drafts replayed with ` +
          `draft-day information only (\`npm run calibrate:blend\`): it costs 0.0015 of correlation ` +
          `against a perfectly tuned weight, and the best setting is not identifiable anywhere ` +
          `between 0.5 and 0.9.`,
      });
    }

    if (!marketUsable && rookieProj) {
      derivation.push({
        kind: 'shrink',
        label:
          r.position === 'RB'
            ? 'Replaced by what his draft slot has returned'
            : 'Pulled 80% toward what his draft slot has returned',
        value: points,
        running: points,
        detail:
          `No usable market read and no NFL snaps, so the only two things known about him are ` +
          `where the NFL drafted him and where fantasy drafters are taking him. Measured against ` +
          `actual rookie seasons, the second is the better predictor: ADP correlates 0.502 for ` +
          `backs and 0.453 for receivers, while the draft pick adds ${r.position === 'RB' ? 'nothing once ADP is known (−0.104)' : 'about a fifth on top of it (0.206)'}. ` +
          `So his projection is ${r.position === 'RB' ? 'set to' : 'pulled most of the way toward'} ` +
          `what pick ${r.adp.toFixed(0)} has historically returned.`,
      });
    }

    /*
     * The receipt reads the SAME constant the arithmetic used. It used to
     * recompute the confidence from its own copy of the formula, which is the
     * #80 family waiting to happen — two expressions that agree until one of
     * them is edited.
     */
    if (!marketUsable && !rookieProj) {
      derivation.push({
        kind: 'shrink',
        label: `Pulled ${Math.round((1 - USAGE_CONFIDENCE) * 100)}% toward what his draft slot usually returns`,
        value: points,
        running: points,
        detail:
          `No book prices him, so the two things known about him are his own measured usage and ` +
          `what pick ${r.adp.toFixed(0)} has historically returned. They are combined ` +
          `${Math.round(USAGE_CONFIDENCE * 100)}/${Math.round((1 - USAGE_CONFIDENCE) * 100)} in favour of the slot. ` +
          `That weight is measured rather than chosen: swept against what players actually did over ` +
          `four drafts, 0.30 scores 0.507 against 0.489 for the rule this replaced, which gave a ` +
          `three-season player his full number and a rookie almost none of it. Seasons of history ` +
          `turned out not to predict who beats their draft slot. A covered player is pulled a ` +
          `comparable amount by the market — 60% there against 70% here — so coverage is not what ` +
          `decides how far a projection may travel from its price.`,
      });
    }

    derivation.push({
      kind: 'replacement',
      label: `Minus replacement level (${r.position}${REPLACEMENT_RANK[r.position] ?? ''})`,
      value: -replLevel,
      running: vorp,
      detail:
        `${replLevel.toFixed(0)} points is what the ${r.position} you could pick up for free is worth — ` +
        `the ${REPLACEMENT_RANK[r.position] ?? '?'}th best at the position in a ${TEAMS}-team league, ` +
        `averaged over the last three seasons. Everything above that line is what drafting him ` +
        `actually buys you; the points below it you could have had for nothing.`,
    });

    derivation.push({
      kind: 'result',
      label: 'VALUE',
      value: vorp,
      running: vorp,
      detail:
        `${vorp >= 0 ? '+' : ''}${vorp.toFixed(0)} points above a freely available ${r.position} ` +
        `across a full season. This is what the board sorts on, because it is the only number that ` +
        `compares a quarterback to a running back honestly — both are measured against what their ` +
        `own position gives away for free.`,
    });
    // Measured against this position's own curve, not the pooled one.
    const equivalent = adpEquivalent(gridFor(grids, r.position), vorp);
    const slotGap = r.adp - equivalent;
    const opp = opportunityFor(r.team ? vacancies.get(r.team) : undefined, r.position);
    const notes = riskNotes(rp);
    const v = verdict(
      slotGap,
      b.disagreement,
      !marketUsable ? 'usage-only' : b.usageZ === null ? 'market-only' : 'both',
      vorp,
      opp.share,
    );

    /*
     * One input object, two consumers. The case and the tags must be arguing
     * about the same player from the same facts — building each from its own
     * gathered inputs is how a board ends up saying GEM and NO UPSIDE at once.
     */
    const tagInput: TagInput = {
      position: r.position,
      adp: r.adp,
      age: r.age,
      slotGap,
      vorp,
      usageGrade: r.usageGrade,
      disagreement: b.disagreement,
      vacated: opp.share,
      expectedGames: rp?.expectedGames ?? null,
      tdOverExpected: rp?.tdOverExpected ?? null,
      seasonsObserved: rp?.seasonsObserved ?? 0,
      signal: r.signal,
      extrapolatedStats: r.extrapolated,
      isRookie: Boolean(rookieProj),
      targetShare: r.ts,
      rushShare: r.rs,
      routeShare: r.pss,
      goalLineShare: r.gl,
      rzShare: r.rz,
      gamesLastSeason: r.gamesLast,
      breakoutRate: outlooks.get(r.player_id)?.breakoutRate ?? null,
      bustRate: outlooks.get(r.player_id)?.bustRate ?? null,
      breakoutPctile: ratePctile(r.position, r.adp, 'breakout', outlooks.get(r.player_id)?.breakoutRate),
      bustPctile: ratePctile(r.position, r.adp, 'bust', outlooks.get(r.player_id)?.bustRate),
      contingentShare: contingencies.get(r.player_id)?.contingentShare ?? null,
      contingentNote: contingencies.get(r.player_id)?.note ?? null,
      teamOffenseRank: r.team ? (offenseRank.get(r.team) ?? null) : null,
      coachChanged: r.team ? coachChanged(r.team) : false,
      priorCoach: r.team ? (priorCoach.get(r.team) ?? null) : null,
      currentCoach: r.team ? (currentCoach.get(r.team) ?? null) : null,
      coachTopBackShare: r.team
        ? (coachConcentration.get(currentCoach.get(r.team) ?? '') ?? null)
        : null,
      draftPick: draftPicks.get(r.player_id) ?? null,
      depthRank: depthRanks.get(`${r.player_id}|${r.position}`) ?? null,
      priorRoleRank: priorRoleRank.get(r.player_id) ?? null,
      usageTeam: usageTeamOf.get(r.player_id) ?? null,
      currentTeam: r.team,
      replacementLevel: replLevel,
      upsidePoints: upside.get(r.player_id)?.leadPoints ?? null,
      upsideChance: upside.get(r.player_id)?.leadChance ?? null,
      upsideGain: upside.get(r.player_id)?.expectedGain ?? null,
    };

    // The case is built FIRST and its verdict is handed to the tags, so no chip
    // can disagree with the headline above it.
    const playerCase = buildCase(tagInput);
    const tags = buildTags({ ...tagInput, caseTone: playerCase.tone });

    update.run(
      // `vorp` is already measured against the replacement level that matches
      // this player's scale — see `replLevel` above. Storing it keeps the board
      // from recomputing it against the wrong one.
      points, vorp,
      upside.get(r.player_id)?.leadPoints ?? null,
      upside.get(r.player_id)?.leadChance ?? null,
      upside.get(r.player_id)?.expectedGain ?? null,
      slotGap, equivalent, b.marketZ, b.usageZ, b.disagreement,
      /*
       * The stored verdict IS the case headline. There is one verdict system.
       *
       * `verdict()` and `buildCase()` were computing conclusions independently
       * from overlapping inputs, and they disagreed on 17 of 174 board rows —
       * Matthew Golden read "bench flier, nobody is owed it" on the board and
       * "worth a late pick on profile" on his own page. That is the exact
       * failure this rebuild was for, one level up: two surfaces, one player,
       * opposite impressions. `verdict()` is still called because its tone drives
       * the board palette, but the words the reader sees now come from one place.
       */
      b.marketWeight, playerCase.headline,
      rp?.expectedGames ?? null, rp?.tdOverExpected ?? null,
      notes.length ? notes.join(' · ') : null,
      opp.share, opp.note, JSON.stringify(tags), JSON.stringify(derivation),
      JSON.stringify(playerCase),
      r.player_id, FORMAT, TEAMS, CURRENT,
    );

    out.push({
      name: r.name, position: r.position, adp: r.adp, points,
      slotGap, disagreement: b.disagreement, label: v.label, signal: r.signal,
      notes: notes.join(' · '), opportunity: opp.note, vacatedShare: opp.share,
    });
  }
})();

console.log(`blended ${out.length} players (${rookiesProjected} rookies from draft capital)\n`);

/*
 * Scarcity and startable weeks — a second pass, because both need the finished
 * board.
 *
 * VONA is the drop to the best player at the same position still expected to be
 * there at the drafter's next turn, so it cannot be computed until every
 * projection exists. Startable rate could have gone in the main loop but belongs
 * beside it: they are the two things VALUE structurally cannot say, and keeping
 * them together keeps the reason visible.
 */
{
  const curves = fitStartableCurves();
  console.log(
    'startable curve (a restatement of the projection, never an input to it): ' +
      ['QB', 'RB', 'WR', 'TE']
        .filter((p) => curves.has(p))
        .map((p) => {
          const c = curves.get(p)!;
          return `${p} R²=${c.r2.toFixed(2)}`;
        })
        .join(' · '),
  );

  const built = sqlite
    .prepare(
      `SELECT v.player_id AS playerId, a.name, v.position, v.adp,
              v.blended_points AS points, v.expected_games AS games,
              (SELECT COUNT(DISTINCT week) FROM snap_counts s
                WHERE s.player_id = v.player_id AND s.season = v.season - 1
                  AND s.game_type = 'REG' AND s.offense_snaps > 0) AS priorGames,
              (SELECT COALESCE(SUM(fantasy_points_half), 0) FROM player_stats_week w
                WHERE w.player_id = v.player_id AND w.season = v.season - 1
                  AND w.season_type = 'REG') AS priorPoints
       FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.blended_points IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, CURRENT) as Array<{
    playerId: string; name: string; position: string; adp: number;
    points: number; games: number | null; priorGames: number; priorPoints: number;
  }>;

  const scarcity = buildScarcity(built);
  const setScarcity = sqlite.prepare(
    `UPDATE value_scores
     SET vona = ?, vona_round = ?, drop_to_next = ?, next_at_position = ?, startable_rate = ?,
         breakout_pctile = ?, bust_pctile = ?, held_role = ?, outlook_pctile = ?
     WHERE player_id = ? AND format = ? AND teams = ? AND season = ?`,
  );

  sqlite.transaction(() => {
    for (const r of built) {
      const s = scarcity.get(r.playerId);
      const rate = startableRate(curves, r.position, r.points);

      /*
       * One axis, bust to breakout.
       *
       * The two component ranks are 87% mirror images and neither survives the
       * other — partial .020 and −.051 — so showing both invited a reader to
       * count one measurement as two reasons. Averaging them cancels part of the
       * noise in each, and it is measured rather than assumed: the mean beats or
       * ties both halves in every band that carries signal.
       *
       * The bust rank is reversed first so both face the same way. High is good.
       * Null unless BOTH halves exist, because an average of one half is just
       * that half wearing a combined label.
       */
      const breakoutPct = ratePctile(r.position, r.adp, 'breakout', outlooks.get(r.playerId)?.breakoutRate);
      const bustPct = ratePctile(r.position, r.adp, 'bust', outlooks.get(r.playerId)?.bustRate);
      const outlookPct =
        breakoutPct === null || bustPct === null ? null : (breakoutPct + (100 - bustPct)) / 2;
      setScarcity.run(
        s?.vona ?? null, s?.vonaRound ?? null, s?.dropToNext ?? null, s?.nextName ?? null,
        rate,
        breakoutPct,
        bustPct,
        /*
         * Held a real role last season. The definition is measured, not typed:
         * looser versions that fire on 70-81% of the late board all score
         * NEGATIVE, which is the dead-threshold family — a split that puts
         * nearly everyone on one side separates nobody.
         */
        r.priorGames >= 10 && r.priorPoints >= 80 ? 1 : 0,
        outlookPct,
        r.playerId, FORMAT, TEAMS, CURRENT,
      );
    }
  })();

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const g = built.filter((r) => r.position === pos).map((r) => scarcity.get(r.playerId)?.vona)
      .filter((v): v is number => v !== null && v !== undefined);
    if (!g.length) continue;
    const top = [...g].sort((a, b) => b - a)[0]!;
    console.log(`  ${pos}: biggest drop to the next man at his position over a snake turn is ${top.toFixed(0)} points`);
  }
  console.log();
}

const show = (title: string, list: Out[]) => {
  console.log(title);
  console.log('    ADP  pos  player                blend  slot gap  usage vs mkt  read');
  for (const r of list) {
    console.log(
      `  ${String(r.adp).padStart(5)}  ${r.position.padEnd(3)}  ${r.name.padEnd(21)}` +
        `${r.points.toFixed(0).padStart(6)}  ${((r.slotGap > 0 ? '+' : '') + r.slotGap.toFixed(1)).padStart(8)}  ` +
        `${(r.disagreement === null ? '   -' : (r.disagreement > 0 ? '+' : '') + r.disagreement.toFixed(2)).padStart(12)}  ${r.label}`,
    );
    if (r.opportunity) console.log(`         opportunity: ${r.opportunity}`);
    if (r.notes) console.log(`         ${r.notes}`);
  }
  console.log();
};

/*
 * Reported for receivers and backs only.
 *
 * The lineup starts 1 QB and 1 TE against 3 WR, 2 RB and a flex, with a bench
 * that will be almost entirely receivers and backs. Roughly eleven of thirteen
 * picks go to those two positions, so a leaderboard topped by tight ends and
 * quarterbacks is answering a question that was not asked.
 */
const skill = out.filter((r) => r.position === 'WR' || r.position === 'RB');
console.log(`WR and RB only — ${skill.length} of ${out.length} blended players\n`);

show('GEMS — cheap, and the on-field role backs it up',
  skill.filter((r) => r.label === 'gem' || r.label === 'good value')
    .sort((a, b) => b.slotGap - a.slotGap).slice(0, 12));

show('AVOID — the price is not supported by the role, or the risk is stacked',
  skill.filter((r) => r.label === 'bust risk' || r.label === 'overpriced' || r.label === 'usage warning')
    .sort((a, b) => (a.disagreement ?? 0) - (b.disagreement ?? 0)).slice(0, 12));

/*
 * Late-round picks are ranked by opportunity, not by projection.
 *
 * Nearly everyone available after pick 90 projects below replacement — that is
 * what makes them available. Sorting them by projected points just re-sorts by
 * ADP and tells you nothing. What separates a bench hit from a bench miss is
 * whether volume has opened up in front of him, which is the pattern behind
 * every late-round back who suddenly matters.
 */
const breakout = skill
  .filter((r) => r.adp >= 80 && r.opportunity !== null)
  .sort((a, b) => (b.vacatedShare ?? 0) - (a.vacatedShare ?? 0));

console.log('BREAKOUT WATCH — late picks with volume vacated in front of them');
console.log('    ADP  pos  player                blend  vacated   read');
for (const r of breakout.slice(0, 14)) {
  console.log(
    `  ${String(r.adp).padStart(5)}  ${r.position.padEnd(3)}  ${r.name.padEnd(21)}` +
      `${r.points.toFixed(0).padStart(6)}   ${`${Math.round((r.vacatedShare ?? 0) * 100)}%`.padStart(6)}   ${r.label}`,
  );
  console.log(`         ${r.opportunity}`);
  if (r.notes) console.log(`         ${r.notes}`);
}
console.log();

const flagged = skill.filter((r) => r.notes);
if (flagged.length) {
  console.log(`RISK FLAGS (${flagged.length} of ${skill.length} WR/RB)`);
  for (const r of flagged.sort((a, b) => a.adp - b.adp).slice(0, 15)) {
    console.log(`  ${String(r.adp).padStart(5)}  ${r.position}  ${r.name.padEnd(22)} ${r.notes}`);
  }
  console.log();
}

const counts = new Map<string, number>();
for (const r of skill) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
console.log('WR/RB verdicts:');
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${k}`);
}
