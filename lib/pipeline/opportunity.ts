import { sqlite } from '../db/index';

/**
 * Vacated opportunity — the volume that left a team and is waiting to be
 * reassigned.
 *
 * This is the structural form of the thing people read news articles for. A
 * breakout almost never comes from a player suddenly getting better; it comes
 * from touches opening up in front of him. Bucky Irving in 2024 is the pattern:
 * a rookie back on a team whose prior-season carries had walked out the door.
 *
 * Rather than parse reporting, this measures the same fact directly. Take last
 * season's carries, targets and red-zone touches, and total the share held by
 * players who are no longer on the team's depth chart. That number is known
 * with certainty, updates daily with the depth chart, and needs no
 * interpretation.
 */

export interface TeamVacancy {
  team: string;
  vacatedCarries: number;
  vacatedTargets: number;
  vacatedRzTouches: number;
  totalCarries: number;
  totalTargets: number;
  totalRzTouches: number;
  carryShare: number;
  targetShare: number;
  /**
   * Red-zone work still open, split by which pool it comes from. Backs and
   * receivers compete for the same goal-line snaps but not for the same
   * arrivals, so a team that signed a receiver has not filled its vacated
   * carries — one number for both charged each position with the other's
   * signings.
   */
  rzShareRush: number;
  rzShareTarget: number;
  /** Share of the vacancy claimed by arrivals, per competing pool. */
  rushAbsorbed: number;
  targetAbsorbed: number;
  departed: string[];
}

