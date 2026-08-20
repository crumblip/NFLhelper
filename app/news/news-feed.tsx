'use client';

import { useMemo, useState } from 'react';
/*
 * Types come from `lib/news`, runtime values from `lib/news-shared`.
 *
 * That split is load-bearing, not tidiness. `lib/news` reaches the database, so
 * importing a *value* from it pulls `better-sqlite3` into the client bundle and
 * the route dies with `Can't resolve 'fs'`. `import type` is erased at compile
 * time and is safe; anything else is not.
 */
import type { NewsMeta, NewsRow, TeamNews } from '../../lib/news';
import {
  CATEGORY_BLURB,
  CATEGORY_LABEL,
  FANTASY_CATEGORIES,
  ago,
  isCreatorSource,
  sourceLabel,
} from '../../lib/news-shared';
import { CREATORS } from '../../lib/creators';
import { teamOf, teamStyle, positionColor } from '../../lib/teams';
import { Tip } from '../ui/tip';

/**
 * The news reader.
 *
 * Three filters, deliberately unequal in weight. Team is the primary axis and
 * gets a persistent picker; position is a filter *within* a team, which is the
 * order the question is actually asked in. Category is a secondary narrowing
 * and sits with the list.
 *
 * Colour follows the house rule (#104): it ranks, it does not decorate. The
 * only saturated marks on a row are the position badge — an index the eye uses
 * to sort — and the injury tint, whose content is a caution. Category, source
 * and time are ink on panel, because none of them is a verdict.
 */

const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

/* Slug to name, so a stored `creator:joel-smyth` prints as "Joel Smyth". */
const CREATOR_NAMES: Record<string, string> = Object.fromEntries(
  CREATORS.map((c) => [c.slug, c.name]),
);
const CREATOR_NOTES: Record<string, string> = Object.fromEntries(
  CREATORS.map((c) => [c.slug, c.note]),
);

function Item({ row }: { row: NewsRow }) {
  const cat = row.category;
  const fromCreator = isCreatorSource(row.source);
  const slug = fromCreator ? row.source.slice('creator:'.length) : null;
  return (
    <article className="news-item" data-cat={cat} data-creator={fromCreator}>
      <div className="news-item-head">
        <Tip
          content={
            <>
              <strong>{CATEGORY_LABEL[cat]}</strong>, {CATEGORY_BLURB[cat]}
              {row.categoryBasis ? (
                <>
                  <br />
                  Filed here because the text says &ldquo;{row.categoryBasis}&rdquo;.
                </>
              ) : null}
            </>
          }
        >
          <span className="news-cat" tabIndex={0}>
            {CATEGORY_LABEL[cat]}
          </span>
        </Tip>
        {fromCreator && slug ? (
          <Tip content={CREATOR_NOTES[slug] ?? 'On the curated creator roster.'}>
            <span className="news-src is-creator" tabIndex={0}>
              {CREATOR_NAMES[slug] ?? slug}
            </span>
          </Tip>
        ) : (
          <span className="news-src">{sourceLabel(row.source, CREATOR_NAMES)}</span>
        )}
        <span className="news-time">{ago(row.publishedAt)}</span>
      </div>

      <h3 className="news-headline">
        {row.url ? (
          <a href={row.url} target="_blank" rel="noreferrer">
            {row.headline}
          </a>
        ) : (
          row.headline
        )}
      </h3>

      {row.body ? <p className="news-body">{row.body}</p> : null}

      {row.players.length > 0 ? (
        <div className="news-players">
          {row.players.slice(0, 6).map((p) => (
            <a
              key={`${row.id}-${p.playerId}`}
              className="news-player"
              href={`/player/${p.playerId}`}
              style={{ ['--pos-color' as string]: positionColor(p.position) }}
            >
              {p.position ? <i className="news-player-pos">{p.position}</i> : null}
              {p.name}
              {/* A soft match is marked. "ESPN told us this is him" and "we found
                  that string in a paragraph" are different claims and the page
                  should not present them identically. */}
              {p.method === 'name' ? (
                <Tip content="Matched on name rather than on an id, very likely right, but not certain.">
                  <i className="news-soft" tabIndex={0} aria-label="matched by name">
                    ~
                  </i>
                </Tip>
              ) : null}
            </a>
          ))}
          {row.players.length > 6 ? (
            <span className="news-more">+{row.players.length - 6}</span>
          ) : null}
        </div>
      ) : (
        <div className="news-players">
          <span className="news-teamlevel">About the team, not one player</span>
        </div>
      )}
    </article>
  );
}

