import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';

/**
 * nflverse player registry. gsis_id is our canonical player key — every other
 * source (ADP, sportsbooks, snap counts) resolves into it via playerAliases.
 */
export const players = sqliteTable(
  'players',
  {
    gsisId: text('gsis_id').primaryKey(),
    displayName: text('display_name').notNull(),
    // nflverse's preferred short form ("Cam" where display_name says "Cameron").
    // Sportsbooks lean toward this one, so it earns its own alias candidate.
    footballName: text('football_name'),
    shortName: text('short_name'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    suffix: text('suffix'),
    normalizedName: text('normalized_name').notNull(),
    position: text('position'),
    positionGroup: text('position_group'),
    latestTeam: text('latest_team'),
    status: text('status'),
    rookieSeason: integer('rookie_season'),
    lastSeason: integer('last_season'),
    /** Needed for age curves: tight ends and backs decline on a schedule. */
    birthDate: text('birth_date'),
    // Cross-source ids. pfrId is the bridge to snap counts, which key on PFR.
    pfrId: text('pfr_id'),
    espnId: text('espn_id'),
    pffId: text('pff_id'),
    esbId: text('esb_id'),
  },
  (t) => [
    index('players_normalized_idx').on(t.normalizedName),
    index('players_pfr_idx').on(t.pfrId),
    index('players_pos_team_idx').on(t.position, t.latestTeam),
  ],
);

/**
 * Weekly box scores. Two jobs: actuals for the ADP baseline curve (section 3),
 * and the context trends on a player card (target share, aDOT).
 *
 * fantasyPointsHalf is computed at ingest — nflverse ships standard and PPR
 * columns but not half, so it is standard + 0.5/reception.
 */
export const playerStatsWeek = sqliteTable(
  'player_stats_week',
  {
    playerId: text('player_id').notNull(),
    season: integer('season').notNull(),
    week: integer('week').notNull(),
    seasonType: text('season_type').notNull(),
    recentTeam: text('recent_team'),
    position: text('position'),
    opponentTeam: text('opponent_team'),

    completions: integer('completions'),
    attempts: integer('attempts'),
    passingYards: real('passing_yards'),
    passingTds: integer('passing_tds'),
    interceptions: integer('interceptions'),
    sackFumblesLost: integer('sack_fumbles_lost'),
    passingAirYards: real('passing_air_yards'),
    passing2ptConversions: integer('passing_2pt_conversions'),

    carries: integer('carries'),
    rushingYards: real('rushing_yards'),
    rushingTds: integer('rushing_tds'),
    rushingFumblesLost: integer('rushing_fumbles_lost'),
    rushing2ptConversions: integer('rushing_2pt_conversions'),

    receptions: integer('receptions'),
    targets: integer('targets'),
    receivingYards: real('receiving_yards'),
    receivingTds: integer('receiving_tds'),
    receivingFumblesLost: integer('receiving_fumbles_lost'),
    receivingAirYards: real('receiving_air_yards'),
    receivingYardsAfterCatch: real('receiving_yards_after_catch'),
    receiving2ptConversions: integer('receiving_2pt_conversions'),

    // Context signals — supporting colour on the player card, never a ranking.
    targetShare: real('target_share'),
    airYardsShare: real('air_yards_share'),
    wopr: real('wopr'),
    racr: real('racr'),

    specialTeamsTds: integer('special_teams_tds'),
    fantasyPoints: real('fantasy_points'),
    fantasyPointsPpr: real('fantasy_points_ppr'),
    fantasyPointsHalf: real('fantasy_points_half'),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.season, t.week, t.seasonType] }),
    index('stats_season_idx').on(t.season, t.seasonType),
    index('stats_player_idx').on(t.playerId),
  ],
);

/** Snap share. Keyed on PFR id upstream; playerId is filled via players.pfrId. */
export const snapCounts = sqliteTable(
  'snap_counts',
  {
    pfrPlayerId: text('pfr_player_id').notNull(),
    playerId: text('player_id'),
    season: integer('season').notNull(),
    week: integer('week').notNull(),
    gameType: text('game_type'),
    team: text('team'),
    position: text('position'),
    offenseSnaps: real('offense_snaps'),
    offensePct: real('offense_pct'),
  },
  (t) => [
    primaryKey({ columns: [t.pfrPlayerId, t.season, t.week] }),
    index('snaps_player_idx').on(t.playerId),
  ],
);