export function buildVacancies(priorSeason: number, currentSeason: number): Map<string, TeamVacancy> {
  // Everyone currently listed on a 2026 depth chart, by team.
  const onRoster = new Set(
    (
      sqlite
        .prepare(`SELECT DISTINCT player_id, team FROM depth_chart WHERE season = ?`)
        .all(currentSeason) as Array<{ player_id: string; team: string }>
    ).map((r) => `${r.player_id}|${r.team}`),
  );

  /*
   * Volume that walked out is not the same as volume that is available.
   *
   * A team can lose its lead back and sign another one, and the carries never
   * reach the young player behind them — they were claimed on the way in. So
   * arrivals are netted off: anyone on the depth chart now who was somewhere
   * else last season takes back a share of the vacancy, scaled by how high he
   * is listed. Someone slotting straight in at RB1 or WR1 absorbs most of it.
   */
  const priorTeam = new Map(
    (
      sqlite
        .prepare(
          `SELECT player_id, team FROM player_usage WHERE season = ? AND team IS NOT NULL`,
        )
        .all(priorSeason) as Array<{ player_id: string; team: string }>
    ).map((r) => [r.player_id, r.team]),
  );

  /**
   * How much of a freed role an arrival absorbs, by where he is listed.
   *
   * The list ends at the depth a position actually competes to, and there is
   * deliberately no fallback past it. Depth charts are 90-man camp rosters —
   * Cleveland lists eleven receivers and seven tight ends — so a token claim for
   * everyone below the rotation was worth more in aggregate than every real
   * signing combined. A WR9 in August is not absorbing anyone's targets.
   *
   * Receivers run four deep because three-receiver sets are base personnel, so
   * the fourth is the first man on. Tight ends stop at two.
   */
  const ARRIVAL_CLAIM: Record<string, number[]> = {
    RB: [0.7, 0.35, 0.15],
    WR: [0.7, 0.35, 0.15, 0.08],
    TE: [0.7, 0.25],
  };

  /**
   * Arrivals are counted against the pool they actually compete in.
   *
   * Summing every RB, WR and TE arrival into one per-team number and applying it
   * to carries and targets alike pinned all 32 teams at the 0.9 cap, because a
   * depth chart holds a dozen listings at those positions and most of them are
   * new every year — rookies and camp bodies have no prior-season usage row, so
   * each one read as an arrival. With `keep` stuck at 0.1 the strongest vacancy
   * in the league came out at 7%, below every threshold that reads it: the
   * `volume-open` tag needs 30%, the Gem tag 25%, and the waiver wire's priority
   * tier 25%. All three were silently dead.
   *
   * Carries are contested by backs; targets by receivers and tight ends
   * together. Capping each pool separately keeps the original intent — an
   * arrival slotting in at RB1 really does take most of a freed backfield —
   * without letting a signing at one position erase a vacancy at another.
   */
  const incoming = new Map<string, number>();
  const poolOf = (pos: string) => (pos === 'RB' ? 'rush' : 'target');

  for (const r of sqlite
    .prepare(
      `SELECT player_id, team, pos_abb AS pos, MIN(pos_rank) AS rank
       FROM depth_chart WHERE season = ? AND pos_abb IN ('RB','WR','TE')
       GROUP BY player_id, team, pos_abb`,
    )
    .all(currentSeason) as Array<{ player_id: string; team: string; pos: string; rank: number }>) {
    const was = priorTeam.get(r.player_id);
    // New to this team — either signed from elsewhere or a rookie.
    if (was === r.team) continue;
    const claim = ARRIVAL_CLAIM[r.pos]?.[r.rank - 1] ?? 0;
    if (claim === 0) continue;
    const key = `${r.team}|${poolOf(r.pos)}`;
    incoming.set(key, (incoming.get(key) ?? 0) + claim);
  }

  // Current team for anyone still on a depth chart, so a move can be named.
  const movedTo = new Map(
    (
      sqlite
        .prepare(
          `SELECT player_id, team FROM depth_chart WHERE season = ? GROUP BY player_id`,
        )
        .all(currentSeason) as Array<{ player_id: string; team: string }>
    ).map((r) => [r.player_id, r.team]),
  );

  const prior = sqlite
    .prepare(
      `SELECT u.player_id, u.team, p.display_name AS name,
              COALESCE(SUM(s.carries), 0) AS carries,
              COALESCE(SUM(s.targets), 0) AS targets,
              COALESCE(u.rz_carries, 0) + COALESCE(u.rz_targets, 0) AS rzTouches
       FROM player_usage u
       JOIN players p ON p.gsis_id = u.player_id
       LEFT JOIN player_stats_week s
         ON s.player_id = u.player_id AND s.season = u.season AND s.season_type = 'REG'
       WHERE u.season = ? AND u.team IS NOT NULL
       GROUP BY u.player_id, u.team`,
    )
    .all(priorSeason) as Array<{
    player_id: string; team: string; name: string;
    carries: number; targets: number; rzTouches: number;
  }>;

  const out = new Map<string, TeamVacancy>();
  for (const r of prior) {
    const v =
      out.get(r.team) ??
      {
        team: r.team,
        vacatedCarries: 0, vacatedTargets: 0, vacatedRzTouches: 0,
        totalCarries: 0, totalTargets: 0, totalRzTouches: 0,
        carryShare: 0, targetShare: 0, rzShareRush: 0, rzShareTarget: 0,
        rushAbsorbed: 0, targetAbsorbed: 0,
        departed: [],
      };

    v.totalCarries += r.carries;
    v.totalTargets += r.targets;
    v.totalRzTouches += r.rzTouches;

    // Gone if he is not on this team's current depth chart. Covers free agency,
    // trades, retirement and being cut in one check.
    if (!onRoster.has(`${r.player_id}|${r.team}`)) {
      v.vacatedCarries += r.carries;
      v.vacatedTargets += r.targets;
      v.vacatedRzTouches += r.rzTouches;
      if (r.carries + r.targets >= 40) {
        // Where he went, so "gone" never reads as "retired" when he simply
        // moved and is listed elsewhere on the board.
        const now = movedTo.get(r.player_id);
        v.departed.push(now && now !== r.team ? `${r.name} -> ${now}` : r.name);
      }
    }
    out.set(r.team, v);
  }

  for (const v of out.values()) {
    const gross = {
      carry: v.totalCarries ? v.vacatedCarries / v.totalCarries : 0,
      target: v.totalTargets ? v.vacatedTargets / v.totalTargets : 0,
      rz: v.totalRzTouches ? v.vacatedRzTouches / v.totalRzTouches : 0,
    };

    /*
     * The vacancy is reported GROSS. Netting out arrivals was answering a
     * question that has no answer.
     *
     * `calibrate:opportunity` fitted next season's share on prior share and
     * vacated share over 1,117 incumbent seasons. The fraction of a vacancy that
     * reaches the man behind it is −0.022 for the first receiver in line and
     * −0.027 for the first back, neither within two standard errors of zero, and
     * every queue position in both pools comes out negative. Volume does not
     * flow down a depth chart — teams REPLACE it, and a first-round rookie takes
     * 20% of the targets or 56% of the carries in his first season.
     *
     * So subtracting an arrival's claim was refining an estimate of something
     * that measures zero either way, and it did real damage: `ARRIVAL_CLAIM`
     * indexes a 90-man camp roster and SUMS, so Philadelphia's rookie WR2, rookie
     * TE2 and two journeymen absorbed 83% of the vacancy A.J. Brown left and
     * DeVonta Smith — incumbent WR1, listed first, 24% target share — read 7%.
     * It erased the six largest vacancies in the league.
     *
     * What survives measurement is the gross fact: this much of last season's
     * offence is no longer here. That is worth telling a reader, as long as it is
     * never dressed up as a forecast. `absorbed` is kept and still reported,
     * because who a team signed is real context — it just no longer edits the
     * number.
     */
    const rushAbsorbed = Math.min(0.9, incoming.get(`${v.team}|rush`) ?? 0);
    const targetAbsorbed = Math.min(0.9, incoming.get(`${v.team}|target`) ?? 0);

    v.carryShare = gross.carry;
    v.targetShare = gross.target;
    v.rzShareRush = gross.rz;
    v.rzShareTarget = gross.rz;
    v.rushAbsorbed = rushAbsorbed;
    v.targetAbsorbed = targetAbsorbed;
    v.departed.sort();
  }

  return out;
}

