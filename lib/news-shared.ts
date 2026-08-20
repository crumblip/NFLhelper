/**
 * Everything about news that a CLIENT component is allowed to import.
 *
 * This file exists for one structural reason and must keep it: **it imports
 * nothing.** Every page in this project is a server component reading SQLite
 * directly, so any module that reaches `lib/db/index` drags `better-sqlite3`
 * with it — and the moment a `'use client'` component imports such a module,
 * Next tries to bundle a native Node addon for the browser and the route dies
 * with `Can't resolve 'fs'`.
 *
 * `import type` is erased at compile time and is safe. A runtime value is not.
 * So the category labels, the status order and the small helpers the filters
 * need live here, away from the queries, and `lib/news.ts` re-exports them so
 * server code still has one place to look.
 *
 * If you add a constant that a filter chip or a badge needs, it goes here. If
 * you add one that a query needs, it does not.
 */

export type NewsCategory =
  | 'injury'
  | 'transaction'
  | 'role'
  | 'scheme'
  | 'analysis'
  | 'performance'
  | 'general';

/** Shown in the tab, in this order. `general` is deliberately absent. */
export const FANTASY_CATEGORIES: NewsCategory[] = [
  'injury',
  'role',
  'scheme',
  'transaction',
  'analysis',
  'performance',
];

export const CATEGORY_LABEL: Record<NewsCategory, string> = {
  injury: 'Injury',
  role: 'Role',
  scheme: 'How they will play',
  transaction: 'Roster move',
  analysis: 'Fantasy analysis',
  performance: 'On the field',
  general: 'Other',
};

export const CATEGORY_BLURB: Record<NewsCategory, string> = {
  injury: 'Hurt, sitting, or on a timeline back.',
  role: 'Who is starting, who is getting the touches.',
  scheme: 'A coach describing how the offence will be run.',
  transaction: 'Signed, traded, cut, suspended, activated.',
  analysis: 'Somebody else’s fantasy read: rankings, draft takes, sleepers.',
  performance: 'What he actually did in a game or a practice.',
  general: 'Nothing matched, so it is set aside rather than scored low.',
};

/**
 * Injury severity, most serious first.
 *
 * ESPN's own vocabulary, ordered rather than scored. "Active" is the one to
 * read correctly: it does not mean healthy, it means *listed with a knock and
 * expected to play*, and it is by far the largest group — 427 of 459 on the
 * pull this was built against. A page calling all of those "injuries" without
 * saying so would be overstating 93% of its own contents.
 */
export const STATUS_ORDER = [
  'Injured Reserve',
  'Out',
  'Doubtful',
  'Suspension',
  'Questionable',
  'Active',
];

export function statusRank(status: string): number {
  const i = STATUS_ORDER.indexOf(status);
  return i === -1 ? STATUS_ORDER.length : i;
}

/** The index at which a status stops meaning "he is probably playing". */
export const EXPECTED_TO_PLAY_FROM = STATUS_ORDER.indexOf('Active');

export const SOURCE_LABEL: Record<string, string> = {
  espn: 'ESPN',
  rotowire: 'RotoWire',
  yahoo: 'Yahoo Sports',
};

/** True for an item from the curated creator roster. */
export function isCreatorSource(source: string): boolean {
  return source.startsWith('creator:');
}

/**
 * The name to print for a source.
 *
 * Creator sources are stored as `creator:<slug>` so one prefix check tells the
 * pipeline which route an item took. The reader should never see that — the
 * slug is turned back into the creator's name by the caller, which passes the
 * roster in rather than importing it, keeping this file free of imports.
 */
export function sourceLabel(source: string, creatorNames: Record<string, string>): string {
  if (isCreatorSource(source)) {
    const slug = source.slice('creator:'.length);
    return creatorNames[slug] ?? slug;
  }
  return SOURCE_LABEL[source] ?? source;
}

/** Relative time in the words a reader uses, rather than a timestamp. */
export function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
