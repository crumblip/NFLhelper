import { sqlite } from '../lib/db/index';
import { fetchEspnNews } from '../lib/providers/news/espn';
import { FEEDS, fetchFeed } from '../lib/providers/news/rss';
import type { NewsFetch } from '../lib/providers/news/types';
import {
  buildRegistry,
  classify,
  resolveMentions,
  subjectCounts,
  vetoOf,
} from '../lib/pipeline/news';

/**
 * Pulls every news source and stores what it finds.
 *
 * **This ingest accumulates and must keep accumulating.** It is the one write
 * path in this project that does not DELETE before it inserts, and the reason
 * is measured rather than stylistic: RotoWire's public feed carries five items,
 * a rolling window of about two hours, and nothing backfills it. A
 * DELETE-then-insert here would reduce the news tab to whatever happened since
 * the last run, which for a tool used on a Sunday morning is nothing.
 *
 * So it is safe and useful to run this often — hourly during the season is not
 * excessive, and every source here is free and unmetered. Re-running it inside
 * the same minute costs four HTTP requests and writes nothing new, because the
 * row key is the publisher's own id.
 *
 * Mentions ARE deleted per item before rewriting, because those are derived: if
 * a player has changed teams since the item was stored, re-running should move
 * it to his new team rather than leave it filed under the old one.
 */