/**
 * Raw FantasyFootballCalculator ADP, one row per player per (format, teams,
 * year). Historical years are kept because the baseline curve is fit across
 * seasons. ffcPlayerId is stable year over year, which makes that join exact.
 */
export const adpRaw = sqliteTable(
  'adp_raw',
  {
    ffcPlayerId: integer('ffc_player_id').notNull(),
    format: text('format').notNull(),
    teams: integer('teams').notNull(),
    year: integer('year').notNull(),
    playerId: text('player_id'),
    name: text('name').notNull(),
    position: text('position').notNull(),
    team: text('team'),
    adp: real('adp').notNull(),
    adpFormatted: text('adp_formatted'),
    timesDrafted: integer('times_drafted'),
    high: integer('high'),
    low: integer('low'),
    stdev: real('stdev'),
    bye: integer('bye'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ffcPlayerId, t.format, t.teams, t.year] }),
    index('adp_lookup_idx').on(t.format, t.teams, t.year),
    index('adp_player_idx').on(t.playerId),
  ],
);

/**
 * Name -> gsis_id crosswalk. Every external source writes names differently
 * ("A.J. Brown" / "AJ Brown" / "Brown, A.J."), and a silent miss drops a player
 * off the board entirely, so resolutions are stored with their method and
 * confidence rather than applied blindly.
 *
 * isManual rows are hand-corrections and are never overwritten by a re-run.
 */
export const playerAliases = sqliteTable(
  'player_aliases',
  {
    aliasText: text('alias_text').notNull(),
    source: text('source').notNull(),
    playerId: text('player_id'),
    rawName: text('raw_name').notNull(),
    position: text('position'),
    team: text('team'),
    method: text('method').notNull(),
    confidence: real('confidence').notNull(),
    isManual: integer('is_manual', { mode: 'boolean' }).notNull().default(false),
    resolvedAt: integer('resolved_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.aliasText, t.source] }),
    index('alias_player_idx').on(t.playerId),
    index('alias_unresolved_idx').on(t.source, t.playerId),
  ],
);

/**
 * Every prop line we have ever seen, append-only.
 *
 * Never updated in place: re-running the ingest adds rows rather than replacing
 * them, so line movement over the draft season falls out of the table for free.
 *
 * `scope` is inferred, not given — the provider ships season and per-game props
 * under the same market_key with no scope field anywhere in the payload.
 */
export const propLines = sqliteTable(
  'prop_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playerId: text('player_id'),
    rawPlayer: text('raw_player').notNull(),
    book: text('book').notNull(),
    marketKey: text('market_key').notNull(),
    stat: text('stat').notNull(),
    scope: text('scope').notNull(),
    scopeMethod: text('scope_method').notNull(),
    line: real('line').notNull(),
    overPrice: integer('over_price'),
    underPrice: integer('under_price'),
    eventId: text('event_id'),
    gameDate: text('game_date'),
    provider: text('provider').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    index('props_player_idx').on(t.playerId, t.scope, t.stat),
    index('props_fetched_idx').on(t.fetchedAt),
    index('props_raw_idx').on(t.rawPlayer),
  ],
);

/**
 * The market's implied projection for one stat, after devigging and combining
 * books. `source` records whether this came from a real line or was inferred
 * from one, so the UI can distinguish a priced number from a modelled one.
 */
export const impliedStats = sqliteTable(
  'implied_stats',
  {
    playerId: text('player_id').notNull(),
    scope: text('scope').notNull(),
    stat: text('stat').notNull(),
    mu: real('mu').notNull(),
    sigma: real('sigma'),
    line: real('line'),
    pOver: real('p_over'),
    source: text('source').notNull(),
    /**
     * How a non-market value was arrived at, e.g. which yards-per-reception
     * ratio converted a receiving line into receptions. A rookie has no history
     * to convert from, so the fallback is a position median — a materially
     * weaker assumption that the player page has to be able to state honestly.
     */
    basis: text('basis'),
    bookCount: integer('book_count').notNull(),
    bookSpread: real('book_spread'),
    methodVersion: text('method_version').notNull(),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.scope, t.stat] }),
    index('implied_player_idx').on(t.playerId),
  ],
);

/**
 * Predictive dispersion per stat, calibrated from nflverse rather than assumed.
 *
 * Needed because a betting line is roughly the median outcome, not the mean:
 * recovering a mean from a line and its price requires knowing how wide the
 * outcome distribution is. Measured as year-over-year variation in season
 * totals, which is the closest observable analogue to preseason uncertainty.
 */
