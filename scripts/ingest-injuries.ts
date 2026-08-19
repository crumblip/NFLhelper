import { sqlite } from '../lib/db/index';
import { fetchEspnInjuries } from '../lib/providers/news/espn';
import { normalizeName } from '../lib/match/normalize';
import { buildRegistry } from '../lib/pipeline/news';

/**
 * The current injury report, from ESPN's public feed. No key, one request.
 *
 * DELETE-then-insert per source, unlike the news ingest next door. An injury
 * report is a claim about *now*: a player who has healed must have no row
 * rather than a stale one, and a table that only ever adds would show every
 * player who was ever hurt as still hurt. That is bugs #9, #64, #94 and #99,
 * all of which were orphan rows surviving a refresh.
 *
 * Attribution is by ESPN athlete id, dug out of the player's own web link
 * because the injuries payload carries no id field. Measured on a live pull:
 * 453 of 459 skill-position rows join on the id, 3 more on name, and 3 miss —
 * two undrafted camp bodies and one two-way player nflverse does not list at
 * receiver. A name-only join would have been at the mercy of ESPN's nicknames,
 * which file Marquise Brown as "Hollywood Brown".
 */

const SEASON = Number(process.env.SEASON ?? 2026);
const MODELLED = new Set(['QB', 'RB', 'WR', 'TE']);

async function main(): Promise<void> {
  console.log(`injury ingest — season ${SEASON}\n`);

  const { rows, error } = await fetchEspnInjuries();
  if (error) {
    console.error(`ESPN injuries FAILED — ${error}`);
    console.error('Nothing written; the existing report is left alone.');
    process.exitCode = 1;
    return;
  }

  const skill = rows.filter((r) => r.position && MODELLED.has(r.position));
  console.log(`${rows.length} injuries listed, ${skill.length} at QB/RB/WR/TE`);

  const reg = buildRegistry(SEASON);

  let byId = 0;
  let byName = 0;
  const missed: string[] = [];

  const resolved = skill.map((r) => {
    let playerId: string | null = null;

    const hit = r.espnId ? reg.byEspn.get(String(r.espnId)) : undefined;
    if (hit) {
      playerId = hit.playerId;
      byId++;
    } else {
      const cands = reg.byName.get(normalizeName(r.name)) ?? [];
      const pick = cands.find((c) => c.current) ?? cands[0];
      if (pick) {
        playerId = pick.playerId;
        byName++;
      } else {
        missed.push(`${r.name} (${r.position})`);
      }
    }
    return { ...r, playerId };
  });

  console.log(
    `matched: ${byId} by ESPN id, ${byName} by name, ${missed.length} unmatched` +
      (missed.length ? ` — ${missed.join(', ')}` : ''),
  );

  /*
   * A row that did not resolve is still stored, with a null player id. The
   * injury tab groups by team, which the feed supplies directly, so an
   * unmatched player still belongs on his team's report — dropping him would
   * make the report quietly incomplete rather than visibly imperfect.
   */
  const del = sqlite.prepare(`DELETE FROM injury_report WHERE source = ?`);
  const ins = sqlite.prepare(
    `INSERT INTO injury_report
       (source, player_id, raw_name, espn_id, position, team, status, body_part,
        detail, analysis, reported_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, raw_name) DO UPDATE SET
       player_id = excluded.player_id, status = excluded.status,
       body_part = excluded.body_part, detail = excluded.detail,
       analysis = excluded.analysis, reported_at = excluded.reported_at,
       fetched_at = excluded.fetched_at`,
  );

  const now = Date.now();
  sqlite.transaction(() => {
    del.run('espn');
    for (const r of resolved) {
      ins.run(
        'espn', r.playerId, r.name, r.espnId, r.position, r.team, r.status,
        r.bodyPart, r.detail, r.analysis, r.reportedAt, now,
      );
    }
  })();

  const byStatus = sqlite
    .prepare(
      `SELECT status, COUNT(*) n FROM injury_report GROUP BY status ORDER BY n DESC`,
    )
    .all() as Array<{ status: string; n: number }>;

  console.log('\nby status:');
  for (const s of byStatus) console.log(`  ${s.status.padEnd(14)} ${String(s.n).padStart(3)}`);

  const withRead = sqlite
    .prepare(`SELECT COUNT(*) n FROM injury_report WHERE analysis IS NOT NULL`)
    .get() as { n: number };
  const teams = sqlite
    .prepare(`SELECT COUNT(DISTINCT team) n FROM injury_report WHERE team IS NOT NULL`)
    .get() as { n: number };

  console.log(
    `\n${resolved.length} stored across ${teams.n} teams · ${withRead.n} carry a written fantasy read`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
