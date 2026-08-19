import { sqlite } from '../lib/db/index';
import { fetchAdp, type ScoringFormat } from '../lib/providers/adp/ffc';
import { SCOPED_POSITIONS, normalizeTeam } from '../lib/match/normalize';

const FORMAT = (process.env.SCORING_FORMAT ?? 'half-ppr') as ScoringFormat;
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const CURRENT = Number(process.env.SEASON ?? 2026);

/**
 * History back to 2018 is what the ADP baseline curve is fit on (section 3):
 * each past year's ADP joined to that year's actual points is the empirical
 * answer to "what does a pick here return?". The current year is the board.
 */
const FROM = Number(process.env.ADP_FROM_SEASON ?? 2018);

const stmt = sqlite.prepare(
  `INSERT OR REPLACE INTO adp_raw
   (ffc_player_id, format, teams, year, player_id, name, position, team,
    adp, adp_formatted, times_drafted, high, low, stdev, bye, fetched_at)
   VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let year = FROM; year <= CURRENT; year++) {
  try {
    const res = await fetchAdp(FORMAT, TEAMS, year);
    // DEF and K are dropped at the door — they are out of scope for this tool.
    const scoped = res.players.filter((p) => SCOPED_POSITIONS.has(p.position.toUpperCase()));

    const now = Date.now();
    const run = sqlite.transaction(() => {
      /*
       * Replace the year wholesale rather than upserting row by row.
       *
       * FFC's list is a rolling window, so players drop out of it as draft
       * volume shifts. An upsert leaves those behind with a stale ADP and they
       * keep appearing on the board — on one refresh that stranded C.J. Stroud
       * and Kenyon Sadiq near the top of the value list days after the market
       * had stopped pricing them there.
       *
       * The delete sits inside the transaction and after a successful fetch, so
       * a failed request can never wipe a year.
       */
      sqlite
        .prepare(`DELETE FROM adp_raw WHERE format = ? AND teams = ? AND year = ?`)
        .run(FORMAT, TEAMS, year);

      for (const p of scoped) {
        stmt.run(
          p.player_id, FORMAT, TEAMS, year, p.name, p.position.toUpperCase(),
          normalizeTeam(p.team), p.adp, p.adp_formatted, p.times_drafted,
          p.high, p.low, p.stdev, p.bye, now,
        );
      }
    });
    run();

    console.log(
      `${year}: ${scoped.length} in scope (of ${res.players.length}) | ` +
        `${res.meta.total_drafts} drafts | ${res.meta.start_date} to ${res.meta.end_date}`,
    );
  } catch (err) {
    console.log(`${year}: FAILED - ${(err as Error).message}`);
  }

  // FFC refreshes once a day and asks callers not to hammer the endpoint.
  if (year < CURRENT) await sleep(1_000);
}

console.log(`\nADP ingest complete for ${FORMAT} / ${TEAMS}-team.`);
