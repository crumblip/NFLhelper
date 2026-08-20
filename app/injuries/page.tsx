import { getInjuries, getInjuryMeta } from '../../lib/news';
import InjuryBoard from './injury-board';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.SEASON ?? 2026);

export const metadata = {
  title: 'Injuries · ChipShip',
  description: 'The injury report by team, for the players who matter in fantasy',
};

/**
 * The injury report, by team.
 *
 * The feed behind it is ESPN's, which is much the richest available for free:
 * besides a status it carries the beat report and a written fantasy read that
 * routinely names who stands to gain from the absence. That paragraph is why
 * this is a tab rather than a column on the board.
 */
export default function InjuriesPage() {
  const rows = getInjuries(SEASON);
  const meta = getInjuryMeta(SEASON);

  return (
    <main className="wrap">
      <h1>Injury report</h1>
      <p className="sub">
        <strong>{meta.total}</strong> players listed across <strong>{meta.teams}</strong> teams ·{' '}
        <strong>{meta.drafted}</strong> are being drafted somewhere ·{' '}
        <strong>{meta.withAnalysis}</strong> carry a written fantasy read
      </p>

      {meta.total === 0 ? (
        <div className="notice">
          <strong>Nothing stored yet.</strong> Run <code>npm run ingest:injuries</code>. It is one
          free request and takes about a second.
        </div>
      ) : null}

      {/*
        The single most misreadable thing on this page, said first.

        ESPN lists a player as "Active" when he is carrying a knock and still
        expected to play, and that is the overwhelming majority of the report —
        427 of 459 on the pull this was built against. A page that called all of
        them "injuries" without saying so would be overstating 93% of its own
        contents, which is exactly the shape of family #6.
      */}
      <div className="notice">
        <strong>Most of this report is not bad news.</strong> ESPN lists a player as{' '}
        <strong>Active</strong> when he is carrying something and is still expected to play, and
        that is most of the list. The rows worth acting on are the ones above it,{' '}
        <strong>Injured Reserve</strong>, <strong>Out</strong>, <strong>Doubtful</strong>,{' '}
        <strong>Questionable</strong>, and they sort to the top of every team. The status is
        ESPN&apos;s own word, kept as written rather than turned into a severity number:
        &ldquo;questionable&rdquo; in August and &ldquo;questionable&rdquo; on a Sunday morning are
        different claims, and one scale cannot hold both.
      </div>

      <div className="notice">
        <strong>Only the four fantasy positions are here.</strong> The feed lists all 800-odd
        injuries in the league; this shows the ~460 at quarterback, running back, receiver and
        tight end. A player nobody drafts still appears, because he is often the reason the man
        ahead of him is worth adding.
      </div>

      <InjuryBoard rows={rows} meta={meta} />
    </main>
  );
}
