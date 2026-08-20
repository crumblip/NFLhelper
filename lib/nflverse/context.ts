import { sqlite } from '../db/index';
import { NFLVERSE_EXTRA, download, streamCsv, num, str } from './sources';

/**
 * The offence a player plays in, and how he is used inside it.
 *
 * Everything here is play-by-play aggregation the box score cannot give: what
 * the team's passing game is actually worth per dropback, how good the offence
 * is relative to the league, which direction a back's carries go and what each
 * direction returns for him.
 *
 * One honest limit, stated up front because it changes what can be claimed.
 * nflverse does not chart blocking scheme — there is no zone/gap flag anywhere
 * in the public data. What exists is run DIRECTION (`run_location` left/middle/
 * right and `run_gap` end/tackle/guard). Outside runs are heavily zone and
 * interior runs are heavily gap, so direction is a real proxy, but it is a proxy
 * and is named for what it measures rather than what it approximates. True
 * zone/gap charting is PFF or Sports Info Solutions, both paid.
 */

const DAY = 86_400_000;

/**
 * Play-by-play spells three franchises differently from every other nflverse
 * release, and one of them is current.
 *
 * pbp writes the Rams as `LA`; `player_stats`, `snap_counts` and the depth
 * charts all write `LAR`. Joining on the raw value therefore dropped all 32
 * Rams skill players from team context in every season — which is how Cooper
 * Kupp's 2021 and Puka Nacua's 2025, two of the five WR1 seasons on record here,
 * came back with no offence rank at all and appeared to break a rule they
 * actually satisfy.
 *
 * The other two only matter if the pbp backfill is taken past 2020, but they
 * cost nothing to carry.
 */
const TEAM_ALIAS: Record<string, string> = {
  LA: 'LAR',
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LAR',
};

const team_ = (t: string | null): string | null => (t === null ? null : TEAM_ALIAS[t] ?? t);

/** Where a carry went. `run_gap` is null on middle runs, which are interior. */
function runBucket(location: string | null, gap: string | null): 'outside' | 'tackle' | 'inside' | null {
  if (gap === 'end') return 'outside';
  if (gap === 'tackle') return 'tackle';
  if (gap === 'guard') return 'inside';
  if (location === 'middle') return 'inside';
  return null;
}

interface TeamAccum {
  games: Set<string>;
  plays: number;
  epa: number;
  dropbacks: number;
  qbEpa: number;
  passOe: number;
  passOeN: number;
  rushes: number;
  rushEpa: number;
  outside: number;
  inside: number;
  tackle: number;
  passerDropbacks: Map<string, { n: number; epa: number }>;
  /** Sacks and hits taken by this offence, per dropback. */
  sacks: number;
  qbHits: number;
  /** Carries stopped at or behind the line, the failure a mean hides. */
  stuffs: number;
  /** Games each head coach was on the sideline for, so a mid-season firing
   *  resolves to whoever actually ran most of the season. */
  coachGames: Map<string, number>;
}

interface PlayerAccum {
  team: string | null;
  carries: number;
  rushYards: number;
  rushEpa: number;
  rushFirstDowns: number;
  outsideCarries: number;
  outsideYards: number;
  outsideEpa: number;
  insideCarries: number;
  insideYards: number;
  insideEpa: number;
  tackleCarries: number;
  tackleYards: number;
  targets: number;
  receptions: number;
  recYards: number;
  recEpa: number;
  recFirstDowns: number;
}

const emptyPlayer = (): PlayerAccum => ({
  team: null,
  carries: 0, rushYards: 0, rushEpa: 0, rushFirstDowns: 0,
  outsideCarries: 0, outsideYards: 0, outsideEpa: 0,
  insideCarries: 0, insideYards: 0, insideEpa: 0,
  tackleCarries: 0, tackleYards: 0,
  targets: 0, receptions: 0, recYards: 0, recEpa: 0, recFirstDowns: 0,
});

/**
 * How long a cached play-by-play file may be reused.
 *
 * A completed season is immutable — its file will never change again, so there
 * is no reason to refetch 100 MB of it. The season being played is rewritten
 * every week, and a flat 30-day cache meant that from September onward this
 * ingest could be running the board on play-by-play up to a month old while the
 * user believed it was live. Availability, team scoring and every first-down
 * count would silently lag by weeks.
 *
 * The current season therefore gets a 12-hour window, which is shorter than the
 * gap between any two NFL game days.
 */
const cacheWindow = (season: number, current: number) =>
  season >= current ? 12 * 3600_000 : 365 * DAY;