export const statDispersion = sqliteTable(
  'stat_dispersion',
  {
    stat: text('stat').notNull(),
    scope: text('scope').notNull(),
    cv: real('cv').notNull(),
    sampleN: integer('sample_n').notNull(),
    calibratedAt: integer('calibrated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.stat, t.scope] })],
);

/**
 * Replacement level: the points a freely-available player at each position
 * returned in a given season. This is what makes cross-position comparison
 * honest — 300 QB points and 300 WR points are not worth the same thing.
 *
 * Derived from roster settings, not from ADP depth, because FFC's `teams`
 * parameter is cosmetic (it returns one pooled dataset for every league size).
 */
export const replacementLevel = sqliteTable(
  'replacement_level',
  {
    format: text('format').notNull(),
    teams: integer('teams').notNull(),
    season: integer('season').notNull(),
    position: text('position').notNull(),
    rankUsed: integer('rank_used').notNull(),
    points: real('points').notNull(),
    fittedAt: integer('fitted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.format, t.teams, t.season, t.position] })],
);

/**
 * The empirical answer to "what does a pick here actually return?" — fitted
 * from historical ADP joined to that same season's real outcomes, including
 * the zeros from players who got hurt. No projections and no opinions feed it.
 *
 * Stored as a dense grid over draft slots so the value engine can both read
 * expected value at an ADP and invert it to find the ADP a projection implies.
 */
export const adpBaseline = sqliteTable(
  'adp_baseline',
  {
    format: text('format').notNull(),
    teams: integer('teams').notNull(),
    /**
     * Fitted per position, with 'ALL' kept as a fallback for positions too thin
     * to fit alone.
     *
     * A pooled curve assumes a pick at 50 returns the same whatever position it
     * is spent on, which is false — receivers and backs have different bust
     * rates and different value decay. Pooling let the position mix at each
     * draft slot drive the answer instead of the player.
     */
    position: text('position').notNull(),
    adpSlot: real('adp_slot').notNull(),
    expectedPoints: real('expected_points').notNull(),
    expectedVorp: real('expected_vorp').notNull(),
    sampleN: integer('sample_n').notNull(),
    fittedAt: integer('fitted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.format, t.teams, t.position, t.adpSlot] })],
);

/**
 * The board. One row per player per format, holding the market's implied value
 * and how far it sits from what that draft slot has historically returned.
 *
 * `signal` is the honesty column: players whose position-defining props are not
 * posted anywhere get 'none' and are shown with ADP only. The tool never
 * invents a projection to fill a gap.
 */
export const valueScores = sqliteTable(
  'value_scores',
  {
    playerId: text('player_id').notNull(),
    format: text('format').notNull(),
    teams: integer('teams').notNull(),
    season: integer('season').notNull(),
    position: text('position').notNull(),
    adp: real('adp').notNull(),
    impliedPoints: real('implied_points'),
    impliedVorp: real('implied_vorp'),
    expectedVorp: real('expected_vorp').notNull(),
    /** Headline metric: how many picks of value the market says you are getting. */
    slotGap: real('slot_gap'),
    adpEquivalent: real('adp_equivalent'),
    vorpGap: real('vorp_gap'),
    signal: text('signal').notNull(),
    completeness: real('completeness').notNull(),

    /*
     * The second, independent view: what last season's on-field usage implies,
     * ranked within position. Kept beside the market rather than folded into
     * it — where the two disagree is the actionable part, and blending would
     * hide which half is driving the number.
     */
    usageGrade: integer('usage_grade'),
    usagePoints: real('usage_points'),
    /** The market's own view expressed the same way, so the two are comparable. */
    marketPct: integer('market_pct'),
    usageGap: integer('usage_gap'),

    /*
     * The combined view, plus its parts. Kept decomposed on purpose — a single
     * number that cannot be taken apart is not auditable, and the split between
     * market and usage is a judgment call rather than a calibrated one.
     */
    blendedPoints: real('blended_points'),
    /**
     * Points over replacement — the board's sort order, stored rather than
     * recomputed.
     *
     * It must be written here because the correct replacement level depends on
     * which scale the projection is on. A player with market coverage is on the
     * actual-points scale and compares against actual-points replacement; a
     * usage-only player is on the regressed usage scale and must compare against
     * replacement measured in usage units, which sits ~20 points lower. The
     * board previously recomputed this in SQL with the actual-points figure for
     * everybody, which charged every uncovered player about 20 phantom points
     * and made "no betting lines" look identical to "not good".
     */
    blendedVorp: real('blended_vorp'),
    /**
     * What he is worth IF the job ahead of him opens, and how likely that is.
     *
     * Kept beside the expectation rather than folded into it. A backup's outcome
     * is not a bell curve around his mean — it is a coin flip between irrelevant
     * and league-winning, and averaging those describes neither. Jaydon Blue
     * reads −64 as an expectation and 156 points if Javonte Williams goes down.
     */
    upsidePoints: real('upside_points'),
    upsideChance: real('upside_chance'),
    upsideGain: real('upside_gain'),
    blendedSlotGap: real('blended_slot_gap'),
    blendedAdpEquivalent: real('blended_adp_equivalent'),
    marketZ: real('market_z'),
    usageZ: real('usage_z'),
    /** usageZ minus marketZ, in standard deviations. The signal to read. */
    disagreement: real('disagreement'),
    marketWeight: real('market_weight'),
    verdict: text('verdict'),
    /** Risk factors, kept separate so the read can explain itself. */
    expectedGames: real('expected_games'),
    tdOverExpected: real('td_over_expected'),
    riskNotes: text('risk_notes'),
    /** Share of his team's prior-season volume that has left the roster. */
    vacatedShare: real('vacated_share'),
    opportunityNote: text('opportunity_note'),
    /**
     * The read, as JSON tags. Each carries its own explanation and the number
     * behind it, so the board can show them, explain them on hover, and filter
     * on them — none of which a single verdict string supported.
     */
    tags: text('tags'),
    /**
     * The case for and against, as JSON — one verdict plus the argument.
     *
     * Replaces the flat tag list as the primary read. Tags were peers, so a
     * player could carry GEM and NO UPSIDE at once with nothing to say which the
     * page meant. Here there is exactly one headline and everything else is
     * evidence stamped with its own strength, so conflict between two points is
     * the argument working rather than the page contradicting itself.
     */
    playerCase: text('player_case'),
    /**
     * Value over next available: points he is worth above the best player at his
     * position expected to survive until the drafter's next turn (24 picks in a
     * 12-team snake). The question VALUE cannot answer — VORP compares to a free
     * replacement, a drafter is choosing among the players still on the board.
     */
    vona: real('vona'),
    /** The same over one round, for a drafter at the turn rather than the wall. */
    vonaRound: real('vona_round'),
    /** Drop to the very next man at his position by ADP, and who that is. */
    dropToNext: real('drop_to_next'),
    nextAtPosition: text('next_at_position'),
    /**
     * Expected share of his games spent as a startable option at his position.
     *
     * A RESTATEMENT of the projection in weekly units, never an input to it:
     * measured over 1,782 season pairs, startable rate carries nothing after
     * points per game (partial −0.03 WR, 0.06 RB, 0.04 TE, 0.14 QB). It earns a
     * place because it states the same forecast in the terms the league is
     * played in, not because it adds information.
     */
    startableRate: real('startable_rate'),
    /**
     * Did he hold a real role last season — 10+ games AND 80+ points.
     *
     * Late in the draft this separates two populations the ADP ordering cannot
     * compare, and the ordering is only meaningful inside each. Among late picks
     * who held a role, taking the earlier one is worth **41 points**; among those
     * who did not, **14**. Splitting past pick 85 lifts the within-group ranking
     * from .193 to .324, and the gain survives dropping any single season.
     *
     * The definition is measured, not typed: looser versions that fire on 70-81%
     * of the late board all come out NEGATIVE, which is the dead-threshold
     * family — a split that puts nearly everyone on one side separates nobody.
     */
    heldRole: integer('held_role', { mode: 'boolean' }),
    /**
     * The bust-to-breakout axis, 0-100, ranked within position and draft band.
     *
     * Replaces the separate UPSIDE and BUST columns, which were one measurement
     * shown twice: they correlate −0.87, and NEITHER survives the other — the
     * partial of upside after bust is .020 pooled, bust after upside −.051. Two
     * columns of one number invite a reader to count it as two reasons.
     *
     * Built as the mean of the breakout rank and the reversed bust rank, because
     * averaging two correlated readings of the same latent quantity cancels part
     * of the noise in each. Measured rather than assumed: the average beats or
     * ties both halves in every band that carries signal (rounds 1-3 .373 against
     * .358 and .367; rounds 11+ .420 against .412 and .395).
     *
     * High is good. It is the one-number summary of the comparables panel.
     */
    outlookPctile: real('outlook_pctile'),
    /*
     * The two halves of that axis, ranked within position AND draft band.
     *
     * Kept because the hover explains OUTLOOK as an average of these two, and an
     * explanation whose inputs are not stored cannot be checked against the
     * figure it explains. They are never ranked on directly — at −0.87 correlated
     * they are one measurement with the sign flipped, and neither survives the
     * other (partials .020 and −.051).
     *
     * These were written by `build:blend` and read by the audit for a long time
     * without ever being declared here, which is a drift that stayed invisible
     * until a schema push went looking for columns it did not know about and
     * removed them.
     */
    breakoutPctile: real('breakout_pctile'),
    bustPctile: real('bust_pctile'),
    /** Range of outcomes from the most similar historical player-seasons. */
    outlook: text('outlook'),
    /**
     * The arithmetic behind VALUE, step by step, as JSON.
     *
     * Stored rather than recomputed because the page cannot re-run the blend:
     * it would need the whole positional distribution, the fitted model and the
     * baseline curve to reproduce one player's number. Storing the derivation
     * beside the result also means the explanation can never drift from the
     * figure it explains.
     */
    derivation: text('derivation'),
    /** Per-predictor contributions from the usage model, as JSON. */
    usageInputs: text('usage_inputs'),
    /** What kind of player he is, from what he actually does. */
    archetype: text('archetype'),
    marketStats: integer('market_stats').notNull(),
    /**
     * Stats scaled up from a per-game line rather than taken from a season one.
     * A single Week 1 line carries matchup noise a season line does not, so a
     * projection leaning on these deserves less trust even when complete.
     */
    extrapolatedStats: integer('extrapolated_stats').notNull().default(0),
    derivedStats: integer('derived_stats').notNull(),
    baselineSampleN: integer('baseline_sample_n').notNull(),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.format, t.teams, t.season] }),
    index('value_slotgap_idx').on(t.format, t.teams, t.season, t.slotGap),
  ],
);

/**
 * What comparable historical seasons went on to do, for every player with a
 * measured role — not only the ones the ADP feed prices.
 *
 * This lives in its own table rather than on `value_scores` because
 * `value_scores` exists only for players with an ADP. That meant the single most
 * informative panel on the player page was absent for every undrafted player,
 * which is precisely the population a waiver claim comes from: 163 players had
 * an outlook and roughly 800 with a real role had none. Same family as bug #13,
 * where the board universe was mistaken for the player universe.
 */
export const playerOutlook = sqliteTable(
  'player_outlook',
  {
    playerId: text('player_id').notNull(),
    format: text('format').notNull(),
    teams: integer('teams').notNull(),
    /** The season being projected INTO. */
    season: integer('season').notNull(),
    position: text('position').notNull(),
    /** Which season's usage described him — this one when live, else last. */
    profileSeason: integer('profile_season').notNull(),
    /** Games behind the profile, so a week-3 read is not read as a full season. */
    profileGames: integer('profile_games').notNull(),
    /** The full Outlook, as JSON. */
    outlook: text('outlook').notNull(),
    archetype: text('archetype'),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.format, t.teams, t.season] }),
    index('outlook_pos_idx').on(t.format, t.teams, t.season, t.position),
  ],
);

