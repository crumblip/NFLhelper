import { sqlite } from './db/index';
import { getPlayerDetail, type PlayerDetail } from './player';
import { cardBadge, cardColumns, cardSeasons } from './card';
import { buildLiveReads, liveePools, type LiveRead } from './pipeline/inseason';
import { resolveUsageSeason } from './pipeline/usage-grade';
import type { ToppsSeason } from '../app/ui/topps-card';

/**
 * Head to head: two players, the same questions asked of both.
 *
 * THE DESIGN CONSTRAINT IS "DO NOT BIAS ME", and it decides everything here.
 * It would be easy to add up some weighted metrics, print a winner and a
 * confidence percentage, and be wrong in a way the reader cannot see. Three
 * rules stop that:
 *
 * 1. **Every row is ranked WITHIN POSITION before the two are compared.** A
 *    receiver's 24% target share and a back's 24% rush share are not the same
 *    fact, and their raw points are not comparable at all: a quarterback
 *    outscores a receiver by a hundred points a year while being worth less,
 *    because twelve quarterbacks start and forty-three receivers do. Percentile
 *    against his own position is the only number that survives the crossing.
 *
 * 2. **A row that is too close to call says so.** Percentile gaps under 10 are
 *    inside the noise of the underlying measurement and are reported as level,
 *    not awarded to whoever is one point ahead.
 *
 * 3. **The verdict carries the draft band's own predictive power.** This
 *    project has measured that the draft order separates players well in rounds
 *    1-3 (rho .518 within position) and barely at all in rounds 7-10 (.066). A
 *    comparison between two seventh-round picks is close to a coin flip and the
 *    page has to say that, however clean the bars look.
 */

export interface CompareRow {
  id: string;
  label: string;
  /** What the number means, and where it came from. */
  detail: string;
  /**
   * Measured partial correlation with next season where one exists, else null.
   * Null rows are shown and never counted toward the lean.
   */
  weight: number | null;
  aDisplay: string;
  bDisplay: string;
  /** Percentile within each player's own position, 0-100. The comparable unit. */
  aPct: number | null;
  bPct: number | null;
  /** 'a', 'b', or null when the gap is inside the noise. */
  leader: 'a' | 'b' | null;
  /** Grouping for the page. */
  group: 'value' | 'role' | 'efficiency' | 'risk';
}

export interface CompareSide {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  adp: number | null;
  vorp: number | null;
  points: number | null;
  age: number | null;
  verdict: string | null;
  confidence: string | null;
  /** Everything the player card needs, so the compare page shows the same one. */
  card: {
    bye: number | null;
    espnId: string | null;
    rookieSeason: number | null;
    status: string | null;
    badge: { value: string; label: string; good: boolean } | null;
    columns: Array<[string, string]>;
    seasons: ToppsSeason[];
    blurb: string;
  };
}

/** Per-group tally, so each section can show who took it and by how much. */
export interface GroupScore {
  group: CompareRow['group'];
  a: number;
  b: number;
  level: number;
  /** Null when the section is split or empty. */
  winner: 'a' | 'b' | null;
}

export interface Comparison {
  a: CompareSide;
  b: CompareSide;
  samePosition: boolean;
  /**
   * Which question the page is answering.
   *
   * `draft` compares two players over a whole season that has not started;
   * `live` compares what they have actually done and is the read for a waiver
   * claim or a start/sit call. The rows are genuinely different, not the same
   * rows with fresher numbers — an ADP and a cost of waiting mean nothing in
   * week 8, and points per game means nothing in August.
   */
  mode: 'draft' | 'live';
  week: number;
  rows: CompareRow[];
  groups: GroupScore[];
  /** Rows each side leads, counting only rows with a measured weight. */
  aWins: number;
  bWins: number;
  level: number;
  verdict: {
    lean: 'a' | 'b' | 'neither';
    /** Sum of measured weights favouring the leader, minus the other side's. */
    margin: number;
    headline: string;
    why: string;
    /** How much the board can actually separate players at this price. */
    bandNote: string;
  };
}

/** Percentile gaps below this are reported as level rather than as a lead. */
const NOISE = 10;

