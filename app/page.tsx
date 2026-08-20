import { getBoard, getMeta } from '../lib/board';
import { getWaiverBoard } from '../lib/waiver';
import BoardTable from './board-table';

export const dynamic = 'force-dynamic';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const SEASON = Number(process.env.SEASON ?? 2026);

export default function Page() {
  const rows = getBoard(FORMAT, TEAMS, SEASON);
  const meta = getMeta(FORMAT, TEAMS, SEASON);
  const wire = getWaiverBoard(FORMAT, TEAMS, SEASON);

  const propsAge = meta.propsFetchedAt
    ? `${Math.round((Date.now() - meta.propsFetchedAt) / 3_600_000)}h`
    : null;

  const priority = wire.rows.filter((r) => r.priority).length;
  const coveredPct = Math.round((meta.ranked / Math.max(1, rows.length)) * 100);

  return (
    <main className="wrap">
      {/*
        The hero states what the board IS in one line and what it is made of in
        four numbers. The old page opened with a run-on subtitle carrying six
        facts in a row, which is a paragraph pretending to be a header, nothing
        in it was findable at a glance.
      */}
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Draft board</span>
          <h1>
            {meta.season} <span className="hero-accent">half-PPR</span> rankings
          </h1>
          <p className="hero-sub">
            Built from sportsbook lines and on-field usage, priced against what each draft slot has
            actually returned. No expert rankings anywhere in it.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="/waiver">
              Waiver wire
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </a>
            <a className="btn btn-ghost" href="/legend">
              What every column means
            </a>
          </div>
        </div>
        <dl className="hero-stats">
          <div className="hero-stat">
            <dt>Players</dt>
            <dd>{rows.length}</dd>
            <span>{meta.teams}-team league</span>
          </div>
          <div className="hero-stat">
            <dt>Market coverage</dt>
            <dd>{coveredPct}%</dd>
            <span>{meta.none} with no lines</span>
          </div>
          <div className="hero-stat">
            <dt>On the wire</dt>
            <dd>{wire.meta.qualified}</dd>
            <span>{priority} near open volume</span>
          </div>
          <div className="hero-stat">
            <dt>Props updated</dt>
            <dd>{propsAge ?? '—'}</dd>
            <span>{propsAge ? 'ago' : 'never fetched'}</span>
          </div>
        </dl>
      </section>

      <div className="note-grid">
        <div className="note">
          <span className="note-tag">How to read it</span>
          <p>
            Every number traces to a sportsbook line or to what draft picks have historically
            returned. Two limits worth knowing: only about {coveredPct}% of these players have
            season-long props, and the quarterback numbers are the shakiest here, because books
            only price players they expect to start.
          </p>
        </div>
        <div className="note">
          <span className="note-tag">Not on this board</span>
          <p>
            {/*
              This used to say those players were "listed to inherit work that
              has already left their team". Measured across more than a thousand
              cases, the next man up gains nothing on average, teams sign and
              draft replacements rather than promoting.
            */}
            <strong>{wire.meta.qualified}</strong> undrafted players held a real role last season,
            and {priority} are on teams that lost a chunk of their offence. Nobody is owed that
            work, but they are closest to it. <a href="/waiver">Open the wire →</a>
          </p>
        </div>
      </div>

      <BoardTable rows={rows} />
    </main>
  );
}
