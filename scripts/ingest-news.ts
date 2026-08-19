import { sqlite } from '../lib/db/index';
import { fetchEspnNews } from '../lib/providers/news/espn';
import { FEEDS, fetchFeed } from '../lib/providers/news/rss';
import type { NewsFetch } from '../lib/providers/news/types';
import { buildRegistry, classify, resolveMentions } from '../lib/pipeline/news';

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

  const write = sqlite.transaction(() => {
    for (const f of live) {
      for (const item of f.items) {
        const id = `${f.source}:${item.externalId}`;
        const known = !!exists.get(id);
        const cls = classify(item.headline, item.body);

        insertItem.run(
          id, f.source, item.externalId, item.headline, item.body ?? null,
          item.url ?? null, item.publishedAt, now, cls.category, cls.basis,
        );

        clearMentions.run(id);
        for (const m of resolveMentions(item, reg)) {
          insertMention.run(
            id, m.playerId, m.rawName, m.position, m.team, m.method,
            m.isTeamLevel ? 1 : 0,
          );
          mentions++;
          byMethod.set(m.method, (byMethod.get(m.method) ?? 0) + 1);
          if (m.method === 'unresolved') unresolved++;
        }

        byCategory.set(cls.category, (byCategory.get(cls.category) ?? 0) + 1);
        if (known) seen++;
        else fresh++;
      }
    }
  });
  write();

  console.log(`\n${fresh} new, ${seen} already held, ${mentions} mentions`);

  console.log('\nthis pull, by category:');
  for (const [cat, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(12)} ${String(n).padStart(3)}`);
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