/**
 * How well the draft order separates players in each band, measured within
 * position against what they actually returned (`calibrate:upside`, 578
 * drafted player-seasons).
 *
 * This is on the page because it is the single most important caveat on any
 * comparison: two players going in round eight are, on this evidence, close to
 * indistinguishable, and a tool that draws two confident bars without saying so
 * is lying by omission.
 */
function bandFor(adp: number | null): { label: string; rho: number; note: string } {
  const pick = adp ?? 999;
  if (pick <= 36) {
    return {
      label: 'rounds 1-3',
      rho: 0.518,
      note:
        'Early picks are where the draft order means most: within a position it ranks players ' +
        'against what they actually returned at 0.52. A clear lead here is worth acting on.',
    };
  }
  if (pick <= 72) {
    return {
      label: 'rounds 4-6',
      rho: 0.207,
      note:
        'Separation is already weakening here. The draft order ranks players at about 0.21 ' +
        'against what they returned, roughly a third of its power in round one.',
    };
  }
  if (pick <= 120) {
    return {
      label: 'the middle rounds',
      rho: 0.066,
      note:
        'This is the least forecastable stretch of the draft, for every signal and not just this ' +
        'board. The draft order ranks players at 0.07 here against 0.52 in round one, and last ' +
        "season's points do no better. Treat any lead below as a lean, not a finding.",
    };
  }
  return {
    label: 'the late rounds',
    rho: 0.207,
    note:
      'Late picks separate again, but mostly by whether a player already held a role. Two ' +
      'unproven players this deep are close to a coin flip.',
  };
}

function side(d: PlayerDetail, age: number | null): CompareSide {
  return {
    playerId: d.header.playerId,
    name: d.header.name,
    position: d.header.position,
    team: d.header.team,
    adp: d.value?.adp ?? null,
    vorp: d.value?.blendedVorp ?? null,
    points: d.value?.blendedPoints ?? null,
    age,
    verdict: d.value?.verdict ?? null,
    confidence: d.value?.playerCase?.confidence ?? null,
    card: {
      bye: d.header.bye,
      espnId: d.header.espnId,
      rookieSeason: d.header.rookieSeason,
      status: d.header.status,
      badge: cardBadge(d.value?.blendedVorp, d.waiver?.grade),
      columns: cardColumns(d.header.position),
      seasons: cardSeasons(d.header.position, d.context),
      blurb: d.value?.archetype ?? d.waiver?.opportunity ?? '',
    },
  };
}

/**
 * Turns two raw values into a row, deciding the leader on PERCENTILE and never
 * on the raw figure.
 */
function row(
  id: string,
  label: string,
  detail: string,
  group: CompareRow['group'],
  weight: number | null,
  a: { display: string; pct: number | null },
  b: { display: string; pct: number | null },
  /** Set when a lower number is better, e.g. ADP. */
  lowerIsBetter = false,
): CompareRow {
  let leader: 'a' | 'b' | null = null;
  if (a.pct !== null && b.pct !== null) {
    const gap = a.pct - b.pct;
    if (Math.abs(gap) >= NOISE) {
      const aAhead = lowerIsBetter ? gap < 0 : gap > 0;
      leader = aAhead ? 'a' : 'b';
    }
  }
  return {
    id, label, detail, group, weight,
    aDisplay: a.display, bDisplay: b.display,
    aPct: a.pct, bPct: b.pct,
    leader,
  };
}

/** The stored OUTLOOK rank, already within position and draft band. */
function outlookPctileOf(id: string, season: number): number | null {
  const r = sqlite
    .prepare(`SELECT outlook_pctile AS p FROM value_scores WHERE player_id = ? AND season = ?`)
    .get(id, season) as { p: number | null } | undefined;
  return r?.p ?? null;
}

/** Rank a value in a list, 0-100. Used for the cross-position common scale. */
function pctOf(value: number | null, pool: number[]): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const usable = pool.filter((v) => Number.isFinite(v));
  if (usable.length < 12) return null;
  return Math.round((usable.filter((v) => v <= value).length / usable.length) * 100);
}