export async function ingestContext(
  seasons: number[],
  currentSeason = Math.max(...seasons),
  maxAgeMs?: number,
) {
  const teamStmt = sqlite.prepare(
    `INSERT INTO team_context
       (season, team, games, points_for, points_rank, off_epa_play, off_epa_rank,
        primary_qb_id, primary_qb_share, qb_epa_dropback, qb_epa_rank, pass_oe, rush_epa_play,
        outside_run_share, plays, head_coach, ybc_per_carry, ybc_rank, stuff_rate,
        sack_rate_allowed, qb_hit_rate_allowed, pass_block_rank, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(season, team) DO UPDATE SET
       games=excluded.games, points_for=excluded.points_for,
       points_rank=excluded.points_rank, off_epa_play=excluded.off_epa_play,
       off_epa_rank=excluded.off_epa_rank, primary_qb_id=excluded.primary_qb_id,
       qb_epa_dropback=excluded.qb_epa_dropback, qb_epa_rank=excluded.qb_epa_rank,
       pass_oe=excluded.pass_oe, rush_epa_play=excluded.rush_epa_play,
       outside_run_share=excluded.outside_run_share, plays=excluded.plays,
       head_coach=excluded.head_coach, ybc_per_carry=excluded.ybc_per_carry,
       ybc_rank=excluded.ybc_rank, stuff_rate=excluded.stuff_rate,
       sack_rate_allowed=excluded.sack_rate_allowed,
       qb_hit_rate_allowed=excluded.qb_hit_rate_allowed,
       pass_block_rank=excluded.pass_block_rank,
       computed_at=excluded.computed_at`,
  );

  const playerStmt = sqlite.prepare(
    `INSERT INTO player_scheme
       (player_id, season, team, carries, rush_yards, rush_epa, rush_first_downs,
        outside_carries, outside_yards, outside_epa,
        inside_carries, inside_yards, inside_epa, tackle_carries, tackle_yards,
        targets, receptions, rec_yards, rec_epa, rec_first_downs, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(player_id, season) DO UPDATE SET
       team=excluded.team, carries=excluded.carries, rush_yards=excluded.rush_yards,
       rush_epa=excluded.rush_epa, rush_first_downs=excluded.rush_first_downs,
       outside_carries=excluded.outside_carries, outside_yards=excluded.outside_yards,
       outside_epa=excluded.outside_epa, inside_carries=excluded.inside_carries,
       inside_yards=excluded.inside_yards, inside_epa=excluded.inside_epa,
       tackle_carries=excluded.tackle_carries, tackle_yards=excluded.tackle_yards,
       targets=excluded.targets, receptions=excluded.receptions,
       rec_yards=excluded.rec_yards, rec_epa=excluded.rec_epa,
       rec_first_downs=excluded.rec_first_downs, computed_at=excluded.computed_at`,
  );

  for (const season of seasons) {
    console.log(`\ncontext ${season}`);
    const path = await download(
      `play_by_play_${season}.csv`,
      NFLVERSE_EXTRA.pbp(season),
      maxAgeMs ?? cacheWindow(season, currentSeason),
    );

    const teams = new Map<string, TeamAccum>();
    const players = new Map<string, PlayerAccum>();
    /** Final score per game, taken once, every row of a game repeats it. */
    const gameScores = new Map<string, { home: string; away: string; hs: number; as: number }>();

    const team = (t: string): TeamAccum => {
      let a = teams.get(t);
      if (!a) {
        a = {
          games: new Set(), plays: 0, epa: 0, dropbacks: 0, qbEpa: 0,
          passOe: 0, passOeN: 0, rushes: 0, rushEpa: 0,
          outside: 0, inside: 0, tackle: 0, passerDropbacks: new Map(),
          sacks: 0, qbHits: 0, stuffs: 0, coachGames: new Map(),
        };
        teams.set(t, a);
      }
      return a;
    };

    const player = (id: string): PlayerAccum => {
      let a = players.get(id);
      if (!a) { a = emptyPlayer(); players.set(id, a); }
      return a;
    };

    const rows = await streamCsv(path, (r) => {
      if (str(r.season_type) !== 'REG') return;

      const gameId = str(r.game_id);
      if (gameId && !gameScores.has(gameId)) {
        const home = team_(str(r.home_team));
        const away = team_(str(r.away_team));
        const hs = num(r.home_score);
        const as = num(r.away_score);
        if (home && away && hs !== null && as !== null) {
          gameScores.set(gameId, { home, away, hs, as });
        }
      }

      const pos = team_(str(r.posteam));
      if (!pos) return;
      const t = team(pos);
      if (gameId) {
        const isHome = team_(str(r.home_team)) === pos;
        const coach = str(isHome ? r.home_coach : r.away_coach);
        // Counted per game rather than per play, or a team that ran 80 plays in
        // one game would out-vote the coach who was there for four.
        if (coach && !t.games.has(gameId)) {
          t.coachGames.set(coach, (t.coachGames.get(coach) ?? 0) + 1);
        }
        t.games.add(gameId);
      }

      const epa = num(r.epa);
      const isRush = num(r.rush_attempt) === 1;
      const isDropback = num(r.qb_dropback) === 1;

      // Only scrimmage plays count toward offensive efficiency; kneels, spikes
      // and special teams carry EPA that says nothing about the offence.
      if ((isRush || isDropback) && epa !== null) {
        t.plays++;
        t.epa += epa;
      }

      const poe = num(r.pass_oe);
      if (poe !== null) { t.passOe += poe; t.passOeN++; }

      if (isDropback) {
        // Sacks and hits are charged to the offence that allowed them.
        if (num(r.sack) === 1) t.sacks++;
        if (num(r.qb_hit) === 1) t.qbHits++;
        const qbEpa = num(r.qb_epa);
        if (qbEpa !== null) {
          t.dropbacks++;
          t.qbEpa += qbEpa;
          const passer = str(r.passer_player_id);
          if (passer) {
            const p = t.passerDropbacks.get(passer) ?? { n: 0, epa: 0 };
            p.n++; p.epa += qbEpa;
            t.passerDropbacks.set(passer, p);
          }
        }
      }

      if (isRush) {
        const bucket = runBucket(str(r.run_location), str(r.run_gap));
        if (epa !== null) { t.rushes++; t.rushEpa += epa; }
        // A carry stopped at or behind the line. Averages hide these, and they
        // are the drives that stall.
        if ((num(r.yards_gained) ?? 1) <= 0) t.stuffs++;
        if (bucket === 'outside') t.outside++;
        else if (bucket === 'inside') t.inside++;
        else if (bucket === 'tackle') t.tackle++;

        const rusher = str(r.rusher_player_id);
        if (rusher) {
          const p = player(rusher);
          p.team = pos;
          const yards = num(r.yards_gained) ?? 0;
          p.carries++;
          p.rushYards += yards;
          if (epa !== null) p.rushEpa += epa;
          if (num(r.first_down_rush) === 1) p.rushFirstDowns++;
          if (bucket === 'outside') {
            p.outsideCarries++; p.outsideYards += yards; p.outsideEpa += epa ?? 0;
          } else if (bucket === 'inside') {
            p.insideCarries++; p.insideYards += yards; p.insideEpa += epa ?? 0;
          } else if (bucket === 'tackle') {
            p.tackleCarries++; p.tackleYards += yards;
          }
        }
      }

      const receiver = str(r.receiver_player_id);
      if (receiver && num(r.pass_attempt) === 1) {
        const p = player(receiver);
        p.team = pos;
        p.targets++;
        if (num(r.complete_pass) === 1) {
          p.receptions++;
          p.recYards += num(r.yards_gained) ?? 0;
        }
        if (epa !== null) p.recEpa += epa;
        if (num(r.first_down_pass) === 1) p.recFirstDowns++;
      }
    });

    /* ------------------------------------------------- run blocking (PFR) */

    /*
     * Yards before contact is the cleanest public split between the line and the
     * back: it is the ground gained before a defender arrives, which the back
     * did not create. Yards AFTER contact is his. Play-by-play carries neither,
     * so this comes from the PFR advanced stats file — 200 KB, and already
     * fetched for the usage ingest.
     */
    const ybc = new Map<string, { yards: number; carries: number }>();
    {
      const rushPath = await download(
        `advstats_week_rush_${season}.csv`,
        NFLVERSE_EXTRA.advstatsRush(season),
        maxAgeMs ?? cacheWindow(season, currentSeason),
      );
      await streamCsv(rushPath, (r) => {
        if (str(r.game_type) !== 'REG') return;
        const tm = team_(str(r.team));
        const carries = num(r.carries) ?? 0;
        const before = num(r.rushing_yards_before_contact);
        if (!tm || carries <= 0 || before === null) return;
        const e = ybc.get(tm) ?? { yards: 0, carries: 0 };
        e.yards += before;
        e.carries += carries;
        ybc.set(tm, e);
      });
    }

    /* ------------------------------------------------------------ points */

    const points = new Map<string, number>();
    for (const g of gameScores.values()) {
      points.set(g.home, (points.get(g.home) ?? 0) + g.hs);
      points.set(g.away, (points.get(g.away) ?? 0) + g.as);
    }

    /*
     * Ranks are computed here, once, rather than at read time. A rank is
     * meaningless without the population it was taken over, and recomputing it
     * in three different queries is how two pages end up disagreeing about who
     * the 11th-best offence is.
     */
    const rankOf = (values: Map<string, number>) => {
      const sorted = [...values.entries()].sort((a, b) => b[1] - a[1]);
      const ranks = new Map<string, number>();
      sorted.forEach(([k], i) => ranks.set(k, i + 1));
      return ranks;
    };

    const epaPerPlay = new Map<string, number>();
    const qbEpaPerDb = new Map<string, number>();
    for (const [name, a] of teams) {
      if (a.plays > 0) epaPerPlay.set(name, a.epa / a.plays);
      if (a.dropbacks > 0) qbEpaPerDb.set(name, a.qbEpa / a.dropbacks);
    }

    const pointsRank = rankOf(points);
    const epaRank = rankOf(epaPerPlay);
    const qbRank = rankOf(qbEpaPerDb);

    const ybcPerCarry = new Map<string, number>();
    for (const [name, e] of ybc) if (e.carries > 0) ybcPerCarry.set(name, e.yards / e.carries);
    const ybcRank = rankOf(ybcPerCarry);

    /*
     * Pass protection as one number, ranked. Sacks are weighted double a hit:
     * a sack is a down lost outright, a hit is a down completed under duress.
     * Negated before ranking so rank 1 is the BEST protection, matching every
     * other rank in this table — a column where 1 means "worst" next to columns
     * where 1 means "best" is how a reader misreads a page.
     */
    const protection = new Map<string, number>();
    for (const [name, a] of teams) {
      if (a.dropbacks < 100) continue;
      protection.set(name, -((a.sacks * 2 + a.qbHits) / a.dropbacks));
    }
    const passBlockRank = rankOf(protection);

    const now = Date.now();
    sqlite.transaction(() => {
      /*
       * Clear the season before writing it. An upsert alone leaves orphans
       * behind whenever a key changes: the first run of this ingest wrote the
       * Rams under pbp's `LA`, and fixing the alias left those rows sitting in
       * the table under a team name nothing joins to. A row that no longer
       * corresponds to anything is worse than a missing one, because it still
       * answers queries.
       */
      sqlite.prepare(`DELETE FROM team_context WHERE season = ?`).run(season);
      sqlite.prepare(`DELETE FROM player_scheme WHERE season = ?`).run(season);

      for (const [name, a] of teams) {
        // The primary quarterback is the one who took the most dropbacks, not
        // whoever is listed first — a team that changed starters mid-season must
        // not be described by its backup.
        let primary: string | null = null;
        let best = 0;
        for (const [id, p] of a.passerDropbacks) {
          if (p.n > best) { best = p.n; primary = id; }
        }
        const runs = a.outside + a.inside + a.tackle;
        teamStmt.run(
          season, name, a.games.size,
          points.get(name) ?? null, pointsRank.get(name) ?? null,
          epaPerPlay.get(name) ?? null, epaRank.get(name) ?? null,
          primary, a.dropbacks > 0 ? best / a.dropbacks : null,
          qbEpaPerDb.get(name) ?? null, qbRank.get(name) ?? null,
          a.passOeN > 0 ? a.passOe / a.passOeN : null,
          a.rushes > 0 ? a.rushEpa / a.rushes : null,
          runs > 0 ? a.outside / runs : null,
          a.plays,
          // Whoever ran the most games. A team that fired its coach in week 8 is
          // described by whoever coached the majority, not by whoever happened
          // to be there for the first snap of the season.
          [...a.coachGames.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
          ybcPerCarry.get(name) ?? null,
          ybcRank.get(name) ?? null,
          a.rushes > 0 ? a.stuffs / a.rushes : null,
          a.dropbacks > 0 ? a.sacks / a.dropbacks : null,
          a.dropbacks > 0 ? a.qbHits / a.dropbacks : null,
          passBlockRank.get(name) ?? null,
          now,
        );
      }

      for (const [id, p] of players) {
        if (p.carries === 0 && p.targets === 0) continue;
        playerStmt.run(
          id, season, p.team, p.carries, p.rushYards, p.rushEpa, p.rushFirstDowns,
          p.outsideCarries, p.outsideYards, p.outsideEpa,
          p.insideCarries, p.insideYards, p.insideEpa,
          p.tackleCarries, p.tackleYards,
          p.targets, p.receptions, p.recYards, p.recEpa, p.recFirstDowns, now,
        );
      }
    })();

    console.log(
      `  ${rows.toLocaleString()} plays -> ${teams.size} teams, ${players.size} players`,
    );
  }
}
