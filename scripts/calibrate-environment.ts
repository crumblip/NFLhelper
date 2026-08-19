import { sqlite } from '../lib/db/index';

/**
 * Two pieces of nuance the model does not currently see.
 *
 * 1. Touchdown competition. A receiver's scoring chances are not just his own
 *    red-zone share — they depend on who else on his team eats near the goal
 *    line. Zay Flowers competes with a quarterback who runs it in himself and a
 *    back built for short yardage. The same target share is worth less in
 *    Baltimore than somewhere those touchdowns are available.
 *
 * 2. Offensive environment. Points have to come from somewhere. A team that
 *    scores a lot, throws a lot, or is forced to keep pace because its defense
 *    leaks, produces more fantasy scoring for everyone in the huddle.
 *
 * Both are plausible. Neither is included until it demonstrably predicts
 * something the player's own usage does not already capture.
 */

const CURRENT = Number(process.env.SEASON ?? 2026);

/* ---------- team environment, built from box scores ---------- */

interface TeamSeason {
  key: string;
  team: string;
  season: number;
  passTds: number;
  rushTds: number;
  passYards: number;
  rushYards: number;
  targets: number;
  carries: number;
  /** Offensive touchdowns conceded by this team's defence. */
  tdsAllowed: number;
  yardsAllowed: number;
}

const teamRows = sqlite
  .prepare(
    `SELECT recent_team AS team, season,
            SUM(COALESCE(passing_tds,0)) passTds,
            SUM(COALESCE(rushing_tds,0)) rushTds,
            SUM(COALESCE(passing_yards,0)) passYards,
            SUM(COALESCE(rushing_yards,0)) rushYards,
            SUM(COALESCE(targets,0)) targets,
            SUM(COALESCE(carries,0)) carries
     FROM player_stats_week
     WHERE season_type='REG' AND recent_team IS NOT NULL
     GROUP BY recent_team, season`,
  )
  .all() as Array<Omit<TeamSeason, 'key' | 'tdsAllowed' | 'yardsAllowed'>>;

// What each defence conceded: everything produced against them.
const allowed = sqlite
  .prepare(
    `SELECT opponent_team AS team, season,
            SUM(COALESCE(passing_tds,0)) + SUM(COALESCE(rushing_tds,0)) + SUM(COALESCE(receiving_tds,0)) tds,
            SUM(COALESCE(passing_yards,0)) + SUM(COALESCE(rushing_yards,0)) yards
     FROM player_stats_week
     WHERE season_type='REG' AND opponent_team IS NOT NULL
     GROUP BY opponent_team, season`,
  )
  .all() as Array<{ team: string; season: number; tds: number; yards: number }>;

const allowedBy = new Map(allowed.map((r) => [`${r.team}|${r.season}`, r]));
const teams = new Map<string, TeamSeason>();
for (const t of teamRows) {
  const a = allowedBy.get(`${t.team}|${t.season}`);
  teams.set(`${t.team}|${t.season}`, {
    ...t,
    key: `${t.team}|${t.season}`,
    tdsAllowed: a?.tds ?? 0,
    yardsAllowed: a?.yards ?? 0,
  });
}

/* ---------- touchdown competition, from goal-line usage ---------- */

const glRows = sqlite
  .prepare(
    `SELECT u.team, u.season, u.position,
            SUM(COALESCE(u.goal_line_carries,0) + COALESCE(u.goal_line_targets,0)) gl,
            SUM(COALESCE(u.rz_carries,0) + COALESCE(u.rz_targets,0)) rz
     FROM player_usage u WHERE u.team IS NOT NULL GROUP BY u.team, u.season, u.position`,
  )
  .all() as Array<{ team: string; season: number; position: string; gl: number; rz: number }>;

/** Share of a team's goal-line work taken by the quarterback, and by its backs. */
const competition = new Map<string, { qbGl: number; rbGl: number; totalGl: number }>();
for (const r of glRows) {
  const key = `${r.team}|${r.season}`;
  const e = competition.get(key) ?? { qbGl: 0, rbGl: 0, totalGl: 0 };
  e.totalGl += r.gl;
  if (r.position === 'QB') e.qbGl += r.gl;
  if (r.position === 'RB') e.rbGl += r.gl;
  competition.set(key, e);
}