/* ------------------------------------------------------ the in-season rows
 *
 * A DIFFERENT SET OF ROWS, not the same rows with fresher numbers.
 *
 * In August the question is "who do I draft", and the answer is built from a
 * price, a projection and last season's role. In week 8 the price is spent and
 * the projection has been overtaken by 8 games of fact, so the question becomes
 * "who do I start" or "who do I claim". Points per game means nothing in
 * August; an ADP and a cost of waiting mean nothing in November.
 *
 * The ordering rule from `calibrate:recency` governs the whole block: season to
 * date leads, and the recent window is CONTEXT that never votes. See the file
 * comment in `pipeline/inseason.ts` for the numbers.
 */
function liveRows(
  A: CompareSide,
  B: CompareSide,
  la: LiveRead | undefined,
  lb: LiveRead | undefined,
  pools: Map<string, { ppg: number[]; opp: number[]; snap: number[]; startable: number[] }>,
): CompareRow[] {
  const rows: CompareRow[] = [];
  const pa = pools.get(A.position);
  const pb = pools.get(B.position);

  const rank = (v: number | null | undefined, pool: number[] | undefined): number | null => {
    if (v === null || v === undefined || !pool || pool.length < 12) return null;
    return Math.round((pool.filter((x) => x <= v).length / pool.length) * 100);
  };

  /*
   * Points per game, half-PPR. The headline in season, and the one number a
   * start/sit decision actually turns on.
   *
   * The weight is the measured season-to-date correlation with the rest of the
   * season at receiver (.737), which is the strongest thing on this page and
   * the reason it leads.
   */
  rows.push(
    row(
      'ppg', 'Half-PPR per game',
      'What he has actually scored per game this season. Season to date rather than a recent ' +
        'window, because season to date predicts the rest of the year better at every position ' +
        'and at every stage: .749 against .730 for backs, .737 against .711 for receivers.',
      'value', 0.737,
      { display: la ? la.ppg.toFixed(1) : 'no games', pct: rank(la?.ppg, pa?.ppg) },
      { display: lb ? lb.ppg.toFixed(1) : 'no games', pct: rank(lb?.ppg, pb?.ppg) },
    ),
  );

  rows.push(
    row(
      'startable-live', 'Weeks he was startable',
      'How often he actually finished inside the starter count at his position, with the bar set ' +
        'by that week’s real scoring rather than a fixed points total. A 12-point week is a ' +
        'startable back some weeks and the 30th back in others.',
      'value', null,
      {
        display: la?.startableRate == null ? '—' : `${la.startableWeeks}/${la.gamesPlayed}`,
        pct: rank(la?.startableRate, pa?.startable),
      },
      {
        display: lb?.startableRate == null ? '—' : `${lb.startableWeeks}/${lb.gamesPlayed}`,
        pct: rank(lb?.startableRate, pb?.startable),
      },
    ),
  );

  rows.push(
    row(
      'total-live', 'Points so far',
      'Season total in half-PPR. Read it beside games played: a man who missed three weeks is ' +
        'not worse per game for it, and the total alone hides that.',
      'value', null,
      { display: la ? `${Math.round(la.points)} in ${la.gamesPlayed}g` : '—', pct: null },
      { display: lb ? `${Math.round(lb.points)} in ${lb.gamesPlayed}g` : '—', pct: null },
    ),
  );

  /* ------------------------------------------------------------------ role */

  rows.push(
    row(
      'opp-live', 'Touches and targets per game',
      'Carries plus targets per game this season. The rawest measure of how much a coach is ' +
        'choosing to use him, and the thing most likely to persist into next week.',
      'role', null,
      { display: la?.opportunitiesPerGame == null ? '—' : la.opportunitiesPerGame.toFixed(1), pct: rank(la?.opportunitiesPerGame, pa?.opp) },
      { display: lb?.opportunitiesPerGame == null ? '—' : lb.opportunitiesPerGame.toFixed(1), pct: rank(lb?.opportunitiesPerGame, pb?.opp) },
    ),
  );

  rows.push(
    row(
      'snap-live', 'Snap share',
      'Share of his offence’s snaps, this season. It moves before the box score does, which ' +
        'is why it is here rather than only in the trend note below.',
      'role', null,
      { display: la?.snapPct == null ? '—' : `${Math.round(la.snapPct * 100)}%`, pct: rank(la?.snapPct, pa?.snap) },
      { display: lb?.snapPct == null ? '—' : `${Math.round(lb.snapPct * 100)}%`, pct: rank(lb?.snapPct, pb?.snap) },
    ),
  );

  // Target share and rush share are position-specific facts. Showing a
  // quarterback a 0% target share next to a receiver's 24% is family #1
  // wearing a percentage, so each is null where it does not apply.
  if (la?.targetShare != null || lb?.targetShare != null) {
    rows.push(
      row(
        'ts-live', 'Target share',
        'Share of his team’s targets this season, averaged over the weeks he played. Target ' +
          'share is the strongest usage signal for a pass catcher in this project.',
        'role', null,
        { display: la?.targetShare == null ? '—' : `${Math.round(la.targetShare * 100)}%`, pct: la?.targetShare == null ? null : Math.round(Math.min(100, la.targetShare * 350)) },
        { display: lb?.targetShare == null ? '—' : `${Math.round(lb.targetShare * 100)}%`, pct: lb?.targetShare == null ? null : Math.round(Math.min(100, lb.targetShare * 350)) },
      ),
    );
  }

  if (la?.rushShare != null || lb?.rushShare != null) {
    rows.push(
      row(
        'rs-live', 'Rush share',
        'Share of his team’s carries this season. A share reflects a coaching decision and is ' +
          'far more stable week to week than the yards that come from it.',
        'role', null,
        { display: la?.rushShare == null ? '—' : `${Math.round(la.rushShare * 100)}%`, pct: la?.rushShare == null ? null : Math.round(Math.min(100, la.rushShare * 140)) },
        { display: lb?.rushShare == null ? '—' : `${Math.round(lb.rushShare * 100)}%`, pct: lb?.rushShare == null ? null : Math.round(Math.min(100, lb.rushShare * 140)) },
      ),
    );
  }

  if (la?.wopr != null || lb?.wopr != null) {
    rows.push(
      row(
        'wopr-live', 'Weighted opportunity',
        'Target share and air-yards share in one number, weighted 1.5 and 0.7. It separates a ' +
          'receiver fed near the line from one being thrown at down the field. Shown as ' +
          'description: this project has not measured its own partial correlation, so it does ' +
          'not vote.',
        'role', null,
        { display: la?.wopr == null ? '—' : la.wopr.toFixed(2), pct: la?.wopr == null ? null : Math.round(Math.min(100, la.wopr * 140)) },
        { display: lb?.wopr == null ? '—' : lb.wopr.toFixed(2), pct: lb?.wopr == null ? null : Math.round(Math.min(100, lb.wopr * 140)) },
      ),
    );
  }

  /* ------------------------------------------------------------------ risk
   *
   * The recent window lives here rather than under value, and it does not vote.
   * That placement is the finding: a hot streak is not evidence, and a
   * collapsing snap share is a risk.
   */
  rows.push(
    row(
      'last3', 'Last 3 games per game',
      'Shown for context and deliberately given no weight. Measured over 22,405 samples, a ' +
        'last-3 window predicts the rest of the season WORSE than the season to date at every ' +
        'position, and the best blend puts 0.2 on it for a gain of 0.0007. A hot run is mostly ' +
        'noise, and the eye cannot tell it from a change in role.',
      'risk', null,
      { display: la?.last3Ppg == null ? '—' : la.last3Ppg.toFixed(1), pct: null },
      { display: lb?.last3Ppg == null ? '—' : lb.last3Ppg.toFixed(1), pct: null },
    ),
  );

  /*
   * Only a COLLAPSE counts, and only against the man collapsing. A spike was
   * measured and carries nothing: 15 points above his own average returns 6.77
   * a game against 6.84 for a flat role, because a spike is usually somebody
   * else's one-week absence.
   */
  const collapsePct = (l: LiveRead | undefined): number | null =>
    l?.snapDelta == null ? null : l.collapsed ? 0 : 100;
  if (la?.snapDelta != null || lb?.snapDelta != null) {
    rows.push(
      row(
        'trend-live', 'Role holding up',
        'Whether his recent snap share has fallen far below his own season average. Only a fall ' +
          'counts. A snap-share spike was measured and predicts nothing (6.77 points a game ' +
          'against 6.84 for a flat role); a collapse of 15 points or more costs 1.23 a game and ' +
          'is one of the few places a recent window beats the season.',
        'risk', 0.3,
        {
          display: la?.snapDelta == null ? '—' : la.collapsed ? `falling ${la.snapDelta.toFixed(0)}pp` : 'holding',
          pct: collapsePct(la),
        },
        {
          display: lb?.snapDelta == null ? '—' : lb.collapsed ? `falling ${lb.snapDelta.toFixed(0)}pp` : 'holding',
          pct: collapsePct(lb),
        },
      ),
    );
  }

  if ((la?.weeksMissed ?? 0) > 0 || (lb?.weeksMissed ?? 0) > 0) {
    rows.push(
      row(
        'missed-live', 'Weeks since he last played',
        'Zero means he took a snap in the most recent week. Anything else is the question the ' +
          'injury report answers, and it should be read there before starting him.',
        'risk', null,
        { display: la ? String(la.weeksMissed) : '—', pct: la ? (la.weeksMissed > 0 ? 0 : 100) : null },
        { display: lb ? String(lb.weeksMissed) : '—', pct: lb ? (lb.weeksMissed > 0 ? 0 : 100) : null },
      ),
    );
  }

  return rows;
}

