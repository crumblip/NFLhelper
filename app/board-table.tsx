'use client';

import { useMemo, useState } from 'react';
import type { BoardRow } from '../lib/board';
import { teamOf, teamStyle, positionColor } from '../lib/teams';
import { Tip, TipHead } from './ui/tip';
import PlayerHover from './ui/player-hover';

type SortKey =
  | 'adp' | 'slotGap' | 'impliedPoints' | 'adpEquivalent' | 'name' | 'position'
  | 'usageGrade' | 'usageGap' | 'blendedSlotGap' | 'blendedVorp' | 'vona' | 'startableRate'
  | 'outlookPctile';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

const fmt = (v: number | null, digits = 0) =>
  v === null || Number.isNaN(v) ? '—' : v.toFixed(digits);

const signed = (v: number, digits = 1) => (v > 0 ? '+' : '') + v.toFixed(digits);

/** The two verdict tags lead the read; everything else is an attribute. */
const isVerdict = (id: string) => id === 'gem' || id === 'bust';

function facts(r: BoardRow) {
  const rows: Array<{ label: string; value: string; tone?: 'pos' | 'neg' }> = [];
  if (r.blendedVorp !== null) {
    rows.push({
      label: 'Value over replacement',
      value: signed(r.blendedVorp, 0),
      tone: r.blendedVorp > 0 ? 'pos' : 'neg',
    });
  }
  if (r.blendedSlotGap !== null) {
    rows.push({
      label: 'Gap vs ADP',
      value: `${signed(r.blendedSlotGap)} picks`,
      tone: r.blendedSlotGap > 0 ? 'pos' : 'neg',
    });
  }
  if (r.impliedPoints !== null) rows.push({ label: 'Implied points', value: fmt(r.impliedPoints) });
  if (r.usageGrade !== null) rows.push({ label: 'Usage grade', value: `${r.usageGrade} / 100` });
  if (r.usageGap !== null) {
    rows.push({
      label: 'Usage vs market',
      value: signed(r.usageGap, 0),
      tone: r.usageGap > 0 ? 'pos' : 'neg',
    });
  }
  if (r.expectedGames !== null) {
    rows.push({ label: 'Expected games', value: r.expectedGames.toFixed(1) });
  }
  rows.push({
    label: 'Market coverage',
    value:
      r.signal === 'none'
        ? 'no props'
        : r.signal === 'partial'
          ? `${Math.round(r.completeness * 100)}% covered`
          : `${r.marketStats} lines`,
  });
  return {
    name: r.name,
    position: r.position,
    team: r.team,
    adp: r.adp,
    bye: r.bye,
    rows,
    note: r.verdict ?? r.riskNotes,
  };
}

