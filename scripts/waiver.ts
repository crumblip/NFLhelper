import { getWaiverBoard, type WaiverRow } from '../lib/waiver';

/**
 * Terminal view of the waiver wire.
 *
 * The logic lives in `lib/waiver.ts` so this and the `/waiver` route cannot
 * disagree about who is available or why. This file is presentation only.
 */

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);
const POSITION = (process.argv[2] ?? '').toUpperCase();

const { rows, meta } = getWaiverBoard(FORMAT, TEAMS, CURRENT);
const filtered = POSITION ? rows.filter((r) => r.position === POSITION) : rows;
const qualified = filtered.filter((r) => r.qualified);

console.log(
  `WAIVER WIRE — ${filtered.length} undrafted players with usage history` +
    (POSITION ? ` (${POSITION} only)` : ''),
);
console.log(
  meta.live
    ? `${meta.season} week ${meta.week} — reading THIS season's usage ` +
      `(${Math.round(meta.currentSeasonWeight * 100)}% of the signal), and opportunity from who sat out last week.`
    : `${meta.season} preseason — reading ${meta.usageSeason} usage and offseason departures.`,
);
console.log(
  `${qualified.length} clear the evidence floor ` +
    `(${meta.minInvolvement * 100}%+ involvement, ${meta.minGames}+ games); ` +
    `${filtered.length - qualified.length} excluded as too little to judge.\n`,
);

const show = (title: string, list: WaiverRow[], sort: (a: WaiverRow, b: WaiverRow) => number) => {
  console.log(title);
  console.log('  pos team  player                 age dep   proj  grade  vacated  tgt%   rz%');
  for (const r of [...list].sort(sort).slice(0, 15)) {
    console.log(
      `  ${r.position.padEnd(3)} ${(r.team ?? '-').padEnd(4)}  ${r.name.padEnd(22)}` +
        `${String(r.age ?? '-').padStart(3)} ${String(r.depthRank).padStart(3)}  ` +
        `${r.points.toFixed(0).padStart(5)}  ${String(r.grade).padStart(5)}  ` +
        `${`${Math.round(r.vacated * 100)}%`.padStart(7)}  ` +
        `${`${((r.targetShare ?? 0) * 100).toFixed(0)}%`.padStart(4)}  ` +
        `${`${((r.rzShare ?? 0) * 100).toFixed(0)}%`.padStart(4)}`,
    );
    if (r.opportunity) console.log(`        ${r.opportunity}`);
    if (r.notes.length) console.log(`        ${r.notes.join(' · ')}`);
  }
  console.log();
};

/*
 * The two tiers describe two different mechanisms and only one of them has been
 * measured.
 *
 * In season, "someone ahead of him is out" is an absence this week and the
 * backup takes those snaps — untested here, but a direct causal step.
 * In the offseason, "volume has left the roster" is NOT a claim that anyone
 * behind it inherits: `calibrate:opportunity` puts the inheritance rate at
 * −0.022 for the first receiver in line and −0.027 for the first back across
 * 1,117 cases, neither distinguishable from zero. Teams replace rather than
 * promote. So the preseason heading states the fact and refuses the inference.
 */
show(
  meta.live
    ? 'PRIORITY ADDS — someone ahead of them is out and they are next in line'
    : 'VOLUME HAS OPENED — nobody is owed it, and these are the men closest to it',
  qualified.filter((r) => r.priority),
  (a, b) => b.vacated - a.vacated,
);

if (meta.live) {
  show(
    'ROLE SHRINKING — snap share falling, worth 1.2 fewer points per game',
    qualified.filter((r) => r.roleShrinking),
    (a, b) => (a.trajectory?.snapDelta ?? 0) - (b.trajectory?.snapDelta ?? 0),
  );
}

show(
  'BEST AVAILABLE BY ROLE — highest usage grade regardless of opportunity',
  qualified,
  (a, b) => b.grade - a.grade,
);

show(
  'YOUNG WITH A PATH — under 25, listed top two, volume open',
  qualified.filter((r) => r.youngPath),
  (a, b) => b.vacated - a.vacated,
);

console.log(
  'In-season this same command surfaces players whose current-year usage is\n' +
    'climbing. Re-run after ingest:usage each week once 2026 data publishes.',
);