export default function NewsFeed({
  teams,
  selected,
  teamNews,
  league,
  meta,
}: {
  teams: Array<{ team: string; n: number }>;
  selected: string | null;
  teamNews: TeamNews | null;
  league: NewsRow[];
  meta: NewsMeta;
  season: number;
}) {
  const [pos, setPos] = useState<string>('ALL');
  const [cat, setCat] = useState<string>('ALL');
  const [query, setQuery] = useState('');
  const [creatorsOnly, setCreatorsOnly] = useState(false);

  /*
   * Search covers the headline, the body AND the names of the players an item
   * is attached to.
   *
   * Including the names matters more than it looks. A RotoWire item reads
   * "Alvin Kamara: Avoids serious setback" so the name is in the headline, but
   * an ESPN camp digest is headlined "2026 Seattle Seahawks training camp" and
   * mentions Cooper Kupp only in its athlete tags — searching "kupp" has to
   * find it, or the search answers a different question from the one asked.
   *
   * Terms are AND-ed and matched as substrings, which is the behaviour a search
   * box gets used as: "kamara knee" should find the knee item about Kamara, not
   * everything about either.
   */
  const rows = useMemo(() => {
    const base = teamNews ? teamNews.rows : league;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return base.filter((r) => {
      if (creatorsOnly && !isCreatorSource(r.source)) return false;
      if (cat !== 'ALL' && r.category !== cat) return false;
      if (pos !== 'ALL') {
        if (pos === 'TEAM') {
          if (!r.teamLevel) return false;
        } else if (!r.positions.includes(pos)) return false;
      }
      if (terms.length) {
        const hay = `${r.headline} ${r.body ?? ''} ${r.players.map((p) => p.name).join(' ')}`
          .toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }, [teamNews, league, pos, cat, query, creatorsOnly]);

  /*
   * The chip counts are computed here rather than read from the server, so they
   * follow the search.
   *
   * Each facet counts what the OTHER filters leave — the position chips ignore
   * the position filter, the category chips ignore the category filter — which
   * is what makes them useful for narrowing rather than just describing. A
   * count that ignored the search box would offer "Injury 14" over a filtered
   * list holding two, and a disabled chip would be the only clue.
   */
  const searched = useMemo(() => {
    const base = teamNews ? teamNews.rows : league;
    const scoped = creatorsOnly ? base.filter((r) => isCreatorSource(r.source)) : base;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return scoped;
    return scoped.filter((r) => {
      const hay = `${r.headline} ${r.body ?? ''} ${r.players.map((p) => p.name).join(' ')}`
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [teamNews, league, query, creatorsOnly]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of searched) {
      if (cat !== 'ALL' && r.category !== cat) continue;
      for (const k of r.teamLevel ? ['TEAM'] : r.positions) m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [searched, cat]);

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of searched) {
      if (pos !== 'ALL') {
        if (pos === 'TEAM' ? !r.teamLevel : !r.positions.includes(pos)) continue;
      }
      m[r.category] = (m[r.category] ?? 0) + 1;
    }
    return m;
  }, [searched, pos]);

  const sorted = [...teams].sort((a, b) => a.team.localeCompare(b.team));

  return (
    <>
      {/* ---- team picker ------------------------------------------------ */}
      <div className="sechead">
        <h2>Team</h2>
        <span className="rule" />
        <span className="hint">
          {selected ? teamOf(selected).name : `all ${meta.teamsCovered} teams with news`}
        </span>
      </div>

      <div className="news-teams">
        <a className="news-team" href="/news" data-on={!selected}>
          <span className="news-team-abbr">ALL</span>
          <span className="news-team-n">{meta.relevant}</span>
        </a>
        {sorted.map((t) => (
          <a
            key={t.team}
            className="news-team"
            href={`/news?team=${t.team}`}
            data-on={selected === t.team}
            style={teamStyle(t.team)}
          >
            <span className="team-dot" aria-hidden />
            <span className="news-team-abbr">{t.team}</span>
            <span className="news-team-n">{t.n}</span>
          </a>
        ))}
      </div>

      {/* ---- position + category ---------------------------------------- */}
      <div className="sechead">
        <h2>{selected ? `${teamOf(selected).nick} news` : 'Latest across the league'}</h2>
        <span className="rule" />
        <span className="hint">
          {rows.length} {rows.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      <div className="news-filters">
        <div className="news-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              selected ? `Search ${teamOf(selected).nick} news…` : 'Search player, team or word…'
            }
            aria-label="Search news"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
              ×
            </button>
          ) : null}
        </div>

        <div className="seg" role="group" aria-label="Position">
          <button data-on={pos === 'ALL'} onClick={() => setPos('ALL')}>
            All
          </button>
          {POSITIONS.map((p) => (
            <button
              key={p}
              data-on={pos === p}
              onClick={() => setPos(p)}
              disabled={!counts[p]}
            >
              {p}
              {counts[p] ? <b> {counts[p]}</b> : null}
            </button>
          ))}
          <Tip content="Items about the team with no skill player attached, a coach on how the offence will be run, a coordinator change, a camp report.">
            <button
              data-on={pos === 'TEAM'}
              onClick={() => setPos('TEAM')}
              disabled={!counts.TEAM}
            >
              Team
              {counts.TEAM ? <b> {counts.TEAM}</b> : null}
            </button>
          </Tip>
        </div>

        {/*
          Creators get their own switch rather than a category chip, because
          "who said it" is a different axis from "what kind of thing is it",
          a creator's injury video is still injury news. It sits ahead of the
          category row since curation is the stronger filter of the two.
        */}
        <Tip
          content={
            <>
              Only the curated roster:{' '}
              {CREATORS.map((c) => c.name).join(', ')}. Titles that defer their
              payoff, &ldquo;stay tuned for number one&rdquo;, are dropped before they
              get here.
            </>
          }
        >
          <button
            className="chip"
            data-on={creatorsOnly}
            onClick={() => setCreatorsOnly((v) => !v)}
          >
            Creators only
          </button>
        </Tip>

        <div className="news-cats">
          <button className="chip" data-on={cat === 'ALL'} onClick={() => setCat('ALL')}>
            Everything
          </button>
          {FANTASY_CATEGORIES.map((c) => (
            <Tip key={c} content={CATEGORY_BLURB[c]}>
              <button
                className="chip"
                data-on={cat === c}
                onClick={() => setCat(c)}
                disabled={!catCounts[c]}
              >
                {CATEGORY_LABEL[c]}
                {catCounts[c] ? <b> {catCounts[c]}</b> : null}
              </button>
            </Tip>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="notice">
          <strong>Nothing here.</strong>{' '}
          {query
            ? `Nothing matches “${query}”${pos !== 'ALL' || cat !== 'ALL' ? ' with the current filters' : ''}. The archive only holds what has been polled, ${meta.relevant} items, so a name that returns nothing may simply not have been in the news yet.`
            : pos === 'TEAM'
              ? 'No item about this team without a player attached, those come from coaching interviews and camp reports, which are rarer than player news.'
              : pos !== 'ALL'
                ? `No ${pos} news for this team in what has been collected so far. The archive is ${meta.oldest && meta.newest ? `${((meta.newest - meta.oldest) / 86_400_000).toFixed(1)} days` : 'young'} deep, this is very likely a gap in the polling rather than a quiet position.`
                : 'Nothing matched these filters.'}
        </div>
      ) : (
        <div className="news-list">
          {rows.map((r) => (
            <Item key={r.id} row={r} />
          ))}
        </div>
      )}

      {/* The archive's own age, stated where the reader has just finished
          reading it, an empty position filter means "we have not been
          watching long" far more often than it means "nothing happened". */}
      {meta.oldest && meta.newest ? (
        <p className="sub" style={{ marginTop: 'var(--s6)' }}>
          Holding <strong>{meta.stored}</strong> items spanning{' '}
          <strong>{((meta.newest - meta.oldest) / 86_400_000).toFixed(1)} days</strong>, oldest{' '}
          {new Date(meta.oldest).toLocaleDateString()}, newest {ago(meta.newest)}.{' '}
          {meta.fetchedAt ? `Last pull ${ago(meta.fetchedAt)}.` : null}
        </p>
      ) : null}
    </>
  );
}
