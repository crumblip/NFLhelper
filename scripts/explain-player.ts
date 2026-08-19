import { sqlite } from '../lib/db/index';

/** Everything the tool knows about one player, in the order it reasons. */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);
const query = process.argv.slice(2).join(' ') || 'Omarion Hampton';

const p = sqlite
  .prepare(
    `SELECT gsis_id, display_name, position, latest_team, birth_date, rookie_season
     FROM players WHERE display_name LIKE ? LIMIT 1`,
  )
  .get(`%${query}%`) as
  | { gsis_id: string; display_name: string; position: string; latest_team: string;
      birth_date: string; rookie_season: number }
  | undefined;

if (!p) {
  console.log(`no player matching "${query}"`);
  process.exit(0);
}

const age = CURRENT - Number(String(p.birth_date).slice(0, 4));
console.log(`${p.display_name} — ${p.position}, ${p.latest_team}, age ${age}, rookie ${p.rookie_season}\n`);

const adp = sqlite
  .prepare(
    `SELECT adp, adp_formatted, times_drafted, high, low, stdev, bye
     FROM adp_raw WHERE player_id = ? AND year = ? AND format = ? AND teams = ?`,
  )
  .get(p.gsis_id, CURRENT, FORMAT, TEAMS) as Record<string, number | string> | undefined;

if (adp) {
  console.log('WHERE HE IS BEING DRAFTED (an observed fact, not a model output)');
  console.log(`  average pick     ${adp.adp}  (round ${adp.adp_formatted})`);
  console.log(`  drafted          ${adp.times_drafted} times in the sample`);
  console.log(`  earliest/latest  pick ${adp.high} to pick ${adp.low}`);
  console.log(`  spread (stdev)   ${adp.stdev} picks`);
  console.log(`  bye week         ${adp.bye}`);
}

const draft = sqlite
  .prepare(`SELECT round, pick, team FROM draft_picks WHERE player_id = ?`)
  .get(p.gsis_id) as { round: number; pick: number; team: string } | undefined;
const depth = sqlite
  .prepare(
    `SELECT pos_abb, pos_rank FROM depth_chart WHERE player_id = ? AND season = ?
     ORDER BY pos_rank LIMIT 1`,
  )
  .get(p.gsis_id, CURRENT) as { pos_abb: string; pos_rank: number } | undefined;

if (draft || depth) {
  console.log('\nSITUATION');
  if (draft) console.log(`  NFL draft        round ${draft.round}, pick ${draft.pick}, ${draft.team}`);
  if (depth) console.log(`  depth chart      ${depth.pos_abb}${depth.pos_rank} as of today`);
}

console.log('\nWHAT THE BETTING MARKET PRICES');
const props = sqlite
  .prepare(
    `SELECT stat, mu, line, source, book_count FROM implied_stats
     WHERE player_id = ? AND scope = 'season' ORDER BY stat`,
  )
  .all(p.gsis_id) as Array<{ stat: string; mu: number; line: number | null; source: string; book_count: number }>;
if (!props.length) console.log('  nothing posted');
for (const s of props) {
  console.log(
    `  ${s.stat.padEnd(16)} ${s.mu.toFixed(s.mu < 20 ? 1 : 0).padStart(6)}` +
      `${s.line !== null ? `  (line ${s.line})` : ''}  [${s.source}]`,
  );
}

console.log('\nHOW HE WAS USED ON THE FIELD');
const usage = sqlite
  .prepare(
    `SELECT season, games, team, rush_share, target_share, pass_snap_share,
            rz_touch_share, goal_line_share, rz_carries, goal_line_carries, total_tds
     FROM player_usage WHERE player_id = ? ORDER BY season`,
  )
  .all(p.gsis_id) as Array<Record<string, number | string | null>>;
if (!usage.length) console.log('  no NFL usage history');
for (const u of usage) {
  console.log(
    `  ${u.season}  ${String(u.games).padStart(2)}g ${String(u.team).padEnd(4)} ` +
      `rush ${((Number(u.rush_share) || 0) * 100).toFixed(0).padStart(3)}%  ` +
      `tgt ${((Number(u.target_share) || 0) * 100).toFixed(0).padStart(3)}%  ` +
      `route ${((Number(u.pass_snap_share) || 0) * 100).toFixed(0).padStart(3)}%  ` +
      `RZ ${((Number(u.rz_touch_share) || 0) * 100).toFixed(0).padStart(3)}%  ` +
      `GL ${((Number(u.goal_line_share) || 0) * 100).toFixed(0).padStart(3)}%  ` +
      `${String(u.goal_line_carries).padStart(2)} GL carries  ${String(u.total_tds).padStart(2)} TD`,
  );
}

console.log('\nWHAT THE TOOL CONCLUDES');
const v = sqlite
  .prepare(
    `SELECT implied_points, implied_vorp, expected_vorp, adp_equivalent, slot_gap,
            signal, market_stats, extrapolated_stats, derived_stats,
            usage_grade, market_pct, usage_gap, blended_points, blended_slot_gap,
            disagreement, verdict
     FROM value_scores WHERE player_id = ? AND format = ? AND teams = ? AND season = ?`,
  )
  .get(p.gsis_id, FORMAT, TEAMS, CURRENT) as Record<string, number | string | null> | undefined;

if (!v) {
  console.log('  not on the board');
} else {
  const n = (x: unknown, d = 1) =>
    x === null || x === undefined ? '—' : Number(x).toFixed(d);
  console.log(`  market projection    ${n(v.implied_points, 0)} pts  (${v.signal}, ` +
    `${v.market_stats} market / ${v.extrapolated_stats} wk1 / ${v.derived_stats} derived)`);
  console.log(`  value over repl      ${n(v.implied_vorp, 0)}`);
  console.log(`  pick ${adp?.adp} historically returns  ${n(v.expected_vorp, 0)}`);
  console.log(`  market-implied slot  ${n(v.adp_equivalent)}   -> slot gap ${n(v.slot_gap)}`);
  console.log(`  usage grade          ${v.usage_grade ?? '—'} of 100   (market rank ${v.market_pct ?? '—'})`);
  console.log(`  usage vs market      ${v.usage_gap ?? '—'} percentile points, ` +
    `${n(v.disagreement, 2)} SD`);
  console.log(`  BLENDED              ${n(v.blended_points, 0)} pts -> slot gap ${n(v.blended_slot_gap)}`);
  console.log(`  READ                 ${v.verdict ?? '—'}`);
}

console.log('\nCOMPARABLE RBs BY ADP');
for (const r of sqlite
  .prepare(
    `SELECT a.name, v.adp, v.implied_points m, v.usage_grade ug, v.blended_slot_gap bg, v.verdict, v.signal
     FROM value_scores v JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
      AND a.format=v.format AND a.teams=v.teams
     WHERE v.season=? AND v.position=? AND v.adp BETWEEN ? AND ?
     ORDER BY v.adp`,
  )
  .all(CURRENT, p.position, (Number(adp?.adp) || 0) - 12, (Number(adp?.adp) || 0) + 14) as Array<
  Record<string, number | string | null>
>) {
  console.log(
    `  ${String(r.adp).padStart(5)}  ${String(r.name).padEnd(22)} ` +
      `mkt ${r.m === null ? '  —' : Number(r.m).toFixed(0).padStart(3)}  ` +
      `usage ${String(r.ug ?? '—').padStart(3)}  ` +
      `blend ${r.bg === null ? '   —' : (Number(r.bg) > 0 ? '+' : '') + Number(r.bg).toFixed(1)}  ` +
      `${r.verdict ?? r.signal}`,
  );
}
