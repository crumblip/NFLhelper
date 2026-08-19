'use client';

import { useMemo, useState } from 'react';
import type { WaiverRow, WaiverMeta } from '../../lib/waiver';
import { teamOf, teamStyle, positionColor } from '../../lib/teams';
import { Tip, TipHead } from '../ui/tip';
import PlayerHover from '../ui/player-hover';

const POSITIONS = ['RB', 'WR', 'TE'] as const;

type SortKey = 'grade' | 'vacated' | 'points' | 'name' | 'age' | 'depthRank' | 'games';

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;

/** Bars are read against a realistic ceiling, not 100% — nobody holds 100%. */
const BAR_MAX: Record<string, number> = { involvement: 0.35, rz: 0.3, vacated: 0.5 };

function Stat({ label, value, max, tone }: { label: string; value: number | null; max: number; tone?: string }) {
  return (
    <div>
      <div className="wcard-stat-label">{label}</div>
      <div className="wcard-stat-value">{pct(value)}</div>
      <div className={`meter ${tone ?? ''}`}>
        <i style={{ width: `${Math.min(100, ((value ?? 0) / max) * 100)}%` }} />
      </div>
    </div>
  );
}

function facts(r: WaiverRow) {
  const rows = [
    { label: 'Usage grade', value: `${r.grade} / 100` },
    { label: 'Fitted points', value: r.points.toFixed(0) },
    ...(r.upside
      ? [
          {
            label: 'If the job opens',
            value: `${r.upside.leadPoints.toFixed(0)} pts`,
            tone: 'pos' as const,
          },
          { label: 'Chance he leads', value: `${Math.round(r.upside.leadChance * 100)}%` },
        ]
      : []),
    { label: r.position === 'RB' ? 'Rush share' : 'Target share', value: pct(r.position === 'RB' ? r.rushShare : r.targetShare) },
    { label: 'Red-zone share', value: pct(r.rzShare) },
    { label: 'Volume vacated', value: pct(r.vacated) },
    { label: 'Depth chart', value: r.depthRank ? `${r.position}${r.depthRank}` : '—' },
    { label: 'Last season', value: `${r.games} games` },
  ];
  return {
    name: r.name,
    position: r.position,
    team: r.team,
    adp: null,
    bye: null,
    rows,
    note: r.opportunity,
    warn: r.notes.length ? r.notes.join(' · ') : null,
  };
}

/**
 * The whole card is the link, and it carries no prose.
 *
 * Hovering gives the summary including the opportunity and risk sentences;
 * clicking opens the full page. Nothing is lost, and every card in the grid is
 * the same height whether or not the player happens to have a note.
 */
function WaiverCard({ r }: { r: WaiverRow }) {
  const team = teamOf(r.team);
  const involvement = r.position === 'RB' ? r.rushShare : r.targetShare;

  return (
    <PlayerHover facts={facts(r)}>
      <a
        className="wcard"
        href={`/player/${r.playerId}`}
        /* Without this the link's name is the whole card — "TE Cade Otton TB ·
           TE1 · 27 89 GRADE TARGET 17%…" — which is unusable read aloud. */
        aria-label={`${r.name}, ${r.position}${r.depthRank ?? ''} ${teamOf(r.team).nick}, usage grade ${r.grade}`}
        style={{ ...teamStyle(r.team), ['--pos-color' as string]: positionColor(r.position) }}
      >
        <div className="wcard-top">
          <span className="pos-badge">{r.position}</span>
          <span className="wcard-id">
            <span className="wcard-name">{r.name}</span>
            <span className="wcard-meta">
              <span className="team-dot" aria-hidden />
              {team.abbr}
              {r.depthRank ? ` · ${r.position}${r.depthRank}` : ''}
              {r.age ? ` · ${r.age}` : ''}
              {r.opportunity && <i className="wcard-mark open" aria-hidden />}
              {r.notes.length > 0 && <i className="wcard-mark risk" aria-hidden />}
            </span>
          </span>
          <span className="wcard-grade">
            <b style={{ color: r.grade >= 60 ? 'var(--value)' : 'var(--text)' }}>{r.grade}</b>
            <span>grade</span>
          </span>
        </div>

        <div className="wcard-stats">
          <Stat
            label={r.position === 'RB' ? 'Rush' : 'Target'}
            value={involvement}
            max={BAR_MAX.involvement!}
          />
          <Stat label="Red zone" value={r.rzShare} max={BAR_MAX.rz!} />
          <Stat label="Vacated" value={r.vacated} max={BAR_MAX.vacated!} tone="pos" />
        </div>
      </a>
    </PlayerHover>
  );
}

