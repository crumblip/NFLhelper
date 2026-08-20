import { sqlite } from '../db/index';

/**
 * What happened to players who looked like this one?
 *
 * A point projection says a receiver is worth 140 points and stops there. It
 * does not say whether that is a safe 140 or the midpoint of a range running
 * from 40 to 260, and those are completely different draft picks.
 *
 * This answers the question empirically. Describe a player by the things that
 * actually predict — role, scoring opportunity, production, age — find the
 * historical player-seasons closest to that description, and report what those
 * players did the *following* year. The spread of their outcomes is the range of
 * outcomes; the share who hit is the probability of hitting.
 *
 * Nothing is assumed about how a career should progress. It is a lookup of what
 * comparable players did.
 *
 * Every choice below is measured by `npm run calibrate:comparables`, which
 * re-runs the lookup on seasons whose following year is already known and checks
 * whether the truth landed where the method said it would.
 */

export interface ProfileFeatures {
  targetShare: number;
  routeShare: number;
  rzShare: number;
  goalLineShare: number;
  rushShare: number;
  age: number;
  /**
   * Half-PPR points per game in the season being described.
   *
   * Role alone does not identify a player, and leaving this out was the defect
   * that made the panel unusable. Bijan Robinson's 2025 (335 points) matched
   * Rhamondre Stevenson's 2022 (217) because their *shares* are alike — a 60%
   * rush share is a 60% rush share whether the offence scores 30 a game or 17.
   * Adding production lifts next-season correlation from .690 to .712 for backs
   * and .746 to .770 for receivers, and stops the list returning strangers a
   * reader rejects on sight.
   */
  ppg: number;
  /**
   * Games on the field as a share of the season.
   *
   * Shares are computed only over the weeks a player appeared (deliberately —
   * see bug #2), so a back who played seven elite games has the same share
   * vector as one who played seventeen. Christian McCaffrey's 2021 (109 points
   * in 7 games) was landing as a comparable for a 17-game workhorse.
   */
  availability: number;
}

export interface Comparable {
  playerId: string;
  name: string;
  season: number;
  /** What he scored in the season being matched on. */
  ownPoints: number;
  ownPpg: number;
  /** What he scored the FOLLOWING season. Zero when he never played again. */
  nextPoints: number;
  nextPpg: number;
  nextGames: number;
  /** False when he did not take a snap the following season. */
  nextPlayed: boolean;
  distance: number;
}

/**
 * How well the neighbourhood actually supports the numbers drawn from it.
 *
 * Measured, not asserted. Bucketing every backtested season by the share of its
 * forty neighbours that are genuinely close shows the median outcome roughly
 * doubles in error as the neighbourhood thins — RB mean absolute error runs 33.5
 * points when 90%+ of the neighbours are close against 65.6 when under a quarter
 * are, with WR 28.3 against 41.1 and TE 15.3 against 34.9.
 *
 * The band is a different matter: interval coverage holds at 0.57-0.66 in every
 * bucket, because a scattered neighbourhood produces a correspondingly wider
 * range. So the range stays honest when the comps are thin and the single
 * headline number does not, and the page must say which it is showing.
 */
export type Support = 'strong' | 'fair' | 'thin';

export interface Outlook {
  /**
   * The seasons the comparable pool actually spans — the PROFILES matched on.
   *
   * It stops a year short of the newest season played, and always will: a
   * season only teaches something once the following one is in the books, so
   * the last profile is the second-newest season, not the newest.
   */
  fromSeason: number;
  toSeason: number;
  /**
   * The seasons the OUTCOMES come from — every profile season plus one.
   *
   * Carried explicitly because the page was labelling the panel with the
   * profile span alone ("2021–2024") while the outcomes it draws ran a year
   * later, which reads as a tool that stopped ingesting a year ago. Derived
   * here rather than as `toSeason + 1` at each call site: this project has
   * already shipped one number defined twice (#71).
   */
  outcomeFromSeason: number;
  outcomeToSeason: number;
  /** Count of historical seasons in the neighbourhood. */
  n: number;
  /**
   * True when no historical season resembles him at all.
   *
   * A hard gate, not a quality grade — `support` carries the gradient. This
   * fires only when even the closest match is remote, which is a real finding
   * about a player rather than a gap in the data.
   *
   * IT NO LONGER SUPPRESSES THE RANGE — see the branch in `lookup` for the
   * measurement. It still suppresses the RATES and the ranked percentiles.
   */
  sparse: boolean;
  support: Support;
  /** Share of the neighbourhood that is a genuine match. Drives `support`. */
  closeShare: number;
  /** Distance to the single closest historical season. */
  nearestDistance: number;
  /** The distance bands for this position, so labels are drawn consistently. */
  bands: Bands;