/**
 * In-season opportunity: work held by teammates who did not play last week.
 *
 * `buildVacancies` measures the offseason — who left the roster between
 * February and August. That is the right question in August and a stale one in
 * November, by which point the roster it describes has been settled for months
 * and the volume that actually moves is moving because somebody is hurt.
 *
 * This measures that directly. Take each team's season-to-date carries and
 * targets, and total the share held by players who were absent from the most
 * recent week. No injury report is parsed and no news is read — a player who did
 * not record a snap did not play, which is the fact the report would have been
 * describing anyway.
 *
 * Carries and targets stay in separate pools for the same reason they do
 * upstream: a receiver sitting out does not free a carry.
 */
export interface AbsenceVacancy {
  team: string;
  carryShare: number;
  targetShare: number;
  /** Absent players holding real volume, most significant first. */
  absent: Array<{ playerId: string; name: string; carryShare: number; targetShare: number }>;
}

export function buildAbsenceVacancies(season: number): Map<string, AbsenceVacancy> {
  const out = new Map<string, AbsenceVacancy>();

  const latestWeek = (
    sqlite
      .prepare(
        `SELECT COALESCE(MAX(week), 0) AS w FROM player_stats_week
         WHERE season = ? AND season_type = 'REG'`,
      )
      .get(season) as { w: number }
  ).w;
  if (latestWeek === 0) return out;

  const rows = sqlite
    .prepare(
      `SELECT s.player_id, p.display_name AS name, s.recent_team AS team,
              SUM(COALESCE(s.carries, 0)) AS carries,
              SUM(COALESCE(s.targets, 0)) AS targets,
              MAX(s.week) AS lastWeek
       FROM player_stats_week s
       JOIN players p ON p.gsis_id = s.player_id
       WHERE s.season = ? AND s.season_type = 'REG' AND s.recent_team IS NOT NULL
       GROUP BY s.player_id, s.recent_team`,
    )
    .all(season) as Array<{
    player_id: string; name: string; team: string;
    carries: number; targets: number; lastWeek: number;
  }>;

  const totals = new Map<string, { carries: number; targets: number }>();
  for (const r of rows) {
    const t = totals.get(r.team) ?? { carries: 0, targets: 0 };
    t.carries += r.carries;
    t.targets += r.targets;
    totals.set(r.team, t);
  }

  for (const r of rows) {
    if (r.lastWeek >= latestWeek) continue; // played the latest week
    const t = totals.get(r.team)!;
    const carryShare = t.carries ? r.carries / t.carries : 0;
    const targetShare = t.targets ? r.targets / t.targets : 0;
    // Ignore players who were not holding meaningful work anyway — a third-string
    // tight end being out is not an opportunity.
    if (carryShare < 0.05 && targetShare < 0.05) continue;

    const v =
      out.get(r.team) ?? { team: r.team, carryShare: 0, targetShare: 0, absent: [] };
    v.carryShare += carryShare;
    v.targetShare += targetShare;
    v.absent.push({ playerId: r.player_id, name: r.name, carryShare, targetShare });
    out.set(r.team, v);
  }

  for (const v of out.values()) {
    v.absent.sort((a, b) => b.carryShare + b.targetShare - (a.carryShare + a.targetShare));
  }

  return out;
}