export default function BoardTable({ rows }: { rows: BoardRow[] }) {
  const [positions, setPositions] = useState<Set<string>>(new Set(POSITIONS));
  const [showUnranked, setShowUnranked] = useState(true);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<'proven' | 'unproven' | null>(null);
  const [sort, setSort] = useState<SortKey>('blendedVorp');
  const [desc, setDesc] = useState(true);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        positions.has(r.position) &&
        (showUnranked || r.signal === 'full') &&
        // Name or team, case-insensitive, so "chase" and "CIN" both work.
        (q === '' ||
          r.name.toLowerCase().includes(q) ||
          (r.team ?? '').toLowerCase().includes(q)) &&
        // Clicking a tag filters the board to players carrying it.
        (activeTag === null || r.tags.some((t) => t.id === activeTag)) &&
        // One population at a time, which is the point of the split.
        (roleFilter === null ||
          (roleFilter === 'proven' ? r.heldRole === true : r.heldRole === false)),
    );
    return [...filtered].sort((a, b) => {
      /*
       * Only the column being sorted decides whether a row sinks.
       *
       * This used to sink every row with no market read, whichever column you
       * clicked — on the reasoning that those players had "no value to rank".
       * That reasoning expired when VALUE started using the replacement level
       * matching each player's scale: a usage-only player now has a real figure.
       * The rule was producing a board that ran correctly down to Denzel Boston
       * at −55 and then jumped back to Josh Jacobs at +59, because Jacobs has no
       * betting lines and was being held below everyone who does.
       */
      const av = a[sort] as number | string | null;
      const bv = b[sort] as number | string | null;
      if ((av === null) !== (bv === null)) return av === null ? 1 : -1;

      let cmp: number;
      if (sort === 'name' || sort === 'position') {
        cmp = String(a[sort]).localeCompare(String(b[sort]));
      } else {
        cmp = ((a[sort] as number | null) ?? -Infinity) - ((b[sort] as number | null) ?? -Infinity);
      }
      return desc ? -cmp : cmp;
    });
  }, [rows, positions, showUnranked, sort, desc, activeTag, query, roleFilter]);

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
          setDesc(key !== 'adp' && key !== 'name');
        }
      }}
    >
      {help ? <TipHead label={label} help={help} /> : label}
      {sort === key ? (desc ? ' ↓' : ' ↑') : ''}
    </th>
  );

  const activeTagInfo = activeTag
    ? rows.flatMap((r) => r.tags).find((t) => t.id === activeTag)
    : null;

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
        <Tip content="Players missing a market category their position needs are excluded from ranking. Hiding them leaves only players with a complete market read.">
          <button className="chip" data-on={showUnranked} onClick={() => setShowUnranked(!showUnranked)}>
            {showUnranked ? 'showing incomplete' : 'ranked only'}
          </button>
        </Tip>
        {/*
          Late in the draft the board is two populations and the ADP ordering
          cannot compare them. Filtering to one at a time is the whole fix: it
          does not re-rank anything, it just stops you comparing a proven role
          against a lottery ticket as though they were the same kind of bet.
        */}
        <Tip content="Late in the draft the board mixes two kinds of player, and where they go tells you very little about each other. Among late picks who held a real role last season, taking the earlier one is worth 41 points. Among those who did not, 14. Look at one group at a time and the order starts meaning something again.">
          <button
            className="chip"
            data-on={roleFilter === 'proven'}
            onClick={() => setRoleFilter(roleFilter === 'proven' ? null : 'proven')}
          >
            had a role
          </button>
        </Tip>
        <Tip content="Players who did NOT hold a real role last season — under 10 games or under 80 points. Late in the draft these are lottery tickets, and where they go in the draft barely predicts what they return, so judge them on role and opportunity rather than on price.">
          <button
            className="chip"
            data-on={roleFilter === 'unproven'}
            onClick={() => setRoleFilter(roleFilter === 'unproven' ? null : 'unproven')}
          >
            unproven
          </button>
        </Tip>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {visible.length} of {rows.length}
        </span>
        <input
          className="search"
          type="search"
          placeholder="filter this board…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {activeTagInfo && (
        <div className="tagfilter">
          Showing only players tagged <strong>{activeTagInfo.label}</strong>
          {' — '}
          {activeTagInfo.detail}
          <button className="chip" onClick={() => setActiveTag(null)}>clear</button>
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {header('adp', 'ADP', 'Where he is going in real half-PPR drafts. Updated on a rolling window, so it moves through August.')}
              {header('position', 'Pos')}
              {header('name', 'Player')}
              <th className="l">Team</th>
              <th>Bye</th>
              {header('impliedPoints', 'Impl pts', 'What the sportsbooks are pricing him at, scored under this league’s rules. Taken from real posted lines, never from someone’s ranking.')}
              {header('adpEquivalent', 'ADP eq', 'The pick where that kind of season is normally worth spending. If this is lower than his ADP, he is cheap.')}
              {header('slotGap', 'Slot gap', 'How many picks of value he is against where he is going. Positive means you are getting more than the pick usually returns.')}
              {header('usageGrade', 'Usage', 'How big his role was last season, ranked against his own position from 0 to 100. Touches, targets, snaps and goal-line work — what the coaches actually gave him.')}
              {header('usageGap', 'vs mkt', 'His role rank minus his price rank. Positive means he did more on the field than he is being paid for.')}
              {header('blendedVorp', 'VALUE', 'Points he gains you over the best player you could grab for free at his position. Use it in the first three rounds — that is where it does its work. After that it fades fast, and by round seven it is telling you almost nothing, because nearly everyone left projects below that bar.')}
              {header('blendedSlotGap', 'Gap vs ADP', 'Whether he is cheap for where he is going — a different question from whether he is good. Trust it in the first three rounds. Through the middle rounds ignore it: it reads positive for four players in five no matter who they are, and everything else weakens there too.')}
              {header('vona', 'VONA', 'How much you lose by waiting. If you pass on him now, this is how far the next player at his position — the best one likely to still be there at your next pick — falls short of him. A big number means the position drops off a cliff right behind him, so take him now. A small number means you can wait and take someone else first.')}
              {header('startableRate', 'Start %', 'How many weeks of the season he should actually be worth starting — finishing inside the top 12 QBs, 24 RBs, 36 WRs or 12 TEs that week. Missed weeks count against him. This is the same projection said a different way, not a separate opinion, but a season total hides it: two players can score the same and one of them is startable twice as often.')}
              {/*
                One column, not two.

                UPSIDE and BUST were one measurement shown twice: ranked within
                position and band they correlate −0.87, and NEITHER survives the
                other — the partial of upside after bust is .020 pooled, bust
                after upside −.051. Two columns of one number invited a reader to
                count it as two reasons to like or avoid someone.

                The axis is the mean of the two ranks, with bust reversed so both
                face the same way. Averaging is measured rather than assumed: it
                beats or ties both halves in every band that carries signal. Both
                halves still appear on the hover, as explanation rather than as
                separate evidence.
              */}
              {header('outlookPctile', 'OUTLOOK', 'How players who looked like him turned out, on one scale from bust to breakout. 0 means almost all of them disappointed, 100 means almost all of them hit. Ranked against other players at HIS position going around the same time, because the raw rates are not comparable between positions. WHERE TO USE IT: from round 11 on it is the best column on this board, twice as good as draft order at picking out who returns value. Through the middle rounds it is not worth reading — nothing on this board is, which is a fact about the middle of the draft rather than about this column.')}
              <th className="l">Read</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const team = teamOf(r.team);
              return (
                <tr
                  key={r.playerId}
                  style={{ ...teamStyle(r.team), ['--pos-color' as string]: positionColor(r.position) }}
                >
                  <td>{r.adp.toFixed(1)}</td>
                  <td><span className="pos-badge">{r.position}</span></td>
                  <td className="l stripe">
                    <PlayerHover facts={facts(r)}>
                      <a className="name" href={`/player/${r.playerId}`}>{r.name}</a>
                    </PlayerHover>
                    {r.position === 'QB' && r.slotGap !== null && r.slotGap > 20 && (
                      <Tip content="Only expected starters get QB props, so deep-ADP quarterbacks are compared against a historical pool full of players who never started. Treat the size of this gap with caution.">
                        <span className="flag" style={{ cursor: 'help' }}>⚠ selection</span>
                      </Tip>
                    )}
                  </td>
                  <td className="l">
                    <span className="team-badge">
                      <span className="team-dot" aria-hidden />
                      {team.abbr}
                    </span>
                  </td>
                  <td className="muted">{r.bye ?? '—'}</td>
                  <td>{fmt(r.impliedPoints)}</td>
                  <td>{fmt(r.adpEquivalent, 1)}</td>
                  <td>
                    <span className={`gap ${r.slotGap === null ? 'na' : r.slotGap > 0 ? 'pos' : 'neg'}`}>
                      {r.slotGap === null ? 'no signal' : signed(r.slotGap)}
                    </span>
                  </td>
                  <td>{r.usageGrade === null ? <span className="muted">—</span> : r.usageGrade}</td>
                  <td>
                    {r.usageGap === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={`gap ${r.usageGap > 0 ? 'pos' : 'neg'}`}>{signed(r.usageGap, 0)}</span>
                    )}
                  </td>
                  <td>
                    {r.blendedVorp === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={`gap ${r.blendedVorp > 0 ? 'pos' : 'neg'} value`}>
                        {r.blendedVorp.toFixed(0)}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.blendedSlotGap === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={`gap ${r.blendedSlotGap > 0 ? 'pos' : 'neg'}`}>
                        {signed(r.blendedSlotGap)}
                      </span>
                    )}
                  </td>
                  {/*
                    VONA and Start % are deliberately not coloured on the
                    value/reach palette. Neither is a verdict: a big VONA says
                    the position falls away behind him, which is a fact about the
                    board rather than about whether he is a good pick, and Start %
                    is the projection restated in weekly units.
                  */}
                  <td>
                    {r.vona === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={r.vona >= 25 ? 'gap pos' : ''}>{r.vona.toFixed(0)}</span>
                    )}
                  </td>
                  <td>
                    {r.startableRate === null ? (
                      <span className="muted">—</span>
                    ) : (
                      `${Math.round(r.startableRate * 100)}%`
                    )}
                  </td>
                  {/*
                    The two halves live on the hover so the axis can be taken
                    apart, but only the axis is ranked and sorted.
                  */}
                  <td>
                    {r.outlookPctile === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <Tip
                        content={
                          `Better outlook than ${Math.round(r.outlookPctile)}% of ${r.position}s going around here. ` +
                          `Built from two halves that are 87% mirror images of each other, averaged: ` +
                          `${r.breakoutRate !== null ? `${Math.round(r.breakoutRate * 100)}% of the players who looked like him finished top-12 at the position` : 'top-12 rate unavailable'}` +
                          `${r.bustRate !== null ? `, and ${Math.round(r.bustRate * 100)}% were worth less than a free ${r.position}` : ''}. ` +
                          `Those two are one measurement, not two — neither tells you anything the other has not already said.`
                        }
                      >
                        <span
                          className={`gap ${r.outlookPctile >= 75 ? 'pos' : r.outlookPctile <= 25 ? 'neg' : 'na'}`}
                          tabIndex={0}
                        >
                          {Math.round(r.outlookPctile)}
                        </span>
                      </Tip>
                    )}
                  </td>
                  <td className="l readcell">
                    {/*
                      Only the three most notable chips.

                      A well-described player carries six, which wrapped onto
                      three lines and pushed every row past 100px — a dense board
                      turning into a list of cards. The chips are filters and a
                      summary now that the case carries the actual verdict, so
                      the tail belongs on his page rather than in the grid. Tags
                      arrive sorted by weight, so the three shown are the three
                      that matter.
                    */}
                    {r.tags.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      r.tags.slice(0, 3).map((t) => (
                        <Tip key={t.id} content={t.detail}>
                          <button
                            className={
                              `tag k-${t.kind}` +
                              (isVerdict(t.id) ? ` verdict-${t.id}` : '') +
                              (activeTag === t.id ? ' on' : '')
                            }
                            onClick={() => setActiveTag(activeTag === t.id ? null : t.id)}
                          >
                            {t.label}
                          </button>
                        </Tip>
                      ))
                    )}
                    {r.tags.length > 3 && (
                      <Tip content={r.tags.slice(3).map((t) => t.label).join(' · ')}>
                        <a className="tag tag-more" href={`/player/${r.playerId}`}>
                          +{r.tags.length - 3}
                        </a>
                      </Tip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="legend">
        <code>VALUE</code> is the draft order — points above the freely available player at that
        position. <code>Gap vs ADP</code> is whether he is cheap at his price, which is a different
        question and a secondary one.{' '}
        <code>Impl pts</code> comes only from posted props — never from a projection or a ranking.
        Players marked <code>no props</code> have no market for the stats that define their position
        and are shown with ADP alone rather than a fabricated number.{' '}
        <code>% covered</code> players are missing a category the market prices for their position,
        so their points are a floor and they are excluded from ranking.{' '}
        <code>+n wk1</code> means part of the projection was scaled up from a Week 1 line using the
        market’s own season-to-game ratio of about 15.2 — not 17, because a season line already
        prices in missed time.{' '}
        <code>Usage</code> is a separate opinion built from what the player actually did on the
        field. Hover any player for a summary, any column heading for what it measures, and any tag
        for the claim behind it.{' '}
        <a href="/legend">Full plain-language legend →</a>
      </p>
    </>
  );
}
