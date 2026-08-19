import {
  getLeagueNews,
  getNewsMeta,
  getTeamNews,
  getTeamsWithNews,
} from '../../lib/news';
import NewsFeed from './news-feed';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.SEASON ?? 2026);

export const metadata = {
  title: 'News — NFLhelper',
  description: 'Fantasy-relevant news by team and position',
};

/**
 * The news tab.
 *
 * Organised by team, because that is how the news is read — a manager holding
 * four Bengals wants Cincinnati, not a national wire. Position filters live
 * inside a team rather than beside it, and anything about the team itself with
 * no player attached gets its own bucket instead of being pinned onto whichever
 * back happens to be listed first.
 */
export default async function NewsPage({
  searchParams,
}: {
  // Next 15 hands search params in as a promise.
  searchParams: Promise<{ team?: string; pos?: string; cat?: string }>;
}) {
  const params = await searchParams;
  const meta = getNewsMeta();
  const teams = getTeamsWithNews();

  const selected = params.team?.toUpperCase();
  const teamNews = selected ? getTeamNews(selected) : null;
  const league = selected ? [] : getLeagueNews();

  return (
    <main className="wrap">
      <h1>News</h1>
      <p className="sub">
        Fantasy-relevant news by team ·{' '}
        <strong>{meta.relevant}</strong> items across{' '}
        <strong>{meta.teamsCovered}</strong> teams ·{' '}
        {meta.sources.map((s) => `${s.source} ${s.n}`).join(' · ')}
      </p>

      {meta.stored === 0 ? (
        <div className="notice">
          <strong>Nothing stored yet.</strong> Run <code>npm run ingest:news</code> to pull the
          feeds. Every source is free and unmetered, so it is safe to run often — and it needs to
          be, for the reason in the next paragraph.
        </div>
      ) : null}

      {/*
        What this tab is and is not, said before anything else on it.

        Two claims a reader would otherwise have to infer: that the archive is
        only as old as the polling, and that items are filed by rule rather than
        scored. Both are the kind of thing that reads as a measurement unless
        stated (family #6).
      */}
      <div className="notice">
        <strong>This is an archive, and it is only as old as the polling.</strong> RotoWire — much
        the best fantasy source here — publishes just <strong>5 items</strong> at a time, a rolling
        window of about two hours, and nothing backfills it. So the history on this page is what
        has been collected since the ingest first ran, not everything that has ever happened. Run{' '}
        <code>npm run news</code> on a schedule and it fills in; the span currently held is shown
        at the bottom of the page.
      </div>

      <div className="notice">
        <strong>Items are filed by rule, not scored.</strong> Each one is placed in the first
        category whose wording it matches, and the phrase that decided it is kept and shown on the
        chip. Anything no rule matched is set aside rather than given a low score —{' '}
        <strong>{meta.setAside}</strong> of {meta.stored} items are being held back that way, and
        they are mostly expansion talk, obituaries and training-camp scuffles. A number would imply
        a measurement nobody made.
      </div>

      <NewsFeed
        teams={teams}
        selected={selected ?? null}
        teamNews={teamNews}
        league={league}
        meta={meta}
        season={SEASON}
      />
    </main>
  );
}