/**
 * How well the usage model fit, per position — persisted because the blend needs
 * it, not as a scorecard.
 *
 * A multiple regression's fitted values have standard deviation R × sd(actual),
 * where R is the multiple correlation. So the usage projection is not merely
 * "a bit conservative": it is compressed by a known factor, and that factor
 * moves every time the model is refit. Storing it lets the blend put usage-only
 * players back on the actual-points scale instead of maintaining a second
 * replacement level to compare them against.
 *
 * This matters more in-season than in August: the model is refit as games are
 * played, so the compression changes underneath the board. Reading it from here
 * means the correction tracks the model rather than a number someone wrote down
 * once.
 */
export const usageModelFit = sqliteTable(
  'usage_model_fit',
  {
    format: text('format').notNull(),
    teams: integer('teams').notNull(),
    season: integer('season').notNull(),
    position: text('position').notNull(),
    /** In-sample R² of the fit that produced the current projections. */
    r2: real('r2').notNull(),
    n: integer('n').notNull(),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.format, t.teams, t.season, t.position] })],
);

/**
 * The offence a player plays in, per season.
 *
 * Fantasy production is a share of a team's output, so the size of that output
 * is half the answer and it was nowhere in this project. Ranks are stored rather
 * than derived at read time: a rank is meaningless without the population it was
 * taken over, and recomputing it in three queries is how two pages end up
 * disagreeing about who the 11th-best offence is.
 */
