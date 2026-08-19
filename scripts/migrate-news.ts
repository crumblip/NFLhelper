import { sqlite } from '../lib/db/index';

/**
 * Creates the news and injury tables.
 *
 * Deliberately explicit CREATE TABLE IF NOT EXISTS rather than
 * `drizzle-kit push`. Bug #96 was a `push --force` silently dropping two
 * columns the schema had never declared, and the standing rule out of it is
 * that a schema operation here should only ever be able to add. This can only
 * add: it creates what is missing and touches nothing that exists.
 *
 * The definitions must stay in step with `lib/db/schema.ts`, which is the
 * declaration of record — that is the other half of the #96 rule.
 */

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS news_item (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     external_id TEXT NOT NULL,
     headline TEXT NOT NULL,
     body TEXT,
     url TEXT,
     published_at INTEGER NOT NULL,
     fetched_at INTEGER NOT NULL,
     category TEXT NOT NULL,
     category_basis TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS news_published_idx ON news_item (published_at)`,
  `CREATE INDEX IF NOT EXISTS news_category_idx ON news_item (category, published_at)`,
  `CREATE INDEX IF NOT EXISTS news_source_idx ON news_item (source)`,

  `CREATE TABLE IF NOT EXISTS news_mention (
     news_id TEXT NOT NULL,
     player_id TEXT,
     raw_name TEXT NOT NULL,
     position TEXT,
     team TEXT,
     method TEXT NOT NULL,
     is_team_level INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (news_id, raw_name)
   )`,
  `CREATE INDEX IF NOT EXISTS mention_player_idx ON news_mention (player_id)`,
  `CREATE INDEX IF NOT EXISTS mention_team_idx ON news_mention (team)`,
  `CREATE INDEX IF NOT EXISTS mention_pos_idx ON news_mention (team, position)`,

  `CREATE TABLE IF NOT EXISTS injury_report (
     source TEXT NOT NULL,
     player_id TEXT,
     raw_name TEXT NOT NULL,
     espn_id TEXT,
     position TEXT,
     team TEXT,
     status TEXT NOT NULL,
     body_part TEXT,
     detail TEXT,
     analysis TEXT,
     reported_at INTEGER,
     fetched_at INTEGER NOT NULL,
     PRIMARY KEY (source, raw_name)
   )`,
  `CREATE INDEX IF NOT EXISTS injury_player_idx ON injury_report (player_id)`,
  `CREATE INDEX IF NOT EXISTS injury_team_idx ON injury_report (team, position)`,
];

for (const sql of STATEMENTS) sqlite.prepare(sql).run();

const tables = sqlite
  .prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
       AND name IN ('news_item','news_mention','injury_report') ORDER BY name`,
  )
  .all() as Array<{ name: string }>;

console.log(`ready: ${tables.map((t) => t.name).join(', ')}`);
for (const t of tables) {
  const n = sqlite.prepare(`SELECT COUNT(*) n FROM ${t.name}`).get() as { n: number };
  console.log(`  ${t.name.padEnd(14)} ${n.n} rows`);
}