function Tier({
  title,
  blurb,
  rows,
  empty,
}: {
  title: string;
  blurb: string;
  rows: WaiverRow[];
  empty: string;
}) {
  return (
    <section>
      <div className="tierhead">
        <h2>{title}</h2>
        <span className="count">{rows.length}</span>
        <p>{blurb}</p>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <strong>Nobody qualifies</strong>
          <p>{empty}</p>
        </div>
      ) : (
        <div className="grid c3">
          {rows.map((r) => (
            <WaiverCard key={r.playerId} r={r} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function WaiverBoard({ rows, meta }: { rows: WaiverRow[]; meta: WaiverMeta }) {
  const [positions, setPositions] = useState<Set<string>>(new Set(POSITIONS));
  const [query, setQuery] = useState('');
  const [showBelowFloor, setShowBelowFloor] = useState(false);
  const [sort, setSort] = useState<SortKey>('grade');
  const [desc, setDesc] = useState(true);

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        positions.has(r.position) &&
        (showBelowFloor || r.qualified) &&
        (q === '' || r.name.toLowerCase().includes(q) || (r.team ?? '').toLowerCase().includes(q)),
    );
  }, [rows, positions, query, showBelowFloor]);

  const sorted = useMemo(() => {
    return [...pool].sort((a, b) => {
      let cmp: number;
      if (sort === 'name') cmp = a.name.localeCompare(b.name);
      else cmp = ((a[sort] as number | null) ?? -Infinity) - ((b[sort] as number | null) ?? -Infinity);
      return desc ? -cmp : cmp;
    });
  }, [pool, sort, desc]);

  const toggle = (p: string) => {
    const next = new Set(positions);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setPositions(next);
  };

  const header = (key: SortKey, label: string, help?: string) => (
    <th
      data-sortable="true"
      data-sorted={sort === key}
      onClick={() => {
        if (sort === key) setDesc(!desc);
        else {
          setSort(key);
          setDesc(key !== 'name' && key !== 'depthRank' && key !== 'age');
        }
      }}
    >
      {help ? <TipHead label={label} help={help} /> : label}
      {sort === key ? (desc ? ' ↓' : ' ↑') : ''}
    </th>
  );

  const priority = pool.filter((r) => r.priority).sort((a, b) => b.vacated - a.vacated).slice(0, 9);
  const young = pool.filter((r) => r.youngPath && !r.priority).sort((a, b) => b.vacated - a.vacated).slice(0, 9);
  /*
   * Lottery tickets: the pickup that wins a league.
   *
   * Everyone on this page projects below replacement in their current role —
   * that is what being undrafted means — so ranking on the expectation alone
   * sorts by how buried a player is. This tier asks the other question instead:
   * what is he worth if the man ahead of him stops playing, and how likely is
   * that. Sorted on the two multiplied together.
   */
  const lottery = pool
    .filter((r) => r.upside && r.upside.expectedGain >= 10 && r.upside.leadChance >= 0.2)
    .sort((a, b) => b.upside!.expectedGain - a.upside!.expectedGain)
    .slice(0, 9);

  const shrinking = pool
    .filter((r) => r.roleShrinking)
    .sort((a, b) => (a.trajectory?.snapDelta ?? 0) - (b.trajectory?.snapDelta ?? 0))
    .slice(0, 9);
  const best = pool
    .filter((r) => !r.priority && !r.youngPath && !r.roleShrinking)
    .sort((a, b) => b.grade - a.grade)
    .slice(0, 9);

  return (
    <>
      <div className="controls">
        {POSITIONS.map((p) => (
          <button
            key={p}
            className="chip"
            data-pos
            data-on={positions.has(p)}
            style={{ ['--pos-color' as string]: positionColor(p) }}
            onClick={() => toggle(p)}
          >
            {p}
          </button>
        ))}
        <Tip
          content={
            <>
              Below the floor sits anyone under <strong>{meta.minInvolvement * 100}% involvement</strong> or
              under <strong>{meta.minGames} games</strong> last season. That is not a judgment that
              they are bad — it is that there is too little evidence to judge them at all. Blocking
              fullbacks and one-game samples both land here.
            </>
          }
        >
          <button className="chip" data-on={showBelowFloor} onClick={() => setShowBelowFloor(!showBelowFloor)}>
            {showBelowFloor ? 'including thin samples' : `${meta.belowFloor} thin samples hidden`}
          </button>
        </Tip>
        <span className="spacer" />
        <input
          className="search"
          type="search"
          placeholder="filter this list…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <Tier
        title="Priority adds"
        blurb={
          meta.live
            ? `A quarter or more of the work he competes for belongs to teammates who did not play in week ${meta.week}, and he is listed within his position's rotation to inherit it. His own snap share is not falling.`
            : 'Volume has left the roster, nobody arriving has claimed it, and he is listed within his position’s rotation to inherit it. This is the profile behind almost every pickup that mattered — the work opened up, not the player improved.'
        }
        rows={priority}
        empty={
          meta.live
            ? 'Nobody with a real role is sitting behind an absence this week. That is the normal state in a healthy week.'
            : 'No team has vacated a quarter of its work at a position where the next man up is already listed. That is normal in August, before injuries and depth-chart churn create openings.'
        }
      />

      <Tier
        title="One injury away"
        blurb="What he is worth if the man ahead of him stops playing, multiplied by the chance that happens. Vulnerability comes from the blocker's durability — a player who missed four or more games misses again 73% of the time — plus age past the position curve and weak play. These are the picks whose average is a bad description of them: irrelevant most weeks, a starter the moment the job opens."
        rows={lottery}
        empty="Nobody undrafted is sitting close enough behind a vulnerable starter to be worth the roster spot."
      />

      <Tier
        title="Young with a path"
        blurb="Under 25, listed within his position’s rotation, and some volume open ahead of him. Less immediate than a priority add, but this is where a mid-season breakout comes from."
        rows={young}
        empty="Nobody under 25 is both listed in the rotation and looking at open volume right now."
      />

      {meta.live && (
        <Tier
          title="Role shrinking — drop candidates"
          blurb="His snap share over the last three games sits 15 points or more below his own season average. Measured against 2018–2025, that group scores 1.23 fewer points per game for the rest of the season. This is the one direction of travel that predicts, which is why there is no matching tier for players trending up."
          rows={shrinking}
          empty="Nobody with a real role is losing snaps sharply right now."
        />
      )}

      <Tier
        title="Best available by role"
        blurb={
          meta.live
            ? 'Highest usage grade regardless of opportunity — the biggest roles among players nobody rosters.'
            : 'Highest usage grade regardless of opportunity — players who were already doing real work last season and still go undrafted.'
        }
        rows={best}
        empty="No players clear the evidence floor with the current filters."
      />

      <h2 style={{ marginTop: 'var(--s7)' }}>Everyone available — {sorted.length} players</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {header('name', 'Player')}
              <th className="l">Team</th>
              {header('depthRank', 'Depth', 'Where he is listed on his own position’s depth chart. A kick-return listing is ignored — taking the best rank across all listings once reported Dylan Sampson as a returner rather than the RB2 he is.')}
              {header('age', 'Age')}
              {header('games', 'G')}
              {header('points', 'Proj', 'Fitted points from the usage model. It regresses hard toward the positional mean, so read the grade rather than setting this against a market number.')}
              {header('grade', 'Grade', 'Where his role ranks against his position, 0–100. Built from target share, route share, red-zone share and goal-line share.')}
              {header('vacated', 'Vacated', 'Share of the volume he competes for that left the roster and has not been claimed by an arriving player. Carries for backs, targets for receivers.')}
              <th className="l">Why he is here</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const team = teamOf(r.team);
              return (
                <tr key={r.playerId} style={{ ...teamStyle(r.team), ['--pos-color' as string]: positionColor(r.position) }}>
                  <td className="l stripe">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span className="pos-badge">{r.position}</span>
                      <PlayerHover facts={facts(r)}>
                        <a className="name" href={`/player/${r.playerId}`}>{r.name}</a>
                      </PlayerHover>
                      {!r.qualified && (
                        <Tip content="Too little evidence to judge — under the involvement or games floor.">
                          <span className="flag">thin</span>
                        </Tip>
                      )}
                    </span>
                  </td>
                  <td className="l">
                    <span className="team-badge">
                      <span className="team-dot" aria-hidden />
                      {team.abbr}
                    </span>
                  </td>
                  <td>{r.depthRank ? `${r.position}${r.depthRank}` : '—'}</td>
                  <td className="muted">{r.age ?? '—'}</td>
                  <td className="muted">{r.games}</td>
                  <td>{r.points.toFixed(0)}</td>
                  <td>
                    <span className={`gap ${r.grade >= 55 ? 'pos' : 'na'}`}>{r.grade}</span>
                  </td>
                  <td>
                    <span className={`gap ${r.vacated >= 0.2 ? 'pos' : 'na'}`}>{pct(r.vacated)}</span>
                  </td>
                  <td className="l readcell">
                    {/* Available, but not a free add — a claim that resolves on a date. */}
                    {r.onWaiversUntil !== null && (
                      <span className="tag k-risk">
                        waivers{r.onWaiversUntil ? ` until ${r.onWaiversUntil}` : ''}
                      </span>
                    )}
                    {r.priority && <span className="tag k-opportunity">priority add</span>}
                    {r.youngPath && <span className="tag k-role">young, path open</span>}
                    {r.roleShrinking && <span className="tag k-risk">role shrinking</span>}
                    {r.upside && r.upside.expectedGain >= 10 && r.upside.leadChance >= 0.2 && (
                      <Tip
                        content={
                          <>
                            Leads the position group in <strong>{Math.round(r.upside.leadChance * 100)}%</strong> of
                            outcomes, worth <strong>{r.upside.leadPoints.toFixed(0)} points</strong> there against{' '}
                            {r.upside.basePoints.toFixed(0)} today. Directly behind {r.upside.blockerName}.
                            Across every branch weighted by probability he averages{' '}
                            {r.upside.expectedPoints.toFixed(0)}.
                          </>
                        }
                      >
                        <span className="tag k-opportunity" tabIndex={0}>one injury away</span>
                      </Tip>
                    )}
                    {r.grade >= 70 && <span className="tag k-role">real role already</span>}
                    {r.notes
                      .filter((n) => !n.startsWith('role shrinking'))
                      .map((n) => (
                        <span className="tag k-risk" key={n}>
                          {n.split(' — ')[0]}
                        </span>
                      ))}
                    {!r.priority && !r.youngPath && !r.roleShrinking && r.grade < 70 &&
                      r.notes.length === 0 && <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="legend">
        Everyone here is <strong>undrafted in a {12}-team half-PPR league</strong> and had a
        measurable role last season. <code>Vacated</code> is the share of the work he competes for
        that left the roster, net of what arriving players have already claimed — a team that lost
        its lead back and signed another one has nothing available.{' '}
        <code>Grade</code> is his role last season ranked against his position. Neither is a
        projection you should set against a sportsbook line; off the board there is no price, so the
        question is whether a role is opening, not whether he is cheap.
      </p>
    </>
  );
}
