import { ingestDraftPicks, ingestDepthCharts } from '../lib/nflverse/situation';

const CURRENT = Number(process.env.SEASON ?? 2026);

await ingestDraftPicks(CURRENT - 8);
await ingestDepthCharts(CURRENT);

console.log('\ndone');
