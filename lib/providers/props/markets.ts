/**
 * Market key -> canonical stat, plus scope inference.
 *
 * The provider ships season-long and per-game props under the *same*
 * market_key with no scope field anywhere in the payload. Amon-Ra St. Brown
 * appears twice under `player_rec_yds`, at 77.5 and at 1225.5 — one game, one
 * season. Getting this wrong is not a rounding error: a season line read as a
 * game line is off by a factor of ~17.
 *
 * So scope comes from the key where the key says so, and from line magnitude
 * only where it must. Anything that cannot be classified confidently is
 * dropped rather than guessed at.
 */

export type CanonicalStat =
  | 'passingYards'
  | 'passingTds'
  | 'interceptions'
  | 'rushingYards'
  | 'rushingTds'
  | 'receptions'
  | 'receivingYards'
  | 'receivingTds';

export type Scope = 'season' | 'game';

interface MarketSpec {
  stat: CanonicalStat;
  /** Explicit when the key names its scope; inferred only when it does not. */
  scope: Scope | 'infer';
  /**
   * Lines at or above this are season-scale. Set well clear of the largest
   * plausible single-game value so the boundary is never a coin flip.
   */
  seasonFloor?: number;
}

export const MARKETS: Record<string, MarketSpec> = {
  // Keys that state their own scope.
  player_season_pass_yards: { stat: 'passingYards', scope: 'season' },
  player_season_rush_yards: { stat: 'rushingYards', scope: 'season' },
  player_season_rush_tds: { stat: 'rushingTds', scope: 'season' },
  player_season_receiving_tds: { stat: 'receivingTds', scope: 'season' },
  player_season_rec_yards: { stat: 'receivingYards', scope: 'season' },
  player_season_receptions: { stat: 'receptions', scope: 'season' },
  player_regular_season_passing_yards_ou: { stat: 'passingYards', scope: 'season' },

  // Keys that carry both scopes. Floors only ever apply to rows that already
  // passed the team check, so they separate one book's season lines from
  // another's game lines rather than season-from-game in general.
  player_pass_yards: { stat: 'passingYards', scope: 'infer', seasonFloor: 600 },
  player_pass_yds: { stat: 'passingYards', scope: 'infer', seasonFloor: 600 },
  player_rush_yards: { stat: 'rushingYards', scope: 'infer', seasonFloor: 120 },
  player_rush_yds: { stat: 'rushingYards', scope: 'infer', seasonFloor: 120 },
  player_rec_yds: { stat: 'receivingYards', scope: 'infer', seasonFloor: 120 },
  player_receiving_yards: { stat: 'receivingYards', scope: 'infer', seasonFloor: 120 },
  player_receptions: { stat: 'receptions', scope: 'infer', seasonFloor: 25 },
  player_pass_tds: { stat: 'passingTds', scope: 'infer', seasonFloor: 8 },
  player_ints_thrown: { stat: 'interceptions', scope: 'infer', seasonFloor: 5 },
  player_int: { stat: 'interceptions', scope: 'infer', seasonFloor: 5 },
};

/**
 * Keys we deliberately ignore, kept explicit so an unrecognised market shows up
 * in the ingest report as something new rather than being silently skipped.
 *
 * `rush + rec TDs` is excluded because it cannot be split into its parts, and
 * counting it would double-score against the separate rushing and receiving TD
 * markets. Period props (1H/1Q) are excluded because they describe a fraction
 * of a game and cannot be extrapolated to either scope.
 */
export const IGNORED_PREFIXES = [
  'player_1h_', 'player_1q_', 'player_2h_', 'player_2q_',
];

export const IGNORED_KEYS = new Set([
  'player_rush___rec_tds', 'player_rush+rec_tds', 'player_first_td',
  'player_anytime_td', 'player_spread', 'player_total', 'player_totals',
  'player_total_points', 'player_points', 'player_moneyline',
  'player_winning_margin', 'player_winning_margin___exact',
  'player_dynamic_winning_margin', 'player_correct_score_range',
  'player_total_points_range', 'player_odd/even_total_points',
  'player_sacks', 'player_season_sacks', 'player_regular_season_games_started',
  'player_regular_season_receiving_yards_matchbet',
  'spreads', 'totals', 'moneyline', 'alternate_spreads', 'alternate_totals',
]);

export interface Classified {
  stat: CanonicalStat;
  scope: Scope;
  method: 'teams' | 'key' | 'magnitude';
}

/**
 * Scope, decided in order of how much the signal can be trusted.
 *
 * 1. A row attached to a real matchup is a game prop. The provider files
 *    season-long props against a synthetic container event with empty team
 *    names, and across 2,295 team-bearing rows there was not a single
 *    season-scale line. This check is exact, so it goes first.
 *
 * 2. Otherwise, a key that names its own scope is taken at its word.
 *
 * 3. Only then does line magnitude decide, and by this point it is doing much
 *    less work: the remaining rows are all on the container event, where the
 *    real split is one book's season lines against another's game lines
 *    (PrizePicks posts game props with blank teams). The floors separate those
 *    two clusters, which are far apart, rather than trying to divide season
 *    from game across the whole feed.
 */
export function classify(
  marketKey: string,
  line: number | null,
  hasTeams: boolean,
): Classified | null {
  if (line === null || !Number.isFinite(line)) return null;
  if (IGNORED_KEYS.has(marketKey)) return null;
  if (IGNORED_PREFIXES.some((p) => marketKey.startsWith(p))) return null;

  const spec = MARKETS[marketKey];
  if (!spec) return null;

  if (hasTeams) return { stat: spec.stat, scope: 'game', method: 'teams' };
  if (spec.scope !== 'infer') return { stat: spec.stat, scope: spec.scope, method: 'key' };

  const floor = spec.seasonFloor;
  if (floor === undefined) return null;
  return {
    stat: spec.stat,
    scope: line >= floor ? 'season' : 'game',
    method: 'magnitude',
  };
}

/** Unknown keys, so new markets surface instead of vanishing. */
export function isUnknown(marketKey: string): boolean {
  if (IGNORED_KEYS.has(marketKey)) return false;
  if (IGNORED_PREFIXES.some((p) => marketKey.startsWith(p))) return false;
  return !MARKETS[marketKey];
}
