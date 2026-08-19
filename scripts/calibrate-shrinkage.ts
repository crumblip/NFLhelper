import { sqlite } from '../lib/db/index';

/**
 * How much should a share measured over N games be trusted?
 *
 * `projectUsage` weights each season by games/17 and then renormalises the
 * weights so "a player with only one season is not penalised". For a player with
 * two or three seasons that is correct — it decides how to mix them. For a
 * player with exactly one it cancels the sample-size penalty completely, and his
 * rates enter the model raw however few games produced them.
 *
 * The effect is not academic. Raheim Sanders played four games in 2025, posted a
 * 26% rush share and a 36% goal-line share while covering for an injured starter,
 * and comes out projected ABOVE Dylan Sampson, who played fifteen games at a 17%
 * share and is listed in front of him. Small-sample players are precisely the
 * population a sleeper list is drawn from, so this error contaminates the part
 * of the board that is supposed to find value.
 *
 * The fix is to shrink a share toward the positional mean by how much evidence
 * stands behind it — weight = g/(g+k) on the player's own rate, the rest on the
 * position average. This measures k rather than picking it: for each candidate,
 * how well does the shrunk share predict the SAME player's share next season?
 *
 * Shares are the target rather than points because the model consumes shares,
 * and because next-season points confound role with team quality and health.
 */

const MIN_NEXT_GAMES = 8;

interface Row {
  player_id: string;
  season: number;
  position: string;
  games: number;
  rush_share: number | null;
  target_share: number | null;
  rz_touch_share: number | null;
}

const rows = sqlite
  .prepare(
    `SELECT player_id, season, position, games, rush_share, target_share, rz_touch_share
     FROM player_usage WHERE position IN ('RB','WR','TE') ORDER BY player_id, season`,
  )
  .all() as Row[];

const byPlayer = new Map<string, Row[]>();
for (const r of rows) {
  const list = byPlayer.get(r.player_id) ?? [];
  list.push(r);
  byPlayer.set(r.player_id, list);
}

/** Positional means, which are what a thin sample regresses toward. */
const means = new Map<string, { rush: number; target: number; rz: number }>();
for (const pos of ['RB', 'WR', 'TE']) {
  const g = rows.filter((r) => r.position === pos && r.games >= 8);
  const avg = (f: (r: Row) => number | null) => {
    const v = g.map(f).filter((x): x is number => x !== null);
    return v.reduce((a, b) => a + b, 0) / (v.length || 1);
  };
  means.set(pos, {
    rush: avg((r) => r.rush_share),
    target: avg((r) => r.target_share),
    rz: avg((r) => r.rz_touch_share),
  });
}

interface Pair {
  position: string;
  games: number;
  observed: number;
  mean: number;
  next: number;
}

const METRICS = [
  ['rush share', (r: Row) => r.rush_share, (m: { rush: number }) => m.rush],
  ['target share', (r: Row) => r.target_share, (m: { target: number }) => m.target],
  ['red-zone share', (r: Row) => r.rz_touch_share, (m: { rz: number }) => m.rz],
] as const;

function corr(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 5) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

/** Mean absolute error of the shrunk estimate against what actually happened. */
function mae(pairs: Pair[], k: number): number {
  let sum = 0;
  for (const p of pairs) {
    const w = p.games / (p.games + k);
    const shrunk = p.observed * w + p.mean * (1 - w);
    sum += Math.abs(shrunk - p.next);
  }
  return sum / pairs.length;
}

console.log('SAMPLE-SIZE SHRINKAGE — how far to trust a share measured over N games\n');

for (const [label, get, pick] of METRICS) {
  const pairs: Pair[] = [];
  for (const seasons of byPlayer.values()) {
    for (let i = 0; i < seasons.length - 1; i++) {
      const cur = seasons[i]!;
      const nxt = seasons[i + 1]!;
      if (nxt.season !== cur.season + 1) continue;
      if (nxt.games < MIN_NEXT_GAMES) continue;
      const observed = get(cur);
      const next = get(nxt);
      if (observed === null || next === null) continue;
      const m = means.get(cur.position);
      if (!m) continue;
      pairs.push({
        position: cur.position,
        games: cur.games,
        observed,
        mean: pick(m as never),
        next,
      });
    }
  }

  if (pairs.length < 60) {
    console.log(`${label}: only ${pairs.length} pairs, skipping\n`);
    continue;
  }

  let best = { k: 0, err: Infinity };
  const scan: string[] = [];
  for (const k of [0, 1, 2, 3, 4, 6, 8, 10, 14, 20]) {
    const err = mae(pairs, k);
    scan.push(`k=${k}:${err.toFixed(4)}`);
    if (err < best.err) best = { k, err };
  }

  const raw = corr(pairs.map((p) => p.observed), pairs.map((p) => p.next));
  const shrunkVals = pairs.map((p) => {
    const w = p.games / (p.games + best.k);
    return p.observed * w + p.mean * (1 - w);
  });
  const shrunkR = corr(shrunkVals, pairs.map((p) => p.next));

  console.log(`${label} — ${pairs.length} season pairs`);
  console.log(`  ${scan.join('  ')}`);
  console.log(
    `  best k = ${best.k}  (error ${best.err.toFixed(4)} vs ${mae(pairs, 0).toFixed(4)} unshrunk, ` +
      `${(((mae(pairs, 0) - best.err) / mae(pairs, 0)) * 100).toFixed(1)}% better)`,
  );
  console.log(`  correlation with next season: raw ${raw.toFixed(3)} -> shrunk ${shrunkR.toFixed(3)}`);

  // The population this actually matters for.
  const thin = pairs.filter((p) => p.games <= 6);
  if (thin.length >= 20) {
    console.log(
      `  players with <=6 games (n=${thin.length}): error ${mae(thin, 0).toFixed(4)} unshrunk -> ` +
        `${mae(thin, best.k).toFixed(4)} shrunk`,
    );
  }
  console.log();
}
