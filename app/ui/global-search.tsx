'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchEntry } from '../../lib/search';
import { teamOf, teamStyle, positionColor } from '../../lib/teams';

/**
 * Search across the whole player universe, not just the draft board.
 *
 * The board holds the 179 players the ADP feed prices. Searching only those
 * meant Dylan Sampson — Cleveland's listed RB2 — returned nothing, which is the
 * opposite of what a waiver tool should do. The index this reads spans everyone
 * being drafted, everyone with a role last season, and everyone on a current
 * depth chart, and each result says which of those it is.
 *
 * The whole index ships to the client so matching happens per keystroke with no
 * round trip. Mid-draft that responsiveness matters more than the payload.
 */

const AVAIL_LABEL: Record<string, string> = {
  board: 'drafted',
  wire: 'wire',
  roster: 'roster',
};

function score(entry: SearchEntry, q: string): number {
  const h = entry.haystack;
  const i = h.indexOf(q);
  if (i === -1) return -1;
  // A surname match should beat a mid-word one, and a first-name match should
  // beat both — rank by where the hit lands and how much of the name it covers.
  const atStart = i === 0 || h[i - 1] === ' ';
  return (atStart ? 200 : 60) + (q.length / entry.name.length) * 40 - i * 0.4;
}

export default function GlobalSearch({ index }: { index: SearchEntry[] }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return index
      .map((e) => ({ e, s: score(e, q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((r) => r.e);
  }, [index, query]);

  useEffect(() => setActive(0), [query]);

  // Cmd/Ctrl-K from anywhere, Escape to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const go = (id: string) => {
    window.location.href = `/player/${id}`;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[active];
      if (pick) go(pick.playerId);
    }
  };

  const showing = open && query.trim().length >= 2;

  return (
    <div className="gsearch" ref={boxRef}>
      <span className="gsearch-icon" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder="Search any player, drafted or not…"
        aria-label="Search players"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {!query && <span className="gsearch-kbd" aria-hidden>⌘K</span>}

      {showing && (
        <div className="gresults" role="listbox">
          {results.length === 0 ? (
            <div className="gempty">
              No player matches “{query.trim()}”.
              <div style={{ fontSize: 12, marginTop: 6, color: 'var(--faint)' }}>
                The index covers everyone drafted, everyone with a role last season, and
                everyone on a 2026 depth chart.
              </div>
            </div>
          ) : (
            <>
              {results.map((r, i) => {
                const team = teamOf(r.team);
                return (
                  <a
                    key={r.playerId}
                    href={`/player/${r.playerId}`}
                    className="gresult"
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    onMouseEnter={() => setActive(i)}
                    style={{ ...teamStyle(r.team), ['--pos-color' as string]: positionColor(r.position) }}
                  >
                    <span className="pos-badge">{r.position}</span>
                    <span>
                      <span className="gresult-name">{r.name}</span>
                      <span className="gresult-meta" style={{ display: 'block' }}>
                        {team.nick}
                        {r.depthRank ? ` · ${r.position}${r.depthRank}` : ''}
                        {r.games ? ` · ${r.games} g` : ''}
                      </span>
                    </span>
                    <span className="gresult-right">
                      {r.adp !== null ? (
                        <span style={{ fontSize: 12, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
                          {r.adp.toFixed(1)}
                          <span style={{ fontSize: 9, color: 'var(--faint)', marginLeft: 3 }}>ADP</span>
                        </span>
                      ) : null}
                      <span className={`avail ${r.availability}`}>{AVAIL_LABEL[r.availability]}</span>
                    </span>
                  </a>
                );
              })}
              <div className="ghint">
                ↑↓ to move · ⏎ to open · <strong>{index.length}</strong> players indexed
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
