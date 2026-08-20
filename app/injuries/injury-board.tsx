'use client';

import { useMemo, useState } from 'react';
// Types from lib/news (erased at compile time); values from lib/news-shared,
// which imports nothing — see the note in news-feed.tsx.
import type { InjuryMeta, InjuryRow } from '../../lib/news';
import { EXPECTED_TO_PLAY_FROM, ago, statusRank } from '../../lib/news-shared';
import { teamOf, teamStyle, positionColor } from '../../lib/teams';
import { Tip } from '../ui/tip';

/**
 * The report, grouped by team and ranked by severity within it.
 *
 * Severity is the one quantity on this page that earns a saturated mark,
 * because it is the rank the whole table is read on (#104). Everything else —
 * body part, the beat report, the fantasy read — is ink.
 */

const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

function Row({ r }: { r: InjuryRow }) {
  const sev = statusRank(r.status);
  const expectedToPlay = sev >= EXPECTED_TO_PLAY_FROM;
  return (
    <div className="inj-row">
      <span
        className="inj-pos"
        style={{ ['--pos-color' as string]: positionColor(r.position) }}
        aria-hidden
      >
        {r.position}
      </span>

      <span>
        {r.playerId ? (
          <a className="inj-name" href={`/player/${r.playerId}`}>
            {r.name}
          </a>
        ) : (
          <Tip content="This name did not match the player index, so there is no page for him. He is still listed, dropping him would make the report quietly incomplete.">
            <span className="inj-name" tabIndex={0} style={{ cursor: 'help' }}>
              {r.name}
            </span>
          </Tip>
        )}
        <span className="inj-adp">
          {r.adp ? `drafted around ${Math.round(r.adp)}` : 'undrafted'}
        </span>
      </span>

      <Tip
        content={
          expectedToPlay
            ? 'Carrying something and still expected to play. This is ESPN’s largest category and is not, by itself, bad news.'
            : 'ESPN’s own designation, kept as written rather than scored.'
        }
      >
        <span className="inj-status" data-sev={sev} tabIndex={0}>
          <i aria-hidden />
          {r.status}
        </span>
      </Tip>

      <span className="inj-body">{r.bodyPart ?? '—'}</span>

      <div className="inj-body">
        {r.detail ? <p className="inj-detail">{r.detail}</p> : null}
        {r.analysis && r.analysis !== r.detail ? (
          <p className="inj-analysis">{r.analysis}</p>
        ) : null}
        {r.reportedAt ? <span className="inj-when">{ago(r.reportedAt)}</span> : null}
      </div>
    </div>
  );
}

export default function InjuryBoard({ rows, meta }: { rows: InjuryRow[]; meta: InjuryMeta }) {
  const [team, setTeam] = useState<string>('ALL');
  const [pos, setPos] = useState<string>('ALL');
  const [draftedOnly, setDraftedOnly] = useState(false);
  const [hideActive, setHideActive] = useState(true);

  const teams = useMemo(
    () => [...new Set(rows.map((r) => r.team).filter((t): t is string => !!t))].sort(),
    [rows],
  );

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (team !== 'ALL' && r.team !== team) return false;
        if (pos !== 'ALL' && r.position !== pos) return false;
        if (draftedOnly && !r.drafted) return false;
        if (hideActive && statusRank(r.status) >= EXPECTED_TO_PLAY_FROM) return false;
        return true;
      }),
    [rows, team, pos, draftedOnly, hideActive],
  );

  const grouped = useMemo(() => {
    const m = new Map<string, InjuryRow[]>();
    for (const r of filtered) {
      const k = r.team ?? 'FA';
      const list = m.get(k) ?? [];
      list.push(r);
      m.set(k, list);
    }
    for (const list of m.values()) {
      list.sort(
        (a, b) =>
          statusRank(a.status) - statusRank(b.status) ||
          (a.adp ?? 999) - (b.adp ?? 999) ||
          a.name.localeCompare(b.name),
      );
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const hiddenActive = hideActive ? rows.filter((r) => statusRank(r.status) >= EXPECTED_TO_PLAY_FROM).length : 0;

  return (
    <>
      <div className="news-filters" style={{ marginTop: 'var(--s5)' }}>
        <div className="seg" role="group" aria-label="Position">
          <button data-on={pos === 'ALL'} onClick={() => setPos('ALL')}>
            All
          </button>
          {POSITIONS.map((p) => (
            <button key={p} data-on={pos === p} onClick={() => setPos(p)}>
              {p}
            </button>
          ))}
        </div>

        <button className="chip" data-on={draftedOnly} onClick={() => setDraftedOnly((v) => !v)}>
          Drafted only
        </button>

        <Tip content="“Active” means carrying a knock and still expected to play, most of the report. Turning this off shows them.">
          <button className="chip" data-on={hideActive} onClick={() => setHideActive((v) => !v)}>
            Hide “expected to play”
            {hiddenActive ? <b> {hiddenActive}</b> : null}
          </button>
        </Tip>

        <span className="hint" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--faint)' }}>
          {filtered.length} of {meta.total} shown
          {meta.fetchedAt ? ` · pulled ${ago(meta.fetchedAt)}` : ''}
        </span>
      </div>

      <div className="news-teams" style={{ marginBottom: 'var(--s5)' }}>
        <button
          className="news-team"
          data-on={team === 'ALL'}
          onClick={() => setTeam('ALL')}
          style={{ font: 'inherit', cursor: 'pointer' }}
        >
          <span className="news-team-abbr">ALL</span>
          <span className="news-team-n">{rows.length}</span>
        </button>
        {teams.map((t) => {
          const n = rows.filter((r) => r.team === t && (!hideActive || statusRank(r.status) < EXPECTED_TO_PLAY_FROM))
            .length;
          return (
            <button
              key={t}
              className="news-team"
              data-on={team === t}
              onClick={() => setTeam(t)}
              style={{ ...teamStyle(t), font: 'inherit', cursor: 'pointer' }}
            >
              <span className="team-dot" aria-hidden />
              <span className="news-team-abbr">{t}</span>
              <span className="news-team-n">{n}</span>
            </button>
          );
        })}
      </div>

      {grouped.length === 0 ? (
        <div className="notice">
          <strong>Nobody matches.</strong>{' '}
          {hideActive
            ? 'Every listed player on this filter is expected to play, which is good news, not a missing report. Turn off “Hide expected to play” to see them.'
            : 'No rows for these filters.'}
        </div>
      ) : (
        grouped.map(([abbr, list]) => (
          <section className="inj-team" key={abbr} style={teamStyle(abbr)}>
            <div className="inj-team-head">
              <span className="team-dot" aria-hidden />
              <h3>{teamOf(abbr).name}</h3>
              <span className="inj-count">
                {list.length} {list.length === 1 ? 'player' : 'players'}
              </span>
            </div>
            {list.map((r) => (
              <Row key={`${r.name}-${r.team}`} r={r} />
            ))}
          </section>
        ))
      )}
    </>
  );
}
