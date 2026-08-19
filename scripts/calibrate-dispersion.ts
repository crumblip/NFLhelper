import { sqlite } from '../lib/db/index';
import { calibrateSeason, calibrateGame } from '../lib/pipeline/dispersion';
import type { CanonicalStat } from '../lib/providers/props/markets';

const STATS: CanonicalStat[] = [
  'passingYards', 'passingTds', 'interceptions',
  'rushingYards', 'rushingTds',
  'receptions', 'receivingYards', 'receivingTds',
];

const now = Date.now();
const insert = sqlite.prepare(
  `INSERT OR REPLACE INTO stat_dispersion (stat, scope, cv, sample_n, calibrated_at)
   VALUES (?, ?, ?, ?, ?)`,
);

console.log('calibrating outcome dispersion from nflverse\n');
console.log('  stat              scope     cv    sample');

sqlite.transaction(() => {
  for (const stat of STATS) {
    for (const d of [calibrateSeason(stat), calibrateGame(stat)]) {
      insert.run(d.stat, d.scope, d.cv, d.sampleN, now);
      console.log(
        `  ${d.stat.padEnd(16)}  ${d.scope.padEnd(7)} ${d.cv.toFixed(3).padStart(6)}  ${String(d.sampleN).padStart(6)}`,
      );
    }
  }
})();

console.log('\ncv is sd/mean of the outcome given expectation — higher means a');
console.log('skewed price moves the implied projection further from the line.');
