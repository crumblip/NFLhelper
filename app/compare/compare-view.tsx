'use client';

import { useMemo, useState } from 'react';
import type { Comparison, CompareRow, GroupScore } from '../../lib/compare';
import type { SearchEntry } from '../../lib/search';
import { teamOf, teamStyle, positionColor } from '../../lib/teams';
import ToppsCard from '../ui/topps-card';
import { Tip } from '../ui/tip';

/**
 * The head to head view.
 *
 * The layout is a triptych: a card either side, the verdict down the middle.
 * That shape is doing an argument rather than decoration — the two players are
 * given exactly equal weight and equal width, and the only thing between them
 * is the evidence. A verdict banner across the top with the players beneath it
 * would put the conclusion before the case, which is the opposite of how this
 * project asks to be read.
 *
 * The metric bar is ONE shared track filled from the centre toward whoever
 * leads, not two bars side by side. Two bars make a 4-point edge and a 60-point
 * edge look alike; a centred difference bar cannot. Same argument as VALUE
 * being a magnitude bar rather than a pill (#106).
 *
 * A level row is drawn level and grey. On a mid-round comparison that is the
 * commonest outcome and the design shows it rather than dressing it as a win.
 */

/*
 * The section wording changes with the question being asked. In August the
 * value block is about a price; in week 8 it is about what he has scored, and
 * calling that "what he is worth" would describe the wrong thing.
 */
const GROUPS = (mode: 'draft' | 'live'): Array<{ id: CompareRow['group']; title: string; blurb: string }> => [
  mode === 'live'
    ? { id: 'value', title: 'What he has produced', blurb: 'Half-PPR scoring so far this season.' }
    : { id: 'value', title: 'What he is worth', blurb: 'Price, value over replacement, and how often he starts.' },
  mode === 'live'
    ? { id: 'role', title: 'The role he is holding', blurb: 'Usage this season, week by week rather than last year.' }
    : { id: 'role', title: 'The size of his role', blurb: 'How much work he gets, ranked against his own position.' },
  { id: 'efficiency', title: 'What he does with it', blurb: 'Per-opportunity metrics, each carrying its measured weight.' },
  mode === 'live'
    ? { id: 'risk', title: 'What could go wrong', blurb: 'Recent form, snap trend and availability.' }
    : { id: 'risk', title: 'What could go wrong', blurb: 'Availability and age.' },
];

