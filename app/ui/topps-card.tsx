'use client';

import { useState } from 'react';
import { teamOf, teamStyle, positionColor } from '../../lib/teams';

/**
 * The player card, built after a printed trading card.
 *
 * The conventions being borrowed are specific and all pre-1990: a white stock
 * border around a full-bleed colour field, a halftone dot screen because the
 * colour was printed not photographed, a diagonal sweep breaking up the field, a
 * team pennant along the bottom, and the name on a plate below the frame. The
 * back is card stock with a season-by-season stat table in a condensed face.
 *
 * THERE IS A PHOTOGRAPH NOW. The old comment here said there was no photo
 * source in the database and filled the frame with two enormous initials — which
 * read as a missing asset however it was dressed up, because that is what it
 * was. `players.espn_id` covers 1,083 of 1,099 skill players and ESPN serves a
 * cut-out portrait from it, so the card carries a face and falls back to the
 * monogram only when the id is absent or the image fails to load.
 *
 * The print-effect layers came off with it. A halftone dot screen, a diagonal
 * gloss sweep and a two-stop gradient were three textures competing behind the
 * subject at full team saturation; a portrait needs a ground, not a pattern.
 */

export interface ToppsSeason {
  season: number;
  games: number;
  a: number | null;
  b: number | null;
  c: number | null;
  d: number | null;
  points: number | null;
}

export interface ToppsProps {
  name: string;
  position: string;
  team: string | null;
  bye: number | null;
  adp: number | null;
  /**
   * The corner badge. Value over replacement for a drafted player, usage grade
   * for one who is not — the two are on different scales and must not be shown
   * under a single label.
   */
  badge: { value: string; label: string; good: boolean } | null;
  /** Four stat columns, each as a two-line heading: ['PASS','YDS']. */
  columns: Array<[string, string]>;
  seasons: ToppsSeason[];
  blurb: string;
  rookieSeason: number | null;
  status: string | null;
  /** ESPN player id — the key to the portrait. Null falls back to initials. */
  espnId: string | null;
}

const initials = (name: string) =>
  name
    .replace(/\b(Jr|Sr|II|III|IV|V)\.?\b/gi, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

const num = (v: number | null, d = 0) => (v === null || Number.isNaN(v) ? '—' : v.toFixed(d));

export default function ToppsCard(p: ToppsProps) {
  const [flipped, setFlipped] = useState(false);
  /*
   * A missing portrait must not leave a broken-image glyph in the frame, and
   * ESPN 404s for a handful of ids that exist in nflverse. `onError` swaps back
   * to the monogram, so the fallback is the old card rather than a hole.
   */
  const [portraitFailed, setPortraitFailed] = useState(false);
  const team = teamOf(p.team);
  const portrait =
    p.espnId && !portraitFailed
      ? `https://a.espncdn.com/i/headshots/nfl/players/full/${p.espnId}.png`
      : null;

  return (
    <div
      className="cardstage"
      style={{ ...teamStyle(p.team), ['--pos-color' as string]: positionColor(p.position) }}
    >
      <button
        type="button"
        className="topps"
        data-flipped={flipped}
        onClick={() => setFlipped((f) => !f)}
        aria-label={`${p.name} card — ${flipped ? 'showing statistics, click for front' : 'click to see season statistics'}`}
      >
        {/* ---------------- front ---------------- */}
        <span className="topps-face" aria-hidden={flipped}>
          <span className="topps-art" data-hasphoto={portrait !== null}>
            {portrait ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                className="topps-photo"
                src={portrait}
                alt=""
                /*
                 * NOT lazy. The card is the first thing on the player page, and
                 * `loading="lazy"` deadlocked against the layout: width was
                 * `auto` against an unknown intrinsic size, so the element
                 * measured 0px wide, a zero-area element never satisfies the
                 * lazy loader, and the width therefore never resolved.
                 */
                decoding="async"
                onError={() => setPortraitFailed(true)}
              />
            ) : (
              <span className="topps-monogram">{initials(p.name)}</span>
            )}

            <span className="topps-pos">{p.position}</span>

            {p.badge && (
              <span className="topps-vorp">
                <b style={{ color: p.badge.good ? '#0f7a5a' : '#111' }}>{p.badge.value}</b>
                <span>{p.badge.label}</span>
              </span>
            )}

            <span className="topps-pennant">
              <span className="topps-team">{team.nick}</span>
            </span>
          </span>

          <span className="topps-plate">
            <span>
              <span className="topps-name">{p.name}</span>
              <span className="topps-sub">
                {team.abbr}
                {p.bye ? ` · bye ${p.bye}` : ''}
                {p.status && p.status !== 'ACT' ? ` · ${p.status}` : ''}
              </span>
            </span>
            <span className="topps-adp">
              <b>{p.adp === null ? '—' : p.adp.toFixed(1)}</b>
              <span>{p.adp === null ? 'undrafted' : 'ADP'}</span>
            </span>
          </span>
        </span>

        {/* ---------------- back ---------------- */}
        <span className="topps-face back" aria-hidden={!flipped}>
          <span className="topps-back-head">
            <span className="topps-back-name">{p.name}</span>
            <span className="topps-back-meta">
              {p.position} · {team.name}
              {p.rookieSeason ? ` · rookie ${p.rookieSeason}` : ''}
            </span>
          </span>

          {p.seasons.length ? (
            <table className="topps-stats">
              <thead>
                <tr>
                  <th>Yr</th>
                  <th>G</th>
                  {/* Two-line headings rather than codes like "PaYd" and "RuTD",
                      which meant nothing to anyone who had not read the source. */}
                  {p.columns.map((c) => (
                    <th key={c.join('-')}>
                      {c[0]}
                      <br />
                      {c[1]}
                    </th>
                  ))}
                  <th>
                    HALF
                    <br />
                    PPR
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.seasons.map((s) => (
                  <tr key={s.season}>
                    <td>{`'${String(s.season).slice(2)}`}</td>
                    <td>{s.games}</td>
                    <td>{num(s.a)}</td>
                    <td>{num(s.b)}</td>
                    <td>{num(s.c)}</td>
                    <td>{num(s.d)}</td>
                    <td>
                      <b>{num(s.points)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ fontSize: 10, color: '#6b6357', margin: '4px 0' }}>
              No regular-season history — rookie.
            </p>
          )}

          <span className="topps-blurb">{p.blurb}</span>
          {/* The scoring line is stated on the card, because "PTS" on its own
              invited exactly the question of what it was counting. */}
          <span className="topps-note">
            HALF PPR = 0.1/yd · 6 rush+rec TD · 0.04/pass yd · 4 pass TD · 0.5/catch · −2 turnover
          </span>
          <span className="topps-flip">click to flip</span>
        </span>
      </button>
    </div>
  );
}