  /*
   * Two scales, because two different questions get asked of this panel.
   *
   * A season total is the draft-day unit: what is he worth over a year. Points
   * per game is the in-season unit — when a waiver claim is being weighed in
   * week 8, "he averaged 12.4 a game" is the decision and a season total is
   * noise plus an injury history. Both come from the same neighbourhood.
   */
  floor: number;
  median: number;
  ceiling: number;
  floorPpg: number;
  medianPpg: number;
  ceilingPpg: number;

  /** Share who cleared replacement the next season. */
  hitRate: number;
  /** Share who finished as a positional top-12 season. */
  breakoutRate: number;
  /** Share who fell below half of replacement, the true busts. */
  bustRate: number;
  /**
   * Share who never took an offensive snap the following season.
   *
   * These seasons used to be dropped from the pool entirely, because the lookup
   * required a following-year stat line to exist. That silently conditioned
   * every rate on "he played at all" and deleted the worst outcome in fantasy
   * football from the sample — 13% of role-holding RB seasons, 15% of WR. Bijan
   * Robinson's bust rate read 2.5% against a pool with the disappearances
   * removed.
   */
  vanishRate: number;
  /** Median games played the following season, among those who played. */
  medianNextGames: number;
  nearest: Comparable[];
}

/**
 * Feature weights.
 *
 * Set from the measured predictive strength of each input rather than evenly:
 * target share carries most for receivers (r=0.71 against next season), rush
 * share for backs (r=0.72), red-zone work next (r=0.63-0.72), age last but not
 * zero (r=-0.18 to -0.27 after role is accounted for).
 *
 * `ppg` at 3.0 and `availability` at 0.5 come from the ablation in
 * `calibrate:comparables`: ppg at 3.0 beat 1.5 and beat leaving it out at every
 * position, and availability above 0.5 bought nothing while pushing the median
 * neighbour from 1.29 to 1.46 standardised units, which degrades the comp list
 * the reader actually looks at.
 */
const WEIGHTS: Record<string, ProfileFeatures> = {
  WR: { targetShare: 3.0, routeShare: 1.6, rzShare: 2.2, goalLineShare: 1.0, rushShare: 0.2, age: 1.2, ppg: 3.0, availability: 0.5 },
  TE: { targetShare: 3.0, routeShare: 1.8, rzShare: 2.0, goalLineShare: 1.0, rushShare: 0.1, age: 0.9, ppg: 3.0, availability: 0.5 },
  RB: { targetShare: 1.8, routeShare: 1.4, rzShare: 2.4, goalLineShare: 1.6, rushShare: 3.0, age: 1.4, ppg: 3.0, availability: 0.5 },
  /*
   * Quarterbacks were excluded entirely, so all 26 on the board had no outlook —
   * no floor, median, ceiling, breakout or bust rate. That left the position
   * with nothing to say about late-round risk, which is where most quarterbacks
   * are drafted.
   *
   * `routeShare` here is pass-snap share, which for a quarterback is starter
   * share — the dominant fact about him and the strongest term in the position's
   * usage model. Target share is given zero weight: it is ~0 for every
   * quarterback and would otherwise make them all look identical.
   */
  QB: { targetShare: 0.0, routeShare: 3.0, rzShare: 1.4, goalLineShare: 1.2, rushShare: 2.4, age: 1.0, ppg: 3.0, availability: 0.5 },
};