export function comparePlayers(
  aId: string,
  bId: string,
  format: string,
  teams: number,
  season: number,
  /** Pools of VORP and startable rate by position, for the shared scale. */
  pools: {
    vorp: Map<string, number[]>;
    startable: Map<string, number[]>;
    live: Map<string, LiveRead>;
    livePools: Map<string, { ppg: number[]; opp: number[]; snap: number[]; startable: number[] }>;
  },
): Comparison | null {
  const da = getPlayerDetail(aId, format, teams, season);
  const db = getPlayerDetail(bId, format, teams, season);
  if (!da || !db) return null;

  /*
   * Age lives on the player row rather than on the header, so it is read here
   * once for both sides. Null is fine and simply drops the row.
   */
  const ageOf = (id: string): number | null => {
    const r = sqlite
      .prepare(
        `SELECT ? - CAST(substr(birth_date, 1, 4) AS INTEGER) AS age FROM players WHERE gsis_id = ?`,
      )
      .get(season, id) as { age: number | null } | undefined;
    return r?.age ?? null;
  };

  const A = side(da, ageOf(aId));
  const B = side(db, ageOf(bId));

  /*
   * Which question this page is answering, decided by the same helper the wire
   * and the usage model use. `live` only when games have been played AND there
   * is data behind them, so a season that kicks off before an ingest falls back
   * rather than showing an empty comparison.
   */
  const { live, week } = resolveUsageSeason(season);
  const la = pools.live.get(aId);
  const lb = pools.live.get(bId);
  const mode: 'draft' | 'live' = live && (la || lb) ? 'live' : 'draft';
  const samePosition = A.position === B.position;
  const rows: CompareRow[] = [];

  const vp = (pos: string) => pools.vorp.get(pos) ?? [];
  const sp = (pos: string) => pools.startable.get(pos) ?? [];

  if (mode === 'live') rows.push(...liveRows(A, B, la, lb, pools.livePools));

  /* ---------------------------------------------------------------- value */
  /* Draft rows below. Skipped entirely in live mode: an ADP is spent and a
     cost of waiting is meaningless once the draft is over. */
  if (mode === 'draft') {

  /*
   * VALUE is the one figure that already crosses positions honestly, because
   * it is measured against each position's own replacement level. Its
   * percentile is still shown, because "+40" means something different at
   * quarterback (where replacement is 296) than at receiver (122).
   */
  rows.push(
    row(
      'value', 'VALUE over replacement',
      'Points above the best player at his position you could have for nothing. The only raw ' +
        'number here that compares across positions, because each is measured against its own ' +
        'replacement level.',
      'value', null,
      { display: A.vorp === null ? 'no read' : `${A.vorp > 0 ? '+' : ''}${Math.round(A.vorp)}`, pct: pctOf(A.vorp, vp(A.position)) },
      { display: B.vorp === null ? 'no read' : `${B.vorp > 0 ? '+' : ''}${Math.round(B.vorp)}`, pct: pctOf(B.vorp, vp(B.position)) },
    ),
  );

  const aVona = da.value?.vona ?? null;
  const bVona = db.value?.vona ?? null;
  if (aVona !== null || bVona !== null) {
    rows.push(
      row(
        'vona', 'Cost of waiting',
        'What you give up by passing now and taking the position next turn. Backs usually lead ' +
          'this because their cliff is steepest, and that IS the finding rather than a bias.',
        'value', null,
        /*
         * Ranked on a fixed 0-80 point scale rather than within position, and
         * that is deliberate: VONA is already in points you lose, which means
         * the same thing at every position. Ranking it within position would
         * erase the finding, since the whole point is that a back's cliff is
         * steeper than a receiver's.
         */
        { display: aVona === null ? '—' : `${Math.round(aVona)} pts`, pct: aVona === null ? null : Math.round(Math.max(0, Math.min(100, (aVona / 80) * 100))) },
        { display: bVona === null ? '—' : `${Math.round(bVona)} pts`, pct: bVona === null ? null : Math.round(Math.max(0, Math.min(100, (bVona / 80) * 100))) },
      ),
    );
  }

  const aStart = da.value?.startableRate ?? null;
  const bStart = db.value?.startableRate ?? null;
  rows.push(
    row(
      'startable', 'Weeks startable',
      'The same projection restated in the unit the league is played in: the share of weeks he ' +
        'should finish inside the starter count at his position. A restatement, never a second ' +
        'opinion.',
      'value', null,
      { display: aStart === null ? '—' : `${Math.round(aStart * 100)}%`, pct: pctOf(aStart, sp(A.position)) },
      { display: bStart === null ? '—' : `${Math.round(bStart * 100)}%`, pct: pctOf(bStart, sp(B.position)) },
    ),
  );

  rows.push(
    row(
      'adp', 'What he costs',
      'Where the national market is drafting him. The CHEAPER man leads this row, which is the ' +
        'only sensible direction: going earlier is what you pay, not what you get. On its own it ' +
        'settles nothing, and it carries no weight for that reason. It matters exactly when the ' +
        'rest of the table is close.',
      'value', null,
      { display: A.adp === null ? 'undrafted' : `pick ${Math.round(A.adp)}`, pct: A.adp === null ? 100 : Math.round(Math.min(100, (A.adp / 200) * 100)) },
      { display: B.adp === null ? 'undrafted' : `pick ${Math.round(B.adp)}`, pct: B.adp === null ? 100 : Math.round(Math.min(100, (B.adp / 200) * 100)) },
    ),
  );

  }

  /* ----------------------------------------------------------------- role */

  if (mode === 'draft') rows.push(
    row(
      'usage', 'Size of his role',
      'Where his measured workload ranks against his own position: targets, carries, routes and ' +
        'red-zone work rolled into one percentile. This is the fair way to set a receiver ' +
        'against a back.',
      'role', null,
      { display: da.value?.usageGrade === null || da.value?.usageGrade === undefined ? '—' : `${da.value.usageGrade}/100`, pct: da.value?.usageGrade ?? null },
      { display: db.value?.usageGrade === null || db.value?.usageGrade === undefined ? '—' : `${db.value.usageGrade}/100`, pct: db.value?.usageGrade ?? null },
    ),
  );

  /*
   * OUTLOOK, read from the stored percentile rather than recomputed.
   *
   * It is already ranked within position AND draft band, which is exactly the
   * unit this page needs, and recomputing it here would be a second definition
   * of one quantity (#71). The first version of this row was a stub that
   * printed an em dash for both players on every comparison: a row that never
   * says anything is worse than no row, because the reader assumes it failed
   * rather than that it was never wired up.
   */
  const aOutPct = outlookPctileOf(aId, season);
  const bOutPct = outlookPctileOf(bId, season);
  if (aOutPct !== null || bOutPct !== null) {
    rows.push(
      row(
        'outlook', 'How players like him turned out',
        'One axis from bust to breakout, built from the 40 most similar historical seasons and ' +
          'ranked within his position and draft band. High is good. It reads as a lean rather ' +
          'than a finding: its two halves are the same measurement with the sign flipped.',
        'role', null,
        { display: aOutPct === null ? 'no comparables' : `${Math.round(aOutPct)}/100`, pct: aOutPct },
        { display: bOutPct === null ? 'no comparables' : `${Math.round(bOutPct)}/100`, pct: bOutPct },
      ),
    );
  }

  /* ----------------------------------------------------- what he does with it
   *
   * The indicators, matched by id so a receiver's first downs line up against a
   * back's. Each carries the partial correlation measured for THAT position, so
   * a quarterback's first-down rate does not enter at a receiver's weight.
   */
  const aInd = new Map((da.scouting?.indicators ?? []).map((i) => [i.id, i]));
  const bInd = new Map((db.scouting?.indicators ?? []).map((i) => [i.id, i]));
  const sharedIds = [...aInd.keys()].filter((id) => bInd.has(id));

  for (const id of sharedIds) {
    const ia = aInd.get(id)!;
    const ib = bInd.get(id)!;
    // A metric dead for either position cannot be evidence in a comparison
    // between them, so it is shown with no weight and never counted.
    const weight = ia.weight === null || ib.weight === null ? null : Math.min(ia.weight, ib.weight);
    rows.push(
      row(
        id, ia.label, ia.detail, 'efficiency', weight,
        { display: ia.display, pct: ia.percentile },
        { display: ib.display, pct: ib.percentile },
      ),
    );
  }

  /* ----------------------------------------------------------------- risk */

  const aGames = da.value?.expectedGames ?? null;
  const bGames = db.value?.expectedGames ?? null;
  rows.push(
    row(
      'games', 'Games he should play',
      'Availability repeats: a player who missed four or more games misses time again about 73% ' +
        'of the time, against 41% for one who stayed healthy. One of the most repeatable things ' +
        'in this data.',
      'risk', 0.42,
      { display: aGames === null ? '—' : `${aGames.toFixed(1)}`, pct: aGames === null ? null : Math.round(Math.min(100, (aGames / 17) * 100)) },
      { display: bGames === null ? '—' : `${bGames.toFixed(1)}`, pct: bGames === null ? null : Math.round(Math.min(100, (bGames / 17) * 100)) },
    ),
  );

  rows.push(
    row(
      'age', 'Age',
      'Age predicts decline at every position, most strongly for receivers. Younger is better ' +
        'here, and the effect is real but modest.',
      'risk', 0.254,
      { display: A.age === null ? '—' : `${A.age}`, pct: A.age === null ? null : Math.round(100 - Math.min(100, ((A.age - 20) / 16) * 100)) },
      { display: B.age === null ? '—' : `${B.age}`, pct: B.age === null ? null : Math.round(100 - Math.min(100, ((B.age - 20) / 16) * 100)) },
    ),
  );

  /* ------------------------------------------------------------- the lean */

  /*
   * Only rows with a MEASURED weight vote, and each votes by its own weight.
   *
   * A count of rows won would let three descriptive lines outvote first downs,
   * which is the strongest independent signal in the project. Same reasoning as
   * the case weighting `measured` points double.
   */
  let aScore = 0;
  let bScore = 0;
  let aWins = 0;
  let bWins = 0;
  let level = 0;
  for (const r of rows) {
    if (r.leader === 'a') aWins++;
    else if (r.leader === 'b') bWins++;
    else if (r.aPct !== null && r.bPct !== null) level++;
    if (r.weight === null || r.leader === null) continue;
    if (r.leader === 'a') aScore += r.weight;
    else bScore += r.weight;
  }

  /*
   * Drop rows where neither man has a reading at all.
   *
   * Tested on the DISPLAY rather than on the percentile, which is the fix for a
   * bug this introduced: several rows are deliberately unranked — points so far,
   * last three games, cost of waiting — because they are context that must not
   * vote. Filtering on percentile silently deleted exactly the rows whose whole
   * purpose is to be shown without being scored.
   */
  const empty = (d: string) => d === '—' || d === 'no games' || d === 'no read';
  const kept = rows.filter((r) => !empty(r.aDisplay) || !empty(r.bDisplay));
  rows.length = 0;
  rows.push(...kept);

  const margin = aScore - bScore;
  const band = bandFor(Math.min(A.adp ?? 999, B.adp ?? 999));

  /*
   * The threshold is deliberately high. A lean needs the weighted evidence to
   * favour one side by more than a single strong signal's worth, because
   * anything less is one metric away from flipping.
   */
  const lean: 'a' | 'b' | 'neither' =
    Math.abs(margin) < 0.25 ? 'neither' : margin > 0 ? 'a' : 'b';
  const winner = lean === 'a' ? A : lean === 'b' ? B : null;

  const headline =
    lean === 'neither'
      ? 'Too close to call on the evidence'
      : `The measured evidence leans ${winner!.name}`;

  const why =
    lean === 'neither'
      ? `They split the rows that carry measured weight, and the difference between them is ` +
        `smaller than a single strong signal. On this evidence the pick is yours to make on ` +
        `roster fit and bye weeks rather than on the numbers.`
      : `${winner!.name} leads on ${lean === 'a' ? aWins : bWins} of the ${rows.filter((r) => r.leader !== null).length} rows that separate them, ` +
        `and the rows he leads carry more measured weight. ${level} more are level. ` +
        `Nothing here says the other man is bad, only that more of the evidence points one way.`;

  /*
   * Per-section tallies. A reader scanning for "who won the efficiency block"
   * should not have to count chevrons, and the sections genuinely disagree —
   * one man often takes the volume rows while the other takes the per-touch
   * ones, which is the most interesting thing a comparison can show.
   */
  const groups: GroupScore[] = (['value', 'role', 'efficiency', 'risk'] as const).map((g) => {
    const inGroup = rows.filter((r) => r.group === g);
    const ga = inGroup.filter((r) => r.leader === 'a').length;
    const gb = inGroup.filter((r) => r.leader === 'b').length;
    const gl = inGroup.filter((r) => r.leader === null && r.aPct !== null && r.bPct !== null).length;
    return { group: g, a: ga, b: gb, level: gl, winner: ga === gb ? null : ga > gb ? 'a' : 'b' };
  });

  return {
    a: A, b: B, samePosition, mode, week, rows, groups, aWins, bWins, level,
    verdict: { lean, margin, headline, why, bandNote: `${band.label}: ${band.note}` },
  };
}

