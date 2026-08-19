import { sqlite } from '../lib/db/index';
import { buildOutlooks } from '../lib/pipeline/outlook';


/**
 * Range of outcomes and player type, from historical comparables.
 *
 * Adds the two things a point projection cannot say: how wide the range is, and
 * what kind of player he is inside it.
 *
 * Written for every player with a measured role, not just the ones on the board.
 * The build used to start from `value_scores JOIN adp_raw` and so produced
 * nothing for anybody the ADP feed does not price — which is every player a
 * waiver claim is made on.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

const build = buildOutlooks(FORMAT, TEAMS, CURRENT);

const insert = sqlite.prepare(
  `INSERT INTO player_outlook
     (player_id, format, teams, season, position, profile_season, profile_games,
      outlook, archetype, computed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(player_id, format, teams, season) DO UPDATE SET
     position = excluded.position, profile_season = excluded.profile_season,
     profile_games = excluded.profile_games, outlook = excluded.outlook,
     archetype = excluded.archetype, computed_at = excluded.computed_at`,
);

// The board keeps its own copy so the sort and the tag filters do not need a
// join; it is written from the same rows, never computed twice.
const updateValue = sqlite.prepare(
  `UPDATE value_scores SET outlook = ?, archetype = ?
   WHERE player_id = ? AND format = ? AND teams = ? AND season = ?`,
);

const now = Date.now();
let onBoard = 0;

sqlite.transaction(() => {
  // A stale row is worse than a missing one: it would describe last week's role
  // with this week's label on it.
  sqlite
    .prepare(`DELETE FROM player_outlook WHERE format = ? AND teams = ? AND season = ?`)
    .run(FORMAT, TEAMS, CURRENT);

  /*
   * The board's copy has to be cleared too, and it was not.
   *
   * `player_outlook` is deleted and rebuilt, but `value_scores.outlook` was only
   * ever UPDATEd for players this run produces. Anyone who drops out of the
   * build — his profile falls under the games floor, his comparables go sparse,
   * he leaves the league — kept whatever was written the last time he qualified.
   *
   * Chase Brown and Theo Wease were still carrying outlooks from an OLDER SCHEMA
   * VERSION: no `support`, no `vanishRate`, no `bands`, no per-game figures, and
   * breakout and bust rates from a model that predates the production term, the
   * availability feature and the distance weighting. The board ranked them on it
   * anyway, because `sparse` was false and nothing else looked wrong.
   *
   * Same family as bugs #9 and #64 — an upsert that never deletes leaves orphans
   * answering queries under a key nothing rebuilds.
   */
  sqlite
    .prepare(
      `UPDATE value_scores SET outlook = NULL, archetype = NULL
       WHERE format = ? AND teams = ? AND season = ?`,
    )
    .run(FORMAT, TEAMS, CURRENT);

  for (const r of build.rows) {
    const json = JSON.stringify(r.outlook);
    insert.run(
      r.playerId, FORMAT, TEAMS, CURRENT, r.position,
      r.profileSeason, r.profileGames, json, r.archetype, now,
    );
    onBoard += updateValue.run(json, r.archetype, r.playerId, FORMAT, TEAMS, CURRENT).changes;
  }
})();

/* ------------------------------------------------------------------ report */

console.log(
  `outlook written for ${build.rows.length} players ` +
    `(${onBoard} of them on the board, ${build.rows.length - onBoard} undrafted)`,
);
console.log(
  build.live
    ? `profiled on the LIVE ${build.profileSeason} season through week ${build.week}`
    : `profiled on the completed ${build.profileSeason} season`,
);

/*
 * Support, distance bands and the sample table are all reported WITHIN position.
 * Pooling them is the cross-position mistake this project keeps rediscovering:
 * quarterbacks score most, so a table sorted on the median across all four
 * positions is a list of quarterbacks, and a support tally across all four hides
 * that "thin" means something different at each one.
 */
console.log('\n     n   strong  fair  thin  none   close  loose  no-analogue');
for (const position of ['QB', 'RB', 'WR', 'TE']) {
  const rows = build.rows.filter((r) => r.position === position);
  if (!rows.length) continue;
  const count = (t: string) =>
    rows.filter((r) => (r.outlook.sparse ? 'none' : r.outlook.support) === t).length;
  const b = rows[0]!.outlook.bands;
  console.log(
    ` ${position}${String(rows.length).padStart(5)}${String(count('strong')).padStart(8)}` +
      `${String(count('fair')).padStart(6)}${String(count('thin')).padStart(6)}${String(count('none')).padStart(6)}` +
      `${b.close.toFixed(2).padStart(8)}${b.loose.toFixed(2).padStart(7)}${b.noAnalogue.toFixed(2).padStart(13)}`,
  );
}

console.log('\n pos player               archetype                      floor/med/ceil   per game   hit break bust gone  support');
for (const position of ['QB', 'RB', 'WR', 'TE']) {
  const shown = build.rows
    .filter((r) => r.position === position && !r.outlook.sparse)
    .sort((a, b) => b.outlook.median - a.outlook.median)
    .slice(0, 5);
  for (const r of shown) {
    const o = r.outlook;
    console.log(
      ` ${r.position.padEnd(3)} ${r.name.slice(0, 20).padEnd(21)}${r.archetype.slice(0, 30).padEnd(31)}` +
        `${o.floor.toFixed(0).padStart(4)} /${o.median.toFixed(0).padStart(4)} /${o.ceiling.toFixed(0).padStart(4)}  ` +
        `${o.floorPpg.toFixed(1).padStart(4)}-${o.ceilingPpg.toFixed(1).padEnd(4)} ` +
        `${`${Math.round(o.hitRate * 100)}%`.padStart(4)} ${`${Math.round(o.breakoutRate * 100)}%`.padStart(4)} ` +
        `${`${Math.round(o.bustRate * 100)}%`.padStart(4)} ${`${Math.round(o.vanishRate * 100)}%`.padStart(4)}  ${o.support}`,
    );
  }
}

console.log('\nfloor/median/ceiling are the 20th, 50th and 80th percentile of what the 40 most');
console.log('similar historical player-seasons did the FOLLOWING year, weighted by how close');
console.log('each one is, and drawn from the ones who took the field. "gone" is the share who');
console.log('never played again — kept out of the range on purpose, since a floor that means');
console.log('"retired" cannot be read as a floor. Similarity is role, scoring opportunity,');
console.log('production, availability and age.');

if (build.skipped.length) {
  console.log(`\n${build.skipped.length} players skipped (too few games or no birth date)`);
}
