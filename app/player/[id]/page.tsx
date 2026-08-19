import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  getPlayerDetail,
  getNeighbours,
  type SeasonContext,
  type Support,
} from '../../../lib/player';
import WeeklyBars from './weekly';
import ToppsCard, { type ToppsSeason } from '../../ui/topps-card';
import { Tip } from '../../ui/tip';
import { teamOf, teamStyle, positionColor } from '../../../lib/teams';
import { buildRead } from '../../../lib/pipeline/read';

export const dynamic = 'force-dynamic';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const SEASON = Number(process.env.SEASON ?? 2026);

const STAT_LABEL: Record<string, string> = {
  passingYards: 'Passing yards',
  passingTds: 'Passing TDs',
  interceptions: 'Interceptions',
  rushingYards: 'Rushing yards',
  rushingTds: 'Rushing TDs',
  receptions: 'Receptions',
  receivingYards: 'Receiving yards',
  receivingTds: 'Receiving TDs',
};

/**
 * Provenance, spelled out from the recorded basis rather than a fixed string.
 *
 * A rookie has no yards-per-reception history, so their receptions come from a
 * position median — a weaker assumption that the old wording ("this player's
 * yards per reception") flatly misdescribed.
 */
function sourceNote(source: string, basis: string | null): string {
  if (source === 'market') return 'Posted season line';

  if (source === 'extrapolated') {
    const ratio = basis?.match(/game-ratio:([\d.]+)/)?.[1];
    return `Scaled from a Week 1 line${ratio ? ` (×${ratio}, the market’s own game count)` : ''}`;
  }

  if (source === 'derived') {
    const own = basis?.match(/^own-ypr:([\d.]+)/)?.[1];
    if (own) return `Converted from the receiving-yards line at his own ${own} yds/catch`;
    const posMatch = basis?.match(/^position-ypr:([\d.]+):(\w+)/);
    if (posMatch) {
      return `Converted at the ${posMatch[2]} median of ${posMatch[1]} yds/catch — no history of his own`;
    }
    return 'Converted from another market line';
  }

  return source;
}

const num = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d);

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;

const pct0 = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;

const odds = (v: number | null) => (v === null ? '—' : v > 0 ? `+${v}` : String(v));

const plural = (n: number) => (n === 1 ? 'was' : 'were');

/**
 * Ordinal suffix. A hard-coded "th" printed "22th" and "1th" — small, but this
 * page argues for its own rigour and a reader who spots that stops believing the
 * decimals too.
 */
const ord = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '';
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
};

/** August games are exhibition; the regular season starts in September. */
const isPreseason = (gameDate: string | null) =>
  gameDate !== null && gameDate < `${SEASON}-09-01`;

/**
 * nflverse ships snap share as a 0–1 fraction, not a percentage. Formatting it
 * directly rounds every starter to "1%".
 */
