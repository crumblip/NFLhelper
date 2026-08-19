import { sqlite } from '../lib/db/index';

/** What do young, late-ADP players actually look like on the gem inputs? */

const rows = sqlite
  .prepare(
    `SELECT a.name, v.position, a.team, v.adp, v.vacated_share vac, v.outlook,
            2026 - CAST(substr(p.birth_date,1,4) AS INTEGER) age
     FROM value_scores v
     JOIN adp_raw a ON a.player_id=v.player_id AND a.year=v.season
      AND a.format=v.format AND a.teams=v.teams
     JOIN players p ON p.gsis_id=v.player_id
     WHERE v.season=2026 AND v.position IN ('WR','RB') AND v.adp >= 60
     ORDER BY v.adp`,
  )
  .all() as Array<{
  name: string; position: string; team: string; adp: number;
  vac: number | null; outlook: string | null; age: number | null;
}>;

const young = rows.filter((r) => (r.age ?? 99) <= 25);
console.log(`late (ADP 60+) WR/RB: ${rows.length}, of which age 25 or under: ${young.length}\n`);

const withBreak = young
  .map((r) => {
    let breakoutRate: number | null = null;
    try {
      breakoutRate = r.outlook ? (JSON.parse(r.outlook).breakoutRate as number) : null;
    } catch {
      /* ignore */
    }
    return { ...r, breakoutRate };
  })
  .filter((r) => r.breakoutRate !== null);

console.log(`  of those, with a comparables outlook: ${withBreak.length}\n`);
console.log('  ADP pos team age player                break%  vacated%');
for (const r of withBreak.sort((a, b) => (b.breakoutRate ?? 0) - (a.breakoutRate ?? 0)).slice(0, 20)) {
  console.log(
    `  ${String(r.adp).padStart(5)} ${r.position} ${String(r.team).padEnd(4)} ${String(r.age).padStart(3)} ` +
      `${r.name.padEnd(22)}${`${Math.round((r.breakoutRate ?? 0) * 100)}%`.padStart(6)}  ` +
      `${`${Math.round((r.vac ?? 0) * 100)}%`.padStart(7)}`,
  );
}

const b = withBreak.map((r) => r.breakoutRate ?? 0).sort((a, c) => a - c);
const v = withBreak.map((r) => r.vac ?? 0).sort((a, c) => a - c);
const q = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))] ?? 0;
console.log(
  `\n  breakout rate  p50 ${(q(b, 0.5) * 100).toFixed(0)}%  p75 ${(q(b, 0.75) * 100).toFixed(0)}%  p90 ${(q(b, 0.9) * 100).toFixed(0)}%`,
);
console.log(
  `  vacated share  p50 ${(q(v, 0.5) * 100).toFixed(0)}%  p75 ${(q(v, 0.75) * 100).toFixed(0)}%  p90 ${(q(v, 0.9) * 100).toFixed(0)}%`,
);
