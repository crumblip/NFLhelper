/**
 * The shape every news source arrives in, before anything is resolved.
 *
 * Sources differ enormously in what they can tell us. ESPN tags an article with
 * athlete ids and team ids; RotoWire gives a headline of the form
 * "Player Name: what happened" and nothing structured at all. This interface is
 * the lowest common denominator, and every field beyond the first four is
 * optional precisely so a thin source is not forced to invent them.
 *
 * A source that cannot say who an item is about returns no `athletes` and no
 * `teams`, and the resolver falls back to reading names out of the text. That
 * fallback is recorded per mention (`method`), because "we matched this on a
 * hard id" and "we guessed from a string" are different levels of confidence
 * and the page should not present them identically.
 */
export interface RawNewsItem {
  /** The publisher's own id. Namespaced with the source to form the row key. */
  externalId: string;
  headline: string;
  /** Publisher's timestamp, epoch ms. */
  publishedAt: number;
  body?: string | null;
  url?: string | null;
  /**
   * Athletes the source itself tags, with the publisher's id where it has one.
   * `espnId` is the valuable field — it joins to `players.espn_id` directly and
   * skips name matching entirely.
   */
  athletes?: Array<{ name: string; espnId?: string | null }>;
  /** Team abbreviations the source itself tags. Already normalised by the adapter. */
  teams?: string[];
}

/** One source's worth of items, plus what it cost to get them. */
export interface NewsFetch {
  source: string;
  items: RawNewsItem[];
  /** Set when the fetch failed. The ingest reports it rather than dying. */
  error?: string;
}

/** A row on the injury report, before resolution. */
export interface RawInjury {
  /** The publisher's athlete id where it has one — ESPN's, here. */
  espnId: string | null;
  name: string;
  position: string | null;
  team: string | null;
  /** The publisher's own word. Not normalised — see the schema comment. */
  status: string;
  bodyPart: string | null;
  /** The beat report. */
  detail: string | null;
  /** The written fantasy read, where the source publishes one. */
  analysis: string | null;
  reportedAt: number | null;
}