export const teamContext = sqliteTable(
  'team_context',
  {
    season: integer('season').notNull(),
    team: text('team').notNull(),
    games: integer('games').notNull(),
    /** Actual points scored, from final scores — not a proxy. */
    pointsFor: integer('points_for'),
    /** 1 = highest scoring offence in the league that season. */
    pointsRank: integer('points_rank'),
    offEpaPlay: real('off_epa_play'),
    offEpaRank: integer('off_epa_rank'),
    /** Whoever took the most dropbacks, so a mid-season change is reflected. */
    primaryQbId: text('primary_qb_id'),
    /** His share of team dropbacks, so the EPA is not pinned on one name when
     *  the team used three passers. */
    primaryQbShare: real('primary_qb_share'),
    qbEpaDropback: real('qb_epa_dropback'),
    qbEpaRank: integer('qb_epa_rank'),
    /** Pass rate over expected — how pass-happy the play caller is for real. */
    passOe: real('pass_oe'),
    rushEpaPlay: real('rush_epa_play'),

    /**
     * Head coach, from play-by-play. Not the offensive coordinator — nflverse
     * publishes no coordinator table anywhere — so for teams where the head
     * coach calls plays this is exact and elsewhere it is a proxy for the staff
     * he hired. Named for what it is.
     */
    headCoach: text('head_coach'),

    /*
     * The offensive line, as close as public data gets.
     *
     * Yards before contact is the standard split: what the blocking creates
     * before anybody touches the back, against yards after contact, which is the
     * back. Stuff rate is the failure mode that split misses — a line can
     * average well and still be blown up on a fifth of its carries.
     *
     * Pass protection is sacks and hits allowed per dropback. `was_pressure` in
     * the participation file is populated on 100% of plays and is unusable
     * (bug #1), so this comes from the events pbp actually records.
     */
    ybcPerCarry: real('ybc_per_carry'),
    ybcRank: integer('ybc_rank'),
    stuffRate: real('stuff_rate'),
    sackRateAllowed: real('sack_rate_allowed'),
    qbHitRateAllowed: real('qb_hit_rate_allowed'),
    passBlockRank: integer('pass_block_rank'),
    /**
     * Share of team carries run outside (`run_gap = 'end'`).
     *
     * Run DIRECTION, not blocking scheme. nflverse charts no zone/gap flag; this
     * is the closest public proxy and is named for what it measures.
     */
    outsideRunShare: real('outside_run_share'),
    plays: integer('plays'),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.season, t.team] })],
);

