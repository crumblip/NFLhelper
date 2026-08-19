import { ingestUsage } from '../lib/nflverse/usage';

const CURRENT = Number(process.env.SEASON ?? 2026);
const FROM = Number(process.env.USAGE_FROM_SEASON ?? 2021);

/**
 * Participation data was assumed to start in 2023. It does not — 2021 and 2022
 * both return full route-share coverage. The comparables pool needs every season
 * it can get: a season is only usable as a comparable if the FOLLOWING year is
 * known, so N seasons of usage yields N-1 of comparables. Go further back with
 * USAGE_FROM_SEASON=2018 (~100MB of play-by-play per season).
 */
const seasons = Array.from({ length: CURRENT - FROM }, (_, i) => FROM + i);

await ingestUsage(seasons);
console.log('\ndone');
