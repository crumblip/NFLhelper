/**
 * Week by week, against the bar that matters.
 *
 * This replaces three sparklines of snap share, target share and points. They
 * were decorative by their own admission — no axis, no scale, no reference, so a
 * reader could see a line wobble and learn nothing from it. Three of them
 * multiplied the problem rather than triangulating it.
 *
 * What a fantasy manager actually needs from a weekly view is not the shape of a
 * curve, it is consistency: how often did starting him work. So every week is a
 * bar, the startable line is drawn across them, and the count is stated in words
 * because that is the finding — the chart is there to show how it was
 * distributed, not to be decoded.
 *
 * The threshold is replacement level divided by a season, so it is the same
 * calibrated number the rest of the tool ranks on rather than a round figure
 * chosen to look tidy.
 */
export default function WeeklyBars({
  weeks,
  threshold,
  label,
}: {
  weeks: Array<{ week: number; points: number | null }>;
  threshold: number;
  label: string;
}) {
  const played = weeks.filter((w) => w.points !== null) as Array<{ week: number; points: number }>;
  if (played.length < 2) return <p className="muted">Not enough weeks to show.</p>;

  const max = Math.max(...played.map((w) => w.points), threshold * 1.6);
  const cleared = played.filter((w) => w.points >= threshold).length;
  const best = Math.max(...played.map((w) => w.points));
  const height = 92;

  return (
    <div className="weekly">
      <div className="weekly-head">
        <span>
          <strong>{cleared}</strong> of {played.length} weeks above{' '}
          <strong>{threshold.toFixed(0)}</strong> points
          <small>{label}</small>
        </span>
        <span className="weekly-best">
          {best.toFixed(0)}
          <small>best week</small>
        </span>
      </div>

      <div className="weekly-plot" style={{ height }}>
        <span
          className="weekly-line"
          style={{ bottom: `${(threshold / max) * 100}%` }}
          aria-hidden
        />
        {weeks.map((w) => (
          <span
            key={w.week}
            className="weekly-bar"
            data-cleared={w.points !== null && w.points >= threshold}
            data-missed={w.points === null}
            style={{ height: w.points === null ? '10px' : `${Math.max(3, (w.points / max) * 100)}%` }}
            title={w.points === null ? `Week ${w.week}: did not play` : `Week ${w.week}: ${w.points.toFixed(1)} pts`}
          />
        ))}
      </div>

      <div className="weekly-axis">
        <span>Week {weeks[0]?.week ?? 1}</span>
        <span className="faint">
          <b className="wk-key cleared" /> above the line &nbsp;
          <b className="wk-key played" /> below it &nbsp;
          <b className="wk-key out" /> did not play
        </span>
        <span>Week {weeks[weeks.length - 1]?.week ?? 18}</span>
      </div>
    </div>
  );
}
