import { sqlite } from '../lib/db/index';

/**
 * How old is every fact on the board, and which command refreshes it?
 *
 * Written after a session that started with one screenshot — Jahan Dotson
 * carrying Nick Sirianni as his play caller after a trade to Atlanta — and found
 * two separate freshness bugs behind it. Neither was visible from inside the
 * app: every page rendered, every number was plausible, and the only tell was a
 * reader who happened to know one player had moved.
 *
 * That is the problem this script exists for. A stale fact does not announce
 * itself, and this tool has SEVEN sources on different clocks: some rewrite
 * weekly in season, some are frozen the moment a season ends, one is a rolling
 * market that must be re-pulled before a draft, and one costs API credits to
 * refresh so it is never pulled casually. Nothing showed all seven ages in one
 * place, so the honest answer to "is this current?" took a database session.
 *
 * It is a REPORT, not a check. It does not fail a build and is not part of
 * `refresh` — the audit already enforces the invariants that must never break,
 * and stale data is a judgement call about what is worth spending on and when.
 * `npm run audit` asks "is this internally consistent"; this asks "is this
 * still true".
 */

const SEASON = Number(process.env.SEASON ?? 2026);
const now = Date.now();
const DAY = 86_400_000;

const days = (ms: number | null) => (ms === null ? null : (now - ms) / DAY);

/** ISO strings, epoch millis and epoch seconds all appear in this schema. */
const toMs = (v: string | number | null): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

const one = <T>(sql: string, ...args: unknown[]): T | undefined => {
  try {
    return sqlite.prepare(sql).get(...(args as never[])) as T;
  } catch {
    return undefined;
  }
};

interface Source {
  name: string;
  /** What the number describes, in the reader's terms. */
  covers: string;
  /** Age in days of the newest thing in it, or null when it carries no clock. */
  age: number | null;
  /** Days past which this is worth re-pulling, and why that number. */
  stale: number;
  refresh: string;
  note?: string;
}

const sources: Source[] = [];

/* ---------------------------------------------------------- rosters */

/*
 * The depth chart is the fastest-moving thing here and the one most claims hang
 * off — who is on which team, who is listed ahead of whom, and therefore which
 * offence a player is scouted against. nflverse republishes it daily through
 * camp, and a cut can move a player between two drafts on the same weekend.
 */
const dc = one<{ newest: string; n: number; teams: number; dates: number }>(
  `SELECT MAX(as_of) AS newest, COUNT(*) AS n, COUNT(DISTINCT team) AS teams,
          COUNT(DISTINCT as_of) AS dates
   FROM depth_chart WHERE season = ?`,
  SEASON,
);
sources.push({
  name: 'depth charts',
  covers: dc?.newest ? `${dc.n} listings across ${dc.teams} teams` : 'nothing',
  age: days(toMs(dc?.newest ?? null)),
  stale: 3,
  refresh: 'npm run ingest:situation',
  note:
    dc && dc.dates > 1
      ? `WARNING: ${dc.dates} different chart dates in one season — this should be 1. See the audit.`
      : 'Camp rosters are 90 men deep and change daily.',
});

/*
 * `players` carries `latest_team`, birth dates and status. It moves more slowly
 * than the depth chart but it is the fallback when a man has no listing, so a
 * gap between the two shows up as a player scouted against the wrong offence.
 */
const pl = one<{ at: number; rows: number }>(
  `SELECT fetched_at AS at, rows FROM ingest_log WHERE key = 'players' ORDER BY fetched_at DESC LIMIT 1`,
);
const dcTeamMismatch = one<{ n: number }>(
  `SELECT COUNT(*) AS n FROM players p
   JOIN (SELECT player_id, team, MIN(pos_rank) r FROM depth_chart WHERE season = ? GROUP BY player_id) d
     ON d.player_id = p.gsis_id
   WHERE p.position IN ('QB','WR','RB','TE') AND p.latest_team <> d.team`,
  SEASON,
);
sources.push({
  name: 'player roster',
  covers: `${pl?.rows ?? 0} players`,
  age: days(toMs(pl?.at ?? null)),
  stale: 7,
  refresh: 'npm run ingest:nflverse',
  note:
    dcTeamMismatch && dcTeamMismatch.n > 0
      ? `${dcTeamMismatch.n} skill players list a team the depth chart disagrees with. The chart wins wherever both are read, so this is a lag rather than a fault — but it is the lag that hides a trade.`
      : 'Agrees with the depth chart.',
});

/* ---------------------------------------------------------- the market */

/*
 * ADP is a ROLLING WINDOW. Fantasy Football Calculator reports the last N days
 * of real drafts, so a pull from three weeks ago describes a market that has
 * since moved on an injury, a holdout or a preseason snap count. It drives the
 * baseline curve, the slot gap and 60% of every blended projection.
 */
