import { sqlite } from '../lib/db/index';
import { getWaiverBoard } from '../lib/waiver';
import { getLeagueNews } from '../lib/news';
import { CREATORS } from '../lib/creators';
import { buildLiveReads } from '../lib/pipeline/inseason';
import { resolveUsageSeason } from '../lib/pipeline/usage-grade';
import { USAGE_CONFIDENCE, GAP_DEAD_BAND } from '../lib/pipeline/blend';
import { buildScouting } from '../lib/pipeline/scouting';
import { buildRoleCertainty } from '../lib/pipeline/role';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Standing invariant checks on the built board.
 *
 * Every bug found in this project so far belongs to one of a small number of
 * families, and each family is detectable without knowing which player is
 * affected. Rather than wait for a result to look wrong to a human, this asserts
 * the properties directly and fails loudly.
 *
 * The families, and the bug that named each:
 *
 *   POSITION DISPATCH  code branching `isRb ? x : y` silently hands quarterbacks
 *                      the receiver path. Bryce Young "depth target — 0% of team
 *                      targets"; Kyler Murray "full-time, secondary target";
 *                      Mahomes "32% of targets vacated".
 *   DEAD THRESHOLD     a cutoff that fires on all or none of a group carries no
 *                      information. `bustRate >= 0.20` flagged 25 of 25 QBs;
 *                      arrival absorption pinned 32 of 32 teams at the cap.
 *   CROSS-POSITION     comparing a metric across positions whose distributions
 *                      differ. Late TEs run a 40% breakout rate against 8% for
 *                      WRs, so any absolute cutoff just selects tight ends.
 *   STALE FACT         last season's team or role asserted as current. Wicks
 *                      credited with the targets he vacated by leaving; Willis
 *                      "not the starter" while listed QB1.
 *   SCALE MISMATCH     comparing a regressed projection to an actual-points
 *                      threshold. Every uncovered player charged ~20 phantom
 *                      points, making "no betting lines" look like "not good".
 *   CONTRADICTION      two tags on one player that cannot both be true.
 *
 * Run after `build:blend`. Exits non-zero if any check fails, so it can gate a
 * refresh.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const SEASON = Number(process.env.SEASON ?? 2026);

interface Row {
  player_id: string;
  name: string;
  position: string;
  adp: number;
  team: string | null;
  signal: string;
  vacated: number | null;
  vorp: number | null;
  usageGrade: number | null;
  adpEquivalent: number | null;
  expectedGames: number | null;
  outlook: string | null;
  upsideGain: number | null;
  upsideChance: number | null;
  tags: Array<{ id: string; label: string; kind: string }>;
}

const rows: Row[] = (
  sqlite
    .prepare(
      `SELECT v.player_id, a.name, v.position, v.adp, a.team, v.signal,
              v.vacated_share AS vacated, v.blended_vorp AS vorp,
              v.usage_grade AS usageGrade, v.expected_games AS expectedGames,
              v.blended_adp_equivalent AS adpEquivalent,
              v.outlook, v.tags,
              v.upside_gain AS upsideGain, v.upside_chance AS upsideChance
       FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ?`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<Omit<Row, 'tags'> & { tags: string | null }>
).map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));

const depthRank = new Map(
  (
    sqlite
      .prepare(
        `SELECT player_id, pos_abb, team, MIN(pos_rank) AS rank FROM depth_chart
         WHERE season = ? AND pos_abb IN ('QB','RB','WR','TE')
         GROUP BY player_id, pos_abb`,
      )
      .all(SEASON) as Array<{ player_id: string; pos_abb: string; team: string; rank: number }>
  ).map((r) => [`${r.player_id}|${r.pos_abb}`, r]),
);

const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
const has = (r: Row, id: string) => r.tags.some((t) => t.id === id);
const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

let failures = 0;
let warnings = 0;

function check(name: string, ok: boolean, detail: string, soft = false) {
  if (ok) {
    console.log(`  PASS  ${name}`);
    return;
  }
  if (soft) {
    warnings++;
    console.log(`  WARN  ${name}\n        ${detail}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}\n        ${detail}`);
  }
}

console.log(`AUDIT — ${FORMAT} ${TEAMS}-team ${SEASON}, ${rows.length} board players\n`);

/* ------------------------------------------------------------------ */
console.log('POSITION DISPATCH — is any position getting another position\'s logic?');

const qbVacancy = rows.filter((r) => r.position === 'QB' && (r.vacated ?? 0) > 0);
check(
  'quarterbacks inherit no vacated volume',
  qbVacancy.length === 0,
  `${qbVacancy.length} QBs carry a vacated share, which is receiver logic: ` +
    qbVacancy.slice(0, 3).map((r) => `${r.name} ${Math.round((r.vacated ?? 0) * 100)}%`).join(', '),
);

// Tags whose wording is only meaningful for a pass catcher.
const RECEIVER_ONLY = ['workhorse', 'committee', 'every-down', 'rotational', 'volume-open'];
const qbReceiverTags = rows.filter(
  (r) => r.position === 'QB' && RECEIVER_ONLY.some((t) => has(r, t)),
);
check(
  'no receiver-only tag lands on a quarterback',
  qbReceiverTags.length === 0,
  `${qbReceiverTags.length} QBs: ` +
    qbReceiverTags
      .slice(0, 3)
      .map((r) => `${r.name} [${r.tags.filter((t) => RECEIVER_ONLY.includes(t.id)).map((t) => t.label)}]`)
      .join(', '),
);

/*
 * Matched as phrases, not substrings. A `LIKE '%back%'` test reports every
 * correct archetype as broken, because "quarterback" contains "back" — the check
 * itself has to survive scrutiny or it just moves the whack-a-mole up a level.
 */
const RECEIVER_PHRASES = [
  'target', 'receiver', 'bell cow', 'committee back', 'depth back',
  'passing-down back', 'goal-line specialist', 'tight end', 'field-stretcher',
];
const qbArchetypes = sqlite
  .prepare(`SELECT player_id, archetype FROM value_scores WHERE season = ? AND position = 'QB' AND archetype IS NOT NULL`)
  .all(SEASON) as Array<{ player_id: string; archetype: string }>;
const wrongArchetype = qbArchetypes.filter((a) =>
  RECEIVER_PHRASES.some((phrase) => a.archetype.toLowerCase().includes(phrase)),
);
check(
  'no quarterback described as a receiver or a back',
  wrongArchetype.length === 0,
  `${wrongArchetype.length}: ${wrongArchetype.map((a) => a.archetype).join(', ')}`,
);

/* ------------------------------------------------------------------ */
console.log('\nDEAD THRESHOLD — does any tag fire on all or none of a position?');

const tagIds = [...new Set(rows.flatMap((r) => r.tags.map((t) => t.id)))].sort();
const saturated: string[] = [];
for (const id of tagIds) {
  for (const pos of POSITIONS) {
    const group = rows.filter((r) => r.position === pos);
    if (group.length < 8) continue;
    const share = group.filter((r) => has(r, id)).length / group.length;
    // A tag on >90% of a position separates nobody within it.
    if (share > 0.9) saturated.push(`${id} on ${Math.round(share * 100)}% of ${pos}`);
  }
}
check(
  'no tag saturates a position',
  saturated.length === 0,
  `uninformative within that position: ${saturated.join('; ')}`,
);

/*
 * The other half of the same problem, and the one that actually shipped.
 *
 * `every-down` used a flat pass-snap-share cutoff of 0.85 across all positions.
 * That is not a threshold on role, it is a threshold on position: it fired on
 * 38% of receivers and 42% of tight ends against 4% of backs, because a bell cow
 * leaves the field on passing downs and a WR1 does not. A tag whose rate swings
 * by an order of magnitude between positions is describing the position.
 *
 * Coverage and price tags are exempt: "no betting lines" genuinely does depend on
 * position (books price quarterbacks and ignore depth backs), and price tags key
 * off ADP, which is a market fact rather than a claim about the player.
 */
const SKEW_EXEMPT = new Set(['coverage', 'price']);
const skewed: string[] = [];
for (const id of tagIds) {
  const kind = rows.flatMap((r) => r.tags).find((t) => t.id === id)?.kind ?? '';
  if (SKEW_EXEMPT.has(kind)) continue;

  const rates = POSITIONS.map((pos) => {
    const group = rows.filter((r) => r.position === pos);
    // Only judge positions where the tag is applicable and the counts can carry
    // a rate. Without an absolute floor this fired on `role-ahead` at "8% of QB
    // vs 1% of WR", which is two players against one — a ratio computed from
    // noise is the same error one level up (#33).
    if (group.length < 15) return null;
    const hits = group.filter((r) => has(r, id)).length;
    return hits < 3 ? null : { pos, rate: hits / group.length };
  }).filter((x): x is { pos: (typeof POSITIONS)[number]; rate: number } => x !== null);

  if (rates.length < 2) continue;
  const hi = rates.reduce((a, b) => (b.rate > a.rate ? b : a));
  const lo = rates.reduce((a, b) => (b.rate < a.rate ? b : a));
  if (hi.rate / lo.rate >= 6) {
    skewed.push(
      `${id} ${Math.round(hi.rate * 100)}% of ${hi.pos} vs ${Math.round(lo.rate * 100)}% of ${lo.pos}`,
    );
  }
}
check(
  'no role or risk tag fires at wildly different rates by position',
  skewed.length === 0,
  `these look like thresholds on position rather than on the player: ${skewed.join('; ')} — ` +
    `rank the metric within position, or set the cutoff from each position's own distribution`,
);

const vacancyStats = sqlite
  .prepare(
    `SELECT COUNT(*) n, SUM(CASE WHEN vacated_share >= 0.25 THEN 1 ELSE 0 END) live
     FROM value_scores WHERE season = ? AND position IN ('RB','WR','TE')`,
  )
  .get(SEASON) as { n: number; live: number };
check(
  'opportunity signal is alive for skill positions',
  vacancyStats.live > 0,
  'no RB/WR/TE reaches a 25% vacated share — the opportunity signal is dead, ' +
    'which is how the arrival-absorption saturation hid for so long',
);

/* ------------------------------------------------------------------ */
console.log('\nCROSS-POSITION — are outcome rates being compared across unlike pools?');

const outlookByPos = new Map<string, { breakout: number[]; bust: number[] }>();
for (const r of rows) {
  if (!r.outlook) continue;
  try {
    const o = JSON.parse(r.outlook) as { breakoutRate: number; bustRate: number };
    const e = outlookByPos.get(r.position) ?? { breakout: [], bust: [] };
    e.breakout.push(o.breakoutRate);
    e.bust.push(o.bustRate);
    outlookByPos.set(r.position, e);
  } catch {
    /* stale */
  }
}
const breakoutMedians = [...outlookByPos].map(([p, v]) => [p, median(v.breakout)] as const);
const spread =
  Math.max(...breakoutMedians.map(([, m]) => m)) - Math.min(...breakoutMedians.map(([, m]) => m));
console.log(
  '  note  breakout-rate medians: ' +
    breakoutMedians.map(([p, m]) => `${p} ${(m * 100).toFixed(0)}%`).join('  '),
);
check(
  'position-relative ranking is in use for outcome rates',
  spread > 0.1,
  'medians are close enough that an absolute cutoff might be safe — verify',
  true,
);
// The real assertion: the tags built on those rates must not select one position.
for (const id of ['late-upside', 'dead-end']) {
  const tagged = rows.filter((r) => has(r, id));
  if (tagged.length < 4) continue;
  const byPos = POSITIONS.map((p) => tagged.filter((r) => r.position === p).length);
  const dominant = Math.max(...byPos) / tagged.length;
  check(
    `"${id}" is not concentrated in a single position`,
    dominant < 0.8,
    `${Math.round(dominant * 100)}% of them are one position (` +
      POSITIONS.map((p, i) => `${p}=${byPos[i]}`).join(' ') +
      ') — the classic sign of an absolute cutoff on a position-relative metric',
  );
}

/* ------------------------------------------------------------------ */
console.log('\nSTALE FACT — is anything from last season asserted as current?');

const movedButListed = rows.filter((r) => {
  const d = depthRank.get(`${r.player_id}|${r.position}`);
  return d && r.team && d.team !== r.team;
});
check(
  'board team agrees with the current depth chart',
  movedButListed.length === 0,
  `${movedButListed.length} players are listed on a different team than the board shows: ` +
    movedButListed.slice(0, 4).map((r) => `${r.name} board=${r.team} chart=${depthRank.get(`${r.player_id}|${r.position}`)!.team}`).join(', '),
  true,
);

const backupButFirst = rows.filter(
  (r) => has(r, 'qb-backup') && (depthRank.get(`${r.player_id}|QB`)?.rank ?? 99) === 1,
);
check(
  'nobody is called a backup while listed first',
  backupButFirst.length === 0,
  `${backupButFirst.length}: ${backupButFirst.map((r) => r.name).join(', ')}`,
);

