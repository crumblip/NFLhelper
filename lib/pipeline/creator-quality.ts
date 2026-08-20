/**
 * Telling deep analysis from a withheld payoff.
 *
 * THE FINDING THAT SHAPES THIS FILE, and the reason it is not what you would
 * first write: **"top 5 of a position" is not the clickbait signal.** Measured
 * against the two creators this roster was built for, a rule keyed on ranked
 * listicles would have thrown away
 *
 *   - Joel Smyth's "Top 50 Fantasy Stats of 2026", "2026 Fantasy WR Rankings",
 *     "2026 Fantasy RB Rankings" — the rankings ARE the work; and
 *   - Eli Duracell's "Top 5 Offensive Coordinators for Fantasy", which names
 *     Shanahan, Coen and Taylor in its own hashtags.
 *
 * That is family #2 arriving in a new place: a rule that fires on most of the
 * population it was meant to sort.
 *
 * The real distinction is **withholding**. "Top 5 RBs" that names them is a
 * list. "Top 5 RBs — stay tuned for number one" is a curiosity gap: the payoff
 * is deliberately deferred to hold you through the ad. So the veto reads for
 * deferral and manufactured shock, and says nothing about how the content is
 * organised.
 *
 * The depth side is REPORTED, NEVER SCORED. Counting how many named metrics a
 * description contains is a fact about the text; turning that into a 0-100
 * "quality" would be a judgement wearing a number's clothes, which is family #6
 * and something this project has paid for repeatedly. The signals are listed;
 * the reader decides.
 */

/**
 * Deferral and manufactured shock. Nothing here is about structure or length.
 *
 * Kept tight on purpose. "Insane", "crazy" and "must watch" were considered and
 * left out: they are ordinary emphasis in this genre and would fire on careful
 * creators having an enthusiastic day, which is the same over-firing the "top
 * N" rule was rejected for.
 */
const WITHHOLDING = [
  'stay tuned', 'wait for it', 'wait until you see', 'wait till you see',
  "you won't believe", 'you wont believe', "won't believe", 'wont believe',
  'will shock you', 'shocked me', 'will surprise you',
  'number 1 will', 'number one will', 'the last one', 'the final one',
  'save the best for last', 'you need to see',
  'nobody is talking about', 'no one is talking about', 'nobody talks about',
  "they don't want you to know", 'the truth about', 'what nobody tells you',
  'what they are not telling', 'the secret', 'secret stat', 'hidden gem nobody',
  'do not draft until', "don't draft until", 'before you draft this',
  'stop scrolling', 'watch till the end', 'watch to the end',
];

/**
 * SCORING DEPTH FROM THE TEXT DOES NOT WORK HERE, AND WAS REMOVED.
 *
 * The first version of this file scanned descriptions for named metrics —
 * target share, yards per route, EPA, expected points, twelve families of them
 * — on the theory that a creator who names four is describing method. Measured
 * against all 60 videos on the roster it returned **zero signals for every
 * single item**, including the deepest ones.
 *
 * The reason is that a YouTube description is not an argument. It is a table of
 * contents:
 *
 *     #fantasyfootball 00:00 Intro 00:24 Emeka Egbuka 00:47 DK Metcalf
 *     01:45 CIN WRs 02:38 Jaylen Waddle … 14:15 James Cook
 *
 * The analysis is in the audio, which no API exposes. Shipping the feature
 * anyway would have printed an empty "signals" row under every video — a
 * measurement that measures nothing, rendered as though it had looked
 * (family #6).
 *
 * **What the data actually offers is better than what was being attempted.**
 * That chapter list is a precise, timestamped index of exactly which players a
 * video covers — 21 of them on an Establish The Run rankings video — and it is
 * a fact rather than a judgement. So the depth reading is now structural: how
 * many players the creator sat down and indexed. A 21-chapter breakdown and a
 * 40-second Short with no description are different objects, and the count says
 * which one you are looking at without pretending to grade either.
 */

export interface CreatorAssessment {
  /** Set when the item defers its payoff. The phrase that decided it. */
  clickbait: string | null;
  /**
   * Timestamped chapters in the description ("00:24 Emeka Egbuka").
   *
   * A fact about the item, not a grade. High means the video is organised
   * around named players; zero means short-form, or a creator who does not
   * write descriptions — never that the content is thin.
   */
  chapters: number;
}

export function assessCreatorItem(
  title: string,
  description: string | null | undefined,
): CreatorAssessment {
  const hay = ` ${(title + ' ' + (description ?? '')).toLowerCase().replace(/[^a-z0-9.\- ]/g, ' ').replace(/\s+/g, ' ')} `;

  let clickbait: string | null = null;
  for (const p of WITHHOLDING) {
    if (hay.includes(` ${p}`)) {
      clickbait = p;
      break;
    }
  }

  // "00:24 Emeka Egbuka" — minutes:seconds at a word boundary.
  const chapters = (description ?? '').match(/(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?\s/g)?.length ?? 0;

  return { clickbait, chapters };
}

/**
 * Player names hidden in hashtags.
 *
 * Short-form creators put the subject in tags rather than prose:
 * `#jamescook #ashtonjeanty`, `#omarionhampton #lutherburden`. The ordinary
 * name scan looks for "James Cook" and finds nothing, so without this every
 * short-form item resolves to no player at all — which for the creator whose
 * whole feed is short-form means his entire contribution arrives unattributed.
 *
 * Returns the normalised forms, to be matched against `players.normalized_name`
 * — which is already stored space-free, so a hashtag is the same shape as the
 * key by construction.
 */
export function hashtagNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#([a-z][a-z0-9]{5,28})\b/gi)) {
    const tag = m[1]!.toLowerCase();
    // Genre tags, not people. Skipping them avoids thousands of pointless
    // lookups and one real risk: "fantasyfootball" cannot be a name, but a
    // short tag like "chase" could collide with a surname.
    if (/^(fantasy|nfl|football|dynasty|draft|sleeper|bestball|redraft|shorts|ppr)/.test(tag)) {
      continue;
    }
    out.add(tag);
  }
  return [...out];
}
