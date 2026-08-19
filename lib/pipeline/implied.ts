import { sqlite } from '../db/index';
import { impliedMean, median } from './devig';
import { cvFor, loadDispersion } from './dispersion';
import type { CanonicalStat, Scope } from '../providers/props/markets';

export const METHOD_VERSION = 'implied-v1';

/**
 * Builds each player's market-implied stat line from their posted props.
 *
 * Two rules govern what is allowed in here, both following from the tool's
 * premise that value must trace back to the market:
 *
 *  - A stat present in the market is taken from the market.
 *  - A stat absent from every book is NOT invented from that player's past
 *    production. Doing so would quietly turn last season's stats into a
 *    projection, which is the ranking-by-opinion this tool exists to avoid.
 *    It is recorded as missing and lowers the player's confidence instead.
 *
 * Receptions are the one deliberate exception, and only in a narrow sense: no
 * book posts season receptions anywhere, but half-PPR needs them. The *level*
 * still comes from the market's receiving-yards line; history supplies only the
 * yards-per-reception conversion. That is a unit change, not a projection.
 */

export type StatSource = 'market' | 'extrapolated' | 'derived' | 'missing';

/**
 * Per-game props only count from the regular season.
 *
 * Preseason lines describe a starter playing two series and would collapse any
 * season projection built on them. August games are exhibition; the regular
 * season begins in September.
 */
export function regularSeasonStart(season: number): string {
  return `${season}-09-01`;
}

/**
 * Stats where the season-to-game ratio is stable enough to extrapolate.
 *
 * Yardage calibrates tightly (n=25-53, ratios clustered 13-17). Touchdowns do
 * not: game TD lines move in half-point steps against season lines in the
 * twenties, so the ratio is dominated by rounding and the sample is tiny.
 * Extrapolating those would manufacture precision that is not there.
 */
const EXTRAPOLATABLE = new Set<CanonicalStat>([
  'receivingYards', 'rushingYards', 'passingYards',
]);

/** Fallback when a stat has too few paired observations to calibrate. */
const DEFAULT_GAME_RATIO = 15.2;

export interface ImpliedStat {
  playerId: string;
  scope: Scope;
  stat: CanonicalStat;
  mu: number;
  sigma: number | null;
  line: number | null;
  pOver: number | null;
  source: StatSource;
  basis: string | null;
  bookCount: number;
  bookSpread: number | null;
}

interface PropRow {
  player_id: string;
  stat: CanonicalStat;
  scope: Scope;
  book: string;
  line: number;
  over_price: number | null;
  under_price: number | null;
  fetched_at: number;
}

/**
 * Career yards per reception, used only to convert a receiving-yards line into
 * receptions. Recent seasons weighted more heavily; players with too little
 * history fall back to their position's median.
 */
function yardsPerReception(): { byPlayer: Map<string, number>; byPosition: Map<string, number> } {
  const rows = sqlite
    .prepare(
      `SELECT player_id, position,
              SUM(receiving_yards) AS yards, SUM(receptions) AS rec
       FROM player_stats_week
       WHERE season_type = 'REG' AND season >= (SELECT MAX(season) - 2 FROM player_stats_week)
       GROUP BY player_id
       HAVING rec >= 20`,
    )
    .all() as Array<{ player_id: string; position: string | null; yards: number; rec: number }>;

  const byPlayer = new Map<string, number>();
  const positionValues = new Map<string, number[]>();

  for (const r of rows) {
    if (!r.rec || !r.yards) continue;
    const ypr = r.yards / r.rec;
    // Guard against absurd ratios from tiny or dirty samples.
    if (ypr < 3 || ypr > 25) continue;
    byPlayer.set(r.player_id, ypr);
    const pos = (r.position ?? 'WR').toUpperCase();
    const list = positionValues.get(pos) ?? [];
    list.push(ypr);
    positionValues.set(pos, list);
  }

  const byPosition = new Map<string, number>();
  for (const [pos, values] of positionValues) byPosition.set(pos, median(values));

  return { byPlayer, byPosition };
}

/**
 * Most recent line per (player, stat, book) — one vote per book, not per
 * snapshot. Game-scope rows are restricted to regular-season dates so preseason
 * lines never reach a projection.
 */