const FEATURES = [
  'targetShare', 'routeShare', 'rzShare', 'goalLineShare', 'rushShare',
  'age', 'ppg', 'availability',
] as const;
type Feature = (typeof FEATURES)[number];

/**
 * Where "close" sits is a per-position question, measured per position.
 *
 * A single distance cutoff across all four positions is the cross-position
 * comparison this project has been bitten by repeatedly (bugs #23, #49). The
 * distributions are not the same shape: at k=40 the median neighbour sits at
 * 1.36 standardised units for a receiver and 1.97 for a quarterback, because the
 * quarterback pool is 179 seasons against 676 and forty of them is 22% of the
 * position rather than 6%. A fixed 1.35 therefore graded 87% of quarterbacks
 * "thin" — a label that fires on almost a whole position is not a finding, it is
 * the default state (family #2).
 *
 * So the bands are computed from each position's own realised distances in
 * `calibrateBands` below, and travel with the outlook so the page cannot apply
 * stale numbers to them.
 */
export interface Bands {
  /** Median neighbour distance at this position, the "genuine match" line. */
  close: number;
  /** Past this a comparable is worth showing but not weighing. */
  loose: number;
  /** Nearest season past this and there is no analogue at all. */
  noAnalogue: number;
}

/** Spread of each feature, so distances are comparable across them. */
type Scales = Record<Feature, number>;

interface HistoricalSeason extends ProfileFeatures {
  playerId: string;
  name: string;
  season: number;
  ownPoints: number;
  nextPoints: number;
  nextPpg: number;
  nextGames: number;
  nextPlayed: boolean;
}

export class ComparableIndex {
  private byPosition = new Map<string, HistoricalSeason[]>();
  private scales = new Map<string, Scales>();
  private replacement = new Map<string, number>();
  private top12 = new Map<string, number>();
  private bands = new Map<string, Bands>();
  private span = { from: 0, to: 0 };
  private k: number;

