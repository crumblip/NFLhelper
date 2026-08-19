import { getWaiverBoard } from '../../lib/waiver';
import WaiverBoard from './waiver-board';

export const dynamic = 'force-dynamic';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const SEASON = Number(process.env.SEASON ?? 2026);

export const metadata = {
  title: 'Waiver wire — NFLhelper',
  description: 'Undrafted players with a role or a path to one',
};

export default function WaiverPage() {
  const { rows, meta } = getWaiverBoard(FORMAT, TEAMS, SEASON);

  return (
    <main className="wrap">
      <h1>Waiver wire — {meta.season}</h1>
      <p className="sub">
        {FORMAT} · {TEAMS}-team ·{' '}
        {meta.live ? (
          <>
            <strong>week {meta.week}</strong>, live
          </>
        ) : (
          'preseason'
        )}{' '}
        · <strong>{meta.total}</strong> available players with a measured role ·{' '}
        <strong>{meta.qualified}</strong> clear the evidence floor
      </p>

      {/*
        Which question this page is answering, stated before anything else on it.
        "Available" from a connected league and "available" from national ADP are
        different claims, and only one of them is about this league — leaving the
        reader to work out which is the fallback-as-measurement failure, family #6.
      */}
      {meta.availabilitySource === 'yahoo' ? (
        <div className="notice">
          <strong>Availability is live from {meta.leagueName ?? 'your Yahoo league'}.</strong> These
          are the players nobody in your league holds — <strong>{meta.rosteredCount}</strong> are
          rostered and excluded, whatever the national market thinks of them.{' '}
          {meta.onWaivers > 0 ? (
            <>
              {meta.onWaivers} of them must be <strong>claimed on waivers</strong> rather than
              simply added, and are marked below.{' '}
            </>
          ) : null}
          {meta.unresolvedOwnership > 0 ? (
            <>
              {meta.unresolvedOwnership} rostered{' '}
              {meta.unresolvedOwnership === 1 ? 'player' : 'players'} could not be matched to this
              tool&apos;s player index — still excluded, by name rather than by id.
            </>
          ) : null}
        </div>
      ) : (
        <div className="notice">
          <strong>Availability is a national estimate, not your league.</strong> No drafted Yahoo
          league is connected, so &ldquo;available&rdquo; here means &ldquo;not taken in the average
          national draft&rdquo;. That is wrong in both directions for any real league — a player
          drafted everywhere but cut in yours never appears, and a player nobody drafts nationally
          but somebody stashed shows as free all season. Connect your league on the{' '}
          <a href="/league">League</a> page to replace the estimate with the actual rosters.
        </div>
      )}

      <div className="notice">
        <strong>A different question from the draft board.</strong> On the board every player has a
        price, so the question is whether he is worth it. Off the board there is no price, so the
        question becomes whether a role is opening up for him. That is why these are sorted by
        available volume ahead of anything else — the profile behind almost every pickup that
        mattered is a backup on a team whose work has moved, not a player who suddenly improved.
      </div>

      <div className="notice" style={{ marginTop: 'calc(-1 * var(--s3))' }}>
        {meta.live ? (
          <>
            <strong>Reading week {meta.week}.</strong> The usage behind every grade is{' '}
            <strong>{Math.round(meta.currentSeasonWeight * 100)}% this season</strong>, the rest last
            season — current-year usage overtakes the prior year after two games, so it takes over
            fast. Opportunity has switched too: it now measures the share of each team&apos;s work
            held by players who <strong>did not play last week</strong>, rather than who left in the
            offseason. A player whose own snap share is falling is flagged and cannot be a priority
            add.
          </>
        ) : (
          <>
            <strong>Preseason.</strong> Grades come from {meta.usageSeason} usage and opportunity
            from offseason departures net of arrivals. Once games are played this page switches
            automatically: usage follows the season being played, and opportunity becomes the work
            held by players who sat out the most recent week. Nothing needs re-running except the
            weekly ingest.
          </>
        )}
      </div>

      <WaiverBoard rows={rows} meta={meta} />
    </main>
  );
}