function latestLines(scope: Scope, season: number): PropRow[] {
  const cutoff = regularSeasonStart(season);
  const dateFilter =
    scope === 'game' ? `AND p.game_date IS NOT NULL AND p.game_date >= '${cutoff}'` : '';
  const innerFilter =
    scope === 'game' ? `AND game_date IS NOT NULL AND game_date >= '${cutoff}'` : '';

  return sqlite
    .prepare(
      `SELECT p.player_id, p.stat, p.scope, p.book, p.line, p.over_price, p.under_price, p.fetched_at
       FROM prop_lines p
       JOIN (
         SELECT player_id, stat, book, MAX(fetched_at) AS mx
         FROM prop_lines WHERE scope = ? AND player_id IS NOT NULL ${innerFilter}
         GROUP BY player_id, stat, book
       ) latest
         ON latest.player_id = p.player_id AND latest.stat = p.stat
        AND latest.book = p.book AND latest.mx = p.fetched_at
       WHERE p.scope = ? AND p.player_id IS NOT NULL ${dateFilter}`,
    )
    .all(scope, scope) as PropRow[];
}

/**
 * The market's own effective game count, measured rather than assumed.
 *
 * For players carrying both a season and a per-game line on the same stat, the
 * ratio between them is how many games the market is really pricing. It lands
 * near 15.2, not 17, because a season line already discounts for missed time
 * while a single-game line does not. Extrapolating at 17 would inflate every
 * filled player by about 12%.
 */
export function calibrateGameRatios(
  seasonMarket?: ImpliedStat[],
): Map<CanonicalStat, { ratio: number; n: number }> {
  // Per-game stats are already persisted when this runs; the season side may
  // still be in memory, mid-build. Taking season from the database here would
  // silently calibrate against nothing and extrapolate zero rows.
  const gameMu = new Map<string, number>();
  for (const g of sqlite
    .prepare(
      `SELECT player_id, stat, mu FROM implied_stats
       WHERE scope = 'game' AND source = 'market' AND mu > 0`,
    )
    .all() as Array<{ player_id: string; stat: string; mu: number }>) {
    gameMu.set(`${g.player_id}|${g.stat}`, g.mu);
  }

  const season =
    seasonMarket ??
    (sqlite
      .prepare(
        `SELECT player_id AS playerId, stat, mu, source FROM implied_stats
         WHERE scope = 'season' AND source = 'market' AND mu > 0`,
      )
      .all() as ImpliedStat[]);

  const rows: Array<{ stat: CanonicalStat; ratio: number }> = [];
  for (const s of season) {
    if (s.source !== 'market' || s.mu <= 0) continue;
    const g = gameMu.get(`${s.playerId}|${s.stat}`);
    if (g === undefined || g <= 0) continue;
    rows.push({ stat: s.stat, ratio: s.mu / g });
  }

  const byStat = new Map<CanonicalStat, number[]>();
  for (const r of rows) {
    // A per-game line near zero produces a meaningless ratio; the median is
    // robust to a few, but obvious nonsense is dropped up front.
    if (!Number.isFinite(r.ratio) || r.ratio < 5 || r.ratio > 30) continue;
    const list = byStat.get(r.stat) ?? [];
    list.push(r.ratio);
    byStat.set(r.stat, list);
  }

  const out = new Map<CanonicalStat, { ratio: number; n: number }>();
  for (const [stat, list] of byStat) {
    if (!EXTRAPOLATABLE.has(stat)) continue;
    out.set(stat, {
      ratio: list.length >= 10 ? median(list) : DEFAULT_GAME_RATIO,
      n: list.length,
    });
  }
  return out;
}