const adp = one<{ at: number | string; n: number }>(
  `SELECT MAX(fetched_at) AS at, COUNT(*) AS n FROM adp_raw WHERE year = ?`,
  SEASON,
);
sources.push({
  name: 'ADP (market price)',
  covers: `${adp?.n ?? 0} players priced for ${SEASON}`,
  age: days(toMs(adp?.at ?? null)),
  stale: 7,
  refresh: 'npm run refresh:adp',
  note: 'A rolling window of recent drafts — it moves on news, and it is 60% of the blend.',
});

/*
 * Props cost credits. 1,000 a month on the free tier and three per call, so this
 * is the one source that should NOT be refreshed reflexively — the right time is
 * shortly before a draft, not on every session.
 */
const props = one<{ at: number; n: number; players: number; books: number }>(
  `SELECT MAX(fetched_at) AS at, COUNT(*) AS n, COUNT(DISTINCT player_id) AS players,
          COUNT(DISTINCT book) AS books
   FROM prop_lines`,
);
sources.push({
  name: 'sportsbook props',
  covers: `${props?.n ?? 0} lines on ${props?.players ?? 0} players from ${props?.books ?? 0} books`,
  age: days(toMs(props?.at ?? null)),
  stale: 7,
  refresh: 'npm run refresh   (COSTS API CREDITS — 3 per call, 1000/month free)',
  note: 'The other 40% of the blend. Refresh before a draft, not on every session.',
});

/* ------------------------------------------------- last season's record */

/*
 * These three are frozen once a season ends and only move again in September.
 * Their staleness question is not "how many days" but "does the newest season
 * present match the newest season played", which is what the row reports.
 */
const stats = one<{ s: number; w: number }>(
  `SELECT MAX(season) AS s, MAX(week) AS w FROM player_stats_week
   WHERE season = (SELECT MAX(season) FROM player_stats_week)`,
);
const usage = one<{ s: number; n: number }>(
  `SELECT MAX(season) AS s, COUNT(*) AS n FROM player_usage
   WHERE season = (SELECT MAX(season) FROM player_usage)`,
);
const ctx = one<{ s: number; n: number }>(
  `SELECT MAX(season) AS s, COUNT(*) AS n FROM team_context
   WHERE season = (SELECT MAX(season) FROM team_context)`,
);

console.log(`\nDATA FRESHNESS — as of ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}, board season ${SEASON}\n`);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${pad('source', 20)} ${pad('age', 9)} ${pad('', 6)} ${pad('holds', 44)} refresh with`);
console.log('-'.repeat(118));

let anyStale = false;
for (const s of sources) {
  const age =
    s.age === null
      ? 'unknown'
      : s.age < 1
        ? 'today'
        : `${s.age.toFixed(0)} day${s.age >= 2 ? 's' : ''}`;
  const isStale = s.age !== null && s.age > s.stale;
  if (isStale) anyStale = true;
  // The flag sits in its own column rather than being appended to the age, or a
  // flagged row loses its alignment and the table stops being scannable — which
  // is the only thing a table is for.
  console.log(
    `${pad(s.name, 20)} ${pad(age, 9)} ${pad(isStale ? 'STALE' : '', 6)} ${pad(s.covers, 44)} ${s.refresh}`,
  );
  if (s.note) console.log(`${' '.repeat(21)}${s.note}`);
}

console.log('\nSEASON RECORD — frozen between seasons, so the question is which season, not how old');
console.log('-'.repeat(118));
console.log(`weekly stats         newest season ${stats?.s ?? '—'}, through week ${stats?.w ?? '—'}`);
console.log(`usage shares         newest season ${usage?.s ?? '—'}, ${usage?.n ?? 0} player-seasons`);
console.log(`team context         newest season ${ctx?.s ?? '—'}, ${ctx?.n ?? 0} teams`);
console.log(`                     refresh with: npm run ingest:nflverse && npm run ingest:usage && npm run ingest:context`);

/*
 * The one structural staleness that is CORRECT and gets mistaken for a fault.
 * A comparable season needs the following year played, so the pool always stops
 * one season short of the newest one and always will. Stated here so nobody
 * "fixes" it — and so the gap between the two numbers is visibly one, not two.
 */
if (stats?.s && stats.s < SEASON - 1) {
  console.log(
    `\nNOTE  the newest season on file is ${stats.s} but the board is built for ${SEASON}. ` +
      `That is a gap of ${SEASON - stats.s} seasons, not the expected 1 — last season may not be ingested.`,
  );
} else if (stats?.s) {
  console.log(
    `\nNOTE  the comparables pool stops at ${stats.s - 1} by construction: a season teaches nothing ` +
      `until the following one is played. ${stats.s} is a profile with no outcome yet, so it is matched FROM and never TO.`,
  );
}

console.log(
  anyStale
    ? '\nSomething above is past its window. Nothing here is broken — these are judgement calls,\nand the props line is the one that costs money.\n'
    : '\nEverything is inside its refresh window.\n',
);
