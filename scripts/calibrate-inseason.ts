import { sqlite } from '../lib/db/index';

/**
 * How fast does this season's usage overtake last season's?
 *
 * The in-season blend has to shift weight from a preseason view toward what a
 * player is actually doing now. The question is how fast, and that is
 * measurable: for players N games into a season, compare how well usage so far
 * predicts the rest of that season against how well the prior season does.
 *
 * Where the two curves cross is where current-season usage should take over.
 */

const MIN_REST_GAMES = 4;

interface Row {
  player_id: string;
  season: number;
  week: number;
  position: string;
  targets: number;
  points: number;
}

const weekly = sqlite
  .prepare(
    `SELECT s.player_id, s.season, s.week, s.position,
            COALESCE(s.targets,0) + COALESCE(s.carries,0) AS targets,
            COALESCE(s.fantasy_points_half,0) AS points
     FROM player_stats_week s
     WHERE s.season_type = 'REG' AND s.season >= 2019
       AND s.position IN ('WR','RB','TE')`,
  )
  .all() as Row[];

// Group weekly lines by player-season.
const bySeason = new Map<string, Row[]>();
for (const r of weekly) {
  const k = `${r.player_id}|${r.season}`;
  const list = bySeason.get(k) ?? [];
  list.push(r);
  bySeason.set(k, list);
}
for (const list of bySeason.values()) list.sort((a, b) => a.week - b.week);

/** Prior-season opportunity per game, the preseason view of a player. */
const priorPerGame = new Map<string, number>();
for (const [key, list] of bySeason) {
  const [id, seasonStr] = key.split('|') as [string, string];
  const opp = list.reduce((a, r) => a + r.targets, 0) / list.length;
  priorPerGame.set(`${id}|${Number(seasonStr) + 1}`, opp);
}

function corr(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 25) return NaN;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

console.log('predicting rest-of-season points per game\n');
console.log('  games in    n     prior season   season to date   winner');

for (const cutoff of [1, 2, 3, 4, 5, 6, 8, 10, 12]) {
  const priorPairs: Array<[number, number]> = [];
  const currentPairs: Array<[number, number]> = [];

  for (const [key, list] of bySeason) {
    if (list.length < cutoff + MIN_REST_GAMES) continue;
    const played = list.slice(0, cutoff);
    const rest = list.slice(cutoff);

    const restPpg = rest.reduce((a, r) => a + r.points, 0) / rest.length;
    const toDate = played.reduce((a, r) => a + r.targets, 0) / played.length;
    const prior = priorPerGame.get(key);

    currentPairs.push([toDate, restPpg]);
    if (prior !== undefined) priorPairs.push([prior, restPpg]);
  }

  const rPrior = corr(priorPairs);
  const rCurrent = corr(currentPairs);
  if (Number.isNaN(rPrior) && Number.isNaN(rCurrent)) continue;

  const winner =
    Number.isNaN(rPrior) || Number.isNaN(rCurrent)
      ? '-'
      : rCurrent > rPrior
        ? 'season to date'
        : 'prior season';

  console.log(
    `  ${String(cutoff).padStart(5)}    ${String(currentPairs.length).padStart(4)}   ` +
      `${(Number.isNaN(rPrior) ? '  -' : rPrior.toFixed(3)).padStart(12)}   ` +
      `${(Number.isNaN(rCurrent) ? '  -' : rCurrent.toFixed(3)).padStart(14)}   ${winner}`,
  );
}

console.log('\nOpportunity per game is used as the yardstick on both sides — targets');
console.log('plus carries — because it is the part of usage that carries forward.');
console.log('Where "season to date" overtakes "prior season" is where the blend');
console.log('should hand over.');