export function buildImpliedStats(scope: Scope, season: number): ImpliedStat[] {
  const dispersion = loadDispersion();
  const rows = latestLines(scope, season);

  // Group by player and stat, then take a consensus across books.
  const groups = new Map<string, PropRow[]>();
  for (const r of rows) {
    const key = `${r.player_id}|${r.stat}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out: ImpliedStat[] = [];
  const byPlayer = new Map<string, Map<CanonicalStat, ImpliedStat>>();

  for (const [key, list] of groups) {
    const [playerId, stat] = key.split('|') as [string, CanonicalStat];
    const cv = cvFor(dispersion, stat, scope);

    const mus: number[] = [];
    const lines: number[] = [];
    const pOvers: number[] = [];
    let sigma = 0;

    for (const r of list) {
      const im = impliedMean(r.line, r.over_price, r.under_price, cv);
      mus.push(im.mu);
      lines.push(r.line);
      pOvers.push(im.pOver);
      sigma = im.sigma;
    }

    const stat_: ImpliedStat = {
      playerId,
      scope,
      stat,
      mu: median(mus),
      sigma,
      line: median(lines),
      pOver: median(pOvers),
      source: 'market',
      basis: null,
      bookCount: list.length,
      // Disagreement across books is the confidence signal. With a single book
      // posting season props there is nothing to compare, so this stays null.
      bookSpread: mus.length > 1 ? Math.max(...mus) - Math.min(...mus) : null,
    };

    out.push(stat_);
    const m = byPlayer.get(playerId) ?? new Map<CanonicalStat, ImpliedStat>();
    m.set(stat, stat_);
    byPlayer.set(playerId, m);
  }

  /*
   * Season stats filled from per-game lines.
   *
   * This exists for running backs. Only a quarter of them have a season
   * receiving line, worth ~77 half-PPR points, which left three quarters of the
   * position unrankable. Per-game receiving props cover far more of them.
   *
   * The level still comes entirely from the market — a posted per-game line
   * scaled by the market's own season-to-game ratio. Nothing is projected from
   * past production. It is marked `extrapolated` rather than `market` because
   * a single Week 1 line carries matchup noise a season line does not.
   */
  if (scope === 'season') {
    const ratios = calibrateGameRatios(out);
    const gameStats = sqlite
      .prepare(
        `SELECT player_id, stat, mu, sigma FROM implied_stats
         WHERE scope = 'game' AND source = 'market' AND mu > 0`,
      )
      .all() as Array<{ player_id: string; stat: CanonicalStat; mu: number; sigma: number | null }>;

    for (const g of gameStats) {
      const cal = ratios.get(g.stat);
      if (!cal) continue; // not a stat we trust to extrapolate
      const existing = byPlayer.get(g.player_id);
      if (existing?.has(g.stat)) continue; // a real season line always wins

      const stat_: ImpliedStat = {
        playerId: g.player_id,
        scope: 'season',
        stat: g.stat,
        mu: g.mu * cal.ratio,
        sigma: g.sigma === null ? null : g.sigma * cal.ratio,
        line: null,
        pOver: null,
        source: 'extrapolated',
        basis: `game-ratio:${cal.ratio.toFixed(1)}:n${cal.n}`,
        bookCount: 0,
        bookSpread: null,
      };
      out.push(stat_);
      const m = existing ?? new Map<CanonicalStat, ImpliedStat>();
      m.set(g.stat, stat_);
      byPlayer.set(g.player_id, m);
    }
  }

  // Receptions: converted from the market's receiving-yards line, never
  // projected from past reception totals. Runs last so an extrapolated
  // receiving line can feed it.
  const { byPlayer: yprPlayer, byPosition: yprPosition } = yardsPerReception();
  const positions = new Map(
    (
      sqlite.prepare(`SELECT gsis_id, position FROM players`).all() as Array<{
        gsis_id: string;
        position: string | null;
      }>
    ).map((r) => [r.gsis_id, (r.position ?? 'WR').toUpperCase()]),
  );

  for (const [playerId, statMap] of byPlayer) {
    if (statMap.has('receptions')) continue;
    const recYards = statMap.get('receivingYards');
    if (!recYards || recYards.mu <= 0) continue;

    const pos = positions.get(playerId) ?? 'WR';
    // A rookie has no history to convert from, so the position median stands
    // in. That is a materially weaker assumption and is recorded as such
    // rather than presented as the player's own rate.
    const own = yprPlayer.get(playerId);
    const ypr = own ?? yprPosition.get(pos) ?? 11;
    const basis = own
      ? `own-ypr:${own.toFixed(1)}`
      : `position-ypr:${(yprPosition.get(pos) ?? 11).toFixed(1)}:${pos}`;

    out.push({
      playerId,
      scope,
      stat: 'receptions',
      mu: recYards.mu / ypr,
      sigma: null,
      line: null,
      pOver: null,
      source: 'derived',
      basis,
      bookCount: 0,
      bookSpread: null,
    });
  }

  return out;
}

export function saveImpliedStats(stats: ImpliedStat[]): number {
  const now = Date.now();
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO implied_stats
     (player_id, scope, stat, mu, sigma, line, p_over, source, basis,
      book_count, book_spread, method_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sqlite.transaction(() => {
    for (const s of stats) {
      stmt.run(
        s.playerId, s.scope, s.stat, s.mu, s.sigma, s.line, s.pOver,
        s.source, s.basis, s.bookCount, s.bookSpread, METHOD_VERSION, now,
      );
    }
  })();
  return stats.length;
}
