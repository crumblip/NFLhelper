// Throwaway spike. Question it answers: does ParlayAPI expose SEASON-LONG NFL
// player props (season total rec yards, etc.), or only per-game props?
// Everything downstream of this depends on the answer.
//
// Usage:  node spike/props-probe.mjs YOUR_KEY
//     or  PARLAY_API_KEY=... node spike/props-probe.mjs
//
// Cost: /events is cheap, /props is 3 credits. Total well under 10 of 1000/mo.

import { writeFileSync, mkdirSync } from 'node:fs';

const KEY = process.argv[2] || process.env.PARLAY_API_KEY;
if (!KEY) {
  console.error('Need a key: node spike/props-probe.mjs YOUR_KEY');
  process.exit(1);
}

const BASE = 'https://parlay-api.com/v1';
const SPORT = 'americanfootball_nfl';
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\//, '');
mkdirSync(OUT, { recursive: true });

async function get(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: { 'X-API-Key': KEY } });
  const body = await res.text();
  if (!res.ok) {
    console.error(`\n!! ${res.status} on ${path}\n${body.slice(0, 400)}`);
    return null;
  }
  return JSON.parse(body);
}

// A game prop and a season prop share the same market_key, so the only way to
// tell them apart is scale: nobody throws for 4000 yards in one game.
const SEASON_FLOOR = {
  player_pass_yds: 1000, player_rush_yds: 250, player_reception_yds: 250,
  player_receptions: 25, player_pass_tds: 8, player_rush_tds: 3,
  player_reception_tds: 3, player_pass_completions: 60, player_pass_attempts: 100,
  player_rush_attempts: 60,
};
const looksSeasonScale = (p) =>
  SEASON_FLOOR[p.market_key] != null && p.line >= SEASON_FLOOR[p.market_key];

const tally = (rows, key) =>
  [...rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]);

const run = async () => {
  const events = await get(`/sports/${SPORT}/events`);
  if (events) {
    writeFileSync(`${OUT}events.json`, JSON.stringify(events, null, 2));
    console.log(`events: ${events.length}`);
    for (const e of events.slice(0, 5)) {
      console.log(`  ${e.commence_time}  ${e.away_team} @ ${e.home_team}`);
    }
  }

  const data = await get(`/sports/${SPORT}/props?limit=5000`);
  if (!data) return;
  writeFileSync(`${OUT}props.json`, JSON.stringify(data, null, 2));

  const props = data.props || [];
  console.log(`\nprops: ${props.length}`);
  if (!props.length) {
    console.log('EMPTY. Either no NFL markets are posted yet, or props are');
    console.log('event-scoped and need ?eventId=. Check events output above.');
    return;
  }

  console.log('\nmarket_key:');
  for (const [k, n] of tally(props, 'market_key')) console.log(`  ${String(n).padStart(5)}  ${k}`);

  console.log('\nbookmaker:');
  for (const [k, n] of tally(props, 'bookmaker')) console.log(`  ${String(n).padStart(5)}  ${k}`);

  console.log(`\nfields on a prop: ${Object.keys(props[0]).join(', ')}`);
  console.log(`distinct players: ${new Set(props.map((p) => p.player_name)).size}`);

  // The actual question.
  const season = props.filter(looksSeasonScale);
  console.log(`\n=== SEASON-LONG PROPS: ${season.length} of ${props.length} ===`);
  if (season.length) {
    writeFileSync(`${OUT}season-props.json`, JSON.stringify(season, null, 2));
    for (const [k, n] of tally(season, 'market_key')) console.log(`  ${String(n).padStart(5)}  ${k}`);
    console.log('\nsamples:');
    for (const p of season.slice(0, 12)) {
      console.log(`  ${p.player_name} | ${p.market_key} ${p.line} | ${p.bookmaker} | o${p.over_price}/u${p.under_price}`);
    }
  } else {
    console.log('  none found -> per-game props only; primary signal must change shape.');
    console.log('\n  per-game samples:');
    for (const p of props.slice(0, 8)) {
      console.log(`  ${p.player_name} | ${p.market_key} ${p.line} | ${p.bookmaker}`);
    }
  }

  console.log(`\nraw payloads written to spike/out/`);
};

run();