  constructor(
    pointsBySeason: Map<string, number>,
    currentSeason: number,
    format: string,
    teams: number,
    k = 40,
  ) {
    this.k = k;
    /*
     * Appearances come from snap counts, not from stat lines.
     *
     * `player_usage.games` counts games with a stat line, so a healthy back who
     * spent the year blocking looks identical to one who was injured — 108
     * players differ by four or more games (bug #40). Availability and points
     * per game are both wrong if this is taken from the wrong place.
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
     * How long each season ran, so a 17-game year is not scored as more
     * available than a 16-game one.
     */
    const seasonLength = new Map<number, number>();
    for (const r of sqlite
      .prepare(
        `SELECT season, MAX(week) w FROM player_stats_week
         WHERE season_type = 'REG' GROUP BY season`,
      )
      .all() as Array<{ season: number; w: number }>) {
      seasonLength.set(r.season, r.w);
    }

    const rows = sqlite
      .prepare(
        `SELECT u.player_id AS playerId, p.display_name AS name, u.season, u.position,
                COALESCE(u.target_share, 0) AS targetShare,
                COALESCE(u.pass_snap_share, 0) AS routeShare,
                COALESCE(u.rz_touch_share, 0) AS rzShare,
                COALESCE(u.goal_line_share, 0) AS goalLineShare,
                COALESCE(u.rush_share, 0) AS rushShare,
                u.season - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age
         FROM player_usage u
         JOIN players p ON p.gsis_id = u.player_id
         WHERE u.games >= 6 AND u.season < ? AND u.position IN ('QB','WR','RB','TE')`,
      )
      .all(currentSeason) as Array<
      Omit<HistoricalSeason, 'ppg' | 'availability' | 'ownPoints' | 'nextPoints' | 'nextPpg' | 'nextGames' | 'nextPlayed'> & {
        position: string;
      }
    >;

    for (const r of rows) {
      if (r.age === null || !Number.isFinite(r.age)) continue;

      /*
       * A season teaches nothing unless the following year has been played and
       * recorded. That is a statement about the DATA, and it is the only reason
       * to drop a row.
       *
       * The old test was whether the player himself had a following-year stat
       * line, which quietly deleted everyone who retired, was cut, or missed the
       * whole year — the single worst outcome a fantasy pick has. Those rows are
       * now kept at zero, which is what actually happened.
       */
      if (!seasonLength.has(r.season + 1)) continue;

      const games = appearances.get(`${r.playerId}|${r.season}`) ?? 0;
      if (games < 6) continue;

      const nextGames = appearances.get(`${r.playerId}|${r.season + 1}`) ?? 0;
      const nextPoints = nextGames > 0 ? pointsBySeason.get(`${r.playerId}|${r.season + 1}`) ?? 0 : 0;
      const ownPoints = pointsBySeason.get(`${r.playerId}|${r.season}`) ?? 0;

      const list = this.byPosition.get(r.position) ?? [];
      list.push({
        ...r,
        ownPoints,
        ppg: ownPoints / games,
        availability: games / (seasonLength.get(r.season) ?? 17),
        nextPoints,
        nextGames,
        nextPpg: nextGames > 0 ? nextPoints / nextGames : 0,
        nextPlayed: nextGames > 0,
      });
      this.byPosition.set(r.position, list);
    }

    {
      const seasons = [...this.byPosition.values()].flat().map((r) => r.season);
      this.span = { from: Math.min(...seasons), to: Math.max(...seasons) };
    }

    /*
     * Scales come from the players who hold a role, measured by interquartile
     * range rather than standard deviation.
     *
     * Both changes fix the same distortion. Using SD across every season put
     * ~100 deep backups clustered near zero target share into the denominator,
     * which drove that scale down to 0.046 — so a six-point difference in target
     * share read as 1.3 standard deviations and contributed 3.06 to the
     * distance, while rush share (the strongest RB predictor, and the highest
     * weight in the model) contributed 0.04. Target and route share were 93% of
     * every RB comparison. The metric was measuring how unusual a player's
     * receiving role is, not how alike two backs are.
     *
     * IQR ignores the mass piled at zero, and restricting to role-holders means
     * the spread describes the population a comparable can actually come from.
     */
    for (const [position, list] of this.byPosition) {
      const primary = (r: HistoricalSeason) =>
        position === 'RB' ? r.rushShare : position === 'QB' ? r.routeShare : r.targetShare;
      const holders = list.filter((r) => primary(r) >= (position === 'QB' ? 0.4 : 0.1));
      const pool = holders.length >= 30 ? holders : list;
      const scales = {} as Scales;
      for (const f of FEATURES) scales[f] = iqr(pool.map((r) => r[f]));
      this.scales.set(position, scales);
    }

    for (const r of sqlite
      .prepare(
        `SELECT position, AVG(points) p FROM replacement_level
         WHERE format = ? AND teams = ? AND season >= ? GROUP BY position`,
      )
      .all(format, teams, currentSeason - 3) as Array<{ position: string; p: number }>) {
      this.replacement.set(r.position, r.p);
    }

    // A top-12 season at the position is the working definition of a breakout:
    // a player you start every week.
    for (const [position, list] of this.byPosition) {
      const bySeason = new Map<number, number[]>();
      for (const r of list) {
        const arr = bySeason.get(r.season + 1) ?? [];
        arr.push(r.nextPoints);
        bySeason.set(r.season + 1, arr);
      }
      const cutoffs: number[] = [];
      for (const arr of bySeason.values()) {
        if (arr.length < 12) continue;
        arr.sort((a, b) => b - a);
        cutoffs.push(arr[11]!);
      }
      if (cutoffs.length) {
        this.top12.set(position, cutoffs.reduce((a, b) => a + b, 0) / cutoffs.length);
      }
    }

    this.calibrateBands();
  }

