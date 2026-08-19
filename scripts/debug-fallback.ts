import { sqlite } from '../lib/db/index';

/** Are usage-only projections landing on a sane scale? */

const rows = sqlite
  .prepare(
    `SELECT a.name, v.position, v.adp, v.signal, v.usage_points up, v.blended_points bp,
            v.usage_grade ug, v.blended_slot_gap bg
     FROM value_scores v JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
      AND a.format=v.format AND a.teams=v.teams
     WHERE v.season=2026 AND v.position='RB' AND v.blended_points IS NOT NULL
     ORDER BY v.adp`,
  )
  .all() as Array<Record<string, number | string | null>>;

console.log('RB — raw usage projection vs what the blend produced\n');
console.log('    ADP  player                 signal   usage pts  blend pts  grade  slot gap');
for (const r of rows) {
  console.log(
    `  ${String(r.adp).padStart(5)}  ${String(r.name).padEnd(22)} ${String(r.signal).padEnd(8)} ` +
      `${r.up === null ? '    —' : Number(r.up).toFixed(0).padStart(9)}  ` +
      `${r.bp === null ? '    —' : Number(r.bp).toFixed(0).padStart(9)}  ` +
      `${String(r.ug ?? '—').padStart(5)}  ${r.bg === null ? '—' : (Number(r.bg) > 0 ? '+' : '') + Number(r.bg).toFixed(1)}`,
  );
}

const d = sqlite
  .prepare(
    `SELECT AVG(implied_points) m, COUNT(*) n FROM value_scores
     WHERE season=2026 AND position='RB' AND signal='full'`,
  )
  .get() as { m: number; n: number };
const u = sqlite
  .prepare(
    `SELECT AVG(usage_points) m, COUNT(*) n FROM value_scores
     WHERE season=2026 AND position='RB' AND usage_points IS NOT NULL`,
  )
  .get() as { m: number; n: number };
console.log(
  `\nRB market distribution (signal=full only): mean ${d.m?.toFixed(0)} over ${d.n} players`,
);
console.log(`RB usage distribution (all with usage):    mean ${u.m?.toFixed(0)} over ${u.n} players`);
console.log(
  '\nIf the market mean is drawn from a better-covered subset than the usage mean,',
  '\nmapping usage onto the market scale lifts everyone who lacks market coverage.',
);