const SEASON = Number(process.env.SEASON ?? 2026);

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`news ingest — season ${SEASON}\n`);

  const fetches: NewsFetch[] = [];
  fetches.push(await fetchEspnNews());
  for (const spec of FEEDS) fetches.push(await fetchFeed(spec));

  for (const f of fetches) {
    if (f.error) console.log(`  ${f.source.padEnd(10)} FAILED — ${f.error}`);
    else console.log(`  ${f.source.padEnd(10)} ${String(f.items.length).padStart(3)} items`);
  }

  const live = fetches.filter((f) => !f.error);
  if (live.length === 0) {
    console.error('\nEvery source failed. Nothing written.');
    process.exitCode = 1;
    return;
  }

  const reg = buildRegistry(SEASON);
  console.log(
    `\nregistry: ${reg.current.length} current players, ${reg.byEspn.size} with an ESPN id`,
  );

  const insertItem = sqlite.prepare(
    `INSERT INTO news_item
       (id, source, external_id, headline, body, url, published_at, fetched_at,
        category, category_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       headline = excluded.headline,
       body = excluded.body,
       url = excluded.url,
       category = excluded.category,
       category_basis = excluded.category_basis`,
  );
  const clearMentions = sqlite.prepare(`DELETE FROM news_mention WHERE news_id = ?`);
  const insertMention = sqlite.prepare(
    `INSERT INTO news_mention
       (news_id, player_id, raw_name, position, team, method, is_team_level)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const exists = sqlite.prepare(`SELECT 1 FROM news_item WHERE id = ?`);

  const now = Date.now();
  let fresh = 0;
  let seen = 0;
  let mentions = 0;
  let unresolved = 0;
  const byCategory = new Map<string, number>();
  const byMethod = new Map<string, number>();
  const byVeto = new Map<string, number>();

  const write = sqlite.transaction(() => {
    for (const f of live) {
      for (const item of f.items) {
        const id = `${f.source}:${item.externalId}`;
        const known = !!exists.get(id);

        /*
         * Resolve first, THEN decide relevance. The veto needs to know whether
         * anybody modelled turned up, so it cannot run on the text alone —
         * that ordering is the whole point of it.
         */
        const resolved = resolveMentions(item, reg);
        const subjects = subjectCounts(item, resolved, reg);
        const veto = vetoOf(item.headline, item.body, subjects.skill, subjects.nonSkill);
        const cls = veto
          ? { category: 'general' as const, basis: `${veto.reason}: ${veto.basis}` }
          : classify(item.headline, item.body);

        insertItem.run(
          id, f.source, item.externalId, item.headline, item.body ?? null,
          item.url ?? null, item.publishedAt, now, cls.category, cls.basis,
        );

        clearMentions.run(id);
        for (const m of resolved) {
          insertMention.run(
            id, m.playerId, m.rawName, m.position, m.team, m.method,
            m.isTeamLevel ? 1 : 0,
          );
          mentions++;
          byMethod.set(m.method, (byMethod.get(m.method) ?? 0) + 1);
          if (m.method === 'unresolved') unresolved++;
        }

        byCategory.set(cls.category, (byCategory.get(cls.category) ?? 0) + 1);
        if (veto) byVeto.set(veto.reason, (byVeto.get(veto.reason) ?? 0) + 1);
        if (known) seen++;
        else fresh++;
      }
    }
  });
  write();

  console.log(`\n${fresh} new, ${seen} already held, ${mentions} mentions`);

  /*
   * Re-file the WHOLE archive, not just what this pull returned.
   *
   * The rules change as they are refined, and an item only appears in the feed
   * for a few hours — so without this, everything stored before a rule changed
   * keeps the answer the old rules gave it. After the relevance veto was added
   * the archive held 146 items and the feed returned 105, which left 41 sitting
   * in the tab under categories the current rules would never assign. A reader
   * cannot tell those apart from correctly-filed ones, so the tab would be part
   * new logic and part fossil.
   *
   * It is cheap — a few hundred rows of string matching against mentions
   * already stored — so it runs every time rather than behind a flag nobody
   * remembers to set.
   */
  const stored = sqlite
    .prepare(`SELECT id, headline, body, category, category_basis AS basis FROM news_item`)
    .all() as Array<{
    id: string; headline: string; body: string | null;
    category: string; basis: string | null;
  }>;

  const mentionRows = sqlite
    .prepare(`SELECT news_id AS id, player_id AS playerId, method FROM news_mention`)
    .all() as Array<{ id: string; playerId: string | null; method: string }>;
  const byItem = new Map<string, Array<{ playerId: string | null; method: string }>>();
  for (const m of mentionRows) {
    const list = byItem.get(m.id) ?? [];
    list.push(m);
    byItem.set(m.id, list);
  }

  const reclass = sqlite.prepare(
    `UPDATE news_item SET category = ?, category_basis = ? WHERE id = ?`,
  );

  let moved = 0;
  sqlite.transaction(() => {
    for (const s of stored) {
      const ms = byItem.get(s.id) ?? [];
      const counts = subjectCounts(
        { externalId: s.id, headline: s.headline, body: s.body, publishedAt: 0 },
        ms.map((m) => ({
          playerId: m.playerId, rawName: '', position: null, team: null,
          method: m.method as never, isTeamLevel: false,
        })),
        reg,
      );
      const veto = vetoOf(s.headline, s.body, counts.skill, counts.nonSkill);
      const next = veto
        ? { category: 'general', basis: `${veto.reason}: ${veto.basis}` }
        : classify(s.headline, s.body);
      if (next.category !== s.category || next.basis !== s.basis) {
        reclass.run(next.category, next.basis, s.id);
        moved++;
      }
    }
  })();

  if (moved > 0) console.log(`${moved} stored items re-filed under the current rules`);

  console.log('\nthis pull, by category:');
  for (const [cat, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(12)} ${String(n).padStart(3)}`);
  }

  if (byVeto.size > 0) {
    console.log('\nset aside as not fantasy news:');
    for (const [r, n] of [...byVeto.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${r.padEnd(38)} ${String(n).padStart(3)}`);
    }
  }

  console.log('\nhow players were matched:');
  for (const [m, n] of [...byMethod.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m.padEnd(12)} ${String(n).padStart(3)}`);
  }
  if (unresolved > 0) {
    const names = sqlite
      .prepare(
        `SELECT DISTINCT raw_name FROM news_mention WHERE method = 'unresolved' LIMIT 8`,
      )
      .all() as Array<{ raw_name: string }>;
    console.log(`  unmatched names: ${names.map((n) => n.raw_name).join(', ')}`);
  }

  const held = sqlite
    .prepare(
      `SELECT COUNT(*) n, MIN(published_at) oldest, MAX(published_at) newest FROM news_item`,
    )
    .get() as { n: number; oldest: number; newest: number };
  const days = held.n ? (held.newest - held.oldest) / 86_400_000 : 0;
  console.log(
    `\narchive: ${held.n} items spanning ${days.toFixed(1)} days` +
      (held.n ? ` (${new Date(held.oldest).toISOString().slice(0, 10)} → ${new Date(held.newest).toISOString().slice(0, 10)})` : ''),
  );
  console.log(
    'RotoWire ships 5 items per pull and nothing backfills it — run this often to build history.',
  );
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