  /**
   * What "close" means at each position, from that position's own distances.
   *
   * Every season in the pool is looked up against every other, and the bands are
   * read off the realised distribution: `close` is the median neighbour, so a
   * typical player's neighbourhood is about half genuine matches and the label
   * has somewhere to move in both directions. `noAnalogue` is the 95th
   * percentile of nearest-comp distances, which by construction flags the ~5% of
   * players at each position who have no precedent rather than a fixed share of
   * whichever position happens to have the smallest pool.
   */
  private calibrateBands() {
    for (const [position, list] of this.byPosition) {
      if (list.length <= this.k) {
        this.bands.set(position, { close: 1.35, loose: 1.75, noAnalogue: 2.2 });
        continue;
      }

      const neighbourDistances: number[] = [];
      const nearestDistances: number[] = [];

      for (const target of list) {
        const ds: number[] = [];
        for (const cand of list) {
          if (cand.playerId === target.playerId) continue;
          ds.push(this.distance(position, cand, target));
        }
        ds.sort((a, b) => a - b);
        const picked = ds.slice(0, this.k);
        nearestDistances.push(picked[0]!);
        neighbourDistances.push(picked[Math.floor(picked.length / 2)]!);
      }

      neighbourDistances.sort((a, b) => a - b);
      nearestDistances.sort((a, b) => a - b);
      const at = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]!;

      const close = at(neighbourDistances, 0.5);
      this.bands.set(position, {
        close,
        loose: at(neighbourDistances, 0.8),
        /*
         * The nearest distance is a minimum over forty draws, so its 95th
         * percentile sits well below the median neighbour distance — taken
         * alone it flagged backs at 1.31 as having no analogue while the
         * typical back's median neighbour sits at 1.40, so the two labels
         * contradicted each other. Floored at `close`, the claim becomes one a
         * reader can check: even his single closest season is further away than
         * a normal player's middling one.
         */
        noAnalogue: Math.max(at(nearestDistances, 0.95), close),
      });
    }
  }

  /** The weighted distance between two profiles, in standardised feature units. */
  private distance(position: string, a: ProfileFeatures, b: ProfileFeatures): number {
    const w = WEIGHTS[position]!;
    const scale = this.scales.get(position)!;
    let sum = 0;
    for (const key of FEATURES) {
      if (w[key] <= 0) continue;
      // Participation data starts in 2021, so seasons backfilled before that
      // have no route share. A missing feature must not read as a zero — that
      // would make an old season look like a player who never took the field
      // (bug #50).
      if (key === 'routeShare' && (a.routeShare <= 0 || b.routeShare <= 0)) continue;
      sum += w[key] * ((a[key] - b[key]) / (scale[key] || 1)) ** 2;
    }
    return Math.sqrt(sum);
  }

  /** The measured distance bands for a position. */
  bandsFor(position: string): Bands {
    return this.bands.get(position) ?? { close: 1.35, loose: 1.75, noAnalogue: 2.2 };
  }

  /** Replacement level for a position, on the actual-points scale. */
  replacementFor(position: string): number {
    return this.replacement.get(position) ?? 0;
  }

  /**
   * Nearest historical seasons, weighted by what actually predicts.
   *
   * `selfId` is the player being described. His own earlier seasons are excluded
   * from his own comparables: they are trivially the closest profile to him (his
   * 2023 and 2024 were the 15th and 16th "players like" Bijan Robinson), and a
   * panel titled "what happened to players like him" that answers with him is
   * not making the claim it appears to. The cost is measurable and small —
   * next-season correlation falls .677 to .675 for backs — and the alternative
   * is a leak.
   */
  outlook(position: string, f: ProfileFeatures, selfId: string | null, k = this.k): Outlook | null {
    const pool = this.byPosition.get(position);
    const scale = this.scales.get(position);
    const w = WEIGHTS[position];
    if (!pool || !scale || !w) return null;

    const candidates = selfId ? pool.filter((r) => r.playerId !== selfId) : pool;
    if (candidates.length < k) return null;

    const scored = candidates
      .map((r) => ({ r, d: this.distance(position, r, f) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k);

    const bands = this.bandsFor(position);
    const nearestDistance = scored[0]!.d;
    const closeShare = scored.filter((s) => s.d <= bands.close).length / scored.length;
    /*
     * Tiers sit either side of the median player, since `bands.close` is defined
     * as the median neighbour distance for the position. A typical player lands
     * near 0.5, so "strong" and "thin" both describe a real departure from
     * normal rather than one of them being the default.
     */
    const support: Support = closeShare >= 0.65 ? 'strong' : closeShare >= 0.3 ? 'fair' : 'thin';

    const nearest = (n: number) =>
      scored.slice(0, n).map((s) => ({
        playerId: s.r.playerId,
        name: s.r.name,
        season: s.r.season,
        ownPoints: s.r.ownPoints,
        ownPpg: s.r.ppg,
        nextPoints: s.r.nextPoints,
        nextPpg: s.r.nextPpg,
        nextGames: s.r.nextGames,
        nextPlayed: s.r.nextPlayed,
        distance: s.d,
      }));

    /*
     * No analogue: a real finding about him, and NOT a reason to withhold the
     * range. Measured, not assumed.
     *
     * This branch used to return zeroes for the floor, median and ceiling, so
     * the ~8% of players with no close precedent got a comparison list and no
     * chart while everyone else got both. That put four of the twelve most
     * expensive players on the board — Nacua, Smith-Njigba, McCaffrey, Rice —
     * on a different panel from the rest, which reads as a missing feature
     * rather than as the finding it is.
     *
     * `calibrate:comparables` now tests the gate against the standard the
     * project already applies to the other quality axis. Replicating the
     * shipped band exactly and bucketing every backtest season either side of
     * it, interval coverage against a 0.60 target:
     *
     *   pos    shown   SUPPRESSED     MAE shown -> suppressed     n
     *   QB      0.58      0.83            86.5 -> 51.7            8
     *   RB      0.60      0.46            43.3 -> 79.8           15
     *   WR      0.62      0.89            33.8 -> 39.5           33
     *   TE      0.57      0.65            25.0 -> 32.9           18
     *
     * The same shape the closeShare buckets found: A THIN NEIGHBOURHOOD BREAKS
     * THE MIDPOINT, NOT THE RANGE. The error on the median roughly doubles at
     * RB and worsens at WR and TE, while coverage holds or runs WIDE — 0.89 at
     * receiver, the biggest suppressed group and the position 11 of 13 picks
     * come from. A band that covers 89% of outcomes is vague, not misleading,
     * and vague-but-drawn beats absent. RB is the one dissent at 0.46 on 15
     * seasons; the group totals 74 seasons, so this is directional evidence and
     * the copy on the page says which half of it to trust.
     *
     * So the range is computed for everyone below, and `sparse` keeps doing the
     * two jobs it has earned: it drives the warning on the panel, and it still
     * suppresses the RATES and the ranked percentiles, which this measurement
     * does not cover and #93 was about.
     */
    const repl = this.replacement.get(position) ?? 0;
    const top = this.top12.get(position) ?? Infinity;

    /*
     * Closer seasons count for more.
     *
     * The 40th neighbour is a much weaker analogy than the 1st and was carrying
     * exactly the same vote. The 0.35 floor stops a near-identical season from
     * dominating the whole distribution.
     */
    const weightOf = (d: number) => 1 / (0.35 + d);

    /*
     * The range is drawn from the seasons where he took the field; whether he
     * took the field at all is `vanishRate` beside it.
     *
     * Mixing the two puts "was out of the league" into a number labelled floor,
     * and a floor of 40 that means "retired" cannot be read as a floor. Measured
     * both ways: splitting them lands interval coverage at 0.60/0.63/0.58 for
     * RB/WR/TE against a 0.60 target, where mixing them gives 0.66/0.66/0.66 —
     * a band too wide to say anything.
     */
    const survivors = scored.filter((s) => s.r.nextPlayed);
    const bandOf = (value: (s: (typeof scored)[number]) => number) => {
      const sorted = survivors
        .map((s) => ({ v: value(s), w: weightOf(s.d) }))
        .sort((a, b) => a.v - b.v);
      return {
        floor: wq(sorted, 0.2),
        median: wq(sorted, 0.5),
        ceiling: wq(sorted, 0.8),
      };
    };

    const total = bandOf((s) => s.r.nextPoints);
    const perGame = bandOf((s) => s.r.nextPpg);

    const totalWeight = scored.reduce((a, s) => a + weightOf(s.d), 0);
    const rate = (test: (s: (typeof scored)[number]) => boolean) =>
      scored.reduce((a, s) => a + (test(s) ? weightOf(s.d) : 0), 0) / totalWeight;

    const nextGames = survivors.map((s) => s.r.nextGames).sort((a, b) => a - b);

    /*
     * The rates, and only the rates, are still withheld with no analogue.
     *
     * The measurement above covers the BAND — where the outcome landed — and
     * the midpoint. It says nothing about whether "31% of them busted" is
     * trustworthy when none of the forty resembles him, so that claim is not
     * made. Zeroes rather than nulls because JSON.stringify turns NaN into
     * null and the consumers then called .toFixed on it; `sparse` is what gates
     * them, the page renders an em dash, and the audit check
     * `a sparse outlook is never ranked` enforces that the percentiles stay
     * null. That check exists because the previous version of this contract was
     * a comment saying "these are never read", which expired silently (#93).
     */
    const noAnalogue = nearestDistance > bands.noAnalogue;
    const rates = noAnalogue
      ? { hitRate: 0, breakoutRate: 0, bustRate: 0, vanishRate: 0 }
      : {
          hitRate: rate((s) => s.r.nextPoints > repl),
          breakoutRate: rate((s) => s.r.nextPoints >= top),
          /*
           * The bust bar is REPLACEMENT, not half of it.
           *
           * Half of replacement landed at a wildly different depth per position
           * — about QB27, RB54, TE35 and WR90 — so a receiver had to fall out of
           * the league to "bust" while a quarterback only had to be a backup.
           * Median raw bust rate ran 5% for receivers against 20% for backs, and
           * that gap was the bar rather than the risk. At replacement itself the
           * event means the same thing everywhere: he was worth less than the
           * man you could have had for nothing.
           *
           * NOTE WHAT THIS MAKES IT. `hitRate` is `> repl`, so `bustRate` is now
           * its exact complement — the two sum to one, and they are one
           * measurement with two names, not two pieces of evidence. Written as
           * `<=` rather than `<` so that is exactly true rather than nearly
           * true, and an audit check enforces the sum. Anything reading both
           * must not treat them as independent confirmation.
           */
          bustRate: rate((s) => s.r.nextPoints <= repl),
          vanishRate: rate((s) => !s.r.nextPlayed),
        };

    return {
      n: scored.length,
      fromSeason: this.span.from,
      toSeason: this.span.to,
      outcomeFromSeason: this.span.from + 1,
      outcomeToSeason: this.span.to + 1,
      sparse: noAnalogue,
      support: noAnalogue ? 'thin' : support,
      closeShare,
      nearestDistance,
      bands,
      ...total,
      floorPpg: perGame.floor,
      medianPpg: perGame.median,
      ceilingPpg: perGame.ceiling,
      ...rates,
      medianNextGames: nextGames.length ? nextGames[Math.floor(nextGames.length / 2)]! : 0,
      nearest: nearest(6),
    };
  }
}

/**
 * Weighted quantile over (value, weight) pairs already sorted by value,
 * interpolated between the two observations that straddle it.
 *
 * Returning the first observation past the cumulative-weight line instead makes
 * the answer a member of the sample, and with a small pool and overlapping
 * neighbourhoods it keeps landing on the SAME member: every starting
 * quarterback came back with a median of exactly 246, which is one particular
 * historical season rather than a statement about any of them. A number that
 * identical across players is the "default shown as measurement" family wearing
 * a different hat.
 *
 * Weights are placed at the midpoint of each observation's own mass, which is
 * the standard construction and makes the median of two equal weights their
 * average rather than the larger of them.
 */
function wq(sorted: Array<{ v: number; w: number }>, p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0]!.v;

  const total = sorted.reduce((a, b) => a + b.w, 0);
  if (total <= 0) return sorted[Math.floor(p * (sorted.length - 1))]!.v;

  const cum: number[] = [];
  let acc = 0;
  for (const s of sorted) {
    cum.push((acc + s.w / 2) / total);
    acc += s.w;
  }

  if (p <= cum[0]!) return sorted[0]!.v;
  if (p >= cum[cum.length - 1]!) return sorted[sorted.length - 1]!.v;

  for (let i = 1; i < cum.length; i++) {
    if (p <= cum[i]!) {
      const span = cum[i]! - cum[i - 1]!;
      const t = span > 0 ? (p - cum[i - 1]!) / span : 0;
      return sorted[i - 1]!.v + t * (sorted[i]!.v - sorted[i - 1]!.v);
    }
  }
  return sorted[sorted.length - 1]!.v;
}