/* ---------- does any of it predict? ---------- */

const players = sqlite
  .prepare(
    `SELECT u.player_id, u.season, u.position, u.team,
            COALESCE(u.target_share,0) ts, COALESCE(u.rush_share,0) rs,
            COALESCE(u.rz_touch_share,0) rz
     FROM player_usage u WHERE u.games >= 6 AND u.team IS NOT NULL
       AND u.position IN ('WR','RB','TE')`,
  )
  .all() as Array<{
  player_id: string; season: number; position: string; team: string;
  ts: number; rs: number; rz: number;
}>;

const nextTds = new Map<string, number>();
for (const r of sqlite
  .prepare(
    `SELECT player_id, season,
            SUM(COALESCE(receiving_tds,0) + COALESCE(rushing_tds,0)) td,
            COUNT(*) g
     FROM player_stats_week WHERE season_type='REG' GROUP BY player_id, season`,
  )
  .all() as Array<{ player_id: string; season: number; td: number; g: number }>) {
  if (r.g >= 6) nextTds.set(`${r.player_id}|${r.season}`, r.td / r.g);
}

function corr(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 30) return NaN;
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

/** Correlation of x with y after removing the linear effect of a control. */
function partial(data: Array<{ x: number; c: number; y: number }>): number {
  if (data.length < 30) return NaN;
  const mc = data.reduce((a, d) => a + d.c, 0) / data.length;
  const my = data.reduce((a, d) => a + d.y, 0) / data.length;
  let scy = 0, scc = 0;
  for (const d of data) {
    scy += (d.c - mc) * (d.y - my);
    scc += (d.c - mc) ** 2;
  }
  const slope = scc ? scy / scc : 0;
  return corr(data.map((d) => [d.x, d.y - (my + slope * (d.c - mc))] as [number, number]));
}

console.log('Do team factors predict a player\'s NEXT-season touchdown rate,');
console.log('after his own red-zone share is accounted for?\n');
console.log('  pos  factor                          n     raw r    partial r');

const factors: Array<[string, (t: TeamSeason, c: { qbGl: number; rbGl: number; totalGl: number }) => number]> = [
  ['team offensive TDs', (t) => t.passTds + t.rushTds],
  ['team pass yards', (t) => t.passYards],
  ['pass rate', (t) => (t.targets + t.carries ? t.targets / (t.targets + t.carries) : 0)],
  ['TDs allowed by own defence', (t) => t.tdsAllowed],
  ['yards allowed by own defence', (t) => t.yardsAllowed],
  ['QB share of goal line', (_t, c) => (c.totalGl ? c.qbGl / c.totalGl : 0)],
  ['RB share of goal line', (_t, c) => (c.totalGl ? c.rbGl / c.totalGl : 0)],
];

for (const pos of ['WR', 'RB', 'TE']) {
  for (const [label, fn] of factors) {
    const data: Array<{ x: number; c: number; y: number }> = [];
    for (const p of players) {
      if (p.position !== pos) continue;
      const t = teams.get(`${p.team}|${p.season}`);
      const comp = competition.get(`${p.team}|${p.season}`);
      const y = nextTds.get(`${p.player_id}|${p.season + 1}`);
      if (!t || !comp || y === undefined) continue;
      data.push({ x: fn(t, comp), c: p.rz, y });
    }
    if (data.length < 30) continue;
    const raw = corr(data.map((d) => [d.x, d.y] as [number, number]));
    console.log(
      `  ${pos.padEnd(4)} ${label.padEnd(30)} ${String(data.length).padStart(4)}  ` +
        `${raw.toFixed(3).padStart(8)}  ${partial(data).toFixed(3).padStart(10)}`,
    );
  }
  console.log();
}

console.log('partial r is the one that matters: what the team factor adds once the');
console.log('player\'s own red-zone share is known. Near zero means the team effect was');
console.log('already inside his usage and adds nothing.');
