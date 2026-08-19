import type { NewsFetch, RawNewsItem } from './types';

/**
 * RSS sources. No key, no account, and between them the most fantasy-specific
 * writing available for free.
 *
 * **RotoWire is the best source here and the most constrained.** Its items are
 * exactly what a drafter wants — player-level, one event each, headlined
 * "Player Name: what happened", with the beat reporter named in the body:
 *
 *     Alvin Kamara: Avoids serious setback but will miss weeks
 *     Kamara (knee) avoided a major injury but "will be out for a few weeks,"
 *     Nick Underhill of NewOrleans.Football reports.
 *
 * That "X of Y reports" is worth noticing, because it is how the beat-reporter
 * posts this project cannot read directly arrive anyway. The public feed
 * carries **5 items**, a rolling window of roughly the last two hours, and
 * accepts no `count` or paging parameter — verified against `count=100` and the
 * bare feed, both of which return 5. Nothing backfills it.
 *
 * The consequence is a design constraint, not a nuisance: **the archive only
 * exists if the ingest runs regularly and accumulates.** That is why
 * `news_item` is append-only, against this project's usual DELETE-then-insert
 * rule, and why the news page reports how much history it is standing on rather
 * than implying it has always been watching.
 *
 * Yahoo Sports is general NFL news rather than fantasy news and tags nothing —
 * no player ids, no team ids. It earns a place on volume (50 items against
 * RotoWire's 5) and everything it contributes has to survive both the name
 * resolver and the relevance classifier on the strength of its text alone.
 */

export interface FeedSpec {
  source: string;
  url: string;
  /**
   * True when the feed headlines items as "Player Name: what happened", which
   * makes the subject extractable without guessing. RotoWire does; Yahoo does
   * not, and mislabelling one as the other would attribute every item to
   * whatever words precede the first colon.
   */
  subjectBeforeColon: boolean;
}

export const FEEDS: FeedSpec[] = [
  {
    source: 'rotowire',
    url: 'https://www.rotowire.com/rss/news.php?sport=NFL',
    subjectBeforeColon: true,
  },
  {
    source: 'yahoo',
    url: 'https://sports.yahoo.com/nfl/rss.xml',
    subjectBeforeColon: false,
  },
];

/** Strips CDATA, decodes the handful of entities these feeds actually emit. */
function text(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block: string, name: string): string | null {
  // Non-greedy, and deliberately tolerant of attributes — Yahoo writes
  // `<guid isPermalink="false">`, which a `<guid>` literal would miss entirely.
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1]! : null;
}

/**
 * A deliberately small RSS reader rather than a dependency.
 *
 * These two feeds are well-formed and this needs five fields from each. Both
 * write an entire item on one line, so anything line-based silently reads zero
 * items — which is the failure worth guarding against, since an empty feed and
 * a broken parser look identical downstream.
 */
export function parseRss(xml: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]!;
    items.push({
      guid: text(tag(block, 'guid')),
      title: text(tag(block, 'title')),
      link: text(tag(block, 'link')),
      description: text(tag(block, 'description')),
      pubDate: text(tag(block, 'pubDate')),
    });
  }
  return items;
}

export async function fetchFeed(spec: FeedSpec): Promise<NewsFetch> {
  try {
    const res = await fetch(spec.url, { headers: { 'User-Agent': 'Mozilla/5.0 (nflhelper)' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const xml = await res.text();
    const rows = parseRss(xml);

    const items: RawNewsItem[] = [];
    for (const r of rows) {
      const published = Date.parse(r.pubDate ?? '');
      if (!Number.isFinite(published)) continue;

      const title = r.title ?? '';
      const athletes: Array<{ name: string }> = [];

      /*
       * Read the subject off the front, but LEAVE IT ON THE HEADLINE.
       *
       * The first version stripped it, on the reasoning that the player is
       * shown as a chip underneath. That produced headlines with no subject —
       * "Avoids serious setback but will miss weeks", "Had a rest day Tuesday",
       * "Dealing with knee injury" — which are unreadable in a list and
       * unsearchable, because the one word anybody would search for is the
       * name. The chip answers "who is this about" for filtering; the headline
       * has to answer it for reading.
       */
      const headline = title;
      if (spec.subjectBeforeColon) {
        const split = title.match(/^([^:]{2,40}):\s*(.+)$/);
        if (split) athletes.push({ name: split[1]!.trim() });
      }

      items.push({
        // RotoWire's guid ("nfl634134") is stable; Yahoo's is a uuid. Falling
        // back to the link keeps the row key stable for any feed that omits one,
        // since a headline can be edited after publication and the key must not.
        externalId: r.guid || r.link || title,
        headline,
        body: r.description || null,
        // RotoWire emits a doubled slash in its player links.
        url: (r.link || '').replace(/([^:])\/\//g, '$1/') || null,
        publishedAt: published,
        athletes,
      });
    }

    return { source: spec.source, items };
  } catch (err) {
    return { source: spec.source, items: [], error: (err as Error).message };
  }
}
