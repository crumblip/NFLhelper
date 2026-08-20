import { CREATORS, type Creator } from '../../creators';
import { hashtagNames } from '../../pipeline/creator-quality';
import type { NewsFetch, RawNewsItem } from './types';

/**
 * Creator videos, from YouTube's per-channel feed.
 *
 * **No API key, no quota, no account** — `feeds/videos.xml?channel_id=…` is a
 * public Atom document returning the 15 most recent uploads with title,
 * description, link and timestamp. Verified against every channel on the
 * roster. The YouTube Data API would give more history for a key and a 10,000
 * unit/day budget, and is not needed for a feed that is polled continuously.
 *
 * This is also how the Instagram reels get here without touching Instagram.
 * Short-form creators cross-post the same cuts as Shorts, and Shorts appear in
 * this feed like any other upload — so the reel's title and hashtags are
 * reachable, which is more than Meta's API gives up without app review.
 *
 * **Atom, not RSS.** Entries are `<entry>` rather than `<item>` and the body is
 * `<media:description>`, so the RSS parser next door does not apply — pointing
 * it at this URL returns zero items and looks exactly like a quiet channel.
 */

const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1]! : null;
}

function decode(raw: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

export async function fetchCreator(creator: Creator): Promise<NewsFetch> {
  try {
    const res = await fetch(`${FEED}${creator.channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (chipship)' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const xml = await res.text();

    const items: RawNewsItem[] = [];
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const block = m[1]!;
      const videoId = decode(tag(block, 'yt:videoId'));
      const title = decode(tag(block, 'title'));
      const published = Date.parse(decode(tag(block, 'published')));
      if (!videoId || !title || !Number.isFinite(published)) continue;

      const description = decode(tag(block, 'media:description'));

      /*
       * Hashtags are carried into the body so the name resolver can see them.
       *
       * A short-form creator puts his subject in tags — "#jamescook
       * #ashtonjeanty" — and the prose scan looks for "James Cook". Appending
       * the de-hashed forms lets one resolver serve both shapes instead of
       * teaching it a second one.
       */
      const tags = hashtagNames(`${title} ${description}`);

      /*
       * Hashtags come off the DISPLAYED headline, after they have been read.
       *
       * A short-form title is half tags — "James Cook or Ashton Jeanty for
       * Fantasy Football #fantasyfootball #jamescook #ashtonjeanty #nflfantasy"
       * — and printing them wastes the width the actual title needs. Nothing is
       * lost: the names in them are already resolved into player chips above,
       * and search reads those chips as well as the headline.
       */
      const clean = title.replace(/#[^\s#]+/g, '').replace(/\s{2,}/g, ' ').trim();

      items.push({
        externalId: videoId,
        headline: clean || title,
        body: description || null,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: published,
        // The creator's own hashtags become athlete candidates; they resolve
        // against normalized names, which are stored space-free already.
        athletes: tags.map((t) => ({ name: t, speculative: true })),
      });
    }

    return { source: `creator:${creator.slug}`, items };
  } catch (err) {
    return { source: `creator:${creator.slug}`, items: [], error: (err as Error).message };
  }
}

export async function fetchAllCreators(): Promise<NewsFetch[]> {
  const out: NewsFetch[] = [];
  for (const c of CREATORS) out.push(await fetchCreator(c));
  return out;
}