/*
 * THE DEPTH CHART IS A SNAPSHOT, NOT AN ACCUMULATION.
 *
 * nflverse ships depth charts as dated snapshots and the ingest used to keep the
 * newest row per (player, position). That is not the same rule: a player cut in
 * August has no August row, so his July row was still his newest and he stayed
 * on the chart at a team that had moved on. 610 of 3,792 rows were leftovers of
 * that kind, 41 of them skill players — Harrison Bryant listed at Seattle while
 * under contract in Houston, Mike Woods at Denver with a status of CUT.
 *
 * It matters because the waiver page REQUIRES a listing, so a departed player
 * stayed claimable, and the depth-chart room showed team-mates who had left.
 *
 * Two things make a chart a snapshot, and both are checked: every row for a team
 * carries that team's one current date, and no player is listed at two teams at
 * once. The second is the observable symptom of the first and is worth testing
 * separately, because a future ingest could hold one date per team and still
 * duplicate a player across them.
 */
{
  const dated = sqlite
    .prepare(
      `SELECT team, COUNT(DISTINCT as_of) dates, COUNT(*) n
       FROM depth_chart WHERE season = ? GROUP BY team`,
    )
    .all(SEASON) as Array<{ team: string; dates: number; n: number }>;
  const mixed = dated.filter((t) => t.dates > 1);
  check(
    'every depth chart is one dated snapshot per team, not a pile of them',
    mixed.length === 0,
    `${mixed.length} teams hold rows from several charts at once: ` +
      mixed.slice(0, 4).map((t) => `${t.team} (${t.dates} dates)`).join(', '),
  );

  const twoTeams = sqlite
    .prepare(
      `SELECT p.display_name AS name, GROUP_CONCAT(DISTINCT d.team) AS teams
       FROM depth_chart d JOIN players p ON p.gsis_id = d.player_id
       WHERE d.season = ? AND p.position IN ('QB','WR','RB','TE')
       GROUP BY d.player_id HAVING COUNT(DISTINCT d.team) > 1`,
    )
    .all(SEASON) as Array<{ name: string; teams: string }>;
  check(
    'no player is on two depth charts at once',
    twoTeams.length === 0,
    `${twoTeams.length}: ${twoTeams.slice(0, 4).map((r) => `${r.name} (${r.teams})`).join(', ')}`,
  );
}

/*
 * EVERY ARROW ON THE DEPTH CHART NAMES A FACT ABOUT THIS ROOM.
 *
 * The trend column fired on artefacts in three separate ways, and each produced
 * a confident arrow with nothing behind it:
 *
 *   - `depthRank > usageRank` compared a rank over the whole room against a rank
 *     over only the men with any usage, so the third role-holder in a
 *     fifteen-man camp room read "out-produced the men listed above him". Ricky
 *     Pearsall carried it at depth 14 (family #3/#5).
 *   - shares were compared across teams, so Brian Thomas Jr — Jacksonville's WR1
 *     — read losing ground because Jakobi Meyers arrived holding a bigger share
 *     of Las Vegas's targets (family #4, and bug #42's exact mistake).
 *   - a man could "slip" on availability without holding a job at all: Brady
 *     Cook, the third quarterback, at "5.0 games a year". True number, false
 *     claim.
 *
 * Three invariants, each tied to one of those:
 *   1. a slip or a rise from a share comparison must name a same-team player
 *   2. an arrival never carries an arrow
 *   3. only the man listed first can slip on his own availability
 */
{
  const rooms = buildRoleCertainty(SEASON);
  const seenRow = new Set<string>();
  const crossTeam: string[] = [];
  const arrivalArrow: string[] = [];
  const slipWithoutJob: string[] = [];
  const unexplained: string[] = [];

  for (const rc of rooms.values()) {
    const byId = new Map(rc.room.map((m) => [m.playerId, m]));
    for (const m of rc.room) {
      if (seenRow.has(m.playerId)) continue;
      seenRow.add(m.playerId);

      if (m.trend !== 'holding' && m.shareTeam) arrivalArrow.push(m.name);

      // A comparison reason names another man; he must be in this room and his
      // share must have been earned here.
      const named = [...byId.values()].find(
        (x) => x.playerId !== m.playerId && m.trendReason.includes(x.name),
      );
      if (named && /took more of the work here|listed below him/.test(m.trendReason) && named.shareTeam) {
        crossTeam.push(`${m.name} <- ${named.name} (@${named.shareTeam})`);
      }

      // An availability slip carries a measured figure and belongs only to the
      // man listed first. A room-fact slip names somebody and is exempt.
      if (m.trend === 'slipping' && !named && m.depthRank !== 1) {
        slipWithoutJob.push(`${m.name} (depth ${m.depthRank}: ${m.trendReason})`);
      }

      /*
       * THE INVARIANT THAT ACTUALLY CATCHES THE ORIGINAL BUG.
       *
       * The first three checks here all passed while the broken rule was
       * restored, because the artefact produced a RISING arrow reading
       * "out-produced the men listed above him" — no team involved, nobody
       * named, nothing to contradict. A check that does not fire on the bug it
       * was written for is worse than no check, since the passing line reads as
       * coverage (#95's lesson, and rule 4 of the working notes).
       *
       * So: an arrow must be backed by ONE of the two things that can back it —
       * a named man in this room, or a measured figure about himself. A claim
       * about "the men above him" that cannot say which men is neither, and
       * that is exactly the shape of the rank-mismatch bug.
       *
       * Same standard as `every "measured" point quotes the number behind it`.
       */
      if (m.trend !== 'holding' && !named && !/\d/.test(m.trendReason)) {
        unexplained.push(`${m.name}: "${m.trendReason}"`);
      }
    }
  }

  check(
    'no depth-chart arrow rests on a share earned at another team',
    crossTeam.length === 0,
    `${crossTeam.length}: ${crossTeam.slice(0, 3).join(', ')}`,
  );
  check(
    'a player who changed teams carries no direction arrow',
    arrivalArrow.length === 0,
    `${arrivalArrow.length}: ${arrivalArrow.slice(0, 4).join(', ')} — his share was earned elsewhere`,
  );
  check(
    'only the man listed first can be losing ground on his own availability',
    slipWithoutJob.length === 0,
    `${slipWithoutJob.length}: ${slipWithoutJob.slice(0, 3).join(', ')} — no job to lose`,
  );
  check(
    'every depth-chart arrow names a man or quotes a number',
    unexplained.length === 0,
    `${unexplained.length} arrows claim a comparison they cannot point at: ${unexplained.slice(0, 3).join(', ')}`,
  );

  /*
   * And the room is a fantasy room, not a camp roster.
   *
   * nflverse publishes 90-man charts — 10 to 15 receivers a team — and a
   * seventh back is not an asset, a contingency, or on the roster in three
   * weeks. The cut is measured (see ROOM_DEPTH); this checks it is actually
   * applied, and that it did not go so far that a room stops describing a
   * position group.
   */
  const sizes = new Map<string, number[]>();
  const seenRoom = new Set<string>();
  for (const rc of rooms.values()) {
    const key = rc.room.map((m) => m.playerId).sort().join(',');
    if (seenRoom.has(key) || rc.room.length === 0) continue;
    seenRoom.add(key);
    const pos = sqlite
      .prepare(`SELECT pos_abb FROM depth_chart WHERE season=? AND player_id=? LIMIT 1`)
      .get(SEASON, rc.room[0]!.playerId) as { pos_abb: string } | undefined;
    if (!pos) continue;
    (sizes.get(pos.pos_abb) ?? sizes.set(pos.pos_abb, []).get(pos.pos_abb)!).push(rc.room.length);
  }
  const bloated = [...sizes].filter(([, ns]) => Math.max(...ns) > 10);
  const gutted = [...sizes].filter(([, ns]) => Math.min(...ns) < 2);
  check(
    'no depth chart is still a camp roster',
    bloated.length === 0,
    `${bloated.map(([p, ns]) => `${p} runs to ${Math.max(...ns)}`).join(', ')}`,
  );
  check(
    'no depth chart was cut down to nothing',
    gutted.length === 0,
    `${gutted.map(([p, ns]) => `${p} falls to ${Math.min(...ns)}`).join(', ')}`,
  );
}

