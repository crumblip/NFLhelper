import { connectedLeague, leagueTeams, rosterFor } from '../../lib/pipeline/ownership';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.SEASON ?? 2026);
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';

export const metadata = {
  title: 'League — NFLhelper',
  description: 'Connected Yahoo league: teams, managers and rosters',
};

/**
 * The connected league.
 *
 * This page exists to make ownership inspectable. The waiver wire now hides
 * players because somebody owns them, and a filter whose input cannot be seen is
 * a filter nobody can check — so every roster the wire is filtering against is
 * printed here, in full.
 */
export default function LeaguePage() {
  const league = connectedLeague(SEASON);

  if (!league) return <NotConnected />;

  const teams = leagueTeams(league.leagueKey);
  const rosters = new Map(teams.map((t) => [t.teamKey, rosterFor(t.teamKey)]));
  const totalRostered = [...rosters.values()].reduce((n, r) => n + r.length, 0);
  const drafted = league.draftStatus === 'postdraft';

  const slots = Object.entries(league.rosterPositions)
    .map(([k, v]) => `${v}×${k}`)
    .join(' · ');

  return (
    <main className="wrap">
      <h1>{league.name}</h1>
      <p className="sub">
        {league.season} · <strong>{league.numTeams}</strong> teams ·{' '}
        {league.scoringType ? <>scoring type {league.scoringType} · </> : null}
        draft <strong>{league.draftStatus ?? 'unknown'}</strong> ·{' '}
        <strong>{totalRostered}</strong> players held · last read{' '}
        {new Date(league.fetchedAt).toLocaleString()}
      </p>

      {slots ? <p className="sub">Roster slots: {slots}</p> : null}

      {!drafted ? (
        <div className="notice">
          <strong>This league has not drafted yet.</strong> Rosters are empty or partial, so
          ownership cannot answer who is available — it would report everyone as free, which is
          true and useless. Until the draft is done the wire keeps using national ADP to decide
          who is undrafted, and says so at the top of the page. Re-run{' '}
          <code>npm run ingest:yahoo</code> afterwards and it switches over on its own.
        </div>
      ) : null}

      {league.numTeams !== TEAMS ? (
        <div className="notice">
          <strong>Team count does not match.</strong> This league has {league.numTeams} teams and
          the board is built for {TEAMS} ({FORMAT}). Replacement level moves with team count, so
          VALUE is measuring a different league than this one until <code>LEAGUE_TEAMS</code> is
          changed to match — note that changing it invalidates the baseline curve and needs a{' '}
          <code>npm run refresh</code>.
        </div>
      ) : null}

      <div className="grid c3">
        {teams.map((t) => {
          const roster = rosters.get(t.teamKey) ?? [];
          return (
            <section key={t.teamKey} className="card" data-mine={t.isMine}>
              <header className="rosterhead">
                <h2>
                  {t.name}
                  {t.isMine ? <span className="chip mine">you</span> : null}
                </h2>
                <p className="muted">
                  {t.managerName ?? 'unknown manager'} · {roster.length} players
                  {t.faabBalance !== null ? ` · $${t.faabBalance} FAAB` : ''}
                  {t.waiverPriority !== null ? ` · waiver #${t.waiverPriority}` : ''}
                </p>
              </header>

              {roster.length === 0 ? (
                <p className="muted empty">No players — this team has not drafted.</p>
              ) : (
                <ul className="roster">
                  {roster.map((p) => (
                    <li key={p.yahooPlayerKey} data-bench={p.selectedPosition === 'BN'}>
                      <span className="slot">{p.selectedPosition ?? '—'}</span>
                      <span className="rname">
                        {p.playerId ? (
                          <a href={`/player/${p.playerId}`}>{p.name}</a>
                        ) : (
                          /* Unmatched to nflverse: shown plainly rather than linked,
                             so a name this tool cannot join on is visible as such. */
                          <span className="unmatched">{p.name}</span>
                        )}
                        {p.injuryStatus ? <em className="inj">{p.injuryStatus}</em> : null}
                      </span>
                      <span className="rpos muted">
                        {p.position}
                        {p.nflTeam ? ` · ${p.nflTeam}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}

function NotConnected() {
  return (
    <main className="wrap narrow">
      <h1>No league connected</h1>
      <p className="sub">
        The waiver wire is deciding who is available from national ADP. Connecting a Yahoo league
        replaces that guess with the actual rosters.
      </p>

      <div className="notice">
        <strong>Why it matters.</strong> Without a league, &ldquo;available&rdquo; means &ldquo;not
        drafted in the average national draft&rdquo;. That is wrong in both directions: a player
        drafted everywhere but cut in your league never appears, and a player nobody drafts
        nationally but someone stashed in August shows as free all season.
      </div>

      <section className="card">
        <h2>Connect it</h2>
        <ol className="steps">
          <li>
            Register an app at <code>developer.yahoo.com/apps/create/</code> with{' '}
            <strong>Fantasy Sports — Read</strong> permission. The redirect URI must be HTTPS;
            Yahoo rejects a bare <code>localhost</code>, but it does not have to work — the code
            you need appears in the address bar either way.
          </li>
          <li>
            Put the credentials in <code>.env.local</code>:
            <pre>
              {`YAHOO_CLIENT_ID=...
YAHOO_CLIENT_SECRET=...
YAHOO_REDIRECT_URI=https://localhost:3000/api/yahoo/callback`}
            </pre>
          </li>
          <li>
            Run <code>npm run yahoo:auth</code> once, approve in the browser, paste the{' '}
            <code>code</code> back. It lists your leagues and tells you which key to set.
          </li>
          <li>
            Run <code>npm run ingest:yahoo</code>. Re-run it whenever you want fresh rosters.
          </li>
        </ol>
      </section>
    </main>
  );
}
