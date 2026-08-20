/**
 * The curated creator roster.
 *
 * **Curation is the primary quality filter, and it is deliberately a human
 * judgement rather than an algorithm.** No text classifier can tell a careful
 * analyst from a confident one; a person who has watched them can. Everything
 * downstream — the clickbait check, the depth signals — is a second line of
 * defence against a bad day from a good creator, not a substitute for this list.
 *
 * Every `channelId` here was resolved from the live channel page and verified,
 * not guessed. A wrong id does not error: it quietly delivers somebody else's
 * videos under the right name, which is the worst kind of wrong this project
 * has (family #4). If you add one, resolve it — `npm run creators:resolve`
 * takes a handle and prints the id.
 *
 * YouTube is the surface rather than Instagram or TikTok for a reason worth
 * knowing: **the same short-form content is cross-posted as Shorts, and only
 * YouTube publishes a machine-readable feed of it.** Instagram exposes no
 * transcript, no caption search and no per-creator feed without Meta app
 * review; TikTok's read API is academic-access or own-account only. The reels
 * are reachable here, with their titles and — where the creator writes one —
 * their description.
 */

export interface Creator {
  /** Short stable key. Used as the news source name, so keep it URL-safe. */
  slug: string;
  name: string;
  /** YouTube channel id, resolved from the handle and verified. */
  channelId: string;
  handle: string;
  /**
   * What this creator is for, in the reader's terms. Shown on the feed so a
   * name nobody recognises still carries its reason for being trusted.
   */
  note: string;
  /**
   * True when the creator posts mostly short-form with no description.
   *
   * It changes what an item can honestly claim to be. Eli Duracell's entries
   * carry a title and hashtags and no body at all, so an item from him is a
   * POINTER — "he posted about James Cook against Ashton Jeanty" — and not
   * analysis this app has read. Joel Smyth writes chaptered descriptions naming
   * every player covered, which is a different and much richer object.
   */
  shortForm: boolean;
}

export const CREATORS: Creator[] = [
  {
    slug: 'joel-smyth',
    name: 'Joel Smyth',
    channelId: 'UCCx78IAwvtd-nAoimYICWOw',
    handle: '@JoelSmythFantasy',
    note: 'Yahoo Fantasy analyst. Chaptered breakdowns naming every player covered.',
    shortForm: false,
  },
  {
    slug: 'eli-duracell',
    name: 'Eli Duracell',
    channelId: 'UClpvEoU4-C4SCaYfEdhwmuw',
    handle: '@EliDuracell',
    note: 'Short-form advanced stats. Titles and hashtags only, with no written body.',
    shortForm: true,
  },
  {
    slug: 'fantasy-points',
    name: 'Fantasy Points',
    channelId: 'UCaCshQX7-gQ0Bs5BnddUwZg',
    handle: '@FantasyPoints',
    note: 'Data-led analysis: route participation, expected points, usage splits.',
    shortForm: false,
  },
  {
    slug: 'establish-the-run',
    name: 'Establish The Run',
    channelId: 'UCvIyBYSykqTU4oqB1gSTM5w',
    handle: '@EstablishTheRun',
    note: 'Projection-driven, betting-adjacent. Heavy on process over takes.',
    shortForm: false,
  },
];

export function creatorBySlug(slug: string): Creator | undefined {
  return CREATORS.find((c) => c.slug === slug);
}