const snapPct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`;

/** The four stat columns that describe each position on the card back. */
function cardColumns(position: string): Array<[string, string]> {
  if (position === 'QB') {
    return [['PASS', 'YDS'], ['PASS', 'TD'], ['RUSH', 'YDS'], ['RUSH', 'TD']];
  }
  if (position === 'RB') {
    return [['RUSH', 'ATT'], ['RUSH', 'YDS'], ['REC', ''], ['TOTAL', 'TD']];
  }
  return [['TGT', ''], ['REC', ''], ['REC', 'YDS'], ['REC', 'TD']];
}

function cardSeasons(position: string, context: SeasonContext[]): ToppsSeason[] {
  return context.map((c) => {
    const base = { season: c.season, games: c.games, points: c.fantasyPointsHalf };
    if (position === 'QB') {
      return { ...base, a: c.passingYards, b: c.passingTds, c: c.rushingYards, d: c.rushingTds };
    }
    if (position === 'RB') {
      return {
        ...base,
        a: c.carries,
        b: c.rushingYards,
        c: c.receptions,
        d: (c.rushingTds ?? 0) + (c.receivingTds ?? 0),
      };
    }
    return { ...base, a: c.targets, b: c.receptions, c: c.receivingYards, d: c.receivingTds };
  });
}

/**
 * How much the neighbourhood can carry, and what that costs.
 *
 * Measured in `calibrate:comparables`: bucketing every backtested season by the
 * share of its forty neighbours that are genuine matches, the median outcome
 * roughly doubles in error as the neighbourhood thins (RB mean error 33.5 points
 * against 65.6, WR 28.3 against 41.1). The range holds up — interval coverage
 * stays near 0.60 in every bucket, because scattered neighbours produce a wider
 * range — so the honest instruction is to read the spread and distrust the
 * midpoint, which is what this says.
 */
const SUPPORT_NOTE: Record<Support, { label: string; cls: string; detail: string }> = {
  strong: {
    label: 'well supported',
    cls: 'k-role',
    detail:
      'Most of the forty seasons behind this are genuine matches for his role and production. ' +
      'Backtested, reads like this land closest to what actually happened — mean error around 33 ' +
      'points for a back and 28 for a receiver.',
  },
  fair: {
    label: 'partly supported',
    cls: 'k-coverage',
    detail:
      'About half the neighbourhood is a genuine match and the rest is looser. The range is still ' +
      'calibrated; the single middle number carries more error than it does for a common profile.',
  },
  thin: {
    label: 'thin support',
    cls: 'k-risk',
    detail:
      'Few of the forty seasons genuinely resemble him, so the list is padded with the least ' +
      'dissimilar available. Backtested, the middle number roughly doubles in error here (RB 65.6 ' +
      'against 33.5) while the range stays honest — read the spread, not the midpoint.',
  },
};

/**
 * A stat tile that explains itself.
 *
 * Every headline figure on this page is the end of a calculation, and a reader
 * who cannot see the calculation has to take it on trust. `explain` carries the
 * arithmetic in plain English — what went in, what was done to it, and what the
 * number would have to be to mean something different.
 *
 * The tile is focusable and the cursor changes, because a tooltip nobody knows
 * is there is the same as no tooltip. Keyboard users get it on focus; the
 * dotted underline on the label is the affordance.
 */
function Stat({
  label,
  value,
  note,
  explain,
  tone,
  meter,
  children,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  explain?: ReactNode;
  tone?: string;
  meter?: { pct: number; kind?: string };
  children?: ReactNode;
}) {
  const body = (
    <div className={`stat${explain ? ' explains' : ''}`} tabIndex={explain ? 0 : undefined}>
      <div className="stat-label">
        {label}
        {explain && <i className="stat-q" aria-hidden>?</i>}
      </div>
      <div className="stat-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {meter && (
        <div className={`meter ${meter.kind ?? 'pos'}`}>
          <i style={{ width: `${Math.max(0, Math.min(100, meter.pct))}%` }} />
        </div>
      )}
      {children}
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
  return explain ? <Tip content={explain}>{body}</Tip> : body;
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="sechead">
      <h2>{title}</h2>
      <span className="rule" />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/**
 * The comparables range, drawn rather than printed.
 *
 * Floor, median and ceiling are the 20th, 50th and 80th percentile of what the
 * most similar historical seasons actually did the FOLLOWING year — so the bar
 * is a distribution of outcomes, not a projection with error bars.
 *
 * Two reference marks sit on the same axis, and they are the point of the
 * redesign. Without them the numbers float: a ceiling of 288 looks fine until
 * you know the player scored 335 last season, and the old bar gave the reader no
 * way to know that. The bar also used to scale itself so the floor pinned to the
 * left edge and the ceiling to the right, which made every range — 40 points
 * wide or 300 — look exactly the same width.
 *
 * `midpointUnreliable` marks the median as the weak part of the reading rather
 * than withholding the whole bar. Measured twice now, on two different measures
 * of neighbourhood quality, the answer is the same both times: a loose
 * neighbourhood roughly doubles the error on the midpoint and leaves the
 * floor-to-ceiling spread doing its job. Drawing the median faint says that
 * where it happens, which is what "read the spread, not the midpoint" means when
 * it is a picture rather than a sentence.
 */
function OutlookRange({
  floor,
  median,
  ceiling,
  own,
  ownLabel,
  replacement,
  digits = 0,
  unit,
  midpointUnreliable = false,
}: {
  floor: number;
  median: number;
  ceiling: number;
  own: number | null;
  ownLabel: string;
  replacement: number | null;
  digits?: number;
  unit: string;
  midpointUnreliable?: boolean;
}) {
  const marks = [floor, median, ceiling, own, replacement].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  // A little air either side so a mark never sits under the panel edge.
  const pad = (hi - lo) * 0.08 || 1;
  const span = hi - lo + pad * 2;
  const at = (v: number) => `${((v - lo + pad) / span) * 100}%`;
  const fmt = (v: number) => v.toFixed(digits);

  return (
    <div className="outlook-range">
      <div className="outlook-track">
        <span className="outlook-band" style={{ left: at(floor), right: `${100 - parseFloat(at(ceiling))}%` }} />

        {replacement !== null && replacement >= lo && replacement <= hi && (
          <span className="outlook-ref repl" style={{ left: at(replacement) }}>
            <i />
            <small>replacement {fmt(replacement)}</small>
          </span>
        )}

        <span className="outlook-marker" style={{ left: at(floor) }}>
          <span>{fmt(floor)}</span>
          <i />
          <small>floor</small>
        </span>
        <span
          className={`outlook-marker mid${midpointUnreliable ? ' unreliable' : ''}`}
          style={{ left: at(median) }}
        >
          <span>{fmt(median)}</span>
          <i />
          <small>{midpointUnreliable ? 'median · rough' : 'median'}</small>
        </span>
        <span className="outlook-marker" style={{ left: at(ceiling) }}>
          <span>{fmt(ceiling)}</span>
          <i />
          <small>ceiling</small>
        </span>

        {own !== null && (
          <span className="outlook-ref own" style={{ left: at(own) }}>
            <i />
            <small>
              {ownLabel} {fmt(own)}
            </small>
          </span>
        )}
      </div>
      <div className="outlook-ends">
        <span>20th percentile</span>
        <span>{unit}</span>
        <span>80th percentile</span>
      </div>
    </div>
  );
}

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = getPlayerDetail(id, FORMAT, TEAMS, SEASON);
  if (!detail) notFound();

  const {
    header, role, value, waiver, props, rawLines, context, weekly, latestContextSeason,
    scouting,
  } = detail;
  const { prev, next } = getNeighbours(id, FORMAT, TEAMS, SEASON);

  const seasonProps = props.filter((p) => p.scope === 'season');
  const gameProps = props.filter((p) => p.scope === 'game');
  const isReceiver = header.position === 'WR' || header.position === 'TE';
  const isRusher = header.position === 'RB';
  const isPasser = header.position === 'QB';
  const team = teamOf(header.team);
  /*
   * Read from the player, not from `value`. Hanging the comparables off the
   * board row meant the panel existed for the 162 players FantasyFootballCalculator
   * prices and for nobody else — so the players a waiver claim is actually made
   * on, who are undrafted by definition, had the most useful section on the page
   * silently omitted.
   */
  const outlookDetail = detail.outlook;
  const outlook = outlookDetail?.outlook ?? null;

  const read = buildRead({
    // One confidence label on the page: the case owns it. See read.ts.
    caseConfidence: value?.playerCase?.confidence ?? null,
    name: header.name,
    position: header.position,
    adp: value?.adp ?? null,
    points: value?.blendedPoints ?? (waiver ? waiver.points : null),
    vorp: value?.blendedVorp ?? waiver?.vorp ?? null,
    replacement: value?.replacement ?? outlookDetail?.replacement ?? null,
    equivalentPick: value?.blendedAdpEquivalent ?? waiver?.equivalentPick ?? null,
    signal: value?.signal ?? (waiver ? 'none' : null),
    usageGrade: value?.usageGrade ?? waiver?.grade ?? null,
    marketPct: value?.marketPct ?? null,
    certainty: role?.certainty ?? null,
    depthRank: role?.depthRank ?? waiver?.depthRank ?? null,
    certaintyReasons: role?.reasons ?? [],
    outlook,
    archetype: outlookDetail?.archetype ?? null,
    risks: (value?.tags ?? [])
      .filter((t) => t.kind === 'risk')
      .sort((a, b) => b.weight - a.weight)
      .map((t) => ({ label: t.label, detail: t.detail })),
    expectedGames: value?.expectedGames ?? null,
    undrafted: !value,
  });

  /*
   * The weekly bar to clear. Replacement level is a season figure, so dividing
   * by a full season gives the per-week pace a freely available player sets —
   * the same calibrated number the board ranks on rather than a round guess.
   */
  const startableLine = (value?.replacement ?? 120) / 17;

  /*
   * One sentence for the back of the card.
   *
   * This used to be the raw outlook string, which is a JSON blob — the card
   * printed `{"n":40,"floor":55.84,...}` at the reader. The archetype is the
   * human-readable summary of the same comparison.
   */
  /*
   * The comparables sentence, built from the span the pool actually covers.
   *
   * It used to read "since 2018" as a fixed string while the pool ran 2021-2024,
   * which is the stale-fact family: a number on screen asserting a range the
   * data does not have. It also only appeared for drafted players, so the card
   * for a waiver target said nothing about his outlook at all.
   */
  const compSentence = outlook
    ? outlook.sparse
      ? // No close analogue quotes the SPREAD and never the midpoint. The card
        // is one sentence with no room for a caveat, and the midpoint is the
        // half of the reading the backtest says not to trust.
        `No close historical profile — the least-unlike roles spanned ${outlook.floor.toFixed(0)}–${outlook.ceiling.toFixed(0)} half-PPR points.`
      : `${outlook.n} similar seasons, ${outlook.fromSeason}–${outlook.toSeason}, went on to a median of ` +
        `${outlook.median.toFixed(0)} half-PPR points — ${outlook.medianPpg.toFixed(1)} a game.`
    : null;

  const blurb = value
    ? [
        value.archetype ? value.archetype[0]!.toUpperCase() + value.archetype.slice(1) : null,
        compSentence,
      ]
        .filter(Boolean)
        .join(' ') || 'Shown with market and usage detail on his page.'
    : waiver
      ? [
          `Undrafted. Role graded ${waiver.grade}/100 at ${header.position}` +
            (waiver.depthRank ? `, listed ${header.position}${waiver.depthRank}` : '') +
            (waiver.vacated >= 0.15
              ? `, with ${Math.round(waiver.vacated * 100)}% of the work ahead of him vacated.`
              : '.'),
          compSentence,
        ]
          .filter(Boolean)
          .join(' ')
      : 'No market and no measured role — shown for reference only.';

  return (
    <main
      className="wrap"
      style={{ ...teamStyle(header.team), ['--pos-color' as string]: positionColor(header.position) }}
    >
      <p className="crumb">
        <a href="/">← Draft board</a>
        {!value && <a href="/waiver">← Waiver wire</a>}
        {prev && <a href={`/player/${prev.id}`}>↑ {prev.name}</a>}
        {next && <a href={`/player/${next.id}`}>↓ {next.name}</a>}
      </p>

      <div className="playerhead">
        <ToppsCard
          name={header.name}
          position={header.position}
          team={header.team}
          bye={header.bye}
          espnId={header.espnId}
          adp={value?.adp ?? null}
          badge={
            value?.blendedVorp != null
              ? {
                  value: (value.blendedVorp > 0 ? '+' : '') + value.blendedVorp.toFixed(0),
                  label: 'value',
                  good: value.blendedVorp > 0,
                }
              : waiver
                ? { value: String(waiver.grade), label: 'grade', good: waiver.grade >= 60 }
                : null
          }
          columns={cardColumns(header.position)}
          seasons={cardSeasons(header.position, context)}
          blurb={blurb}
          rookieSeason={header.rookieSeason}
          status={header.status}
        />

        <div className="playerhead-main">
          <h1>{header.name}</h1>
          <p className="sub">
            <span className="pos-badge">{header.position}</span>{' '}
            <span className="team-badge">
              <span className="team-dot" aria-hidden />
              {team.name}
            </span>{' '}
            · bye {header.bye ?? '—'} ·{' '}
            {value ? (
              <>
                ADP <strong>{value.adp.toFixed(1)}</strong>
              </>
            ) : (
              <span className="avail wire">undrafted</span>
            )}
            {header.status && header.status !== 'ACT' ? ` · ${header.status}` : ''}
          </p>

          {/*
            The read, before any of the numbers.

            Everything else on this page is a figure with an explanation
            attached; this is the conclusion in the language someone would use
            out loud. It exists because the page could answer "what is his target
            share" from six directions and could not answer "so what do you think
            of him" from any.
          */}
          <section className="read">
            <div className="read-head">
              <h2>{read.headline}</h2>
              <Tip content={read.convictionWhy}>
                <span className={`read-conv c-${read.conviction}`} tabIndex={0}>
                  {read.conviction} conviction
                </span>
              </Tip>
            </div>
            {read.body.map((line, idx) => (
              <p key={idx}>{line}</p>
            ))}
          </section>

          {/*
            The case for and against.

            This replaced a flat list of tags as the primary read. Tags were
            peers, so Matthew Golden carried GEM and NO UPSIDE at the same time
            with nothing on the page to say which one it meant — two claims from
            two evidence bases of completely different quality, rendered as two
            identical chips. Here there is exactly one verdict and everything
            else is argument, so two points disagreeing is the case working
            rather than the page contradicting itself.

            Every line states its own evidence strength, because that is the
            thing the reader could not previously see: "measured" means a
            calibration in this project backs it and the hover quotes the number,
            "weak" means a real effect too small to lean on, "fact" is
            description, and "unknown" means it was measured and carries no
            direction at all — vacated volume being the whole of that category.
          */}
          {value?.playerCase && (
            <section className="card pcase">
              <div className="pcase-head">
                <h2>{value.playerCase.headline}</h2>
                <Tip content={value.playerCase.confidenceWhy}>
                  <span className={`read-conv c-${value.playerCase.confidence}`} tabIndex={0}>
                    {value.playerCase.confidence} confidence
                  </span>
                </Tip>
              </div>
              {([
                ['for', 'The case for'],
                ['against', 'The case against'],
                ['unknowns', 'Measured to carry no direction'],
              ] as const).map(([key, title]) =>
                value.playerCase![key].length ? (
                  <div className={`pcase-col pcase-${key}`} key={key}>
                    <h3>{title}</h3>
                    <ul>
                      {value.playerCase![key].map((p, idx) => (
                        <li key={idx}>
                          <Tip content={p.basis}>
                            <span tabIndex={0}>
                              <span className={`pcase-str s-${p.strength}`}>{p.strength}</span>
                              {p.text}
                            </span>
                          </Tip>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
              {!value.playerCase.for.length && !value.playerCase.against.length && (
                <p className="caveat">
                  Nothing calibrated in this project applies to him either way. Everything on this
                  page below is description, and should be read as description.
                </p>
              )}
            </section>
          )}

          {value?.verdict && (
            <p style={{ margin: '0 0 var(--s3)', fontSize: 15, fontWeight: 620 }}>
              {value.verdict[0]!.toUpperCase() + value.verdict.slice(1)}
              {value.archetype && (
                <span className="muted" style={{ fontWeight: 400 }}> · {value.archetype}</span>
              )}
            </p>
          )}

          {value?.tags && value.tags.length > 0 && (
            <div style={{ margin: '0 0 var(--s4)' }}>
              {value.tags.map((t) => (
                <Tip key={t.id} content={t.detail}>
                  <span className={`tag k-${t.kind}`} style={{ cursor: 'help' }} tabIndex={0}>
                    {t.label}
                  </span>
                </Tip>
              ))}
            </div>
          )}

          {value && value.slotGap !== null ? (
            <div className="grid c4">
              <Stat
                label="Projected points"
                value={num(value.blendedPoints)}
                note={
                  <>
                    Half-PPR, full season.{' '}
                    {value.signal === 'full'
                      ? 'Market and usage combined'
                      : value.signal === 'partial'
                        ? 'Partial market, leaning on usage'
                        : 'Usage only — no betting lines'}
                    .
                  </>
                }
                explain={
                  <>
                    What he is expected to score across seventeen games under this league&rsquo;s
                    rules: 0.1 per yard, 6 per touchdown, 0.5 per catch, −2 per turnover.{' '}
                    {value.signal === 'full'
                      ? 'Built from his posted sportsbook props and his on-field role, combined 60/40 by rank within his position.'
                      : value.signal === 'partial'
                        ? 'Some props are posted and the rest is filled from his role, so this leans on usage more than a fully priced player does.'
                        : 'No book prices him, so this is entirely his on-field role run through the usage model, stretched back onto the real points scale.'}{' '}
                    The full arithmetic is in &ldquo;How his VALUE is built&rdquo; below.
                  </>
                }
              />
              <Stat
                label="Value"
                value={
                  value.blendedVorp === null
                    ? '—'
                    : (value.blendedVorp > 0 ? '+' : '') + value.blendedVorp.toFixed(0)
                }
                tone={(value.blendedVorp ?? 0) > 0 ? 'var(--value)' : 'var(--reach)'}
                note="Points above a freely available player."
                explain={
                  <>
                    Projected points minus what a free {header.position} is worth —{' '}
                    {value.replacement === null ? '—' : value.replacement.toFixed(0)} points, the best one
                    sitting on nobody&rsquo;s roster in a {TEAMS}-team league. It is the board&rsquo;s
                    sort order because it is the one number that compares positions fairly: 250 points from
                    a quarterback is worth less than 180 from a tight end, since quarterbacks are
                    easy to replace and tight ends are not.
                  </>
                }
              />
              <Stat
                label="Gap vs ADP"
                value={
                  value.blendedSlotGap === null
                    ? '—'
                    : (value.blendedSlotGap > 0 ? '+' : '') + value.blendedSlotGap.toFixed(1)
                }
                tone={(value.blendedSlotGap ?? 0) > 0 ? 'var(--value)' : 'var(--reach)'}
                note="In draft picks of value."
                explain={
                  <>
                    His VALUE is looked up on the curve of what each draft slot has actually returned
                    since 2018, which gives the pick he is priced like. Subtract where he is really
                    going and you get this.{' '}
                    {value.adpEquivalent !== null && (
                      <>
                        He projects like pick <b>{value.adpEquivalent.toFixed(1)}</b> and is going at{' '}
                        <b>{value.adp.toFixed(1)}</b>.{' '}
                      </>
                    )}
                    Positive means the market is late to him. It is secondary to VALUE on purpose:
                    slot gap once made deep quarterbacks look elite while they projected below
                    replacement.
                  </>
                }
              />
              <Stat
                label="Usage grade"
                value={value.usageGrade ?? '—'}
                meter={{ pct: value.usageGrade ?? 0 }}
                note="Role ranked against his position."
                explain={
                  <>
                    His percentile among every graded {header.position} on what the usage model
                    projects from his role alone — target or rush share, red-zone and goal-line work,
                    first downs, team scoring, age. 0 is the worst role at the position and 100 the
                    best. This ignores the market entirely, which is the point: where it disagrees
                    with the price is where the interesting picks are.
                    {header.position === 'QB' && (
                      <>
                        {' '}
                        Read quarterback grades with more caution — the position&rsquo;s model
                        explains 36% of next-season points against roughly 55% elsewhere.
                      </>
                    )}
                  </>
                }
              />
              <Stat
                label="Role certainty"
                value={role ? `${role.certainty}%` : '—'}
                tone={role && role.certainty < 40 ? 'var(--warn)' : undefined}
                note={
                  role
                    ? `Listed ${header.position}${role.depthRank}. Chance he still holds the job.`
                    : 'Not on a depth chart.'
                }
                explain={
                  <>
                    Three independent facts are compared: where the depth chart lists him, where his
                    production ranked in his own position room last season, and how much time he
                    misses. Where they agree, certainty is high. Where they disagree — listed second
                    but out-produced the man above him, or listed first with a rookie drafted behind
                    him — the job is contested, and that disagreement is the number. It is not a
                    projection of his points; it is the chance the rest of this page is describing
                    the right role.
                  </>
                }
              >
                {role && (
                  <div className="certainty-bar">
                    <i
                      style={{
                        width: `${role.certainty}%`,
                        background:
                          role.certainty >= 60
                            ? 'var(--value)'
                            : role.certainty >= 40
                              ? 'var(--warn)'
                              : 'var(--reach)',
                      }}
                    />
                  </div>
                )}
              </Stat>
              <Stat
                label="Upside"
                value={outlook && !outlook.sparse ? pct0(outlook.breakoutRate) : '—'}
                tone={(outlook?.breakoutRate ?? 0) >= 0.3 ? 'var(--value)' : undefined}
                note={
                  outlook && !outlook.sparse
                    ? `Comparables finishing top-12. ${pct0(outlook.bustRate)} returned nothing.`
                    : 'No close historical analogue.'
                }
                explain={
                  outlook && !outlook.sparse ? (
                    <>
                      Of the {outlook.n} historical seasons whose role, scoring opportunity,
                      production and age most resembled his, this share went on to finish top-12 at
                      the position the following year — a player you start every week. Closer
                      matches count for more. It is a frequency from real seasons, not a model
                      output: {pct0(outlook.bustRate)} of the same group returned less than half of
                      replacement, and {pct0(outlook.vanishRate)} never played again.
                    </>
                  ) : (
                    <>
                      No historical season resembles his closely enough to draw a rate from. That is
                      a finding about him rather than missing data — see the comparables section
                      below.
                    </>
                  )
                }
              />
            </div>
          ) : waiver ? (
            <div className="grid c5">
              <div className="stat">
                <div className="stat-label">Usage grade</div>
                <div
                  className="stat-value"
                  style={{ color: waiver.grade >= 60 ? 'var(--value)' : undefined }}
                >
                  {waiver.grade}
                </div>
                <div className="meter pos">
                  <i style={{ width: `${waiver.grade}%` }} />
                </div>
                <div className="stat-note">Role ranked against his position, 0–100.</div>
              </div>
              {/*
                The number a waiver claim actually turns on: what comparable
                roles produced per game. The board's projected-points tile is
                meaningless here — there is no market on an undrafted player —
                but the comparables are not, and they were being withheld from
                the only page where this question gets asked.
              */}
              {/*
                The number an undrafted player was missing entirely. A grade of
                84 says he holds a good role for his position; "projects like
                pick 66, and costs a waiver claim" is the decision. This could
                not be shown until the usage scale was unified — the wire's own
                doc comment said so, because subtracting an actual-points
                replacement level from a regressed projection produced nonsense.
              */}
              <div className="stat">
                <div className="stat-label">Projects like pick</div>
                <div
                  className="stat-value"
                  style={{
                    color:
                      waiver.equivalentPick !== null && waiver.equivalentPick <= 120
                        ? 'var(--value)'
                        : undefined,
                  }}
                >
                  {waiver.equivalentPick === null ? '—' : waiver.equivalentPick.toFixed(0)}
                </div>
                <div className="stat-note">
                  {waiver.equivalentPick === null ? (
                    <>
                      He projects below anything the draft curve covers — it runs to pick 200,
                      and nobody is drafted lower than that. Not &ldquo;like pick 200&rdquo;: off
                      the end of the scale entirely, which is the normal state of a backup.
                      {waiver.vorp !== null && ` He is ${Math.abs(waiver.vorp).toFixed(0)} points below replacement in his current role.`}
                    </>
                  ) : waiver.vorp === null ? (
                    'No baseline curve for his position.'
                  ) : (
                    <>
                      {waiver.vorp >= 0
                        ? `${waiver.vorp.toFixed(0)} points above replacement`
                        : `${Math.abs(waiver.vorp).toFixed(0)} below replacement`}
                      . That is what pick {waiver.equivalentPick.toFixed(0)} has returned
                      historically — and he is free.
                    </>
                  )}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Comparable output</div>
                <div className="stat-value">
                  {outlook && !outlook.sparse ? outlook.medianPpg.toFixed(1) : '—'}
                </div>
                {/*
                  The tile IS the midpoint, so with no close analogue it stays an
                  em dash — that is the half of the reading the backtest breaks.
                  The note points at the range below rather than implying there
                  is nothing to read, which is what it used to do.
                */}
                <div className="stat-note">
                  {outlook && !outlook.sparse
                    ? `Half-PPR per game, median of ${outlook.n} similar roles. Range ${outlook.floorPpg.toFixed(1)}–${outlook.ceilingPpg.toFixed(1)}.`
                    : outlook?.sparse
                      ? `No close analogue, so no midpoint. The spread below still reads: ${outlook.floorPpg.toFixed(1)}–${outlook.ceilingPpg.toFixed(1)} a game.`
                      : 'Too few games to profile him.'}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Volume available</div>
                <div
                  className="stat-value"
                  style={{ color: waiver.vacated >= 0.25 ? 'var(--value)' : undefined }}
                >
                  {Math.round(waiver.vacated * 100)}%
                </div>
                <div className="meter team">
                  <i style={{ width: `${Math.min(100, waiver.vacated * 200)}%` }} />
                </div>
                <div className="stat-note">Work he competes for that is open.</div>
              </div>
              <div className="stat">
                <div className="stat-label">Role certainty</div>
                <div
                  className="stat-value"
                  style={{ color: role && role.certainty < 40 ? 'var(--warn)' : undefined }}
                >
                  {role ? `${role.certainty}%` : '—'}
                </div>
                {role && (
                  <div className="certainty-bar">
                    <i
                      style={{
                        width: `${role.certainty}%`,
                        background: role.certainty >= 60 ? 'var(--value)' : role.certainty >= 40 ? 'var(--warn)' : 'var(--reach)',
                      }}
                    />
                  </div>
                )}
                <div className="stat-note">
                  {role ? `Listed ${header.position}${role.depthRank}. Chance he still holds this role.` : 'Not on a depth chart.'}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ---------------- the room ---------------- */}
      {role && role.room.length > 1 && (
        <>
          <SectionHead
            title="The depth chart"
            hint={`${teamOf(header.team).nick} ${header.position}s, as listed today`}
          />
          <section className="card">
            <p className="body">
              Every projection on this page assumes he keeps doing what he did. Whether he keeps the
              job is a separate question, and this is it. The column that matters is{' '}
              <strong>direction</strong>: whether the man at the top is about to give the job up,
              and whether anyone below him is about to take it. A static risk score for every row
              answers a question nobody asks during a draft.
            </p>

            <div className="room-head">
              <span />
              <span>Player</span>
              <span>2025 share of the work</span>
              <span>Which way he is moving</span>
            </div>
            <div className="room">
              {role.room.map((m) => (
                <div className="room-row" key={m.playerId} data-self={m.isSelf}>
                  <span className="room-rank">
                    {header.position}
                    {m.depthRank}
                  </span>
                  <span className="room-name">
                    {m.isSelf ? m.name : <a className="name" href={`/player/${m.playerId}`}>{m.name}</a>}
                    <small>
                      {m.usageRank
                        ? `${m.usageRank}${m.usageRank === 1 ? 'st' : m.usageRank === 2 ? 'nd' : m.usageRank === 3 ? 'rd' : 'th'} heaviest ${header.position === 'RB' ? 'rush' : 'target'} share in this room`
                        : 'no measured role last season'}
                    </small>
                  </span>
                  <span className="room-share">
                    {m.volumeShare > 0 ? (
                      <>
                        {Math.round(m.volumeShare * 100)}%
                        {m.shareTeam && <small className="faint" style={{ display: 'block', fontSize: 9.5 }}>at {m.shareTeam}</small>}
                      </>
                    ) : (
                      <span className="faint">none</span>
                    )}
                  </span>
                  <span className="room-vuln">
                    {!m.hasRole ? (
                      <b className="faint" style={{ fontWeight: 400 }}>no real role</b>
                    ) : (
                      /* No `title` here: the reason is already rendered as
                         visible text in `room-why` one column over, so the
                         attribute was a second copy of the same sentence behind
                         a one-second delay that never appears on touch. */
                      <b className={`room-trend ${m.trend}`}>
                        {m.trend === 'rising' ? '↑ gaining' : m.trend === 'slipping' ? '↓ losing ground' : '→ holding'}
                      </b>
                    )}
                  </span>
                  <span className="room-why">{m.hasRole ? m.trendReason : ''}</span>
                </div>
              ))}
            </div>
            <p className="legend" style={{ marginTop: 'var(--s3)' }}>
              Every arrow names the fact behind it, in the row.{' '}
              <strong>↓ losing ground</strong> means either that somebody listed below him took more
              of <em>this team&rsquo;s</em> work last season, or — for the man listed first, who is
              the only one with a job to lose — that his own games or age say so, with the figure
              given. <strong>↑ gaining</strong> is the mirror: he took more of the work than
              somebody listed above him, or the man <em>directly</em> ahead is the fragile one.{' '}
              <strong>→ holding</strong> is most of a depth chart and should read that way.
            </p>
            <p className="legend">
              Two things are deliberately <em>not</em> an arrow.{' '}
              <strong>A player who arrived from another team</strong> is marked as such and holds:
              his share was earned on a different roster, so it is not evidence about this room, and
              guessing a direction from it is how a receiver read &ldquo;losing ground&rdquo; to a
              team-mate who had never played beside him.{' '}
              <strong>No real role</strong> means under 8% of the position&rsquo;s work, or a share
              measured over fewer than four games — a share is computed over the weeks a man
              appeared, so one relief appearance can read as a large share of nothing.
            </p>
            <p className="legend">
              {/*
                Say what has been cut, or the reader assumes the chart is wrong.
                The alternative was a fifteen-man camp roster, where a seventh
                back costs the same attention as the starter.
              */}
              The room is cut to the men who can hold or take a role — measured at four deep for
              quarterbacks, five for backs, six for receivers and three for tight ends, which is
              where a listing stops carrying information. Anyone who held a real share last season,
              or who is being drafted, is kept however deep the camp chart lists him. Shares are each
              man&rsquo;s {SEASON - 1} usage on whichever team he was with, so a room can total over
              100% when someone arrived from elsewhere — those carry the team they were earned at.
            </p>
            {role.reasons.length > 0 && (
              <p className="caveat warn">{role.reasons.join(' · ')}</p>
            )}
          </section>
        </>
      )}

      {/* ---------------- undrafted ---------------- */}
      {!value && waiver && (
        <>
          <SectionHead title="Why he is not on the board" />
          <section className="card">
            <p className="body">
              There is no ADP for him, so there is no price to judge — the board’s frame of value
              against cost does not apply. What is left is the question the waiver wire asks: what
              was his role, and is work opening up ahead of him.
            </p>
            {waiver.opportunity && (
              <p className="body">
                <strong>Opportunity.</strong> {waiver.opportunity}
              </p>
            )}
            {waiver.notes.length > 0 && <p className="caveat warn">{waiver.notes.join(' · ')}</p>}
            {!waiver.qualified && (
              <p className="caveat">
                Below the evidence floor — too little involvement or too few games to judge him
                either way. That is not a verdict, it is the absence of one.
              </p>
            )}
            <p className="caveat">
              <a href="/waiver">See him against the rest of the wire →</a>
            </p>
          </section>
        </>
      )}

      {/* ---------------- how VALUE is built ---------------- */}
      {value?.derivation && value.derivation.length > 0 && (
        <>
          <SectionHead
            title="How his VALUE is built"
            hint="every step, in order"
          />
          <section className="card">
            <p className="body">
              VALUE is the number the board sorts on, and it is the end of a chain rather than a
              judgement. Each row below is one step of that chain — what it added, what the running
              total became, and why the step exists at all. If you disagree with the answer, this is
              where to find the assumption you disagree with.
            </p>

            <div className="deriv">
              {value.derivation.map((step, i) => (
                <details className={`deriv-step k-${step.kind}`} key={`${step.kind}-${i}`}>
                  <summary>
                    <span className="deriv-idx">{i + 1}</span>
                    <span className="deriv-label">{step.label}</span>
                    <span className="deriv-nums">
                      {step.value !== null && (
                        <b className="deriv-value">
                          {step.kind === 'replacement' || step.kind === 'result'
                            ? `${step.value >= 0 ? '+' : ''}${step.value.toFixed(0)}`
                            : step.value.toFixed(0)}
                        </b>
                      )}
                      {step.running !== null && step.kind !== 'result' && (
                        <small>runs to {step.running.toFixed(0)}</small>
                      )}
                    </span>
                  </summary>
                  <div className="deriv-detail">
                    <p>{step.detail}</p>

                    {/*
                      The usage step opens into the model's own arithmetic. Each
                      input times its fitted weight, in points — so "his target
                      share is 24%" becomes "which is worth 31 points of this".
                      A coefficient without the multiplication is not an
                      explanation, it is a second number to take on faith.
                    */}
                    {step.inputs && step.inputs.length > 0 && (
                      <table className="deriv-inputs">
                        <thead>
                          <tr>
                            <th className="l">What was measured</th>
                            <th>His value</th>
                            <th>Average {header.position}</th>
                            <th>Worth vs average</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...step.inputs]
                            .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
                            .map((inp) => (
                              <tr key={inp.label}>
                                <td className="l">{inp.label}</td>
                                <td>
                                  {inp.label === 'age'
                                    ? inp.value.toFixed(0)
                                    : inp.value < 1.5
                                      ? `${(inp.value * 100).toFixed(1)}%`
                                      : inp.value.toFixed(1)}
                                </td>
                                <td className="faint">
                                  {inp.label === 'age'
                                    ? inp.average.toFixed(1)
                                    : inp.average < 1.5
                                      ? `${(inp.average * 100).toFixed(1)}%`
                                      : inp.average.toFixed(1)}
                                </td>
                                <td className={inp.contribution >= 0 ? 'pos' : 'neg'}>
                                  {inp.contribution >= 0 ? '+' : ''}
                                  {inp.contribution.toFixed(1)}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </details>
              ))}
            </div>

            <p className="legend">
              Click any step to open it. The percentages are shares of his team&rsquo;s work; the
              points column is that share multiplied by the weight the model fitted for it, which is
              multiplied by the weight the model fitted for it — so it reads as "worth N points more
              than a typical {header.position}". Those sum to his distance from the average
              projection, not to the projection itself.
            </p>
          </section>
        </>
      )}

      {/* ---------------- scouting ---------------- */}
      {scouting && scouting.indicators.length > 0 && (
        <>
          <SectionHead
            title="The scouting read"
            hint={`${scouting.season}, ${scouting.games} games · per opportunity, not per season`}
          />
          <section className="card">
            <p className="body">
              Volume says how often he touched the ball. This says what happened when he did, and
              what offence it happened in. Every indicator below was measured against next-season
              points twice — on its own, and again after removing what{' '}
              {scouting.position === 'RB' ? 'rush' : 'target'} share already explains. Only the
              second number is a second opinion, and it is the one quoted in each hover.
            </p>

            <div className="scout-grid">
              {scouting.indicators.map((ind) => (
                <Tip key={ind.id} content={ind.detail}>
                  <div className="scout" tabIndex={0}>
                    <div className="scout-label">{ind.label}</div>
                    <div className="scout-value">{ind.display}</div>
                    {ind.percentile !== null ? (
                      <>
                        <div className="meter pos">
                          <i style={{ width: `${ind.percentile}%` }} />
                        </div>
                        <div className="scout-note">
                          {ind.percentile}{ord(ind.percentile)} percentile among {header.position}s
                        </div>
                      </>
                    ) : (
                      <div className="scout-note faint">too few at the position to rank</div>
                    )}
                    <div className="scout-weight">
                      predictive weight {ind.weight.toFixed(2)}
                    </div>
                  </div>
                </Tip>
              ))}
            </div>

            {/* ------------- the offence around him ------------- */}
            <h3 className="outlook-h">
              The offence he plays in
              {scouting.environment.team ? ` — ${scouting.environment.team}` : ''}
            </h3>
            {/*
              For anyone who moved, this whole block is the RIGHT team measured
              in a season he was not on it. Both halves of that have to be said:
              naming only the team implies he was part of these numbers, and
              naming only the season leaves the reader assuming it is his old
              one. `team_context` cannot reach further forward — it is built
              from play-by-play, and 2026 has not been played.
            */}
            {scouting.movedFrom && (
              <p className="legend">
                He arrives from <strong>{scouting.movedFrom}</strong>, so every number in this
                block is <strong>{scouting.environment.team}</strong> in {scouting.season} —
                the offence he is joining, measured the season before he joined it. His own
                production above was earned at {scouting.movedFrom}.
              </p>
            )}
            <div className="grid c4">
              <div className="stat">
                <div className="stat-label">Scoring offence</div>
                <div className="stat-value">
                  {scouting.environment.pointsRank ?? '—'}
                  {scouting.environment.pointsRank && <small className="ord">{ord(scouting.environment.pointsRank)}</small>}
                </div>
                <div className="stat-note">
                  {scouting.environment.pointsFor ?? '—'} points in {scouting.season}.
                  {' '}Team scoring carries a .20 partial correlation with a receiver&rsquo;s next season.
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Quarterback</div>
                <div className="stat-value">
                  {scouting.environment.qbEpaRank ?? '—'}
                  {scouting.environment.qbEpaRank && <small className="ord">{ord(scouting.environment.qbEpaRank)}</small>}
                </div>
                {/*
                  The EPA is the TEAM's per dropback, not one man's. Printing a
                  single name beside it implied otherwise, which matters exactly
                  when it is least obvious: Cincinnati's 2025 number is mostly
                  backup play, and labelling it "Joe Burrow" made a season he
                  largely missed look like a season he played badly.
                */}
                <div className="stat-note">
                  {scouting.environment.qbEpaDropback === null
                    ? '—'
                    : `${scouting.environment.qbEpaDropback.toFixed(3)} EPA per dropback, all passers`}
                  .{' '}
                  {scouting.environment.primaryQbName && (
                    <>
                      {scouting.environment.primaryQbName} took{' '}
                      {scouting.environment.primaryQbShare === null
                        ? 'most'
                        : `${Math.round(scouting.environment.primaryQbShare * 100)}%`}{' '}
                      of them.
                    </>
                  )}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Play-caller lean</div>
                <div className="stat-value">
                  {scouting.environment.passOe === null
                    ? '—'
                    : `${scouting.environment.passOe > 0 ? '+' : ''}${scouting.environment.passOe.toFixed(1)}`}
                </div>
                <div className="stat-note">
                  Pass rate over expected. Positive means he throws more than the situation calls
                  for. Measured as no help to a projection — shown as context, not signal.
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Offensive EPA</div>
                <div className="stat-value">
                  {scouting.environment.offEpaRank ?? '—'}
                  {scouting.environment.offEpaRank && <small className="ord">{ord(scouting.environment.offEpaRank)}</small>}
                </div>
                <div className="stat-note">Per play, ranked across the 32 offences.</div>
              </div>
            </div>

            {/* ------------- who calls the plays, and who blocks ------------- */}
            <h3 className="outlook-h">The play caller and the line</h3>
            <div className="grid c4">
              <div className="stat">
                <div className="stat-label">
                  Head coach{scouting.environment.team ? `, ${scouting.environment.team}` : ''}
                </div>
                <div className="stat-value coach">{scouting.environment.headCoach ?? '—'}</div>
                <div className="stat-note">
                  {/*
                    The tile is labelled with the team because the name alone is
                    unfalsifiable to a reader who does not already know where the
                    player is — which is exactly the reader this tile is for.
                    Jahan Dotson read "Nick Sirianni" for a season he will spend
                    in Atlanta, and nothing on the tile made that checkable.
                  */}
                  Who called the plays there in {scouting.season}, from play-by-play — the head
                  coach rather than the coordinator, since nflverse publishes no coordinator table.
                  {scouting.movedFrom
                    ? ' He was not in this building last season, and a coaching change costs a running back about 12 points, so treat a new room as a real unknown.'
                    : ' A coaching change costs a running back about 12 points: backs who stayed put lost 24.5 the next season against 12.5 for backs who kept their coach.'}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">His lead back gets</div>
                <div className="stat-value">
                  {scouting.environment.coachTopBackShare === null
                    ? '—'
                    : `${Math.round(scouting.environment.coachTopBackShare * 100)}%`}
                </div>
                <div className="stat-note">
                  Mean share of carries this coach&rsquo;s top back has taken. Concentration follows
                  the coach — it repeats at r=0.337 when he stays and only r=0.107 when a team
                  changes coach. Two to five seasons each, so read it as a lean.
                </div>
              </div>
              {/*
                Both blocking numbers are shown and neither feeds a projection,
                for opposite reasons. Run blocking was measured and does not
                predict RB scoring at all. Pass protection DOES predict QB
                scoring — but it is absorbed by offence EPA, which the model
                already carries, so adding it buys 0.004 of out-of-sample R².
              */}
              <div className="stat">
                <div className="stat-label">Run blocking</div>
                <div className="stat-value">
                  {scouting.environment.ybcRank ?? '—'}
                  {scouting.environment.ybcRank && <small className="ord">{ord(scouting.environment.ybcRank)}</small>}
                </div>
                <div className="stat-note">
                  {scouting.environment.ybcPerCarry === null
                    ? 'No data.'
                    : `${scouting.environment.ybcPerCarry.toFixed(2)} yards before contact per carry. `}
                  Shown, not scored: measured against next-season RB points it lands at 0.02–0.08
                  once rush share is known. Volume is the coach&rsquo;s decision, not the
                  line&rsquo;s.
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Pass protection</div>
                <div className="stat-value">
                  {scouting.environment.passBlockRank ?? '—'}
                  {scouting.environment.passBlockRank && <small className="ord">{ord(scouting.environment.passBlockRank)}</small>}
                </div>
                <div className="stat-note">
                  {scouting.environment.sackRateAllowed === null
                    ? 'No data.'
                    : `${(scouting.environment.sackRateAllowed * 100).toFixed(1)}% of dropbacks sacked. `}
                  Real for quarterbacks (0.28 after usage) but absorbed by offensive EPA, which the
                  projection already uses — so it explains the number rather than moving it.
                </div>
              </div>
            </div>

            {/* ------------- the receiver screen ------------- */}
            {scouting.screen && (
              <>
                <h3 className="outlook-h">
                  The WR1 profile — {scouting.screen.passed} of 5
                </h3>
                <div className="screen">
                  {scouting.screen.filters.map((f) => (
                    <div className={`screen-row ${f.ok ? 'ok' : 'no'}`} key={f.id}>
                      <span className="screen-mark">{f.ok ? '✓' : '✗'}</span>
                      <span className="screen-label">{f.label}</span>
                      <span className="screen-actual">{f.actual}</span>
                    </div>
                  ))}
                </div>
                <p className="legend">
                  {scouting.screen.clears ? (
                    <>
                      <strong>He clears all five.</strong> Receivers who did averaged{' '}
                      <strong>228</strong> half-PPR points the following season with{' '}
                      <strong>62%</strong> finishing top-12, against 142 points and 20% for
                      receivers who held a real role and did not — a three-fold lift in the
                      probability of a startable season, and the strongest single screen in this
                      tool.
                    </>
                  ) : (
                    <>
                      Of the five WR1 seasons on record here, three cleared all five filters.
                      Jefferson 2022 missed only on his quarterback ranking 12th rather than
                      top-10; Chase 2024 missed only on 2.27 yards per route against a 2.30 line.
                      So this describes the archetype well and the cutoffs are not a law — read{' '}
                      <strong>{scouting.screen.passed} of 5</strong> as a gradient, and check which
                      one is missing.
                    </>
                  )}
                </p>
              </>
            )}

            {/* ------------- run direction ------------- */}
            {scouting.runSplit && (
              <>
                <h3 className="outlook-h">Where his carries go</h3>
                <div className="runsplit">
                  <div className="runsplit-bar">
                    {(() => {
                      const s = scouting.runSplit!;
                      const total = s.outside + s.tackle + s.inside || 1;
                      return (
                        <>
                          <span className="rs out" style={{ width: `${(s.outside / total) * 100}%` }}>
                            {Math.round((s.outside / total) * 100)}%
                          </span>
                          <span className="rs tak" style={{ width: `${(s.tackle / total) * 100}%` }}>
                            {Math.round((s.tackle / total) * 100)}%
                          </span>
                          <span className="rs ins" style={{ width: `${(s.inside / total) * 100}%` }}>
                            {Math.round((s.inside / total) * 100)}%
                          </span>
                        </>
                      );
                    })()}
                  </div>
                  <div className="runsplit-key">
                    <span>
                      <i className="out" /> outside{' '}
                      {scouting.runSplit.outsideYpc !== null && (
                        <b>{scouting.runSplit.outsideYpc.toFixed(2)} y/c</b>
                      )}
                    </span>
                    <span>
                      <i className="tak" /> off tackle
                    </span>
                    <span>
                      <i className="ins" /> interior{' '}
                      {scouting.runSplit.insideYpc !== null && (
                        <b>{scouting.runSplit.insideYpc.toFixed(2)} y/c</b>
                      )}
                    </span>
                  </div>
                </div>
                <p className="legend">
                  <strong>Shown, not scored — and here is why.</strong> This is run{' '}
                  <em>direction</em>, not blocking scheme; nflverse charts no zone/gap flag, so
                  true scheme data would need PFF or SIS. More to the point, it was tested and it
                  does not predict. A back&rsquo;s per-carry edge outside over interior does not
                  persist from one season to the next at all (<strong>r = −0.010</strong> across 104
                  consecutive-season pairs), so there is no stable trait for a scheme to suit.
                  Matching that edge to his next team&rsquo;s tendency returned nothing: the
                  best-fit third scored <strong>147.5</strong> the following season against{' '}
                  <strong>146.7</strong> for the worst-fit third. The league premise is unstable
                  too — outside runs beat interior by 0.16 and 0.11 yards in 2021–22, then lost by
                  0.11 and 0.15 in 2023–24. It is real description of how he is used, and it is not
                  a forecast.
                </p>
              </>
            )}
          </section>
        </>
      )}

      {/* ---------------- outlook ---------------- */}
      {/*
        ONE panel for every player, because the difference between a common
        profile and an unprecedented one is a caption, not a missing chart.

        This used to be two branches: a player whose nearest historical season
        sat past his position's no-analogue band got a comparison list and no
        range, everyone else got both. That put Puka Nacua, Jaxon Smith-Njigba,
        Christian McCaffrey and Rashee Rice — four of the twelve most expensive
        players in the draft — on a visibly different panel from the rest, so a
        reader starting at the top of the board met the exception before the
        rule and read it as a missing feature.

        The suppression was also against this project's own calibration.
        `calibrate:comparables` now replicates the shipped gate and buckets every
        backtested season either side of it: a remote neighbourhood breaks the
        MIDPOINT and not the RANGE. Mean error on the median roughly doubles at
        running back (43 to 80) while interval coverage holds or runs wide — 0.89
        at receiver against a 0.60 target, on the largest suppressed group and
        the position 11 of 13 picks come from. Same shape the closeShare buckets
        found, and the same conclusion the file header already drew: report
        support, read the spread, do not suppress the range.

        The RATES are a different claim on the same neighbourhood and were not
        tested here, so they stay withheld — as do the ranked percentiles (#93).
      */}
      {outlookDetail && (
        <>
          <SectionHead
            title="What happened to players like him"
            hint={`${outlook!.n} closest seasons, ${outlook!.fromSeason}–${outlook!.toSeason} · outcomes to ${outlook!.outcomeToSeason}`}
          />
          <section className="card">
            {outlook!.sparse ? (
              <p className="body">
                <strong>Nothing in the record looks much like him.</strong> Across every{' '}
                {header.position} season from {outlook!.fromSeason} to {outlook!.toSeason}, his
                single closest match sits further away than a typical {header.position}&rsquo;s{' '}
                <em>middling</em> one — {outlook!.nearestDistance.toFixed(2)} against{' '}
                {outlook!.bands.noAnalogue.toFixed(2)} on the same scale. That is a finding about
                him rather than a gap in the data, and it is why no hit or bust rate is quoted for
                him: those are claims about a group he does not belong to. The range below is
                still drawn, with the caveat that goes under it.
              </p>
            ) : (
              <p className="body">
                His {outlookDetail.profileSeason} role, scoring opportunity, production and age were
                matched against every {header.position} season from {outlook!.fromSeason} to{' '}
                {outlook!.toSeason}, and the {outlook!.n} closest were followed into the{' '}
                <em>next</em> year.{' '}
                {/*
                One framing, once. The bust bar is now replacement itself, so
                "cleared replacement" and "busted" are the same measurement with
                the sign flipped — and this page was printing both, a few inches
                apart, as though they were two facts. The board column is called
                BUST, so bust is the wording everywhere.
                */}
                <strong>{pct0(outlook!.bustRate)}</strong> of them were worth less than a{' '}
                {header.position} you could have picked up for free,{' '}
                <strong>{pct0(outlook!.breakoutRate)}</strong> finished top-12 at the position, and{' '}
                <strong>{pct0(outlook!.vanishRate)}</strong> never took another offensive snap.
              </p>
            )}

            {/*
              Why the pool stops a year short of the newest season played, said
              on the page instead of left for the reader to wonder about.

              The panel printed the profile span alone, so a board built for 2026
              announced itself with "2021–2024" and read as a tool that had
              stopped ingesting a year ago. It had not: every one of those
              seasons is followed into the year after, so the outcomes here run a
              year later than the label did. Both ends are now stated.
            */}
            <p className="legend">
              The pool ends at {outlook!.toSeason} because a season only teaches something once the
              following one has been played — so {outlook!.toSeason} is the newest profile with an
              answer attached, and what these seasons went on to do runs from{' '}
              {outlook!.outcomeFromSeason} through <strong>{outlook!.outcomeToSeason}</strong>, the
              most recent completed season.
            </p>

            <div className="outlook-meta">
              <Tip content={SUPPORT_NOTE[outlook!.support].detail}>
                <span className={`tag ${SUPPORT_NOTE[outlook!.support].cls}`} tabIndex={0} style={{ cursor: 'help' }}>
                  {outlook!.sparse ? 'no close analogue' : SUPPORT_NOTE[outlook!.support].label} ·{' '}
                  {pct0(outlook!.closeShare)} genuine matches
                </span>
              </Tip>
              <Tip content={`Profiled on ${outlookDetail.profileGames} games. Shares are stable from small samples — a four-game rush share predicts the next season's at r=0.919 — but points per game is noisier, so a short profile widens the range rather than sharpening it.`}>
                <span className="tag k-coverage" tabIndex={0} style={{ cursor: "help" }}>
                  profiled on {outlookDetail.profileSeason}, {outlookDetail.profileGames} games
                </span>
              </Tip>
              {outlookDetail.archetype && (
                <span className="tag k-coverage">{outlookDetail.archetype}</span>
              )}
            </div>

            {/*
              Two scales, because the question changes with the calendar. In
              August a season total is the unit of a draft pick. In week 8 a
              waiver claim is decided on what he does per game from here, and a
              season total is that number plus an injury history nobody is
              buying.
            */}
            <h3 className="outlook-h">Per game — what a start is worth</h3>
            <OutlookRange
              floor={outlook!.floorPpg}
              median={outlook!.medianPpg}
              ceiling={outlook!.ceilingPpg}
              own={outlookDetail.ownPpg}
              ownLabel={`his ${outlookDetail.profileSeason}`}
              replacement={outlookDetail.replacement !== null ? outlookDetail.replacement / 17 : null}
              digits={1}
              unit="half-PPR points per game"
              midpointUnreliable={outlook!.sparse}
            />

            <h3 className="outlook-h">Across a full season</h3>
            <OutlookRange
              floor={outlook!.floor}
              median={outlook!.median}
              ceiling={outlook!.ceiling}
              own={outlookDetail.ownPoints}
              ownLabel={`his ${outlookDetail.profileSeason}`}
              replacement={outlookDetail.replacement}
              unit="half-PPR points, full season"
              midpointUnreliable={outlook!.sparse}
            />

            {outlook!.sparse ? (
              <p className="legend">
                <strong>Read the width, not the middle.</strong> The forty seasons behind this bar
                are the least dissimilar available rather than genuine matches, and that damages the
                two ends of the reading differently. Checked against 74 seasons whose following year
                is already known, the middle number roughly doubles in error — which is why it is
                drawn faint — while the floor-to-ceiling spread still contained what actually
                happened about as often as it does for an ordinary profile, and for receivers rather
                more often than that. Seventy-four seasons is a small sample and running backs were
                the one position that disagreed, so read the band as a rough width and treat his own
                record, the depth chart and the market as the evidence.
              </p>
            ) : (
              <p className="legend">
                The band is drawn from the comparables who <strong>took the field</strong> the
                following year; the {pct0(outlook!.vanishRate)} who did not are counted in the rate
                above rather than dragged into the floor, because a floor that means &ldquo;out of the
                league&rdquo; cannot be read as a floor. Of those who played, the median managed{' '}
                <strong>{outlook!.medianNextGames.toFixed(0)}</strong> games. Closer seasons count for
                more than distant ones.
              </p>
            )}

            {/*
              THE NAMED-COMPARISON LIST IS GONE, deliberately.

              It listed the six nearest historical seasons by player and showed
              what each did the following year. The RANGE above is the useful
              half of that machinery — it is a distribution of outcomes, and it
              is what the backtest actually validates. The list was six rows of
              other men's names, which invites reading one analogy as a forecast
              ("he is the next Rhamondre Stevenson") when the model is making no
              such claim about any individual comparable.

              The comparables themselves still do all the work; only the roster
              of names is off the page. Nothing else in the panel changes.
            */}
          </section>
        </>
      )}

      {/* ---------------- the price read ---------------- */}
      {value && value.slotGap !== null && (
        <>
          <SectionHead title="Is he worth his price" hint={`ADP ${value.adp.toFixed(1)}`} />
          <section className="card">
            <div className="headline">
              <span className={`gap ${value.slotGap > 0 ? 'pos' : 'neg'} big`}>
                {(value.slotGap > 0 ? '+' : '') + value.slotGap.toFixed(1)}
              </span>
              <div>
                <strong style={{ fontSize: 15 }}>
                  {value.slotGap > 0 ? 'Value' : 'Reach'} of {Math.abs(value.slotGap).toFixed(1)} picks
                </strong>
                <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                  Priced like pick {value.adpEquivalent!.toFixed(1)}; going at {value.adp.toFixed(1)}.
                </div>
              </div>
            </div>

            <table className="mini">
              <tbody>
                <tr>
                  <td>Implied points</td>
                  <td>{num(value.impliedPoints)}</td>
                  <td className="muted">from posted props, scored at {FORMAT}</td>
                </tr>
                <tr>
                  <td>Replacement ({header.position})</td>
                  <td>−{num(value.replacement)}</td>
                  <td className="muted">3-season mean for a {TEAMS}-team league</td>
                </tr>
                <tr className="rule">
                  <td>Value over replacement</td>
                  <td>{num(value.impliedVorp)}</td>
                  <td className="muted">what the market says he is worth</td>
                </tr>
                <tr>
                  <td>Expected at ADP {value.adp.toFixed(1)}</td>
                  <td>{num(value.expectedVorp)}</td>
                  <td className="muted">
                    what that pick returned 2018–2025 ({value.baselineSampleN} nearby picks)
                  </td>
                </tr>
                <tr className="rule">
                  <td>Gap</td>
                  <td>{num((value.impliedVorp ?? 0) - value.expectedVorp)}</td>
                  <td className="muted">points above what the slot has paid</td>
                </tr>
              </tbody>
            </table>

            {/*
              What VALUE structurally cannot say, stated beside it.

              VALUE compares a player to a FREE replacement and, measured against
              what players went on to return, it stops discriminating after round
              three (rho .268 in rounds 1-3, then .080 and .058). These two are
              the gaps: VONA compares him to the alternative a drafter would
              ACTUALLY take, and the startable rate restates the same projection
              in the units a weekly league is played in.
            */}
            {(value.vona !== null || value.startableRate !== null) && (
              <table className="kv" style={{ marginTop: 'var(--s3)' }}>
                <tbody>
                  {value.vona !== null && (
                    <tr>
                      <th>Worth over the next man at his position</th>
                      <td>
                        <b>{value.vona >= 0 ? '+' : ''}{value.vona.toFixed(0)}</b>
                        {value.vonaRound !== null && (
                          <span className="muted"> · {value.vonaRound >= 0 ? '+' : ''}{value.vonaRound.toFixed(0)} if you only wait one round</span>
                        )}
                      </td>
                      <td className="muted">
                        against the best {header.position} expected to last 24 picks — a snake turn
                      </td>
                    </tr>
                  )}
                  {value.dropToNext !== null && value.nextAtPosition && (
                    <tr>
                      <th>Next {header.position} off the board</th>
                      <td>{value.nextAtPosition}</td>
                      <td className="muted">
                        {value.dropToNext >= 0
                          ? `${value.dropToNext.toFixed(0)} points behind him`
                          : `${Math.abs(value.dropToNext).toFixed(0)} points ahead of him — the board has them in the wrong order`}
                      </td>
                    </tr>
                  )}
                  {value.startableRate !== null && (
                    <tr>
                      <th>Weeks he should be startable</th>
                      <td><b>{Math.round(value.startableRate * 100)}%</b></td>
                      <td className="muted">
                        of the games he plays, inside the top{' '}
                        {header.position === 'RB' ? 24 : header.position === 'WR' ? 36 : 12} at his position
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
            {value.startableRate !== null && (
              <p className="caveat">
                The startable share is this projection <em>restated</em>, not a second opinion on it.
                Measured over 1,782 season pairs, a player&rsquo;s startable rate carries nothing once
                his points per game are known — the partial is −0.03 for receivers, 0.06 for backs,
                0.14 for quarterbacks — and only 4&ndash;5% of players sit more than 15 points of rate
                away from what their scoring level implies. It is here because a season total hides
                how a weekly league is played, not because it adds information.
              </p>
            )}

            {value.opportunityNote && <p className="caveat">{value.opportunityNote}</p>}
            {value.riskNotes && <p className="caveat warn">{value.riskNotes}</p>}

            {/*
              Market coverage, moved here from the draft board.

              It belongs on the player rather than in a board column: whether a
              sportsbook posts a line is a fact about the sportsbook, and among
              fourteen columns that describe the player it read as a fifteenth
              one that did. It matters here because it says how much of the
              projection is a market read and how much is the usage model —
              which is the single largest thing separating two players with the
              same VALUE.
            */}
            <p className="caveat">
              {value.signal === 'none'
                ? `No sportsbook posts a season line on him, so this projection is the usage model ` +
                  `alone, pulled ${Math.round((1 - 0.3) * 100)}% toward what his draft slot has ` +
                  `historically returned. That is a statement about the betting market's coverage, ` +
                  `not about him — 65 board players are in the same position.`
                : value.signal === 'partial'
                  ? `Sportsbooks price ${Math.round(value.completeness * 100)}% of what he scores, ` +
                    `and the rest is scaled up from the categories they do price. Read it as a ` +
                    `weaker market signal than a fully covered player's.`
                  : `Fully priced — ${value.marketStats} posted season lines, devigged and scored ` +
                    `under this league's rules. The market carries 60% of his blended projection.`}
            </p>

            {(value.extrapolatedStats > 0 || value.derivedStats > 0) && (
              <p className="caveat">
                {value.marketStats} came from posted season lines
                {value.extrapolatedStats > 0 &&
                  `, ${value.extrapolatedStats} ${plural(value.extrapolatedStats)} scaled from a Week 1 line`}
                {value.derivedStats > 0 &&
                  `, ${value.derivedStats} ${plural(value.derivedStats)} converted from another line`}
                .
              </p>
            )}
            {value.adpEquivalent !== null && value.adpEquivalent <= 1.01 && (
              <p className="caveat">
                His implied value sits above the top of the historical curve, which is flat across
                picks 1–7.5 — eight seasons cannot tell those picks apart. The gap shown is a floor.
              </p>
            )}
            {isPasser && value.slotGap > 20 && (
              <p className="caveat warn">
                Quarterback gaps run hot. Books only price expected starters, so a deep-ADP QB is
                compared against a historical pool full of players who never took a snap.
              </p>
            )}
          </section>
        </>
      )}

      {value && value.slotGap === null && (
        <>
          <SectionHead title="Is he worth his price" />
          <section className="card">
            <strong>No market signal.</strong>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 13.5 }}>
              No book posts the props that define this position for him, so there is nothing to set
              against his ADP. The read here rests on usage alone — no projection is invented to
              fill the gap.
            </p>
          </section>
        </>
      )}

      {/* ---------------- role ---------------- */}
      <SectionHead title="How he was used" hint="nflverse play-by-play" />
      {context.length ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Season</th>
                <th>G</th>
                <th>Snap%</th>
                {isReceiver || isRusher ? <th>Tgt</th> : null}
                {isReceiver ? <th>Tgt share</th> : null}
                {isReceiver ? <th>Air yd share</th> : null}
                {isRusher || isReceiver ? <th>Rec</th> : null}
                {isRusher || isReceiver ? <th>Rec yd</th> : null}
                {isRusher ? <th>Car</th> : null}
                {isRusher ? <th>Rush yd</th> : null}
                {isPasser ? <th>Pass yd</th> : null}
                {isPasser ? <th>Pass TD</th> : null}
                <th>Half-PPR</th>
              </tr>
            </thead>
            <tbody>
              {context.map((c) => (
                <tr key={c.season}>
                  <td>{c.season}</td>
                  <td>{c.games}</td>
                  <td>{snapPct(c.snapPct)}</td>
                  {isReceiver || isRusher ? <td>{num(c.targets)}</td> : null}
                  {isReceiver ? <td>{pct(c.targetShare)}</td> : null}
                  {isReceiver ? <td>{pct(c.airYardsShare)}</td> : null}
                  {isRusher || isReceiver ? <td>{num(c.receptions)}</td> : null}
                  {isRusher || isReceiver ? <td>{num(c.receivingYards)}</td> : null}
                  {isRusher ? <td>{num(c.carries)}</td> : null}
                  {isRusher ? <td>{num(c.rushingYards)}</td> : null}
                  {isPasser ? <td>{num(c.passingYards)}</td> : null}
                  {isPasser ? <td>{num(c.passingTds)}</td> : null}
                  <td>
                    <strong>{num(c.fantasyPointsHalf, 1)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No regular-season history — likely a rookie.</p>
      )}

      {weekly.length > 1 && (
        <>
          <SectionHead
            title="How often he was worth starting"
            hint={`${latestContextSeason} week by week`}
          />
          <section className="card">
            <WeeklyBars
              weeks={weekly.map((w) => ({ week: w.week, points: w.points }))}
              threshold={startableLine}
              label={`the weekly pace of a replacement ${header.position} in a ${TEAMS}-team league`}
            />
            <p className="legend">
              The dashed line is replacement level for his position spread across a season — the
              pace a freely available player sets. Green weeks beat it. This is consistency rather
              than a total: two backs can finish on the same points with one of them useless in
              nine weeks out of fifteen, and that difference decides games.
            </p>
          </section>
        </>
      )}

      {/* ---------------- market ---------------- */}
      {seasonProps.length > 0 && (
        <>
          <SectionHead title="What sportsbooks price" hint="devigged, margin removed" />
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="l">Stat</th>
                  <th>Line</th>
                  <th>P(over)</th>
                  <th>Implied</th>
                  <th>Books</th>
                  <th className="l">Source</th>
                </tr>
              </thead>
              <tbody>
                {seasonProps.map((p) => (
                  <tr key={p.stat}>
                    <td className="l">{STAT_LABEL[p.stat] ?? p.stat}</td>
                    <td>{p.line === null ? '—' : num(p.line, 1)}</td>
                    <td>{p.pOver === null ? '—' : pct(p.pOver)}</td>
                    <td>
                      <strong>{num(p.mu, p.mu < 20 ? 1 : 0)}</strong>
                    </td>
                    <td>{p.bookCount || '—'}</td>
                    <td className="l muted">{sourceNote(p.source, p.basis)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/*
           * The individual book quotes are provenance, not a finding. They were
           * dumped on the page as a second full-width table, which buried the
           * read under the plumbing. They stay one click away.
           */}
          {rawLines.length > 0 && (
            <details className="prov">
              <summary>Show the {rawLines.length} individual book quotes behind these numbers</summary>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th className="l">Book</th>
                      <th className="l">Stat</th>
                      <th className="l">Scope</th>
                      <th>Line</th>
                      <th>Over</th>
                      <th>Under</th>
                      <th className="l">Game</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawLines.map((l, i) => (
                      <tr key={i}>
                        <td className="l">{l.book}</td>
                        <td className="l">{STAT_LABEL[l.stat] ?? l.stat}</td>
                        <td className="l muted">{l.scope}</td>
                        <td>{num(l.line, 1)}</td>
                        <td>{odds(l.overPrice)}</td>
                        <td>{odds(l.underPrice)}</td>
                        <td className="l muted">
                          {l.scope === 'season' ? (
                            'full season'
                          ) : isPreseason(l.gameDate) ? (
                            <>
                              {l.gameDate} <span className="flag">preseason, unused</span>
                            </>
                          ) : (
                            (l.gameDate ?? '—')
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {gameProps.length > 0 && (
                <p className="legend">
                  Only regular-season game lines feed a projection. Preseason lines are listed for
                  completeness but never used — a starter’s August line describes two series.
                </p>
              )}
            </details>
          )}
        </>
      )}

      <p className="legend">
        <a href="/legend">Full plain-language legend →</a>
      </p>
    </main>
  );
}
