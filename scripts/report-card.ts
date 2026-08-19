import { sqlite } from '../lib/db/index';

/**
 * A scouting report card for receivers and backs.
 *
 * The board has many columns and no direction — the complaint that it reads as
 * statistics on a sheet is fair. This gives one headline per player and shows
 * only the inputs that earned their place in testing.
 *
 * Grades come from a percentile within position, not from fixed thresholds.
 * Thresholds were what produced a board where most of the league was "fairly
 * priced": any cutoff wide enough to be meaningful swallows the middle. A rank
 * always separates.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);
const POSITION = (process.argv[2] ?? '').toUpperCase();

interface Row {
  name: string; position: string; team: string | null; adp: number; age: number | null;
  blend: number | null; slotGap: number | null; usageGrade: number | null;
  disagreement: number | null; vacated: number | null; expectedGames: number | null;
  tdOver: number | null; signal: string; marketStats: number; extrapolated: number;
  ts: number | null; rs: number | null; pss: number | null; rz: number | null; gl: number | null;
  games: number | null;
}

const rows = sqlite
  .prepare(
    `SELECT a.name, v.position, a.team, v.adp,
            ? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age,
            v.blended_points blend, v.blended_slot_gap slotGap, v.usage_grade usageGrade,
            v.disagreement, v.vacated_share vacated, v.expected_games expectedGames,
            v.td_over_expected tdOver, v.signal, v.market_stats marketStats,
            v.extrapolated_stats extrapolated,
            u.target_share ts, u.rush_share rs, u.pass_snap_share pss,
            u.rz_touch_share rz, u.goal_line_share gl, u.games
     FROM value_scores v
     JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
      AND a.format = v.format AND a.teams = v.teams
     JOIN players p ON p.gsis_id = v.player_id
     LEFT JOIN player_usage u ON u.player_id = v.player_id AND u.season = ? - 1
     WHERE v.season = ? AND v.format = ? AND v.teams = ?
       AND v.position IN ('WR','RB')`,
  )
  .all(CURRENT, CURRENT, CURRENT, FORMAT, TEAMS) as Row[];

const pool = POSITION ? rows.filter((r) => r.position === POSITION) : rows;

/**
 * The headline score.
 *
 * Value carries the most weight — what he is projected to be worth is the point
 * of the exercise. Price is second: the same player is a different proposition
 * at pick 20 and pick 120. Role and opportunity break ties, and risk subtracts.
 */
function score(r: Row, valuePct: number, gapPct: number): number {
  const role = (r.usageGrade ?? 40) / 100;
  const opportunity = Math.min(1, (r.vacated ?? 0) / 0.5);
  const durability = r.expectedGames === null ? 0.85 : Math.min(1, r.expectedGames / 16);
  // Scoring above red-zone volume does not repeat, so it is marked down.
  const tdPenalty = r.tdOver !== null && r.tdOver > 2.5 ? 0.05 : 0;

  return (
    valuePct * 0.4 + gapPct * 0.25 + role * 0.2 + opportunity * 0.1 + durability * 0.05 - tdPenalty
  );
}

const pct = (vals: Array<[number, number]>) => {
  const sorted = [...vals].sort((a, b) => a[1] - b[1]);
  const m = new Map<number, number>();
  sorted.forEach(([i], idx) => m.set(i, sorted.length > 1 ? idx / (sorted.length - 1) : 0.5));
  return m;
};

const graded: Array<Row & { score: number; grade: string }> = [];

for (const position of POSITION ? [POSITION] : ['WR', 'RB']) {
  const group = pool.filter((r) => r.position === position && r.blend !== null);
  if (!group.length) continue;

  const valuePct = pct(group.map((r, i) => [i, r.blend!] as [number, number]));
  const gapPct = pct(group.map((r, i) => [i, r.slotGap ?? 0] as [number, number]));

  const scored = group.map((r, i) => ({
    ...r,
    score: score(r, valuePct.get(i) ?? 0.5, gapPct.get(i) ?? 0.5),
  }));

  scored.sort((a, b) => b.score - a.score);
  const n = scored.length;
  scored.forEach((r, i) => {
    const q = i / Math.max(1, n - 1);
    const grade =
      q <= 0.08 ? 'A+' : q <= 0.2 ? 'A' : q <= 0.35 ? 'B+' : q <= 0.5 ? 'B'
      : q <= 0.65 ? 'C+' : q <= 0.8 ? 'C' : q <= 0.92 ? 'D' : 'F';
    graded.push({ ...r, grade });
  });
}

graded.sort((a, b) => a.adp - b.adp);

const p = (v: number | null | undefined) =>
  v === null || v === undefined ? '  -' : `${Math.round(v * 100)}%`.padStart(4);

console.log(`SCOUTING REPORT — ${CURRENT} ${FORMAT}, ${TEAMS}-team${POSITION ? `, ${POSITION}` : ''}`);
console.log('Graded within position. A+ is a top-8% player at his position on this board.\n');
console.log('  gr   ADP pos team  player                age  tgt% rush% route%  rz%  gl%   proj  gap   role');
for (const r of graded) {
  const usage = r.position === 'RB' ? p(r.rs) : p(r.ts);
  console.log(
    `  ${r.grade.padEnd(2)} ${String(r.adp).padStart(5)} ${r.position.padEnd(3)} ${(r.team ?? '-').padEnd(4)}  ` +
      `${r.name.padEnd(21)}${String(r.age ?? '-').padStart(3)}  ${p(r.ts)} ${usage} ${p(r.pss)} ` +
      `${p(r.rz)} ${p(r.gl)}  ${r.blend === null ? '   -' : r.blend.toFixed(0).padStart(4)} ` +
      `${r.slotGap === null ? '    -' : ((r.slotGap > 0 ? '+' : '') + r.slotGap.toFixed(0)).padStart(5)}  ` +
      `${String(r.usageGrade ?? '-').padStart(4)}`,
  );

  const flags: string[] = [];
  if (r.vacated !== null && r.vacated >= 0.3) flags.push(`${Math.round(r.vacated * 100)}% volume vacated ahead`);
  if (r.expectedGames !== null && r.expectedGames <= 13) flags.push(`${r.expectedGames.toFixed(1)} games/yr`);
  if (r.tdOver !== null && r.tdOver > 2.5) flags.push(`TDs ${r.tdOver.toFixed(1)} over volume — expect regression`);
  if (r.tdOver !== null && r.tdOver < -2) flags.push(`TDs ${Math.abs(r.tdOver).toFixed(1)} under volume — expect rebound`);
  if (r.disagreement !== null && Math.abs(r.disagreement) > 1) {
    flags.push(r.disagreement > 0 ? 'role ahead of market price' : 'market price ahead of role');
  }
  if (r.signal !== 'full') flags.push(`market coverage ${r.signal}`);
  if (flags.length) console.log(`       ${flags.join(' · ')}`);
}

console.log('\nColumns: tgt%/rush% is his share of the team. route% is share of pass plays');
console.log('he was on the field for. rz%/gl% are shares of the team\'s red-zone and');
console.log('inside-the-5 work — the scoring chances. proj is blended points, gap is');
console.log('picks of value against his ADP, role is his usage rank at the position.');