/*
 * A PRESENT-TENSE CLAIM ABOUT AN OFFENCE MUST NAME THE OFFENCE HE IS IN.
 *
 * The scouting panel — play caller, scoring offence, quarterback, offensive
 * line — was keyed on `player_usage.team`, which is last season's roster. 165
 * players had changed teams and 31 of them were on the board, so A.J. Brown was
 * scouted against Philadelphia's offence while playing for New England and Jahan
 * Dotson read Nick Sirianni as his play caller after a trade to Atlanta. Family
 * #4, and the same join error as #14, #29 and #42.
 *
 * The environment is still measured LAST season — `team_context` is built from
 * play-by-play and the coming season has not been played — so the right team in
 * the past tense is the best available, and the page says so. What must never
 * happen again is the wrong team.
 */
{
  const scoutingRows = buildScouting(SEASON);
  const currentTeam = new Map(
    (
      sqlite
        .prepare(
          `SELECT d.player_id, d.team FROM depth_chart d
           JOIN (SELECT player_id, pos_abb, MIN(pos_rank) mr FROM depth_chart
                 WHERE season = ? GROUP BY player_id, pos_abb) m
             ON m.player_id = d.player_id AND m.pos_abb = d.pos_abb AND m.mr = d.pos_rank
           WHERE d.season = ?`,
        )
        .all(SEASON, SEASON) as Array<{ player_id: string; team: string }>
    ).map((r) => [r.player_id, r.team]),
  );

  const wrongOffence = [...scoutingRows.values()].filter((s) => {
    const listed = currentTeam.get(s.playerId);
    return listed && s.environment.team && s.environment.team !== listed;
  });
  check(
    'the offence on the scouting panel is the one he currently plays for',
    wrongOffence.length === 0,
    `${wrongOffence.length} players are scouted against a team they have left: ` +
      wrongOffence
        .slice(0, 4)
        .map((s) => `${s.playerId} env=${s.environment.team} chart=${currentTeam.get(s.playerId)}`)
        .join(', '),
  );

  // The flag the page branches on has to disagree with the team it sits beside,
  // or the caveat reads "he arrives from Atlanta" above Atlanta's own numbers —
  // a claim of movement about a player who stayed put, which is worse than no
  // caveat at all.
  const badMoved = [...scoutingRows.values()].filter(
    (s) => s.movedFrom !== null && s.movedFrom === s.environment.team,
  );
  check(
    'the "he arrives from" note names a team he actually left',
    badMoved.length === 0,
    `${badMoved.length} rows say a player arrived from the team he is already on`,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nSCALE MISMATCH — is missing data being read as bad performance?');

const medianVorpBySignal = ['full', 'partial', 'none'].map((s) => {
  const v = rows.filter((r) => r.signal === s && r.vorp !== null).map((r) => r.vorp!);
  return [s, v.length, median(v)] as const;
});
console.log(
  '  note  median VALUE by market coverage: ' +
    medianVorpBySignal.map(([s, n, m]) => `${s} n=${n} med=${Number.isNaN(m) ? '-' : m.toFixed(0)}`).join('  '),
);
{
  /*
   * The comparison has to control for quality.
   *
   * Comparing raw medians says covered players are ~28 points better, which is
   * mostly true and mostly selection: sportsbooks price the players they expect
   * to be good, so the uncovered pool is full of marginal ones. The question
   * that isolates a scale bug is whether two players of the SAME measured role
   * get different value depending only on whether a book prices them.
   *
   * Checked in the grade band where draft decisions actually happen. At the
   * bottom the pools are too unlike to compare — 32 uncovered players against 8
   * covered — and a difference there says more about who gets priced than about
   * the arithmetic.
   */
  /*
   * Two corrections to how this comparison was drawn, both of which it was
   * failing on rather than finding a bug with.
   *
   * It pooled positions. The covered side was 46 players and the uncovered side
   * was 9 — one back, three tight ends and five receivers — and tight end VALUE
   * runs structurally lower than receiver VALUE, so the medians were measuring
   * position mix. That is the cross-position family (#23, #49) inside the audit
   * itself, which has happened before (#33).
   *
   * It also ignored availability, and availability is not incidental here: a
   * sportsbook declines to post a season line precisely when it does not know
   * whether a player will be on the field. Malik Nabers came back at grade 94
   * and VALUE 14.5 off an ACL. His usage read and his market silence have the
   * same cause, so comparing him against fully-priced healthy receivers cannot
   * isolate an arithmetic error.
   *
   * A median over three players is not evidence either way, so a position
   * without enough on both sides is reported and not judged. The check now
   * makes a claim it can actually support, which is the point of it.
   */
  const MIN_PER_SIDE = 5;
  const draftable = rows.filter(
    (r) =>
      r.vorp !== null &&
      r.usageGrade !== null &&
      r.usageGrade >= 60 &&
      (r.expectedGames ?? 0) >= 14,
  );

  const gaps: Array<{ position: string; gap: number; cov: number; unc: number }> = [];
  const thin: string[] = [];
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    const at = draftable.filter((r) => r.position === position);
    const cov = at.filter((r) => r.signal === 'full').map((r) => r.vorp!);
    const unc = at.filter((r) => r.signal === 'none').map((r) => r.vorp!);
    if (cov.length < MIN_PER_SIDE || unc.length < MIN_PER_SIDE) {
      thin.push(`${position} ${cov.length}v${unc.length}`);
      continue;
    }
    gaps.push({ position, gap: median(cov) - median(unc), cov: cov.length, unc: unc.length });
  }

  const worst = gaps.reduce(
    (a, b) => (Math.abs(b.gap) > Math.abs(a?.gap ?? -1) ? b : a),
    undefined as (typeof gaps)[number] | undefined,
  );

  if (!gaps.length) {
    console.log(
      `  note  coverage-vs-VALUE not testable this build — too few healthy uncovered players ` +
        `at any position (${thin.join(', ')}). The scale it guards is exercised by the ` +
        `"usage scale -> actual" line in build:blend.`,
    );
  } else {
    check(
      'at equal measured role, market coverage does not change VALUE',
      Math.abs(worst!.gap) < 20,
      `${worst!.position}: the median covered player is ${worst!.gap.toFixed(0)} points from the ` +
        `median uncovered one (n=${worst!.cov} vs ${worst!.unc}, both healthy) — a large gap here ` +
        `is the signature of comparing a regressed projection against an actual-points replacement` +
        (thin.length ? `. Not testable at ${thin.join(', ')}` : ''),
    );
  }
}

/* ------------------------------------------------------------------ */
console.log('\nUSER-FACING TEXT — is any internal representation leaking?');

const LEAKS = ['NaN', 'undefined', '{"', '[object', 'Infinity'];
const leaky = rows.filter((r) =>
  r.tags.some((t) => {
    const text = `${t.label} ${(t as { detail?: string }).detail ?? ''}`;
    return LEAKS.some((bad) => text.includes(bad));
  }),
);
check(
  'no tag text leaks an internal value',
  leaky.length === 0,
  `${leaky.length}: ${leaky.slice(0, 3).map((r) => r.name).join(', ')}`,
);

const prose = sqlite
  .prepare(
    `SELECT COUNT(*) n FROM value_scores WHERE season = ?
     AND (verdict LIKE '{%' OR archetype LIKE '{%' OR risk_notes LIKE '{%'
          OR opportunity_note LIKE '{%')`,
  )
  .get(SEASON) as { n: number };
check(
  'no JSON blob stored in a prose column',
  prose.n === 0,
  `${prose.n} rows hold JSON where a sentence is expected — the outlook column did ` +
    `exactly this and printed itself at the reader`,
);

/*
 * NO `title=` ATTRIBUTES. The rule was written down and then broken three times.
 *
 * The native attribute waits about a second, cannot be styled, and never appears
 * on a touch device — so on a page whose whole argument is that every number
 * carries its explanation, it is the same as no explanation. `Tip` exists for
 * this and is used everywhere else.
 *
 * It had crept back into the weekly chart (one per bar, the only way to read an
 * individual week), the depth-chart room (a duplicate of text already rendered
 * one column over) and the theme toggle (a duplicate of its own `aria-label`).
 * A rule in a document is not enforcement, so this greps the source.
 *
 * Matches only the JSX attribute form `title={` / `title="` on a lowercase HTML
 * element line, because `<SectionHead title="..." />` is a React prop of the
 * same name and is entirely fine — a checker that cannot tell those apart would
 * fire on 20 correct call sites and be turned off within a day.
 */
{
  const files = readdirSync('app', { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `app/${f}`.replace(/\\/g, '/'));

  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/(^|\s)title=[{"']/.test(line)) return;
      // Walk back to the tag this attribute belongs to. A capitalised tag is a
      // React component and `title` is its prop.
      let tag = '';
      for (let j = i; j >= 0 && j > i - 12; j--) {
        const m = [...lines[j]!.matchAll(/<([A-Za-z][\w.]*)/g)].pop();
        if (m) { tag = m[1]!; break; }
      }
      if (tag && /^[a-z]/.test(tag)) offenders.push(`${file}:${i + 1} <${tag}>`);
    });
  }
  check(
    'no native title attribute on an HTML element — explanations use Tip',
    offenders.length === 0,
    `${offenders.length}: ${offenders.slice(0, 4).join(', ')}`,
  );
}

const badOutlook = rows.filter((r) => {
  if (!r.outlook) return false;
  try {
    const o = JSON.parse(r.outlook) as { floor: number; median: number; ceiling: number };
    return !(o.floor <= o.median && o.median <= o.ceiling);
  } catch {
    return true;
  }
});
check(
  'outlook ranges are ordered floor <= median <= ceiling',
  badOutlook.length === 0,
  `${badOutlook.length} malformed: ${badOutlook.slice(0, 3).map((r) => r.name).join(', ')}`,
);

const dupes = rows.map((r) => r.player_id).filter((id, i, all) => all.indexOf(id) !== i);
check('no player appears on the board twice', dupes.length === 0, `${dupes.length} duplicates`);

/* ------------------------------------------------------------------ */
console.log('\nCONTRADICTION — can two tags on one player both be true?');

const PAIRS: Array<[string, string]> = [
  ['qb-backup', 'promoted'],
  ['workhorse', 'committee'],
  ['gem', 'bust'],
  // Matthew Golden carried GEM and NO UPSIDE (`dead-end`) at once, plus
  // "lottery ticket", plus "volume vacated" — four price and risk claims from
  // four evidence bases of completely different quality, rendered as four
  // identical chips. The case section fixes this structurally by having one
  // verdict; these pairs stop the tag list regressing to the old behaviour.
  ['gem', 'dead-end'],
  ['gem', 'lottery'],
  ['volume-open', 'dead-end'],
  // A GEM is a player you are getting cheaply. If the same row also says you are
  // paying ahead of his historical return, one of the two is lying.
  ['gem', 'reach'],
  ['gem', 'slight-reach'],
  ['late-upside', 'dead-end'],
  ['value', 'reach'],
  ['every-down', 'rotational'],
  ['bench', 'value'],
];
for (const [a, b] of PAIRS) {
  const both = rows.filter((r) => has(r, a) && has(r, b));
  check(
    `"${a}" and "${b}" never co-occur`,
    both.length === 0,
    `${both.length}: ${both.slice(0, 4).map((r) => r.name).join(', ')}`,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nWR / RB — the positions that make up most of the draft');

for (const pos of ['WR', 'RB'] as const) {
  const group = rows.filter((r) => r.position === pos && r.vorp !== null);
  const top = [...group].sort((a, b) => b.vorp! - a.vorp!).slice(0, 12);
  const weakTop = top.filter((r) => (r.usageGrade ?? 100) < 40);
  check(
    `top-12 ${pos} by VALUE have a role behind them`,
    weakTop.length <= 2,
    `${weakTop.length} of the top 12 have a usage grade under 40: ` +
      weakTop.map((r) => `${r.name} (${r.usageGrade})`).join(', '),
    true,
  );

  const eliteButBuried = group.filter((r) => (r.usageGrade ?? 0) >= 90 && r.vorp! < 0);
  check(
    `no elite-usage ${pos} is buried below replacement`,
    eliteButBuried.length === 0,
    `${eliteButBuried.length}: ` +
      eliteButBuried.map((r) => `${r.name} grade=${r.usageGrade} VALUE=${r.vorp!.toFixed(0)}`).join(', '),
  );
}

/* ------------------------------------------------------------------ */
console.log('\nCONTINGENT UPSIDE — is the lottery-ticket case being seen?');

const upsideRows = rows.filter((r) => r.upsideGain !== null);
check(
  'contingent upside is computed for players with a blocker',
  upsideRows.length >= 20,
  `only ${upsideRows.length} board players have an upside figure — the handcuff case is invisible`,
);

const deniedUpside = rows.filter(
  (r) => has(r, 'dead-end') && (r.upsideGain ?? 0) >= 20 && (r.upsideChance ?? 0) >= 0.3,
);
check(
  'nobody is called NO UPSIDE while sitting on a real lottery ticket',
  deniedUpside.length === 0,
  `${deniedUpside.length}: ${deniedUpside.map((r) => r.name).join(', ')} — comparables match on the ` +
    `role a player holds now, so a backup's comparables are backups and cannot see this`,
);

const qbUpside = rows.filter((r) => r.position === 'QB' && r.upsideGain !== null);
check(
  'quarterbacks get no share-transfer upside',
  qbUpside.length === 0,
  `${qbUpside.length} QBs carry an inherited-volume upside; a QB job opens by starting, not by ` +
    `inheriting targets`,
);

/* ------------------------------------------------------------------ */
console.log('\nWAIVER WIRE — the same invariants on the other board');

const wire = getWaiverBoard(FORMAT, TEAMS, SEASON);
console.log(`  note  ${wire.meta.total} undrafted players, ${wire.meta.qualified} clear the floor, ` +
  `live=${wire.meta.live}`);

check(
  'the wire is not empty',
  wire.meta.qualified > 20,
  `only ${wire.meta.qualified} players clear the evidence floor — check the games floor scaling`,
);

const wireNoQb = wire.rows.filter((r) => r.position === 'QB');
check('the wire carries no quarterbacks', wireNoQb.length === 0, `${wireNoQb.length} QBs present`);

const wireStaleTeam = wire.rows.filter((r) => {
  const d = depthRank.get(`${r.playerId}|${r.position}`);
  return d && r.team && d.team !== r.team;
});
check(
  'every wire row uses the current depth-chart team',
  wireStaleTeam.length === 0,
  `${wireStaleTeam.length} on a stale team: ` +
    wireStaleTeam.slice(0, 4).map((r) => `${r.name} shows ${r.team}`).join(', '),
);

const wireSelfCredit = wire.rows.filter(
  (r) => r.opportunity !== null && r.opportunity.includes(r.name),
);
check(
  'nobody is credited with the volume he vacated himself',
  wireSelfCredit.length === 0,
  `${wireSelfCredit.length}: ${wireSelfCredit.map((r) => r.name).join(', ')}`,
);

const wireDepthOk = wire.rows.every(
  (r) => r.depthRank !== null && r.depthRank >= 1 && r.depthRank <= 20,
);
check('every wire row has a sane depth rank', wireDepthOk, 'a row has a missing or absurd rank');

const wireTiers = {
  priority: wire.rows.filter((r) => r.priority).length,
  lottery: wire.rows.filter((r) => r.upside && r.upside.expectedGain >= 10 && r.upside.leadChance >= 0.2).length,
};
console.log(`  note  wire tiers: priority=${wireTiers.priority} lottery=${wireTiers.lottery}`);
check(
  'the wire surfaces lottery tickets',
  wireTiers.lottery > 0,
  'no undrafted player is close enough behind a vulnerable starter — the contingent path is dead',
);

const wirePosSpread = ['RB', 'WR', 'TE'].map(
  (p) => wire.rows.filter((r) => r.qualified && r.position === p).length,
);
check(
  'the wire is not one position',
  Math.max(...wirePosSpread) / wirePosSpread.reduce((a, b) => a + b, 0) < 0.75,
  `positions are RB=${wirePosSpread[0]} WR=${wirePosSpread[1]} TE=${wirePosSpread[2]} — a single ` +
    `position dominating is how the flat depth cutoff hid`,
);

const skillCovered = rows.filter(
  (r) => (r.position === 'WR' || r.position === 'RB') && r.signal === 'full',
).length;
const skillTotal = rows.filter((r) => r.position === 'WR' || r.position === 'RB').length;
check(
  'at least half the WR/RB board has a full market read',
  skillCovered / skillTotal >= 0.4,
  `only ${skillCovered}/${skillTotal} (${Math.round((skillCovered / skillTotal) * 100)}%) ` +
    `of receivers and backs have complete props — the rest rest entirely on usage`,
  true,
);

/* ------------------------------------------------------------------ */
console.log('\nDERIVATION — does the receipt for VALUE actually add up?');

/*
 * The panel exists so a reader can take the number apart. That promise is only
 * worth something if the parts reconstruct the whole, and for seven rookies they
 * did not: Jeremiyah Love's receipt showed a projection of 121.5 going into a
 * subtraction performed on 220.8. Ninety-nine points appeared with no step
 * accounting for them, because the usage line was gated on measured usage and a
 * rookie's projection comes from draft capital instead.
 *
 * An explanation that does not reconcile with the figure it explains is worse
 * than no explanation, so this is a hard failure rather than a warning.
 */
{
  const derivRows = sqlite
    .prepare(
      `SELECT v.player_id, a.name, v.position, v.signal,
              v.blended_points AS points, v.blended_vorp AS vorp, v.derivation
       FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.derivation IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<{
    player_id: string; name: string; position: string; signal: string;
    points: number | null; vorp: number | null; derivation: string;
  }>;

  interface Step { kind: string; value: number | null; running: number | null }

  const unexplained: string[] = [];
  const mismatched: string[] = [];

  for (const r of derivRows) {
    let steps: Step[];
    try {
      steps = JSON.parse(r.derivation) as Step[];
    } catch {
      mismatched.push(`${r.name} (unparseable)`);
      continue;
    }

    const replIdx = steps.findIndex((s) => s.kind === 'replacement');
    const result = steps.find((s) => s.kind === 'result');
    if (replIdx < 1 || !result) {
      mismatched.push(`${r.name} (no replacement or result step)`);
      continue;
    }

    // The subtraction has to operate on the projection the board actually
    // stored, and the last figure stated before it has to be that projection.
    const repl = steps[replIdx]!;
    const operatedOn = (repl.running ?? 0) - (repl.value ?? 0);
    if (r.points !== null && Math.abs(operatedOn - r.points) > 1) {
      mismatched.push(`${r.name} subtracts from ${operatedOn.toFixed(1)} but board says ${r.points.toFixed(1)}`);
    }
    if (r.vorp !== null && Math.abs((result.value ?? 0) - r.vorp) > 1) {
      mismatched.push(`${r.name} result ${result.value?.toFixed(1)} vs stored VALUE ${r.vorp.toFixed(1)}`);
    }

    const priorFigures = steps.slice(0, replIdx).filter((s) => s.running !== null || s.value !== null);
    const lastStated = priorFigures.length
      ? (priorFigures[priorFigures.length - 1]!.running ?? priorFigures[priorFigures.length - 1]!.value)
      : null;
    if (lastStated !== null && Math.abs(lastStated - operatedOn) > 1) {
      unexplained.push(
        `${r.position} ${r.name} (${r.signal}): last step states ${lastStated.toFixed(1)}, ` +
          `subtraction operates on ${operatedOn.toFixed(1)}`,
      );
    }
  }

  check(
    'every VALUE receipt reconciles with the stored number',
    mismatched.length === 0,
    `${mismatched.length}: ${mismatched.slice(0, 3).join('; ')}`,
  );

  /*
   * The market figure SHOWN must be the market figure USED.
   *
   * For a partially covered player the blend receives a COMPLETED figure —
   * scaled up for the stat categories no book priced — but the receipt printed
   * the raw scored props. Bhayshul Tuten's read "105.5" against a blend that
   * used 157.7, so his panel showed 105.5 and 67.6 averaging to 137.7:
   * impossible on its face, and sitting there looking authoritative. 29 board
   * players are partially covered.
   *
   * Tested against the source values rather than by re-deriving z. Reproducing
   * the z needs the exact positional mean and sd the build used, and an earlier
   * attempt at that flagged 45 correct receipts over a sample-vs-population sd
   * convention and then 26 more over an off-by-one in the pool. The invariant
   * that actually matters is simpler and exact: a fully covered player's receipt
   * must show his raw scored props, and a partially covered one must show a
   * figure at or above them, because completion only ever adds the unpriced part.
   *
   * A previous version of this check asserted a blend must land between its
   * inputs. That is FALSE for a rank-based blend across two differently centred
   * distributions and flagged Christian McCaffrey behaving exactly as designed.
   * Do not reinstate it.
   */
  const shownVsUsed: string[] = [];
  {
    const marketRows = sqlite
      .prepare(
        `SELECT v.player_id, a.name, v.position, v.signal,
                v.implied_points AS raw, v.derivation
         FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format = ? AND v.teams = ? AND v.season = ?
           AND v.derivation IS NOT NULL AND v.implied_points IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{
      player_id: string; name: string; position: string; signal: string;
      raw: number; derivation: string;
    }>;

    for (const r of marketRows) {
      let steps: Step[];
      try {
        steps = JSON.parse(r.derivation) as Step[];
      } catch {
        continue;
      }
      const marketStep = steps.find((s) => s.kind === 'market');
      if (!marketStep || marketStep.value === null) continue;

      if (r.signal === 'full' && Math.abs(marketStep.value - r.raw) > 0.5) {
        shownVsUsed.push(
          `${r.position} ${r.name}: fully covered, receipt shows ` +
            `${marketStep.value.toFixed(1)} but his scored props are ${r.raw.toFixed(1)}`,
        );
      }
      if (r.signal === 'partial' && marketStep.value < r.raw - 0.5) {
        shownVsUsed.push(
          `${r.position} ${r.name}: partially covered, receipt shows ` +
            `${marketStep.value.toFixed(1)} below his raw props ${r.raw.toFixed(1)} — ` +
            `completion cannot subtract`,
        );
      }
    }
  }
  check(
    'the market figure on the receipt is the one the blend used',
    shownVsUsed.length === 0,
    `${shownVsUsed.length}: ${shownVsUsed.slice(0, 3).join('; ')}`,
  );
  check(
    'no step of a VALUE receipt is unaccounted for',
    unexplained.length === 0,
    `${unexplained.length} receipts jump without a step explaining it — ` +
      `${unexplained.slice(0, 3).join('; ')}`,
  );

  /*
   * SCALE MISMATCH — the availability discount must be a pure multiplication on
   * the actual-points scale.
   *
   * `build-blend` applied `usage x durability` to the COMPRESSED usage figure
   * and only afterwards stretched it onto the real scale. Multiplication and an
   * affine map do not commute unless the map's fixed point is zero, and this
   * one's is not: the usage scale's zero sits wherever the regression's
   * intercept happens to land. So scaling a player down to zero games left him
   * at −17.0 points at WR, −20.8 at RB, −6.1 at TE and −85.4 at QB. That the
   * endpoint depended on his POSITION is the tell — a discount is a statement
   * about one player's availability and cannot know what position he plays.
   * Fixing the order moved 44 of 179 board rows, every one of them upward.
   *
   * The invariant is the one thing a discount must satisfy: the ratio it applies
   * has to be the durability multiplier itself, so that scaling by zero yields
   * zero. Checked against `expected_games`, which is the input the multiplier is
   * built from, so this reproduces the step from source rather than re-deriving
   * it from the same arithmetic it is auditing (bug #33 — a check can carry the
   * bug it hunts, and the market-receipt check above got this wrong twice before
   * it was written against source values).
   */
  const badDiscount: string[] = [];
  {
    const rows = sqlite
      .prepare(
        `SELECT v.player_id, a.name, v.position, v.expected_games AS games, v.derivation
         FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format = ? AND v.teams = ? AND v.season = ?
           AND v.derivation IS NOT NULL AND v.expected_games IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{
      player_id: string; name: string; position: string;
      games: number; derivation: string;
    }>;

    for (const r of rows) {
      let steps: Step[];
      try {
        steps = JSON.parse(r.derivation) as Step[];
      } catch {
        continue;
      }
      const i = steps.findIndex((s) => s.kind === 'availability');
      if (i < 1) continue;

      const base = steps[i - 1]!.value;
      const after = steps[i]!.value;
      if (base === null || after === null || base === 0) continue;

      // The step directly above an availability discount must be the figure it
      // discounts — the scale conversion, or the usage/capital line itself.
      const prior = steps[i - 1]!.kind;
      if (prior !== 'scale' && prior !== 'usage') {
        badDiscount.push(`${r.position} ${r.name}: discount follows a '${prior}' step, not the figure it scales`);
        continue;
      }

      const expected = Math.min(1, r.games / 17 / 0.88);
      const applied = after / base;
      if (Math.abs(applied - expected) > 0.02) {
        badDiscount.push(
          `${r.position} ${r.name}: ${r.games.toFixed(1)} games implies a ${(expected * 100).toFixed(0)}% ` +
            `multiplier, receipt applies ${(applied * 100).toFixed(0)}% (${base.toFixed(1)} -> ${after.toFixed(1)})`,
        );
      }
      if (after < 0 || after > base + 0.5) {
        badDiscount.push(
          `${r.position} ${r.name}: discount produced ${after.toFixed(1)} from ${base.toFixed(1)} — ` +
            `a discount cannot go negative or increase a projection`,
        );
      }
    }
  }
  check(
    'the availability discount is a pure multiplier on the points scale',
    badDiscount.length === 0,
    `${badDiscount.length}: ${badDiscount.slice(0, 3).join('; ')}`,
  );

  /*
   * The shrinkage the receipt DESCRIBES must be the one that ran.
   *
   * That step used to recompute its own confidence from a second copy of the
   * formula. Two expressions that agree until one of them is edited is the #80
   * family with a fuse in it, and the fix — reading the shared constant — is
   * only worth anything if something notices when it stops being shared. Every
   * uncovered non-rookie is pulled by the SAME measured amount now, so a single
   * disagreeing label is a real defect.
   */
  const wrongPull: string[] = [];
  {
    const expected = Math.round((1 - USAGE_CONFIDENCE) * 100);
    const rows = sqlite
      .prepare(
        `SELECT a.name, v.position, v.derivation FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.derivation IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; position: string; derivation: string }>;
    for (const r of rows) {
      let steps: Array<{ kind: string; label: string }>;
      try {
        steps = JSON.parse(r.derivation);
      } catch {
        continue;
      }
      for (const s of steps) {
        const m = /^Pulled (\d+)% toward what his draft slot usually returns$/.exec(s.label ?? '');
        if (m && Number(m[1]) !== expected) {
          wrongPull.push(`${r.position} ${r.name}: receipt says ${m[1]}%, the build applies ${expected}%`);
        }
      }
    }
  }
  check(
    'the slot pull on the receipt is the one the build applied',
    wrongPull.length === 0,
    `${wrongPull.length}: ${wrongPull.slice(0, 3).join('; ')}`,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nPRICE READ — is the slot gap quoted only where it carries information?');

/*
 * The slot gap's correlation with what a player went on to return AGAINST HIS
 * PRICE, measured over 2022-2025 by band: rounds 1-3 0.296, rounds 4-6 0.190,
 * rounds 7-10 **0.041**, rounds 11+ 0.135.
 *
 * Picks 73-120 are the one stretch where the number means nothing — and it is
 * also where the gap is biggest and most flattering (mean +17.3, 82% positive),
 * because the historical return falls away faster after round 7 than the
 * projections do. The board was loudest exactly where it knew least, which is
 * the saturation family (#83) wearing a different hat.
 *
 * Rescaling was tested as the fix and REJECTED — demeaning within band dropped
 * the pooled correlation from 0.250 to 0.160, and inside a band a monotone
 * recentring cannot reorder anything. The number is not miscalibrated there, it
 * is uninformative there, so the tag says so instead.
 */
{
  const rows = sqlite
    .prepare(
      `SELECT a.name, v.position, v.adp, v.tags FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.tags IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; position: string; adp: number; tags: string }>;

  const VERDICTS = new Set(['value', 'slight-value', 'reach', 'slight-reach']);
  const leaked: string[] = [];
  const misplaced: string[] = [];
  let inBand = 0;
  let flagged = 0;

  for (const r of rows) {
    let ids: string[];
    try {
      ids = (JSON.parse(r.tags) as Array<{ id: string }>).map((t) => t.id);
    } catch {
      continue;
    }
    const dead = r.adp >= GAP_DEAD_BAND.from && r.adp <= GAP_DEAD_BAND.to;
    if (dead) inBand++;
    if (dead && ids.some((id) => VERDICTS.has(id))) {
      leaked.push(`${r.position} ${r.name} (ADP ${r.adp.toFixed(0)}) carries a price verdict inside the dead band`);
    }
    if (ids.includes('gap-unreliable')) {
      flagged++;
      if (!dead) {
        misplaced.push(`${r.position} ${r.name} (ADP ${r.adp.toFixed(0)}) flagged unreliable outside the band`);
      }
    }
  }

  check(
    'no price verdict is issued where the slot gap measured r = 0.04',
    leaked.length === 0,
    `${leaked.length}: ${leaked.slice(0, 3).join('; ')}`,
  );
  check(
    'the unreliable-gap flag fires only inside the measured dead band',
    misplaced.length === 0,
    `${misplaced.length}: ${misplaced.slice(0, 3).join('; ')}`,
  );
  /*
   * And it has to fire on somebody without firing on everybody — the dead
   * threshold family. A flag that covers the whole band is not information
   * about a player, it is a restatement of his ADP.
   */
  check(
    'the unreliable-gap flag is neither empty nor the whole band',
    inBand === 0 || (flagged > 0 && flagged < inBand),
    `${flagged} flagged of ${inBand} players in picks ${GAP_DEAD_BAND.from}-${GAP_DEAD_BAND.to}`,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nBUST REASONS — does each one point the way the data does?');

/*
 * Age is a bust reason for receivers and tight ends and NOT for backs.
 *
 * Measured against the slot residual over 2022-2025 early picks: WR r(age) =
 * -0.113, receivers at 30+ returning -17 against price where younger ones
 * return +4. For backs r = +0.060, with 28+ at -7 and younger at +7 — a
 * rounding error pointing the other way. The tag charged backs for aging on a
 * lower cutoff than everyone else, which is precisely backwards.
 */
{
  const rows = sqlite
    .prepare(
      `SELECT a.name, v.position, v.tags FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.position = 'RB'
         AND v.tags IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; position: string; tags: string }>;
  const aged: string[] = [];
  for (const r of rows) {
    let tags: Array<{ id: string; detail: string }>;
    try {
      tags = JSON.parse(r.tags);
    } catch {
      continue;
    }
    const bust = tags.find((t) => t.id === 'bust');
    if (bust && /aging and already missing time/.test(bust.detail ?? '')) {
      aged.push(r.name);
    }
  }
  check(
    'no running back is called a bust for his age (measured r = +0.06)',
    aged.length === 0,
    `${aged.length}: ${aged.slice(0, 3).join(', ')}`,
  );
}

/*
 * GEM — the dead-threshold family, guarded in BOTH directions.
 *
 * This tag has failed twice already and in opposite ways: bug #76 fired it on
 * 0 of 179 players by AND-ing two defensible conditions, and #81 fired it on a
 * starting tight end at pick 72 because "late" meant round five. Its gate is now
 * a measured profile — short record plus draft capital inside pick 60, which
 * cleared replacement 59% of the time at ADP 100+ against a 31% base rate — and
 * a measured gate can drift on a new board just as easily as a guessed one.
 *
 * A gem list is meant to be short. Nothing is a hard bound, so this is a warning
 * either side: empty means the tag has stopped working, and more than a third of
 * the late board means it has stopped discriminating.
 */
{
  const lateBoard = rows.filter((r) => r.adp >= 100);
  const gems = lateBoard.filter((r) => has(r, 'gem'));
  const share = lateBoard.length ? gems.length / lateBoard.length : 0;
  check(
    'the GEM tag names somebody without naming a third of the late board',
    lateBoard.length === 0 || (gems.length > 0 && share <= 0.34),
    `${gems.length} gems among ${lateBoard.length} picks at ADP 100+ (${Math.round(share * 100)}%): ` +
      gems.slice(0, 5).map((r) => r.name).join(', '),
    true,
  );

  /*
   * And it must not become a list of one position. The measured lift is general
   * — WR +18pp, RB +67pp, TE +34pp, QB +26pp against each position's own base
   * rate — so a gem list confined to a single position is a symptom, not a
   * finding. Judged only when there are enough gems for the question to mean
   * anything.
   */
  const byPos = new Map<string, number>();
  for (const r of gems) byPos.set(r.position, (byPos.get(r.position) ?? 0) + 1);
  const top = Math.max(0, ...byPos.values());
  check(
    'the GEM list is not confined to one position',
    gems.length < 4 || byPos.size > 1,
    `all ${gems.length} gems are ${[...byPos.keys()][0]} (${top})`,
    true,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nSATURATION — is any displayed figure really a clamp?');

/*
 * The ADP baseline curve runs from pick 1 to pick 200 because that is the range
 * players are drafted in. `adpEquivalent` clamps outside it, which is correct
 * arithmetic and a lie as a claim: **83% of the waiver wire** came back
 * "projects like pick 200", a saturation artifact wearing the clothes of a
 * measurement (family #6). The wire now reports null there and says so.
 *
 * This guards both ends on the board, where the clamp is rarer but the slot gap
 * is measured against it.
 */
{
  const wire = getWaiverBoard(FORMAT, TEAMS, SEASON);
  const withPick = wire.rows.filter((r) => r.equivalentPick !== null);
  const atFloor = withPick.filter((r) => (r.equivalentPick ?? 0) >= 199.5).length;
  check(
    'the wire does not report the end of the draft curve as a pick equivalent',
    atFloor === 0,
    `${atFloor} of ${withPick.length} wire rows show pick 200, which is the curve running out ` +
      `rather than a comparison — report null and say he is below the curve`,
  );

  const boardClamped = rows.filter(
    (r) => r.vorp !== null && r.adpEquivalent !== null && r.adpEquivalent >= 199.5,
  );
  check(
    'no board slot gap rests on a clamped pick equivalent without being flagged',
    boardClamped.length <= 12,
    `${boardClamped.length} board players have their slot gap measured against pick 200, ` +
      `which is a floor rather than a slot: ` +
      boardClamped.slice(0, 3).map((r) => `${r.name} (${r.vorp?.toFixed(0)})`).join(', '),
    true,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nCOMPARABLES — is the "players like him" panel making a real claim?');

interface StoredOutlook {
  n: number;
  sparse: boolean;
  support: string;
  fromSeason: number;
  toSeason: number;
  outcomeFromSeason: number;
  outcomeToSeason: number;
  closeShare: number;
  nearestDistance: number;
  bands: { close: number; loose: number; noAnalogue: number };
  floor: number; median: number; ceiling: number;
  floorPpg: number; medianPpg: number; ceilingPpg: number;
  hitRate: number; breakoutRate: number; bustRate: number; vanishRate: number;
  medianNextGames: number;
  nearest: Array<{ playerId: string; name: string; season: number; distance: number }>;
}

const outlookRows = sqlite
  .prepare(
    `SELECT o.player_id AS playerId, p.display_name AS name, o.position,
            o.profile_games AS profileGames, o.outlook
     FROM player_outlook o JOIN players p ON p.gsis_id = o.player_id
     WHERE o.format = ? AND o.teams = ? AND o.season = ?`,
  )
  .all(FORMAT, TEAMS, SEASON) as Array<{
  playerId: string; name: string; position: string; profileGames: number; outlook: string;
}>;

const outlooks = outlookRows.flatMap((r) => {
  try {
    return [{ ...r, o: JSON.parse(r.outlook) as StoredOutlook }];
  } catch {
    return [];
  }
});

check(
  'every stored outlook parses',
  outlooks.length === outlookRows.length,
  `${outlookRows.length - outlooks.length} rows hold unparseable JSON`,
);

/*
 * The gap that started this: the panel existed only for players the ADP feed
 * prices, so every waiver target — the entire population the tool is used on
 * during the season — had it silently omitted. Same family as bug #13.
 */
const withRole = (
  sqlite
    .prepare(
      `SELECT COUNT(*) n FROM player_usage
       WHERE season = ? AND position IN ('QB','WR','RB','TE') AND games >= 6`,
    )
    .get(SEASON - 1) as { n: number }
).n;
check(
  'comparables cover the player universe, not just the board',
  outlooks.length >= withRole * 0.7,
  `only ${outlooks.length} outlooks for ${withRole} players with a measured role — the build is ` +
    `starting from the board again`,
);

/*
 * Default shown as measurement (family: bug #41, #46). If most players at a
 * position come back with the same headline number, the lookup has not
 * distinguished anybody and the number is decoration. This is the check
 * CLAUDE.md lists as a known gap; the weighted quantile returning a sample
 * member instead of interpolating tripped it for real, giving every starting
 * quarterback a median of exactly 246.
 */
for (const position of ['QB', 'RB', 'WR', 'TE']) {
  const meds = outlooks
    .filter((r) => r.position === position && !r.o.sparse)
    .map((r) => Math.round(r.o.median));
  if (meds.length < 20) continue;
  const commonest = Math.max(...[...new Set(meds)].map((v) => meds.filter((m) => m === v).length));
  check(
    `${position} outlook medians are not all the same number`,
    commonest / meds.length < 0.25,
    `${commonest} of ${meds.length} ${position}s share one median — a figure that identical ` +
      `across players is a default wearing the clothes of a measurement`,
  );
}

/*
 * Dead threshold (family: bug #12, #28, #44). Support is graded against each
 * position's own distance distribution precisely so it cannot collapse onto one
 * value; a fixed cutoff previously graded 87% of quarterbacks "thin".
 */
for (const position of ['QB', 'RB', 'WR', 'TE']) {
  const at = outlooks.filter((r) => r.position === position);
  if (at.length < 20) continue;
  const worst = Math.max(
    ...['strong', 'fair', 'thin'].map(
      (t) => at.filter((r) => !r.o.sparse && r.o.support === t).length,
    ),
  );
  check(
    `${position} support grades carry information`,
    worst / at.length < 0.8,
    `${worst} of ${at.length} ${position}s land in one support tier — a label that fires on a ` +
      `whole position is the default state, not a finding`,
  );
}

// A player must never be his own comparable: he is trivially the closest
// profile to himself, and the panel would be answering its own question.
const selfComp = outlooks.filter((r) => r.o.nearest.some((c) => c.playerId === r.playerId));
check(
  'no player appears in his own comparables',
  selfComp.length === 0,
  `${selfComp.length}: ${selfComp.slice(0, 3).map((r) => r.name).join(', ')}`,
);

const ordered = outlooks.filter(
  (r) =>
    !r.o.sparse &&
    !(r.o.floor <= r.o.median && r.o.median <= r.o.ceiling &&
      r.o.floorPpg <= r.o.medianPpg && r.o.medianPpg <= r.o.ceilingPpg),
);
check(
  'outlook ranges are ordered floor <= median <= ceiling, on both scales',
  ordered.length === 0,
  `${ordered.length} malformed: ${ordered.slice(0, 3).map((r) => r.name).join(', ')}`,
);

/*
 * The two scales must be drawn from the same neighbourhood — the scale-mismatch
 * family (bugs #5, #6, #15, #19), which in this project has always been a number
 * on one scale compared against a threshold from another.
 *
 * The test is the season median against the per-game median times the median
 * games played. These are three separate order statistics of a skewed
 * distribution, so they do not have to multiply out exactly: a pool of backups
 * where most played three games and a few played seventeen puts the ratio below
 * one legitimately. Measured across all 470 stored outlooks it runs 0.40 to
 * 1.95, with the middle half inside 0.81-0.99. The gate sits well outside that,
 * so it catches a per-game band computed over a different pool without firing on
 * ordinary skew.
 *
 * The first version of this check compared the implied game count against a flat
 * 6-17.5 and failed 42 backup quarterbacks who were entirely correct — a
 * threshold picked before looking at the distribution, which is the same mistake
 * it exists to catch.
 */
const scaleMismatch = outlooks.filter((r) => {
  if (r.o.sparse || r.o.medianPpg <= 0 || r.o.medianNextGames <= 0) return false;
  const ratio = r.o.median / r.o.medianPpg / r.o.medianNextGames;
  return ratio < 0.3 || ratio > 2.5;
});
check(
  'season and per-game bands come from the same neighbourhood',
  scaleMismatch.length === 0,
  `${scaleMismatch.length} disagree about games played: ` +
    scaleMismatch
      .slice(0, 3)
      .map(
        (r) =>
          `${r.name} implies ${(r.o.median / r.o.medianPpg).toFixed(1)}g against a median of ` +
          `${r.o.medianNextGames}g`,
      )
      .join(', '),
);

// The disappeared were being dropped from the pool entirely, which deleted the
// worst outcome in fantasy football and made every bust rate optimistic. They
// run 9-15% of role-holding seasons, so a league-wide zero means it regressed.
const anyVanish = outlooks.filter((r) => !r.o.sparse && r.o.vanishRate > 0).length;
const gradedOutlooks = outlooks.filter((r) => !r.o.sparse).length;
check(
  'comparables who never played again are counted',
  gradedOutlooks === 0 || anyVanish / gradedOutlooks > 0.5,
  `only ${anyVanish}/${gradedOutlooks} carry any chance of a comparable vanishing — the pool is ` +
    `conditioning on "he played at all" again`,
);

// A "close match" must be close on the position's own scale, or the label is a
// cross-position comparison (family: bug #23, #49).
const bandOrder = outlooks.filter(
  (r) => !(r.o.bands.close <= r.o.bands.loose && r.o.bands.close <= r.o.bands.noAnalogue),
);
check(
  'distance bands are ordered close <= loose and close <= no-analogue',
  bandOrder.length === 0,
  `${bandOrder.length} positions have contradictory bands — a player could be flagged "no ` +
    `analogue" while holding neighbours inside the close band`,
);

// A profile built on two games is not a season. It is allowed mid-season, but
// it has to be recorded so the page can say so rather than implying a full year.
const thinProfile = outlooks.filter((r) => r.profileGames < 4);
check(
  'no outlook rests on fewer than four games',
  thinProfile.length === 0,
  `${thinProfile.length}: ${thinProfile.slice(0, 3).map((r) => `${r.name} ${r.profileGames}g`).join(', ')}`,
);

/*
 * EVERY player with an outlook gets a range — the panel is one panel.
 *
 * The no-analogue branch used to return zeroes for floor, median and ceiling,
 * so 41 of 511 players — Nacua, Smith-Njigba, McCaffrey and Rice among them —
 * showed a comparison list and no chart while everyone else showed both. A
 * reader starting at the top of the board met the exception first and read it
 * as a missing feature.
 *
 * The suppression was also against the project's own calibration, twice over:
 * `calibrate:comparables` buckets backtested seasons by BOTH readings of
 * neighbourhood quality and gets the same answer from each — a loose
 * neighbourhood breaks the MIDPOINT and leaves the RANGE working (interval
 * coverage 0.89 at receiver against a 0.60 target, on the largest suppressed
 * group). So the range is drawn for everyone and the midpoint is marked rough.
 *
 * Two failure modes here, and the check has to catch both: a range that is
 * missing, and a range that is present but collapsed to a placeholder. A
 * degenerate floor == ceiling is the second one wearing the first one's clothes.
 */
const noRange = outlooks.filter(
  (r) => !Number.isFinite(r.o.floor) || !Number.isFinite(r.o.ceiling) || r.o.ceiling <= r.o.floor,
);
check(
  'every outlook carries a drawable range, including the ones with no close analogue',
  noRange.length === 0,
  `${noRange.length} rows have no range to draw: ${noRange.slice(0, 3).map((r) => r.name).join(', ')}`,
);

/*
 * The panel must not date itself a year stale.
 *
 * The pool stops one season short of the newest one played, because a season
 * teaches nothing until the following year is in the books. The page was
 * labelled with that profile span alone, so a 2026 board announced "2021–2024"
 * while the outcomes it draws from ran through 2025 — an accurate number
 * reading as an out-of-date tool. Both ends are carried now, and the outcome
 * end has to actually be the profile end plus one.
 */
const spanSlip = outlooks.filter(
  (r) => r.o.outcomeToSeason !== r.o.toSeason + 1 || r.o.outcomeFromSeason !== r.o.fromSeason + 1,
);
check(
  'the outlook states the seasons its outcomes come from, one past the profiles',
  spanSlip.length === 0,
  `${spanSlip.length} rows disagree with their own span: ` +
    `${spanSlip.slice(0, 3).map((r) => `${r.name} ${r.o.fromSeason}-${r.o.toSeason} -> ${r.o.outcomeFromSeason}-${r.o.outcomeToSeason}`).join(', ')}`,
);

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
console.log('\nOWNERSHIP — does the wire know who is actually available?');

/*
 * These guard one contract: ABSENCE FROM `yahoo_ownership` MEANS FREE.
 *
 * That inverts the usual risk. Everywhere else in this project a missing row is
 * a gap — a player without a projection simply has no projection. Here a missing
 * row is an assertion, and the assertion is "go ahead and add him". So the
 * checks below are aimed at the ways a row can go missing or go wrong, not at
 * whether the numbers look sensible.
 *
 * All of them report `note` rather than failing when no league is connected.
 * A tool that fails its own audit for the absence of an optional integration
 * would train its reader to ignore the audit.
 *
 * The resolution floor is JUDGMENT, not a measured threshold — the same status
 * as the tag cutoffs. It has never been run against a real league.
 */
{
  const league = sqlite
    .prepare(`SELECT league_key, name, draft_status FROM yahoo_league WHERE season = ?`)
    .get(SEASON) as { league_key: string; name: string; draft_status: string | null } | undefined;

  if (!league) {
    console.log(
      '  note  no Yahoo league connected — availability falls back to national ADP.\n' +
        '        The wire says so on the page; these checks resume once a league is ingested.',
    );
  } else {
    const owned = sqlite
      .prepare(
        `SELECT player_id, name, status, team_key, position
         FROM yahoo_ownership WHERE league_key = ?`,
      )
      .all(league.league_key) as Array<{
      player_id: string | null;
      name: string;
      status: string;
      team_key: string | null;
      position: string | null;
    }>;

    // A player on two rosters means the per-team fetch double-counted somebody,
    // which would also mean one real owner is unrecorded.
    const seen = new Map<string, number>();
    for (const o of owned) {
      if (o.status !== 'rostered' || !o.player_id) continue;
      seen.set(o.player_id, (seen.get(o.player_id) ?? 0) + 1);
    }
    const doubled = [...seen.entries()].filter(([, n]) => n > 1);
    check(
      'no player is on two rosters at once',
      doubled.length === 0,
      `${doubled.length} players held twice`,
    );

    // Free agents must never be stored. If they were, absence would stop
    // meaning "free" and every consumer of this table would be reading a
    // different contract than the one documented on it.
    const badStatus = owned.filter((o) => o.status !== 'rostered' && o.status !== 'waivers');
    check(
      'ownership stores only unavailable players',
      badStatus.length === 0,
      `${badStatus.length} rows with an unexpected status`,
    );

    // Every rostered row must point at a team that exists in this league.
    const teamKeys = new Set(
      (
        sqlite
          .prepare(`SELECT team_key FROM yahoo_team WHERE league_key = ?`)
          .all(league.league_key) as Array<{ team_key: string }>
      ).map((t) => t.team_key),
    );
    const orphans = owned.filter((o) => o.status === 'rostered' && !teamKeys.has(o.team_key ?? ''));
    check(
      'every rostered player belongs to a team in this league',
      orphans.length === 0,
      `${orphans.length} rows point at no team`,
    );

    const rostered = owned.filter((o) => o.status === 'rostered');
    const skill = owned.filter((o) => ['QB', 'RB', 'WR', 'TE'].includes((o.position ?? '').toUpperCase()));
    const unresolvedSkill = skill.filter((o) => !o.player_id);
    const rate = skill.length ? 1 - unresolvedSkill.length / skill.length : 1;
    check(
      'Yahoo skill players resolve to the player index',
      rate >= 0.9,
      `${(rate * 100).toFixed(1)}% matched — unresolved: ` +
        unresolvedSkill.slice(0, 5).map((o) => o.name).join(', '),
      rate >= 0.9,
    );

    /*
     * A rostered player appearing on the wire is the one failure that produces a
     * confident, actionable, wrong answer: the tool tells you to add someone
     * another manager is already holding.
     *
     * BE CLEAR ABOUT WHAT THIS CAN AND CANNOT CATCH. The wire filters on the
     * same `resolveAvailability` set this reads, so under the current code it is
     * very nearly a tautology — negative-testing it by injecting an owned player
     * did not make it fire, because the filter correctly removed him first. It
     * is a REGRESSION GUARD, not an independent measurement: it fires the day
     * somebody adds a second path onto the wire that does not consult ownership.
     * That is worth having and it is not evidence that ownership is right.
     *
     * The checks above it are the independent ones — they test the stored data
     * against itself and all four fire on injected faults.
     */
    if (rostered.length === 0) {
      console.log(
        `  note  ${league.name} has not drafted (status "${league.draft_status}"), so there is ` +
          'no ownership to test the wire against yet.',
      );
    } else {
      const ownedIds = new Set(rostered.map((o) => o.player_id).filter(Boolean) as string[]);
      const board = getWaiverBoard(FORMAT, TEAMS, SEASON);
      const leaked = board.rows.filter((r) => ownedIds.has(r.playerId));
      check(
        'no rostered player is offered on the waiver wire',
        leaked.length === 0,
        `${leaked.length} owned players shown as available: ` +
          leaked.slice(0, 5).map((r) => r.name).join(', '),
      );

      check(
        'the wire is reading ownership, not the national ADP proxy',
        board.meta.availabilitySource === 'yahoo',
        `source is "${board.meta.availabilitySource}" despite ${rostered.length} rostered players`,
      );
    }
  }
}


/* ------------------------------------------------------------------ */
console.log('\nTHE CASE — is the read internally coherent?');

/*
 * The case section exists because a flat tag list could assert two
 * incompatible things about one player with nothing to say which it meant. The
 * structure prevents that — one verdict, everything else argument — but only if
 * the structure holds. These check that it does.
 *
 * The last one is the important one: a point may only call itself "measured" if
 * a calibration in this project actually backs it. That is the guard against the
 * whole exercise decaying back into confident-sounding assertion, which is the
 * failure mode the section was built to fix.
 */
{
  interface CasePoint { text: string; strength: string; basis: string }
  interface PCase {
    headline: string; tone: string;
    for: CasePoint[]; against: CasePoint[]; unknowns: CasePoint[];
    confidence: string; confidenceWhy: string;
  }

  const caseRows = sqlite
    .prepare(
      `SELECT a.name, v.position, v.adp, v.player_case AS pc
       FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.player_case IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; position: string; adp: number; pc: string }>;

  const parsed = caseRows
    .map((r) => {
      try { return { ...r, c: JSON.parse(r.pc) as PCase }; } catch { return null; }
    })
    .filter((x): x is { name: string; position: string; adp: number; pc: string; c: PCase } => x !== null);

  check(
    'every board player has a case',
    parsed.length === caseRows.length && caseRows.length > 100,
    `${parsed.length} parsed of ${caseRows.length} rows`,
  );

  // One verdict. Never a list, never empty.
  const badHeadline = parsed.filter((r) => !r.c.headline || r.c.headline.trim().length < 8);
  check(
    'every case states exactly one verdict',
    badHeadline.length === 0,
    `${badHeadline.length}: ${badHeadline.slice(0, 3).map((r) => r.name).join(', ')}`,
  );

  /*
   * A headline that fires on most of the board is the absence of an opinion —
   * the failure that "fairly priced on a third of the board" named. Six players
   * is the floor for judging a headline at all.
   */
  const heads = new Map<string, number>();
  for (const r of parsed) heads.set(r.c.headline, (heads.get(r.c.headline) ?? 0) + 1);
  const dominant = [...heads.entries()].filter(([, n]) => n > parsed.length * 0.4);
  check(
    'no single verdict covers most of the board',
    dominant.length === 0,
    dominant.map(([h, n]) => `"${h}" on ${n}/${parsed.length}`).join('; '),
  );

  /*
   * Vacated volume is an UNKNOWN and must never appear as a case FOR.
   *
   * `calibrate:opportunity`: the share of a vacancy reaching the man behind it
   * is −0.022 (first receiver) and −0.027 (first back), neither within two
   * standard errors of zero, against a shipped assumption of 0.60. A point that
   * files it as a reason to draft someone has reintroduced the claim the
   * measurement rules out.
   */
  const vacatedAsPositive = parsed.filter((r) =>
    [...r.c.for, ...r.c.against].some((p) => /left the roster|vacat/i.test(p.text)),
  );
  check(
    'vacated volume is never argued as a reason either way',
    vacatedAsPositive.length === 0,
    `${vacatedAsPositive.length}: ${vacatedAsPositive.slice(0, 3).map((r) => r.name).join(', ')}`,
  );

  // The slot gap carries r 0.04 between picks 73 and 120. It may be reported
  // there as an unknown, never argued as evidence.
  const deadBandPrice = parsed.filter(
    (r) => r.adp > 72 && r.adp <= 120 &&
      [...r.c.for, ...r.c.against].some((p) => /pick \d+ normally returns|earlier than the evidence/i.test(p.text)),
  );
  check(
    'the slot gap is not argued as evidence where it carries none (picks 73-120)',
    deadBandPrice.length === 0,
    `${deadBandPrice.length}: ${deadBandPrice.slice(0, 3).map((r) => r.name).join(', ')}`,
  );

  /*
   * "measured" is a promise that a calibration backs the point. Enforced by
   * requiring the basis to quote a number — an r, a rate, a sample size. A
   * strength chip that means nothing is worse than no chip, because the reader
   * is being asked to weight by it.
   */
  const unbacked = parsed.flatMap((r) =>
    [...r.c.for, ...r.c.against, ...r.c.unknowns]
      .filter((p) => p.strength === 'measured' && !/\d/.test(p.basis))
      .map((p) => `${r.name}: "${p.text.slice(0, 40)}"`),
  );
  check(
    'every "measured" point quotes the number behind it',
    unbacked.length === 0,
    `${unbacked.length}: ${unbacked.slice(0, 3).join('; ')}`,
  );

  /*
   * STALE FACT — a vacancy belongs to the team the player is ON.
   *
   * The case reused `whose()` from `tags.ts`, which attributes a USAGE share to
   * the roster it was earned on. That is right for usage and wrong for a
   * vacancy: A.J. Brown's line read "27% of PHI's volume has left" while he
   * plays for New England and the number was New England's. Right figure, wrong
   * team, on every player who changed roster.
   */
  const teamRows = sqlite
    .prepare(
      `SELECT a.name, a.team, v.player_case AS pc FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.player_case IS NOT NULL
         AND a.team IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; team: string; pc: string }>;
  const misattributed: string[] = [];
  for (const r of teamRows) {
    let c: PCase;
    try { c = JSON.parse(r.pc) as PCase; } catch { continue; }
    for (const p of [...c.for, ...c.against, ...c.unknowns]) {
      const m = p.text.match(/of ([A-Z]{2,3})'s volume/);
      if (m && m[1] !== r.team) misattributed.push(`${r.name} is on ${r.team}, text says ${m[1]}`);
    }
  }
  check(
    'a vacancy is attributed to the team the player actually plays for',
    misattributed.length === 0,
    `${misattributed.length}: ${misattributed.slice(0, 3).join('; ')}`,
  );

  // Confidence describes evidence, so it must track how much evidence there is.
  const confMismatch = parsed.filter((r) => {
    const measured = [...r.c.for, ...r.c.against].filter((p) => p.strength === 'measured').length;
    return (r.c.confidence === 'high' && measured < 3) || (r.c.confidence === 'low' && measured >= 2);
  });
  check(
    'stated confidence matches how much measured evidence there is',
    confMismatch.length === 0,
    `${confMismatch.length}: ${confMismatch.slice(0, 3).map((r) => r.name).join(', ')}`,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nSCARCITY AND WEEKLY UNITS — do the two new columns mean what they say?');

/*
 * VONA and the startable rate were added because VALUE stops discriminating
 * after round three. Both are easy to get subtly wrong in ways that look fine.
 */
{
  const rows2 = sqlite
    .prepare(
      `SELECT a.name, v.position, v.adp, v.blended_points AS points, v.expected_games AS games,
              v.vona, v.vona_round AS vonaRound, v.drop_to_next AS dropToNext,
              v.startable_rate AS rate
       FROM value_scores v
       JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
        AND a.format = v.format AND a.teams = v.teams
       WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.blended_points IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<{
    name: string; position: string; adp: number; points: number; games: number | null;
    vona: number | null; vonaRound: number | null; dropToNext: number | null; rate: number | null;
  }>;

  /*
   * Waiting longer cannot leave you better off. The pool of players still
   * available at 24 picks is a SUBSET of the pool at 12, so the best of it can
   * only be worse — which makes vona >= vonaRound an identity, and a violation
   * means the horizons were applied to different pools.
   */
  const wrongOrder = rows2.filter(
    (r) => r.vona !== null && r.vonaRound !== null && r.vona < r.vonaRound - 0.01,
  );
  check(
    'waiting a full snake turn is never better than waiting one round',
    wrongOrder.length === 0,
    `${wrongOrder.length}: ${wrongOrder.slice(0, 3).map((r) => `${r.name} ${r.vona?.toFixed(0)} v ${r.vonaRound?.toFixed(0)}`).join('; ')}`,
  );

  // A rate is a rate.
  const badRate = rows2.filter((r) => r.rate !== null && (r.rate < 0 || r.rate > 1));
  check(
    'the startable share is a share',
    badRate.length === 0,
    `${badRate.length}: ${badRate.slice(0, 3).map((r) => `${r.name} ${r.rate}`).join('; ')}`,
  );

  /*
   * DEAD THRESHOLD — a column where everyone reads the same is a column that
   * separates nobody. Checked per position, because the startable bar differs
   * by position and a pooled spread would hide a collapsed one.
   */
  const flat: string[] = [];
  for (const pos of POSITIONS) {
    const g = rows2.filter((r) => r.position === pos && r.rate !== null).map((r) => r.rate!);
    if (g.length < 8) continue;
    const lo = Math.min(...g), hi = Math.max(...g);
    if (hi - lo < 0.1) flat.push(`${pos} startable spans only ${((hi - lo) * 100).toFixed(0)}pp`);
    const v = rows2.filter((r) => r.position === pos && r.vona !== null).map((r) => r.vona!);
    if (v.length >= 8 && Math.max(...v) - Math.min(...v) < 5) {
      flat.push(`${pos} VONA spans only ${(Math.max(...v) - Math.min(...v)).toFixed(0)} points`);
    }
  }
  check(
    'the new columns separate players within every position',
    flat.length === 0,
    flat.join('; '),
  );

  /*
   * The startable rate must track the projection, since it IS the projection
   * restated. A weak correlation would mean the curve is being applied to the
   * wrong quantity — expected games, say, instead of points per game.
   */
  const drift: string[] = [];
  for (const pos of POSITIONS) {
    const g = rows2.filter((r) => r.position === pos && r.rate !== null);
    if (g.length < 10) continue;
    // Per season week, matching how the rate is built.
    const x = g.map((r) => r.points / 17);
    const y = g.map((r) => r.rate!);
    const mx = median(x), my = median(y);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < x.length; i++) {
      num += (x[i]! - mx) * (y[i]! - my); dx += (x[i]! - mx) ** 2; dy += (y[i]! - my) ** 2;
    }
    const r = dx && dy ? num / Math.sqrt(dx * dy) : 0;
    if (r < 0.9) drift.push(`${pos} r=${r.toFixed(2)} against points per game`);
  }
  check(
    'the startable share tracks the projection it restates',
    drift.length === 0,
    `it is a restatement, so a loose fit means it is being computed from the wrong quantity: ${drift.join('; ')}`,
  );
}

/* ------------------------------------------------------------------ */
console.log('\nCROSS-POSITION — does any board column just select a position?');

/*
 * The UPSIDE column showed the raw breakout rate, and sorting on it returned
 * ten quarterbacks and five tight ends in the top twenty. Not because they have
 * more upside — because "top-12 at your position" is a fixed bar held against
 * pools of very different size. The board carries 68 receivers and 25
 * quarterbacks, so a receiver clearing it is doing something five times rarer:
 * median breakout rate is 35% for a QB and 36% for a TE against 14% for a back
 * and 7% for a receiver.
 *
 * Bug #23 established the rule and `ratePctile` implements it, but the fix was
 * applied to the tag thresholds and to the COLOUR and never to the number or
 * the sort. This checks the thing a reader actually does: sort the column, look
 * at the top.
 */
{
  const cols: Array<[string, string]> = [
    ['outlook_pctile', 'OUTLOOK'],
    ['vona', 'VONA'],
    ['startable_rate', 'Start %'],
  ];
  const share = rows.length
    ? new Map(POSITIONS.map((p) => [p, rows.filter((r) => r.position === p).length / rows.length]))
    : new Map<string, number>();

  const skewed: string[] = [];
  for (const [col, label] of cols) {
    const top = sqlite
      .prepare(
        `SELECT position FROM value_scores
         WHERE format=? AND teams=? AND season=? AND ${col} IS NOT NULL
         ORDER BY ${col} DESC LIMIT 20`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{ position: string }>;
    if (top.length < 20) continue;
    for (const pos of POSITIONS) {
      const got = top.filter((r) => r.position === pos).length / top.length;
      const expected = share.get(pos) ?? 0;
      /*
       * Three times the position's share of the board is the line. A real signal
       * can legitimately favour a position — backs dominate VONA because their
       * cliff is steepest, and that IS the finding. What it cannot do is return
       * a top twenty that is half one position holding a seventh of the board.
       */
      if (expected > 0.05 && got > expected * 3) {
        skewed.push(`${label}: ${Math.round(got * 100)}% of the top 20 are ${pos}, who are ${Math.round(expected * 100)}% of the board`);
      }
    }
  }
  check(
    'sorting a board column does not just select one position',
    skewed.length === 0,
    skewed.join('; '),
  );
}

/*
 * A sparse outlook carries placeholder zeros, and they must never be ranked.
 *
 * `comparables.ts` returns early when a player's nearest historical analogue is
 * beyond his position's no-analogue band, with every rate set to 0 and a comment
 * saying the flag gates display and "these are never read". They were read the
 * moment UPSIDE and BUST became ranked columns: Puka Nacua at ADP 3, Jaxon
 * Smith-Njigba at 5 and Christian McCaffrey at 6 all came out 0th percentile for
 * upside AND 0th for bust — a placeholder reading as "no upside, no risk" — on 18
 * of 163 board players. Family #6.
 *
 * A player with no usable neighbourhood must show nothing, not zero.
 */
{
  const leaked = (
    sqlite
      .prepare(
        `SELECT a.name, v.outlook, v.breakout_pctile AS bp, v.bust_pctile AS up
         FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format = ? AND v.teams = ? AND v.season = ? AND v.outlook IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; outlook: string; bp: number | null; up: number | null }>
  ).filter((r) => {
    try {
      const o = JSON.parse(r.outlook) as { sparse?: boolean };
      return Boolean(o.sparse) && (r.bp !== null || r.up !== null);
    } catch {
      return false;
    }
  });
  check(
    'a player with no usable comparables is ranked on nothing, not on zero',
    leaked.length === 0,
    `${leaked.length} sparse outlooks still carry a percentile: ${leaked.slice(0, 3).map((r) => r.name).join(', ')}`,
  );
}

/*
 * The late-board split must actually split.
 *
 * "Held a role last season" separates two populations the ADP ordering cannot
 * compare — among late picks who held one, taking the earlier pick is worth 41
 * points; among those who did not, 14. That only works while both sides are
 * populated. Every looser definition tested fired on 70-81% of the late board
 * and scored NEGATIVE, which is the dead-threshold family: a split that puts
 * nearly everyone on one side separates nobody.
 */
{
  const late = sqlite
    .prepare(
      `SELECT held_role AS held FROM value_scores
       WHERE format=? AND teams=? AND season=? AND adp >= 85 AND held_role IS NOT NULL`,
    )
    .all(FORMAT, TEAMS, SEASON) as Array<{ held: number }>;
  const share = late.length ? late.filter((r) => r.held === 1).length / late.length : 0;
  check(
    'the late-board role split puts a real group on each side',
    late.length >= 30 && share >= 0.2 && share <= 0.8,
    `${(share * 100).toFixed(0)}% of picks 85+ held a role (n=${late.length}); outside 20-80% it separates nobody`,
  );
}

/*
 * The board's outlook copy must be from THIS build, not a previous schema.
 *
 * `build:outlook` deletes and rebuilds `player_outlook`, but for a long time it
 * only UPDATEd `value_scores.outlook` for the players it produced. Anyone who
 * dropped out of the build kept whatever was written the last time he qualified.
 * Chase Brown and Theo Wease were carrying outlooks from an older schema — no
 * `support`, no `vanishRate`, no `bands`, and breakout and bust rates from a
 * model predating the production term, the availability feature and the distance
 * weighting. The board ranked them on it, because `sparse` was false and nothing
 * else looked wrong.
 *
 * Checked by shape rather than by timestamp: a row missing fields the current
 * builder always writes cannot have come from the current builder.
 */
{
  const REQUIRED = ['support', 'vanishRate', 'bands', 'closeShare', 'medianPpg', 'outcomeToSeason'];
  const stale = (
    sqlite
      .prepare(
        `SELECT a.name, v.outlook FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format=? AND v.teams=? AND v.season=? AND v.outlook IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; outlook: string }>
  ).filter((r) => {
    try {
      const o = JSON.parse(r.outlook) as Record<string, unknown>;
      return REQUIRED.some((k) => o[k] === undefined);
    } catch {
      return true;
    }
  });
  check(
    'no board row carries an outlook from an older build',
    stale.length === 0,
    `${stale.length} rows are missing fields the current builder always writes: ${stale.slice(0, 3).map((r) => r.name).join(', ')}`,
  );
}

/*
 * The hit rate and the bust rate are one measurement with two names.
 *
 * The bust bar was moved from half of replacement to replacement itself, which
 * makes `bustRate` the exact complement of `hitRate` — "cleared replacement" and
 * "did not" are the same question. That is intended and it is also a trap: two
 * surfaces showing 38% bust and 62% hit look like two findings. This asserts the
 * identity so nobody later "fixes" one of them into a different bar and leaves
 * the pages quietly disagreeing about what a bust is.
 */
{
  const broken = (
    sqlite
      .prepare(
        `SELECT a.name, v.outlook FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format=? AND v.teams=? AND v.season=? AND v.outlook IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; outlook: string }>
  ).filter((r) => {
    try {
      const o = JSON.parse(r.outlook) as { sparse?: boolean; hitRate?: number; bustRate?: number };
      if (o.sparse || o.hitRate === undefined || o.bustRate === undefined) return false;
      return Math.abs(o.hitRate + o.bustRate - 1) > 0.02;
    } catch {
      return true;
    }
  });
  check(
    'the hit rate and the bust rate are complements, as the shared bar requires',
    broken.length === 0,
    `${broken.length} outlooks where they do not sum to 1: ${broken.slice(0, 3).map((r) => r.name).join(', ')}`,
  );
}

/*
 * UPSIDE and BUST must stay near-mirrors, because that is what they are.
 *
 * Measured with the comparables rebuilt per season and ranked within position
 * and band, they correlate at −0.874 and NEITHER survives the other: the partial
 * of upside after bust is .020 pooled, and bust after upside −.051. Two columns
 * carrying one measurement.
 *
 * They are kept because the two framings answer different questions a drafter
 * asks, and both hovers say outright that they are the same number. This check
 * exists so that stays true: if someone later moves one definition and not the
 * other, the columns would quietly stop being mirrors and the page would be
 * presenting one measurement as two pieces of evidence without saying so.
 */
{
  const pairs = (
    sqlite
      .prepare(
        `SELECT breakout_pctile AS up, bust_pctile AS bust FROM value_scores
         WHERE format=? AND teams=? AND season=?
           AND breakout_pctile IS NOT NULL AND bust_pctile IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{ up: number; bust: number }>
  );
  if (pairs.length >= 30) {
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const u = pairs.map((r) => r.up), b = pairs.map((r) => r.bust);
    const mu = mean(u), mb = mean(b);
    let n = 0, du = 0, db = 0;
    for (let i = 0; i < u.length; i++) {
      n += (u[i]! - mu) * (b[i]! - mb); du += (u[i]! - mu) ** 2; db += (b[i]! - mb) ** 2;
    }
    const r = du && db ? n / Math.sqrt(du * db) : 0;
    check(
      'the two halves behind OUTLOOK are still the mirrors the measurement says they are',
      r <= -0.6,
      `they correlate ${r.toFixed(2)} on the board; the partial test says they are one measurement ` +
        `at −0.87, so a weaker mirror means one definition has drifted from the other`,
    );
  }
}

/*
 * The combined axis must actually be the average of its halves.
 *
 * OUTLOOK collapses UPSIDE and BUST into one column because they were one
 * measurement shown twice. The hover still explains it as "the two halves
 * averaged", so the arithmetic has to match the explanation — an axis that
 * drifted from its stated construction would be a number with a story attached
 * rather than a number the story describes.
 */
{
  const wrong = (
    sqlite
      .prepare(
        `SELECT a.name, breakout_pctile AS up, bust_pctile AS bust, outlook_pctile AS axis
         FROM value_scores v
         JOIN adp_raw a ON a.player_id = v.player_id AND a.year = v.season
          AND a.format = v.format AND a.teams = v.teams
         WHERE v.format=? AND v.teams=? AND v.season=? AND outlook_pctile IS NOT NULL`,
      )
      .all(FORMAT, TEAMS, SEASON) as Array<{ name: string; up: number | null; bust: number | null; axis: number }>
  ).filter((r) => {
    if (r.up === null || r.bust === null) return true; // an axis with a missing half
    return Math.abs((r.up + (100 - r.bust)) / 2 - r.axis) > 0.51;
  });
  check(
    'the OUTLOOK axis is the average of the two halves it claims to be',
    wrong.length === 0,
    `${wrong.length}: ${wrong.slice(0, 3).map((r) => r.name).join(', ')}`,
  );
}

/* ------------------------------------------------------------------ */
/*
 * NEWS AND INJURIES
 *
 * These tables are optional — a board built before the news ingest ever ran is
 * a valid board — so every check here is skipped rather than failed when the
 * table is empty. A check that fails because a feature is not in use trains the
 * reader to ignore the audit, which is the failure #95 was about wearing
 * different clothes.
 */
console.log('\nNEWS — is the feed attributing and classifying honestly?');

const newsCount = (
  sqlite.prepare(`SELECT COUNT(*) n FROM news_item`).get() as { n: number }
).n;

if (newsCount === 0) {
  console.log('  SKIP  no news stored — run `npm run ingest:news`');
} else {
  /*
   * FAMILY #2 — a category matching almost everything is not classifying.
   *
   * The classifier is judgement, and this is the standard judgement is held to
   * everywhere else here. Deliberately generous at 70%: the point is to catch a
   * rule that has collapsed into "everything", not to police the shape of a
   * distribution that legitimately shifts between August and December.
   */
  const catRows = sqlite
    .prepare(`SELECT category, COUNT(*) n FROM news_item GROUP BY category`)
    .all() as Array<{ category: string; n: number }>;
  const worst = catRows
    .filter((c) => c.category !== 'general')
    .sort((a, b) => b.n - a.n)[0];
  check(
    'no single news category has swallowed the feed',
    !worst || worst.n / newsCount <= 0.7,
    `${worst?.category} is ${(((worst?.n ?? 0) / newsCount) * 100).toFixed(0)}% of ${newsCount} items — ` +
      `a category that matches nearly everything carries no information`,
  );

  /*
   * FAMILY #6 — the same standard as `every "measured" point quotes the number
   * behind it`. A category is a claim about why an item matters, and the phrase
   * that produced it is the evidence. Without it the chip is an assertion.
   */
  const noBasis = (
    sqlite
      .prepare(
        `SELECT COUNT(*) n FROM news_item
         WHERE category != 'general' AND (category_basis IS NULL OR category_basis = '')`,
      )
      .get() as { n: number }
  ).n;
  check(
    'every categorised news item names the phrase that categorised it',
    noBasis === 0,
    `${noBasis} items carry a category with no basis — the chip would be an assertion`,
  );

  /*
   * FAMILY #2, pointed at the relevance veto.
   *
   * The veto is the most destructive rule in this pipeline — it removes items
   * before any category is tried — so it needs the same guard the categories
   * get from the other direction. A veto matching almost everything is not a
   * filter, it is an outage, and it would look exactly like a quiet news week.
   *
   * Generous at 75%: the August feed genuinely is mostly linemen and camp
   * scuffles, and the measured rate is about a third.
   */
  const vetoedN = (
    sqlite
      .prepare(
        `SELECT COUNT(*) n FROM news_item WHERE category = 'general' AND category_basis IS NOT NULL`,
      )
      .get() as { n: number }
  ).n;
  check(
    'the relevance veto has not swallowed the feed',
    vetoedN / newsCount <= 0.75,
    `${vetoedN} of ${newsCount} items (${((100 * vetoedN) / newsCount).toFixed(0)}%) are being ` +
      `held back as not fantasy news — a veto that removes nearly everything is an outage, ` +
      `and reads as a quiet news week`,
  );

  /*
   * Every curated creator is still returning videos.
   *
   * A channel that renames itself or goes quiet costs nothing loudly — the feed
   * simply returns fewer items and the tab looks a bit thinner, which is
   * indistinguishable from a slow week. Since the whole quality argument for
   * this surface rests on the roster, a roster member silently dropping out is
   * exactly the failure that must not be quiet.
   *
   * Soft, because a creator genuinely can post nothing for a fortnight in
   * February, and a hard failure would then block every refresh.
   */
  const rostered = sqlite
    .prepare(
      `SELECT source, COUNT(*) n FROM news_item WHERE source LIKE 'creator:%' GROUP BY source`,
    )
    .all() as Array<{ source: string; n: number }>;
  if (rostered.length > 0) {
    const seen = new Set(rostered.map((r) => r.source.slice('creator:'.length)));
    const missing = CREATORS.filter((c) => !seen.has(c.slug));
    check(
      'every creator on the roster is still returning videos',
      missing.length === 0,
      `${missing.map((m) => `${m.name} (${m.handle})`).join(', ')} returned nothing — ` +
        `a renamed or dead channel looks exactly like a quiet fortnight`,
      true,
    );
  }

  /*
   * FAMILY #4 — the whole point of resolving through the depth chart.
   *
   * A mention's team must be the team the player is on NOW. This is the check
   * for bugs #14, #29, #42 and #100 arriving through the news table: if the
   * resolver ever falls back to `player_usage.team`, a traded player's news
   * files under the roster he left.
   */
  const staleTeam = sqlite
    .prepare(
      `SELECT m.raw_name, m.team AS mentionTeam, dc.team AS chartTeam
       FROM news_mention m
       JOIN (SELECT player_id, team, MIN(pos_rank) r FROM depth_chart
             WHERE season = ? GROUP BY player_id) dc ON dc.player_id = m.player_id
       WHERE m.player_id IS NOT NULL AND m.team IS NOT NULL
         AND m.team != dc.team`,
    )
    .all(SEASON) as Array<{ raw_name: string; mentionTeam: string; chartTeam: string }>;
  check(
    'news is filed under the team a player is on now, not the one he left',
    staleTeam.length === 0,
    `${staleTeam.length} mentions disagree with the depth chart: ` +
      staleTeam.slice(0, 3).map((s) => `${s.raw_name} ${s.mentionTeam} v ${s.chartTeam}`).join(', '),
  );

  /*
   * Every relevant item must be reachable, whether or not it names a team.
   *
   * This tests the READ PATH rather than the table, because the bug it exists
   * for lived there. An inner join requiring a team dropped 30 of 85 items from
   * the team pages *and* from the league view, since both were built from the
   * same map — so the items existed, were correctly classified, and appeared
   * nowhere at all.
   *
   * The first version of this check counted items with no mention row and
   * warned on them, which is the wrong quantity twice over: a league-wide
   * rankings piece legitimately belongs to no team, and after the fix it is
   * reachable anyway. A check that fires on correct behaviour is worse than no
   * check (#33 — an audit check can have the bug it is hunting).
   */
  const relevantCats = "'injury','role','scheme','transaction','analysis','performance'";
  const relevantTotal = (
    sqlite
      .prepare(`SELECT COUNT(*) n FROM news_item WHERE category IN (${relevantCats})`)
      .get() as { n: number }
  ).n;
  const reachable = getLeagueNews().length;
  check(
    'every fantasy-relevant news item is reachable in the feed',
    reachable === relevantTotal,
    `${reachable} reachable against ${relevantTotal} stored — ` +
      `${relevantTotal - reachable} items are classified, attributed and visible on no page`,
  );

  /*
   * Every mention is accounted for by name. `out_of_scope` is a success and
   * `unresolved` is a miss, and conflating them is what made 33 correct
   * exclusions look like failures. This fails only if genuine misses become a
   * large share, which would mean the registry has drifted from the feed.
   */
  const methods = sqlite
    .prepare(`SELECT method, COUNT(*) n FROM news_mention GROUP BY method`)
    .all() as Array<{ method: string; n: number }>;
  const totalM = methods.reduce((a, m) => a + m.n, 0);
  const unresolved = methods.find((m) => m.method === 'unresolved')?.n ?? 0;
  check(
    'news names resolve to players, and an unresolvable name is rare',
    totalM === 0 || unresolved / totalM < 0.15,
    `${unresolved} of ${totalM} mentions resolve to nobody — over 15% means the registry has drifted from the feed`,
    true,
  );

  /*
   * The archive is append-only, and that is the one property it cannot lose.
   * If a future change turns the ingest into DELETE-then-insert to match the
   * house pattern, this is what notices: RotoWire publishes 5 items at a time,
   * so a same-day span means the history was just erased.
   */
  const span = sqlite
    .prepare(`SELECT MIN(published_at) a, MAX(published_at) b FROM news_item`)
    .get() as { a: number; b: number };
  const days = (span.b - span.a) / 86_400_000;
  check(
    'the news archive spans more than one pull',
    newsCount < 60 || days > 0.5,
    `${newsCount} items spanning only ${days.toFixed(2)} days — ` +
      `if an ingest started deleting before it wrote, this is how it would look`,
    true,
  );
}

console.log('\nINJURIES — is the report current and honestly labelled?');

const injCount = (
  sqlite.prepare(`SELECT COUNT(*) n FROM injury_report`).get() as { n: number }
).n;

if (injCount === 0) {
  console.log('  SKIP  no injury report stored — run `npm run ingest:injuries`');
} else {
  /*
   * The opposite property from news: this one is a SNAPSHOT, so it must have
   * been written in one go. Two fetch timestamps in the table means a
   * DELETE-then-insert became an upsert somewhere and healed players are
   * lingering — bugs #9, #64, #94 and #99, all the same shape.
   */
  const stamps = (
    sqlite
      .prepare(`SELECT COUNT(DISTINCT fetched_at) n FROM injury_report WHERE source = 'espn'`)
      .get() as { n: number }
  ).n;
  check(
    'the injury report is one snapshot, not a pile of them',
    stamps <= 1,
    `${stamps} distinct fetch times in one source — a healed player has no row to update, only a row that should stop existing`,
  );

  // Only the four modelled positions, or the page is quietly reporting on
  // linemen it has no other opinion about.
  const offPos = (
    sqlite
      .prepare(
        `SELECT COUNT(*) n FROM injury_report WHERE position NOT IN ('QB','RB','WR','TE')`,
      )
      .get() as { n: number }
  ).n;
  check(
    'the injury report holds only the four positions this project models',
    offPos === 0,
    `${offPos} rows at other positions`,
  );

  /*
   * FAMILY #6 again, and the specific thing this page could most easily lie
   * about. ESPN's "Active" means "carrying a knock and expected to play" and is
   * the overwhelming majority of the report. The page states that in as many
   * words; this fails if the composition ever shifts far enough that the
   * sentence stops being true, at which point the copy needs rewriting rather
   * than the data.
   */
  const active = (
    sqlite
      .prepare(`SELECT COUNT(*) n FROM injury_report WHERE status = 'Active'`)
      .get() as { n: number }
  ).n;
  check(
    'the page\'s claim that most of the injury report is "expected to play" is still true',
    active / injCount > 0.5,
    `only ${((active / injCount) * 100).toFixed(0)}% are Active — the notice on /injuries says most of the report is, and would now be wrong`,
    true,
  );

  // A row with a status and nothing else is a status with no evidence.
  const noText = (
    sqlite
      .prepare(
        `SELECT COUNT(*) n FROM injury_report WHERE detail IS NULL AND analysis IS NULL`,
      )
      .get() as { n: number }
  ).n;
  check(
    'an injury row carries the report behind it, not just a status word',
    noText / injCount < 0.1,
    `${noText} of ${injCount} rows have neither a beat report nor a written read`,
    true,
  );
}

/* ------------------------------------------------------------------ */
/*
 * THE IN-SEASON SWITCH
 *
 * The compare tool answers a different question once games are played, and the
 * switch is automatic. That makes it exactly the kind of thing that can be
 * wrong for months without anyone noticing: in August a broken switch looks
 * like a working draft tool, and the failure only appears in week 1 when it is
 * most needed.
 *
 * So the contract is asserted directly. `buildLiveReads` must be EMPTY before
 * the season starts, because every caller is written unconditionally on that
 * promise, and it must be POPULATED for a season that was played.
 */
console.log('\nIN-SEASON SWITCH — does the live read arm and disarm correctly?');
{
  const { live, week } = resolveUsageSeason(SEASON);
  const nowReads = buildLiveReads(SEASON);

  check(
    live
      ? 'the live read is populated now that games have been played'
      : 'the live read is empty before the season starts',
    live ? nowReads.size > 0 : nowReads.size === 0,
    live
      ? `week ${week} is in the data but buildLiveReads returned ${nowReads.size} players`
      : `no games played yet, but buildLiveReads returned ${nowReads.size} players — every caller ` +
        `is written on the promise that it is empty until week 1`,
  );

  /*
   * The other half, tested against a season that definitely happened. Without
   * this the check above passes trivially all summer while the machinery it is
   * guarding has never once been executed.
   */
  const priorSeason = (
    sqlite
      .prepare(
        `SELECT COALESCE(MAX(season), 0) s FROM player_stats_week
         WHERE season < ? AND season_type = 'REG'`,
      )
      .get(SEASON) as { s: number }
  ).s;
  if (priorSeason > 0) {
    const past = buildLiveReads(priorSeason);
    const scoring = [...past.values()].filter((r) => r.ppg > 0).length;
    check(
      'the live read works on a season that was actually played',
      past.size > 100 && scoring > 100,
      `${priorSeason} returned ${past.size} players, ${scoring} with points — the in-season ` +
        `path is unreachable until September, so this is the only thing exercising it`,
    );

    // A spike carries no signal and must never be flagged; only a fall is.
    const spiked = [...past.values()].filter((r) => (r.snapDelta ?? 0) >= 15 && r.collapsed);
    check(
      'a snap-share spike is never flagged as a role problem',
      spiked.length === 0,
      `${spiked.length} players with a RISING snap share are marked collapsed — a spike returns ` +
        `6.77 points a game against 6.84 for a flat role and carries no signal`,
    );
  }
}

/*
 * The tally, and the only place the exit code is decided.
 *
 * This has to be the last statement in the file, and it was not: the summary
 * sat two thirds of the way up, so every check below it printed PASS or FAIL
 * into a total that had already been reported and an exit code that had
 * already been set. Roughly a third of the checks — the whole of THE CASE,
 * scarcity, and the cross-position column tests — could fail without failing
 * `npm run refresh`, which is the one job this script has.
 *
 * An audit that does not enforce its own later checks is worse than a shorter
 * audit, because the passing tail reads as coverage. Anything appended from
 * here on must go ABOVE this block.
 */
console.log(
  `\n${failures} failed, ${warnings} warnings, ` +
    `${rows.length} players checked.`,
);
if (failures > 0) process.exitCode = 1;
