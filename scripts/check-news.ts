import { sqlite } from '../lib/db/index';
import { CATEGORY_LABEL, FANTASY_CATEGORIES, classify } from '../lib/pipeline/news';

/**
 * What the classifier is actually doing, over everything stored.
 *
 * This exists because the category rules are judgement, and judgement in this
 * project gets measured rather than trusted. The specific failure it hunts is
 * family #2: a rule that fires on nearly everything or on nearly nothing
 * carries no information. A category matching 80% of items is not classifying,
 * and a category matching two items is not worth a filter chip.
 *
 * It also prints the phrases doing the work. A category carried entirely by one
 * over-broad phrase is the same failure wearing a longer list, and the only way
 * to see that is to count the bases rather than the categories.
 *
 * A report, not a check — it fails nothing and is not wired into anything. What
 * counts as too broad here is a reading, not a threshold.
 */

const items = sqlite
  .prepare(
    `SELECT id, source, headline, body, category, category_basis AS basis FROM news_item`,
  )
  .all() as Array<{
  id: string;
  source: string;
  headline: string;
  body: string | null;
  category: string;
  basis: string | null;
}>;

if (items.length === 0) {
  console.log('No news stored. Run `npm run ingest:news` first.');
  process.exit(0);
}

console.log(`${items.length} items stored\n`);

/* ---- category firing rates -------------------------------------------- */

const counts = new Map<string, number>();
for (const i of items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);

console.log('CATEGORY FIRING RATES');
console.log('  a category matching almost everything or almost nothing is not classifying\n');
const ordered = [...FANTASY_CATEGORIES, 'general'];
for (const cat of ordered) {
  const n = counts.get(cat) ?? 0;
  const pct = (100 * n) / items.length;
  const bar = '#'.repeat(Math.round(pct / 2));
  const flag = cat === 'general' ? '' : pct > 60 ? '  <- too broad' : n > 0 && pct < 2 ? '  <- barely fires' : '';
  console.log(
    `  ${cat.padEnd(12)} ${String(n).padStart(4)}  ${pct.toFixed(1).padStart(5)}%  ${bar}${flag}`,
  );
}

const shown = ordered
  .filter((c) => c !== 'general')
  .reduce((a, c) => a + (counts.get(c) ?? 0), 0);
console.log(
  `\n  ${shown} of ${items.length} (${((100 * shown) / items.length).toFixed(1)}%) reach the news tab; ` +
    `${counts.get('general') ?? 0} are set aside as unclassified.`,
);

/* ---- which phrases are doing the work ---------------------------------- */

console.log('\nPHRASES CARRYING EACH CATEGORY');
console.log('  a category carried by one loose phrase is the same problem in disguise\n');
for (const cat of FANTASY_CATEGORIES) {
  const rows = items.filter((i) => i.category === cat);
  if (rows.length === 0) continue;
  const byBasis = new Map<string, number>();
  for (const r of rows) byBasis.set(r.basis ?? '(none)', (byBasis.get(r.basis ?? '(none)') ?? 0) + 1);
  const top = [...byBasis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const dominant = (100 * top[0]![1]) / rows.length;
  console.log(
    `  ${CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL]} (${rows.length})` +
      (dominant > 70 ? `  <- ${dominant.toFixed(0)}% on one phrase` : ''),
  );
  for (const [b, n] of top) console.log(`     ${String(n).padStart(3)}  "${b}"`);
}

/* ---- attribution ------------------------------------------------------- */

const methods = sqlite
  .prepare(`SELECT method, COUNT(*) n FROM news_mention GROUP BY method ORDER BY n DESC`)
  .all() as Array<{ method: string; n: number }>;

console.log('\nATTRIBUTION');
const totalM = methods.reduce((a, m) => a + m.n, 0);
for (const m of methods) {
  const note =
    m.method === 'out_of_scope'
      ? '  (correct — a real player at a position this tool does not model)'
      : m.method === 'unresolved'
        ? '  (a genuine miss — nobody by that name in the registry)'
        : '';
  console.log(`  ${m.method.padEnd(13)} ${String(m.n).padStart(4)}  ${((100 * m.n) / totalM).toFixed(1)}%${note}`);
}

const stillMissing = sqlite
  .prepare(
    `SELECT raw_name, COUNT(*) n FROM news_mention WHERE method = 'unresolved'
     GROUP BY raw_name ORDER BY n DESC LIMIT 12`,
  )
  .all() as Array<{ raw_name: string; n: number }>;
if (stillMissing.length) {
  console.log('\n  unresolved names:');
  for (const m of stillMissing) console.log(`     ${String(m.n).padStart(3)}  ${m.raw_name}`);
}

/* ---- coverage ---------------------------------------------------------- */

const teams = sqlite
  .prepare(
    `SELECT COUNT(DISTINCT team) n FROM news_mention m
     JOIN news_item i ON i.id = m.news_id
     WHERE m.team IS NOT NULL AND i.category != 'general'`,
  )
  .get() as { n: number };

const perTeam = sqlite
  .prepare(
    `SELECT m.team, COUNT(DISTINCT m.news_id) n FROM news_mention m
     JOIN news_item i ON i.id = m.news_id
     WHERE m.team IS NOT NULL AND i.category != 'general'
     GROUP BY m.team ORDER BY n`,
  )
  .all() as Array<{ team: string; n: number }>;

console.log(`\nTEAM COVERAGE — ${teams.n} of 32 teams have at least one fantasy-relevant item`);
if (perTeam.length) {
  const thin = perTeam.filter((t) => t.n <= 1);
  console.log(
    `  thinnest: ${perTeam.slice(0, 6).map((t) => `${t.team} ${t.n}`).join(', ')}` +
      `   richest: ${perTeam.slice(-4).reverse().map((t) => `${t.team} ${t.n}`).join(', ')}`,
  );
  if (thin.length) console.log(`  ${thin.length} teams have 1 item or fewer — the archive is young, not broken.`);
}

/* ---- the archive ------------------------------------------------------- */

const span = sqlite
  .prepare(`SELECT MIN(published_at) a, MAX(published_at) b, COUNT(*) n FROM news_item`)
  .get() as { a: number; b: number; n: number };
const bySource = sqlite
  .prepare(`SELECT source, COUNT(*) n FROM news_item GROUP BY source ORDER BY n DESC`)
  .all() as Array<{ source: string; n: number }>;

console.log(
  `\nARCHIVE — ${span.n} items over ${((span.b - span.a) / 86_400_000).toFixed(1)} days ` +
    `(${bySource.map((s) => `${s.source} ${s.n}`).join(', ')})`,
);

/* ---- reclassification drift -------------------------------------------- */

let drift = 0;
for (const i of items) {
  if (classify(i.headline, i.body).category !== i.category) drift++;
}
if (drift > 0) {
  console.log(
    `\n${drift} stored items would classify differently under the current rules — ` +
      're-run `npm run ingest:news` to bring them into line (it rewrites categories in place).',
  );
}
