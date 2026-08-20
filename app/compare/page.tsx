import { buildComparePools, comparePlayers } from '../../lib/compare';
import { getSearchIndex } from '../../lib/search';
import CompareView from './compare-view';

export const dynamic = 'force-dynamic';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const SEASON = Number(process.env.SEASON ?? 2026);

export const metadata = {
  title: 'Compare · ChipShip',
  description: 'Two players, the same questions asked of both',
};

/**
 * Head to head.
 *
 * The brief was "show me which one to take without biasing me", and that is a
 * sharper constraint than it sounds. The easy build adds up some metrics,
 * prints a winner and a percentage, and is confidently wrong in a way the
 * reader cannot audit. What this does instead is put both players on the same
 * scale, mark the rows that genuinely separate them, and say plainly when they
 * do not separate at all.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { a, b } = await searchParams;
  const index = getSearchIndex(FORMAT, TEAMS, SEASON);
  const pools = buildComparePools(SEASON);

  const comparison =
    a && b ? comparePlayers(a, b, FORMAT, TEAMS, SEASON, pools) : null;

  return (
    <main className="wrap">
      <h1>Compare</h1>
      <p className="sub">
        Two players, the same questions asked of both · {FORMAT} · {TEAMS}-team
      </p>

      <div className="notice">
        <strong>Every row is ranked within position before the two are compared.</strong> A
        receiver&apos;s 24% target share and a back&apos;s 24% rush share are not the same fact,
        and their raw point totals are not comparable at all: a quarterback outscores a receiver
        by a hundred points a season while being worth less, because twelve quarterbacks start
        and forty-three receivers do. Percentile against his own position is the one number that
        survives crossing between them.
      </div>

      <div className="notice">
        <strong>A row that is too close to call says so rather than picking someone.</strong>{' '}
        Gaps under 10 percentile points sit inside the noise of the measurement behind them and
        are shown as level. Only rows carrying a measured correlation vote on the lean, and each
        votes by its own weight, so first downs cannot be outvoted by three descriptive lines.
      </div>

      <CompareView index={index} comparison={comparison} aId={a ?? null} bId={b ?? null} />
    </main>
  );
}
