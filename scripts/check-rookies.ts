import { sqlite } from '../lib/db/index';
import { getRookieSituations, calibrateRookieBaseline } from '../lib/pipeline/rookie';

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

console.log('rookie draft-capital baseline (2018-2025 outcomes)\n');
console.log('  pos bucket           n   mean VORP   med pts   hit rate');
for (const b of calibrateRookieBaseline(FORMAT, TEAMS, CURRENT)) {
  if (!['WR', 'RB', 'TE'].includes(b.position)) continue;
  console.log(
    `  ${b.position.padEnd(3)} ${b.bucket.padEnd(14)} ${String(b.n).padStart(3)}   ` +
      `${b.meanVorp.toFixed(1).padStart(8)}   ${b.medianPoints.toFixed(0).padStart(7)}   ` +
      `${(b.hitRate * 100).toFixed(0).padStart(6)}%`,
  );
}

console.log(`\n${CURRENT} rookies: market projection against draft-capital baseline\n`);
console.log('   ADP  pos team player                 draft     depth  market  base  hit   read');

const situations = getRookieSituations(FORMAT, TEAMS, CURRENT);
const marketFor = sqlite.prepare(
  `SELECT implied_points AS pts, implied_vorp AS vorp, signal FROM value_scores
   WHERE player_id = ? AND format = ? AND teams = ? AND season = ?`,
);

for (const s of situations) {
  const m = marketFor.get(s.playerId, FORMAT, TEAMS, CURRENT) as
    | { pts: number | null; vorp: number | null; signal: string }
    | undefined;

  const draft = s.pick === null ? 'undrafted' : `rd${s.round} p${s.pick}`;
  const base = s.baselineVorp === null ? '   -' : s.baselineVorp.toFixed(0).padStart(4);
  const hit = s.baselineHitRate === null ? '  -' : `${(s.baselineHitRate * 100).toFixed(0)}%`.padStart(3);
  const mv = m?.vorp ?? null;

  /*
   * Where the market and the draft-capital base rate disagree is the whole
   * point — a book pricing a third-rounder like a starter knows something the
   * base rate does not.
   *
   * But a disagreement is only real if the market number is complete. A partial
   * projection is missing a whole category (most RBs have no receiving line),
   * so it sits below the base rate by construction and would read as "market
   * behind capital" for every early-down back on the board.
   */
  const thin = (s.baselineN ?? 0) < 8 ? ' (thin base)' : '';
  let read: string;
  if (mv === null) {
    read = 'no market — capital only';
  } else if (m?.signal !== 'full') {
    read = 'market incomplete — not comparable';
  } else if (s.baselineVorp === null) {
    read = 'no base rate';
  } else {
    const d = mv - s.baselineVorp;
    read =
      (d > 25 ? 'market ahead of capital' : d < -25 ? 'market behind capital' : 'aligned') + thin;
  }

  console.log(
    `  ${String(s.adp).padStart(5)} ${s.position.padEnd(3)} ${(s.team ?? '-').padEnd(4)} ` +
      `${s.name.padEnd(22)} ${draft.padEnd(9)} ${String(s.depthRank ?? '-').padStart(5)}  ` +
      `${(mv === null ? '   -' : mv.toFixed(0).padStart(6))}  ${base}  ${hit}   ${read}`,
  );
}