/**
 * What a specific player stands to inherit while others are out.
 *
 * His own absence is never opportunity for him, so it is removed before the
 * share is reported — otherwise the injured player leading a backfield would
 * read as the biggest beneficiary of his own injury, which is the in-season form
 * of the mistake that once credited a departed receiver with the targets he took
 * with him.
 */
export function absenceOpportunityFor(
  vacancy: AbsenceVacancy | undefined,
  position: string,
  playerId: string,
): { share: number; note: string | null } {
  /*
   * A quarterback inherits nothing when receivers leave.
   *
   * Both of these branched `isRb ? carries : targets`, so every QB was handed his
   * team's vacated TARGET share — Mahomes read "32% of targets vacated" and
   * Jordan Love 38%, work neither will ever receive. That number then fed the
   * volume-open tag, the gem test, the verdict's opportunity argument and the
   * rookie projection. A quarterback's opportunity is the starting job, which
   * depth rank and the promotion tag already carry.
   */
  if (position.toUpperCase() === 'QB') return { share: 0, note: null };
  if (!vacancy) return { share: 0, note: null };

  const isRb = position.toUpperCase() === 'RB';
  const own = vacancy.absent.find((a) => a.playerId === playerId);
  const ownShare = own ? (isRb ? own.carryShare : own.targetShare) : 0;
  const share = Math.max(0, (isRb ? vacancy.carryShare : vacancy.targetShare) - ownShare);

  if (share < 0.12) return { share, note: null };

  const who = vacancy.absent
    .filter((a) => a.playerId !== playerId)
    .slice(0, 2)
    .map((a) => a.name)
    .join(', ');

  return {
    share,
    note:
      `${Math.round(share * 100)}% of this team's ${isRb ? 'carries' : 'targets'} belong to players ` +
      `who did not play last week${who ? ` (${who})` : ''}`,
  };
}

/**
 * What a specific player stands to inherit, given his position and where the
 * volume went.
 *
 * Backs are graded on vacated carries and receivers on vacated targets, since
 * a team losing its lead back tells you little about its receiver room.
 */
export function opportunityFor(
  vacancy: TeamVacancy | undefined,
  position: string,
): { share: number; rzShare: number; note: string | null } {
  /*
   * A quarterback inherits nothing when receivers leave.
   *
   * Both of these branched `isRb ? carries : targets`, so every QB was handed his
   * team's vacated TARGET share — Mahomes read "32% of targets vacated" and
   * Jordan Love 38%, work neither will ever receive. That number then fed the
   * volume-open tag, the gem test, the verdict's opportunity argument and the
   * rookie projection. A quarterback's opportunity is the starting job, which
   * depth rank and the promotion tag already carry.
   */
  if (position.toUpperCase() === 'QB') return { share: 0, rzShare: 0, note: null };
  if (!vacancy) return { share: 0, rzShare: 0, note: null };

  const isRb = position.toUpperCase() === 'RB';
  const share = isRb ? vacancy.carryShare : vacancy.targetShare;
  const rzShare = isRb ? vacancy.rzShareRush : vacancy.rzShareTarget;
  const absorbed = isRb ? vacancy.rushAbsorbed : vacancy.targetAbsorbed;

  /*
   * The note describes what left. It deliberately does NOT say "he is next in
   * line", which is what it used to imply and what the measurement rules out.
   */
  let note: string | null = null;
  if (share >= 0.2 || rzShare >= 0.3) {
    const who = vacancy.departed.slice(0, 2).join(', ');
    note =
      `${Math.round(share * 100)}% of ${isRb ? 'carries' : 'targets'} left the roster` +
      (rzShare >= 0.3 ? `, ${Math.round(rzShare * 100)}% of red-zone work` : '') +
      (who ? ` (${who})` : '') +
      (absorbed >= 0.25 ? `; arrivals signed on top` : '') +
      ' — an open question, not an inheritance';
  }

  return { share, rzShare, note };
}