function Picker({
  label, index, value, onPick, exclude,
}: {
  label: string;
  index: SearchEntry[];
  value: string | null;
  onPick: (id: string) => void;
  exclude: string | null;
}) {
  const [q, setQ] = useState('');
  const current = index.find((e) => e.playerId === value) ?? null;

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return index.filter((e) => e.playerId !== exclude && e.haystack.includes(t)).slice(0, 8);
  }, [q, index, exclude]);

  return (
    <div className="cmp-picker">
      <div className="cmp-picker-label">{label}</div>
      {current ? (
        <div className="cmp-chosen" style={teamStyle(current.team)}>
          <span className="pos-badge" style={{ ['--pos-color' as string]: positionColor(current.position) }}>
            {current.position}
          </span>
          <span className="cmp-chosen-name">{current.name}</span>
          <button type="button" onClick={() => { onPick(''); setQ(''); }} aria-label={`Clear ${label}`}>×</button>
        </div>
      ) : (
        <div className="cmp-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any player…" aria-label={label} />
          {hits.length > 0 && (
            <ul className="cmp-hits">
              {hits.map((h) => (
                <li key={h.playerId}>
                  <button type="button" onClick={() => { onPick(h.playerId); setQ(''); }}>
                    <span className="pos-badge" style={{ ['--pos-color' as string]: positionColor(h.position) }}>
                      {h.position}
                    </span>
                    {h.name}
                    <span className="cmp-hit-meta">
                      {teamOf(h.team).abbr}{h.adp ? ` · ${Math.round(h.adp)}` : ' · UDFA'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The per-row win marker. A chevron pointing at whoever took the row. */
function Marker({ side, leader }: { side: 'a' | 'b'; leader: 'a' | 'b' | null }) {
  const won = leader === side;
  return (
    <span className="cmp-mark" data-won={won} aria-hidden>
      {won ? (side === 'a' ? '◀' : '▶') : ''}
    </span>
  );
}

function Row({ r, aName, bName }: { r: CompareRow; aName: string; bName: string }) {
  const both = r.aPct !== null && r.bPct !== null;
  const gap = both ? (r.aPct ?? 0) - (r.bPct ?? 0) : 0;
  const width = Math.min(50, Math.abs(gap) / 2);

  return (
    <Tip
      content={
        <>
          <strong>{r.label}</strong>
          <br />
          {r.detail}
          <br />
          {both ? (
            <em>
              {aName} {r.aPct}th percentile, {bName} {r.bPct}th.{' '}
              {r.leader === null
                ? 'Inside the noise, so this is level.'
                : `A ${Math.abs(gap)}-point gap.`}
            </em>
          ) : (
            <em>One of them has no reading here.</em>
          )}
          <br />
          {r.weight !== null ? (
            <em>Measured weight {r.weight.toFixed(2)} against next season, so it votes.</em>
          ) : (
            <em>No measured weight, so it is context and does not vote.</em>
          )}
        </>
      }
    >
      <div className="cmp-row" data-leader={r.leader ?? 'level'} tabIndex={0}>
        <Marker side="a" leader={r.leader} />
        <span className="cmp-val" data-win={r.leader === 'a'}>{r.aDisplay}</span>
        <span className="cmp-track">
          <i
            className="cmp-fill"
            data-side={r.leader ?? 'level'}
            style={{ left: gap >= 0 ? `${50 - width}%` : '50%', width: `${Math.max(width, both ? 1.5 : 0)}%` }}
          />
          <i className="cmp-mid" aria-hidden />
        </span>
        <span className="cmp-val cmp-val-b" data-win={r.leader === 'b'}>{r.bDisplay}</span>
        <Marker side="b" leader={r.leader} />
        <span className="cmp-label">
          {r.label}
          {/* No `title=` here or anywhere: the ban is real and the audit
              caught this exact line (#101). The weight is explained by the
              row's own Tip. */}
          {r.weight !== null && <b>{r.weight.toFixed(2)}</b>}
        </span>
      </div>
    </Tip>
  );
}

/** The section header, carrying who took the section. */
function GroupHead({
  title, blurb, score, aName, bName,
}: {
  title: string; blurb: string; score: GroupScore | undefined; aName: string; bName: string;
}) {
  return (
    <div className="cmp-grouphead">
      <h2>{title}</h2>
      <span className="cmp-grouphead-blurb">{blurb}</span>
      {score && score.a + score.b + score.level > 0 && (
        <Tip
          content={
            score.winner === null
              ? 'Split, so this block does not favour either of them.'
              : `${score.winner === 'a' ? aName : bName} takes more rows in this block. Rows without a measured weight are shown but do not vote on the overall lean.`
          }
        >
          <span className="cmp-groupscore" data-winner={score.winner ?? 'none'} tabIndex={0}>
            <b data-win={score.winner === 'a'}>{score.a}</b>
            <em>{score.level ? `${score.level} level` : 'split'}</em>
            <b data-win={score.winner === 'b'}>{score.b}</b>
          </span>
        </Tip>
      )}
    </div>
  );
}

export default function CompareView({
  index, comparison, aId, bId,
}: {
  index: SearchEntry[];
  comparison: Comparison | null;
  aId: string | null;
  bId: string | null;
}) {
  const go = (a: string | null, b: string | null) => {
    const p = new URLSearchParams();
    if (a) p.set('a', a);
    if (b) p.set('b', b);
    window.location.href = `/compare${p.toString() ? `?${p}` : ''}`;
  };

  const c = comparison;

  return (
    <>
      <div className="cmp-pickers">
        <Picker label="Player A" index={index} value={aId} exclude={bId} onPick={(id) => go(id || null, bId)} />
        <span className="cmp-versus" aria-hidden>vs</span>
        <Picker label="Player B" index={index} value={bId} exclude={aId} onPick={(id) => go(aId, id || null)} />
      </div>

      {!c ? (
        <div className="notice">
          <strong>Pick two players.</strong> Anyone in the search works, drafted or not, and they
          do not have to play the same position. Crossing positions is the harder question and
          the one this page exists for.
        </div>
      ) : (
        <>
          {/* The triptych: a card each side, the evidence between them. Equal
              width on purpose, so the layout itself takes no side. */}
          <div className="cmp-stage">
            <div className="cmp-side" style={teamStyle(c.a.team)}>
              <ToppsCard
                name={c.a.name} position={c.a.position} team={c.a.team}
                bye={c.a.card.bye} adp={c.a.adp} espnId={c.a.card.espnId}
                badge={c.a.card.badge} columns={c.a.card.columns} seasons={c.a.card.seasons}
                blurb={c.a.card.blurb} rookieSeason={c.a.card.rookieSeason} status={c.a.card.status}
              />
              <div className="cmp-sidefoot">
                {c.a.verdict && <p className="cmp-sideverdict">{c.a.verdict}</p>}
                {c.a.confidence && (
                  <span className="cmp-conf" data-level={c.a.confidence}>{c.a.confidence} confidence</span>
                )}
                <a className="cmp-sidelink" href={`/player/${c.a.playerId}`}>Full page →</a>
              </div>
            </div>

            <div className="cmp-middle">
              <div className="cmp-verdict" data-lean={c.verdict.lean}>
                <span className="cmp-verdict-kicker">
                  {c.mode === 'live' ? `Through week ${c.week}` : 'Draft read'}
                </span>
                <h2>{c.verdict.headline}</h2>

                {/* The scoreboard. Rows taken, not a score out of a hundred:
                    inventing a percentage here would be the bias the brief
                    asked to avoid. */}
                <div className="cmp-scoreboard">
                  <span className="cmp-score" data-win={c.verdict.lean === 'a'}>
                    <b>{c.aWins}</b>
                    <em>{c.a.name.split(' ').slice(-1)[0]}</em>
                  </span>
                  <span className="cmp-score cmp-score-level">
                    <b>{c.level}</b>
                    <em>level</em>
                  </span>
                  <span className="cmp-score" data-win={c.verdict.lean === 'b'}>
                    <b>{c.bWins}</b>
                    <em>{c.b.name.split(' ').slice(-1)[0]}</em>
                  </span>
                </div>

                <p>{c.verdict.why}</p>
                <p className="cmp-band">{c.verdict.bandNote}</p>
              </div>

              {c.mode === 'live' ? (
                <p className="cmp-modenote">
                  <strong>This is the in-season read.</strong> Everything below is what they have
                  actually done through week {c.week}, not a preseason projection, so it answers
                  a waiver claim or a start/sit call rather than a draft pick.{' '}
                  <strong>Season to date leads and recent form does not vote</strong>, which is
                  measured rather than stylistic: over 22,405 samples a last-3 window predicts the
                  rest of the season worse than the season to date at every position. The last-3
                  row is shown because you will want to see it, and it is deliberately given no
                  weight.
                </p>
              ) : (
                <p className="cmp-modenote">
                  <strong>This is the draft read.</strong> No games have been played yet, so the
                  rows are a price, a projection and last season&apos;s role. Once week 1 is in
                  the data this page switches itself over to what they are actually doing.
                </p>
              )}

              {!c.samePosition && (
                <p className="cmp-crosspos">
                  <strong>{c.a.position} against {c.b.position}</strong>, so every row is a rank
                  within each man&apos;s own position. That is the only comparison that means
                  anything across them. Backs lead <em>cost of waiting</em> more often than
                  receivers because their drop-off is steeper, which is a property of the
                  position and not a thumb on the scale.
                </p>
              )}
            </div>

            <div className="cmp-side cmp-side-b" style={teamStyle(c.b.team)}>
              <ToppsCard
                name={c.b.name} position={c.b.position} team={c.b.team}
                bye={c.b.card.bye} adp={c.b.adp} espnId={c.b.card.espnId}
                badge={c.b.card.badge} columns={c.b.card.columns} seasons={c.b.card.seasons}
                blurb={c.b.card.blurb} rookieSeason={c.b.card.rookieSeason} status={c.b.card.status}
              />
              <div className="cmp-sidefoot">
                {c.b.verdict && <p className="cmp-sideverdict">{c.b.verdict}</p>}
                {c.b.confidence && (
                  <span className="cmp-conf" data-level={c.b.confidence}>{c.b.confidence} confidence</span>
                )}
                <a className="cmp-sidelink" href={`/player/${c.b.playerId}`}>Full page →</a>
              </div>
            </div>
          </div>

          {GROUPS(c.mode).map((g) => {
            const rows = c.rows.filter((r) => r.group === g.id);
            if (!rows.length) return null;
            return (
              <section key={g.id} className="cmp-group">
                <GroupHead
                  title={g.title}
                  blurb={g.blurb}
                  score={c.groups.find((s) => s.group === g.id)}
                  aName={c.a.name}
                  bName={c.b.name}
                />
                <div className="cmp-rows">
                  {rows.map((r) => (
                    <Row key={r.id} r={r} aName={c.a.name} bName={c.b.name} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