/**
 * How a player is used inside that offence, from play-by-play.
 *
 * Carries split by direction, first downs, and EPA per touch — the things a box
 * score cannot express. Kept separate from `player_usage` because that table is
 * shares of team volume and this is what happened on the plays themselves.
 */
export const playerScheme = sqliteTable(
  'player_scheme',
  {
    playerId: text('player_id').notNull(),
    season: integer('season').notNull(),
    team: text('team'),
    carries: integer('carries').notNull().default(0),
    rushYards: real('rush_yards').notNull().default(0),
    rushEpa: real('rush_epa').notNull().default(0),
    rushFirstDowns: integer('rush_first_downs').notNull().default(0),
    outsideCarries: integer('outside_carries').notNull().default(0),
    outsideYards: real('outside_yards').notNull().default(0),
    outsideEpa: real('outside_epa').notNull().default(0),
    insideCarries: integer('inside_carries').notNull().default(0),
    insideYards: real('inside_yards').notNull().default(0),
    insideEpa: real('inside_epa').notNull().default(0),
    tackleCarries: integer('tackle_carries').notNull().default(0),
    tackleYards: real('tackle_yards').notNull().default(0),
    targets: integer('targets').notNull().default(0),
    receptions: integer('receptions').notNull().default(0),
    recYards: real('rec_yards').notNull().default(0),
    recEpa: real('rec_epa').notNull().default(0),
    recFirstDowns: integer('rec_first_downs').notNull().default(0),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.season] }),
    index('scheme_season_idx').on(t.season),
  ],
);