/**
 * The per-position pools the percentiles are ranked against.
 *
 * Built from the board rather than from the comparison, so the two players are
 * placed against every player at their position and not merely against each
 * other. Ranking two players against a pool of two would make every row a
 * 100-vs-0 blowout.
 */
export function buildComparePools(season: number): {
  vorp: Map<string, number[]>;
  startable: Map<string, number[]>;
  live: Map<string, LiveRead>;
  livePools: Map<string, { ppg: number[]; opp: number[]; snap: number[]; startable: number[] }>;
} {
  const rows = sqlite
    .prepare(
      `SELECT position, blended_vorp AS vorp, startable_rate AS startable
       FROM value_scores WHERE season = ?`,
    )
    .all(season) as Array<{ position: string; vorp: number | null; startable: number | null }>;

  const vorp = new Map<string, number[]>();
  const startable = new Map<string, number[]>();
  for (const r of rows) {
    if (r.vorp !== null) vorp.set(r.position, [...(vorp.get(r.position) ?? []), r.vorp]);
    if (r.startable !== null) {
      startable.set(r.position, [...(startable.get(r.position) ?? []), r.startable]);
    }
  }
  /*
   * The live reads and their pools, built here so the page does not have to
   * know whether the season has started. Both are empty before week 1, which is
   * what makes `mode` fall back to `draft` on its own.
   */
  const live = buildLiveReads(season);
  const positionOf = new Map(
    (
      sqlite
        .prepare(`SELECT gsis_id AS id, position AS pos FROM players WHERE position IN ('QB','RB','WR','TE')`)
        .all() as Array<{ id: string; pos: string }>
    ).map((r) => [r.id, r.pos]),
  );
  const livePools = liveePools(live, positionOf);

  return { vorp, startable, live, livePools };
}