/** Interquartile range, a spread that the mass of backups at zero cannot squash. */
function iqr(values: number[]): number {
  if (values.length < 4) return sd(values);
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.floor(s.length * p)]!;
  return q(0.75) - q(0.25) || sd(values);
}

function sd(values: number[]): number {
  if (values.length < 2) return 1;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length) || 1;
}

/**
 * What kind of player he is, from what he actually does rather than reputation.
 *
 * Thresholds come from the distribution of each share within the position, so
 * the labels describe where he sits among his peers rather than an absolute
 * standard.
 */
export function archetype(position: string, f: ProfileFeatures, adot: number | null): string {
  /*
   * Quarterbacks fell through to the receiver branch, which described Kyler
   * Murray as a "full-time, secondary target" — a statement about target share,
   * which is ~0 for every quarterback alive. Same family of error as tagging a
   * quarterback a "depth target".
   *
   * `routeShare` is pass-snap share here, which for this position means starter
   * share. Rushing volume is the axis that actually separates quarterbacks: the
   * median starter takes 12% of his team's carries and the 75th percentile 18%.
   */
  if (position === 'QB') {
    if (f.routeShare < 0.5) return 'backup quarterback';
    if (f.rushShare >= 0.18 && f.goalLineShare >= 0.2) return 'dual threat who takes the goal line';
    if (f.rushShare >= 0.18) return 'dual-threat quarterback';
    if (f.rushShare >= 0.12) return 'mobile pocket passer';
    return 'pocket passer';
  }

  if (position === 'RB') {
    if (f.rushShare >= 0.55 && f.goalLineShare >= 0.35) return 'bell cow with the goal line';
    if (f.rushShare >= 0.55) return 'volume back, shares the goal line';
    if (f.targetShare >= 0.12 && f.rushShare < 0.45) return 'passing-down back';
    if (f.goalLineShare >= 0.35) return 'goal-line specialist';
    if (f.rushShare >= 0.35) return 'committee back';
    return 'depth back';
  }

  const deep = adot !== null && adot >= 12;
  const shallow = adot !== null && adot <= 8;

  if (position === 'TE') {
    if (f.targetShare >= 0.2 && f.rzShare >= 0.12) return 'featured tight end';
    if (f.routeShare >= 0.8 && f.targetShare < 0.15) return 'full-time blocker, low volume';
    if (f.rzShare >= 0.12) return 'red-zone tight end';
    return 'rotational tight end';
  }

  if (f.targetShare >= 0.25 && f.rzShare >= 0.12) return 'true WR1 with scoring role';
  if (f.targetShare >= 0.25) return 'volume WR1, thin at the goal line';
  if (deep && f.targetShare >= 0.15) return 'field-stretcher';
  if (shallow && f.targetShare >= 0.18) return 'high-volume underneath';
  if (f.rzShare >= 0.14) return 'red-zone target, low volume';
  if (f.routeShare >= 0.8) return 'full-time, secondary target';
  return 'rotational receiver';
}