/**
 * Draft capital. For a rookie this is the single strongest forward-looking
 * signal available — a first-round receiver and a fifth-round receiver get
 * radically different opportunity regardless of what either did in college.
 */
export const draftPicks = sqliteTable(
  'draft_picks',
  {
    season: integer('season').notNull(),
    round: integer('round').notNull(),
    pick: integer('pick').notNull(),
    playerId: text('player_id'),
    team: text('team'),
    position: text('position'),
    college: text('college'),
  },
  (t) => [
    primaryKey({ columns: [t.season, t.pick] }),
    index('draft_player_idx').on(t.playerId),
  ],
);

/**
 * Latest depth-chart position per player. The other half of rookie situation:
 * draft capital says what a team paid, the depth chart says whether anyone is
 * currently in front of him.
 */
export const depthChart = sqliteTable(
  'depth_chart',
  {
    season: integer('season').notNull(),
    playerId: text('player_id').notNull(),
    team: text('team'),
    posAbb: text('pos_abb'),
    posName: text('pos_name'),
    posRank: integer('pos_rank'),
    posSlot: integer('pos_slot'),
    asOf: text('as_of'),
  },
  (t) => [
    primaryKey({ columns: [t.season, t.playerId, t.posAbb] }),
    index('depth_player_idx').on(t.playerId),
    index('depth_team_idx').on(t.season, t.team),
  ],
);

/**
 * Per-player, per-season advanced usage — the forward-looking on-field signal
 * that sits alongside the market rather than inside it.
 *
 * Deliberately usage-weighted rather than efficiency-only: opportunity is far
 * more predictive year to year than rate stats, which regress hard.
 */
export const playerUsage = sqliteTable(
  'player_usage',
  {
    playerId: text('player_id').notNull(),
    season: integer('season').notNull(),
    position: text('position'),
    team: text('team'),
    games: integer('games').notNull(),
    /** Pass snaps on the field / team pass snaps. Routes run, honestly named. */
    passSnapShare: real('pass_snap_share'),
    passSnaps: integer('pass_snaps'),
    teamPassSnaps: integer('team_pass_snaps'),
    targetShare: real('target_share'),
    airYardsShare: real('air_yards_share'),
    targetsPerRoute: real('targets_per_route'),
    adot: real('adot'),
    yacPerReception: real('yac_per_reception'),
    /** Share of that player's snaps on plays with pre-snap motion — scheme
     *  context for the offense, NOT a personal motion rate. nflverse charts
     *  motion at play level with no player attribution. */
    teamMotionRate: real('team_motion_rate'),
    rushShare: real('rush_share'),
    yardsBeforeContact: real('yards_before_contact'),
    yardsAfterContact: real('yards_after_contact'),
    brokenTackles: integer('broken_tackles'),

    /*
     * Scoring opportunity. Fantasy points are dominated by touchdowns, and who
     * gets the ball near the goal line is a coaching tendency that persists —
     * so this is opportunity, not efficiency. Touchdown *rate* is famously
     * noisy; touchdown *chances* are not.
     */
    rzCarries: integer('rz_carries'),
    rzTargets: integer('rz_targets'),
    /** Player's red-zone touches / team's red-zone plays. */
    rzTouchShare: real('rz_touch_share'),
    /** Inside the 5 — the goal-line role specifically. */
    goalLineCarries: integer('goal_line_carries'),
    goalLineTargets: integer('goal_line_targets'),
    goalLineShare: real('goal_line_share'),
    rzTds: integer('rz_tds'),
    totalTds: integer('total_tds'),

    computedAt: integer('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.season] }),
    index('usage_season_idx').on(t.season, t.position),
  ],
);

/** Download bookkeeping, so ingest can skip fresh files and stay polite. */
export const ingestLog = sqliteTable('ingest_log', {
  key: text('key').primaryKey(),
  url: text('url').notNull(),
  bytes: integer('bytes'),
  rows: integer('rows'),
  status: text('status').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

/*
 * ---------------------------------------------------------------------------
 * Yahoo league connection
 *
 * Everything above this line describes football. Everything below describes one
 * particular fantasy league on Yahoo, which is a different kind of fact: it is
 * not measured, it is simply what the league says, and it changes the moment
 * somebody makes a claim.
 *
 * The reason it earns tables at all is that the waiver wire was answering the
 * wrong question. Availability was inferred from `adp_raw` — "anyone the
 * national market drafts is not on the wire" — which is a proxy for a fact we
 * can now just read. It is wrong in both directions: a drafted player who was
 * cut in this league never appeared, and an undrafted player somebody stashed
 * in August showed as free all season.
 *
 * These are refreshed by DELETE-then-insert per league, never upserted. Bugs #9
 * and #64 were both orphan rows surviving a key change, and ownership is
 * exactly the shape that breaks that way: a player who leaves a roster has no
 * row to update, only a row that should stop existing.
 * ---------------------------------------------------------------------------
 */

/** The league itself, as Yahoo describes it. One row per connected league. */
export const yahooLeague = sqliteTable('yahoo_league', {
  leagueKey: text('league_key').primaryKey(),
  leagueId: text('league_id').notNull(),
  name: text('name').notNull(),
  season: integer('season').notNull(),
  numTeams: integer('num_teams').notNull(),
  /** Yahoo's own word: 'head', 'roto', 'point'. */
  scoringType: text('scoring_type'),
  /**
   * 'predraft' | 'drafting' | 'postdraft'. This decides whether ownership means
   * anything yet: before the draft every roster is empty, so a wire filtered on
   * ownership would show the entire league as available and be perfectly
   * accurate and perfectly useless.
   */
  draftStatus: text('draft_status'),
  currentWeek: integer('current_week'),
  /** Roster slots as Yahoo lists them, e.g. {"QB":1,"WR":3,"RB":2,"BN":5}. */
  rosterPositions: text('roster_positions'),
  /** Raw stat modifiers, kept so scoring can be derived later without a refetch. */
  statModifiers: text('stat_modifiers'),
  fetchedAt: integer('fetched_at').notNull(),
});

/**
 * The other managers. Names matter more than they look: a wire row saying
 * "rostered by Imad's Team" is a different piece of information from "taken",
 * because it tells you whether the man holding him needs him.
 */
export const yahooTeam = sqliteTable(
  'yahoo_team',
  {
    leagueKey: text('league_key').notNull(),
    teamKey: text('team_key').notNull(),
    teamId: integer('team_id').notNull(),
    name: text('name').notNull(),
    managerName: text('manager_name'),
    logoUrl: text('logo_url'),
    /** The authenticated user's own team. Drives "mine" vs "theirs" on screen. */
    isMine: integer('is_mine', { mode: 'boolean' }).notNull().default(false),
    waiverPriority: integer('waiver_priority'),
    faabBalance: integer('faab_balance'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamKey] }),
    index('yahoo_team_league_idx').on(t.leagueKey),
  ],
);

/**
 * Who is unavailable, and why. Absence from this table IS free agency — that is
 * the whole contract, and it is why the table is rebuilt wholesale rather than
 * updated.
 *
 * `playerId` is the gsis_id and is nullable on purpose. Yahoo player keys carry
 * no cross-source id, so the bridge is name resolution through `player_aliases`
 * (source 'yahoo') and it will sometimes miss. A miss must be visible as a null
 * rather than silently dropping the row, because a dropped row here does not
 * read as "unknown" — it reads as "available", which is the one wrong answer
 * this table exists to prevent.
 */
export const yahooOwnership = sqliteTable(
  'yahoo_ownership',
  {
    leagueKey: text('league_key').notNull(),
    yahooPlayerKey: text('yahoo_player_key').notNull(),
    playerId: text('player_id'),
    name: text('name').notNull(),
    position: text('position'),
    nflTeam: text('nfl_team'),
    /** 'rostered' | 'waivers'. Free agents are absent, never stored. */
    status: text('status').notNull(),
    /** Set when status is 'rostered'. */
    teamKey: text('team_key'),
    /** Which lineup slot the owner has him in — 'BN' means benched, not dropped. */
    selectedPosition: text('selected_position'),
    /** Yahoo's injury flag: 'Q', 'O', 'IR', 'PUP-R', null when healthy. */
    injuryStatus: text('injury_status'),
    /** Set when status is 'waivers': the date the claim period ends. */
    waiverDate: text('waiver_date'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.yahooPlayerKey, t.leagueKey] }),
    index('yahoo_own_player_idx').on(t.playerId),
    index('yahoo_own_team_idx').on(t.teamKey),
    index('yahoo_own_status_idx').on(t.leagueKey, t.status),
  ],
);
