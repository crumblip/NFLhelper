import { sqlite } from '../db/index';
import { vulnerabilityOf } from './depth';
import { buildRiskProfiles } from './risk';

/**
 * Certainty of role — how safe a player's job actually is.
 *
 * Every projection on this board assumes a player keeps doing what he did. That
 * assumption is never stated and never tested, and it is the single largest
 * hidden risk in a fantasy projection: a 20% rush share is worth nothing if the
 * rookie behind him takes it in October.
 *
 * Three independent facts decide it, and the interesting cases are where they
 * disagree:
 *
 *   WHERE THE TEAM LISTS HIM   the depth chart, refreshed daily. Authoritative
 *                              about intent, noisy in August, and derived from
 *                              90-man camp rosters.
 *   WHAT HE ACTUALLY DID       his rank among his own teammates by the share
 *                              that defines the position. Authoritative about
 *                              last season, blind to everything since.
 *   WHETHER HE STAYS AVAILABLE the same vulnerability model used to score the
 *                              man ahead of him, turned on the player himself.
 *
 * Cleveland is the case that forced this. The depth chart lists Dylan Sampson
 * RB2 and Raheim Sanders RB3; the usage says the reverse, because Sanders posted
 * a 26% rush share and a 36% goal-line share in his four games while Sampson ran
 * 17% across fifteen. Shrinking the short sample was tested and rejected — it
 * measured at k≈0-3, a 3-4% improvement, because share reflects a coaching
 * decision rather than a noisy count. So neither source is wrong; they disagree,
 * and a model that silently picks one is hiding the most useful fact about that
 * backfield. This reports the disagreement instead.
 */

export interface RoleCertainty {
  playerId: string;
  position: string;
  team: string | null;
  /** 0-100. High means the depth chart, the usage and his availability agree. */
  certainty: number;
  /** Where his team lists him at his own position. */
  depthRank: number | null;
  /** Where last season's usage ranks him among teammates at the position. */
  usageRank: number | null;
  /** Chance he stops holding this role, from the shared vulnerability model. */
  ownVulnerability: number;
  /** False when certainty rests on a prior rather than evidence. */
  certaintyKnown: boolean;
  reasons: string[];
  /** The room, in depth-chart order, for the player page. */
  room: Array<{
    playerId: string;
    name: string;
    depthRank: number;
    usageRank: number | null;
    volumeShare: number;
    /**
     * The team that share was earned on, when it is not his current one.
     *
     * Travis Etienne's 53% was Jacksonville's carries; he is now listed in New
     * Orleans. Without this the room appears to total 172%.
     */
    shareTeam: string | null;
    vulnerability: number;
    /** False when nothing was measured and the figure is only a prior. */
    vulnerabilityKnown: boolean;
    /** The measured cause, with its number, "5.4 games a year", "age 32". */
    vulnerabilityReason: string;
    /**
     * False when he holds too little work, over too few games, for the question
     * to mean anything.
     */
    hasRole: boolean;
    /**
     * Where this man is headed relative to where he is listed.
     *
     * The page previously showed a static "chance he loses the job" for every
     * row, which answers a question nobody in a draft is asking. What decides a
     * pick is direction: is the starter going to give the job up, and is one of
     * the men behind him going to take it. Positive means he is gaining on the
     * room, negative means he is losing it.
     */
    trend: 'rising' | 'holding' | 'slipping';
    trendReason: string;
    isSelf: boolean;
  }>;
}

/** Positions where a depth chart means something for fantasy purposes. */
const TRACKED = ['QB', 'RB', 'WR', 'TE'];

/**
 * How deep a room goes before it stops being about football.
 *
 * nflverse publishes 90-man camp rosters, so the raw chart lists 10 to 15
 * receivers a team and up to eight backs. A seventh running back is not a
 * fantasy asset, is not a contingency, and is not going to be on the roster in
 * three weeks — he is a training-camp body, and a row for him costs the reader
 * the same attention as a row for the starter.
 *
 * MEASURED, not chosen. Two independent readings agree:
 *
 * 1. How many men per team ever hold a real share (>=8% of the position's work),
 *    across 160 team-seasons 2021-2025 — the 95th percentile is QB 4 · RB 5 ·
 *    WR 6 · TE 3, and the maximum ever observed is QB 5 · RB 6 · WR 8 · TE 3.
 * 2. What a listing at each rank implies. The share of men at that rank who held
 *    a real role last season falls off a cliff in the same place:
 *
 *      QB  1: 97%   2: 69%   3: 34%   4: 9%    5: 0%
 *      RB  1: 97%   2: 81%   3: 38%   4: 34%   5: 19%   6: 14%
 *      WR  1: 97%   2: 94%   3: 66%   4: 28%   5: 25%   6: 16%   7+: <=9%
 *      TE  1: 97%   2: 44%   3: 3%    4: 13%   5+: 0%
 *
 * So this is the depth at which a listing still carries information. It is NOT
 * a claim that nobody deeper can matter — that is what the escape hatches in
 * `roomMembers` are for, and they are facts rather than guesses.
 */
const ROOM_DEPTH: Record<string, number> = { QB: 4, RB: 5, WR: 6, TE: 3 };

/**
 * Below this share of the position's work there is no role to have.
 *
 * The same 8% floor `depth.ts` uses, and for the same reason: 546 of 826 skill
 * players sit under it, so "secure" or "slipping" said about one of them is a
 * confident statement about a job he does not hold.
 */
const ROLE_SHARE_FLOOR = 0.08;

/**
 * Games the share must be computed over before it counts as evidence of a role.
 *
 * Not a shrinkage — `calibrate:shrinkage` measured that shares do NOT need
 * regressing toward a mean (k=0, and a four-game rush share predicts the next
 * season's at r=0.919). This is the prior question: whether a role existed at
 * all. Jakobie Keeney-James read a 20% target share off ONE appearance and
 * Samori Toure 9% off one, which is not a small sample of a job, it is a man who
 * played a game. Four is the shortest span the shrinkage work found informative,
 * and `comparables.ts` already refuses a profile under six for the same reason.
 */
const ROLE_GAMES_FLOOR = 4;

/**
 * Who belongs in the room.
 *
 * A rank cut on its own would hide the players this tool exists to find. The
 * 2026 chart lists a drafted receiver at WR11 and another at WR14 — Ricky
 * Pearsall is listed 14th — so "deep on a camp chart" and "irrelevant" are not
 * the same statement, and a tool that conflated them would drop exactly the men
 * whose roles are about to change.
 *
 * So the cut applies only to players about whom NOTHING else is known. Each
 * escape hatch below is a recorded fact, not a projection:
 *   - he held a real share of the work last season, over enough games for that
 *     share to describe a job rather than an afternoon
 *   - somebody is drafting him
 *   - he is the player whose page this is
 */
function roomMembers<
  T extends {
    pos: string;
    depthRank: number;
    volumeShare: number;
    gamesPlayed: number | null;
    drafted: boolean;
  },
>(list: T[], keepId: string | null, idOf: (r: T) => string): T[] {
  return list.filter(
    (r) =>
      r.depthRank <= (ROOM_DEPTH[r.pos] ?? 5) ||
      (r.volumeShare >= ROLE_SHARE_FLOOR && (r.gamesPlayed ?? 0) >= ROLE_GAMES_FLOOR) ||
      r.drafted ||
      idOf(r) === keepId,
  );
}

export function buildRoleCertainty(season: number): Map<string, RoleCertainty> {
  // Durability for everyone with usage history, not only the drafted players.
  const risk = buildRiskProfiles(season - 1);
  const rows = sqlite
    .prepare(
      `SELECT dc.player_id AS playerId, p.display_name AS name, dc.team,
              dc.pos_abb AS pos, MIN(dc.pos_rank) AS depthRank,
              ? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) AS age,
              v.usage_grade AS usageGrade,
              CASE WHEN dc.pos_abb = 'RB' THEN COALESCE(u.rush_share, 0)
                   WHEN dc.pos_abb = 'QB' THEN COALESCE(u.pass_snap_share, 0)
                   ELSE COALESCE(u.target_share, 0) END AS volumeShare,
              u.games AS gamesPlayed, u.team AS usageTeam,
              -- Somebody is spending a pick on him, so he is in the room
              -- whatever a camp chart says. See roomMembers below.
              CASE WHEN v.player_id IS NOT NULL THEN 1 ELSE 0 END AS drafted
       FROM depth_chart dc
       JOIN players p ON p.gsis_id = dc.player_id
       LEFT JOIN value_scores v ON v.player_id = dc.player_id AND v.season = ?
       LEFT JOIN player_usage u ON u.player_id = dc.player_id AND u.season = ? - 1
       WHERE dc.season = ? AND dc.pos_abb IN ('QB','RB','WR','TE')
       GROUP BY dc.player_id, dc.pos_abb`,
    )
    .all(season, season, season, season) as Array<{
    playerId: string; name: string; team: string; pos: string; depthRank: number;
    age: number | null; usageGrade: number | null;
    volumeShare: number; gamesPlayed: number | null; usageTeam: string | null;
    drafted: number;
  }>;

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!TRACKED.includes(r.pos)) continue;
    const key = `${r.team}|${r.pos}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out = new Map<string, RoleCertainty>();

  for (const list of groups.values()) {
    list.sort((a, b) => a.depthRank - b.depthRank);

    /*
     * Ranked on what each man actually did, which is only a same-team comparison
     * for the players who were here last season. Travis Etienne's 53% was
     * Jacksonville's carries, not New Orleans', so a room can sum past 100% and
     * the rank is "how heavily has he been used", not "where he sits in this
     * room". The share carries its own team label wherever the two differ.
     */
    const byUsage = [...list].filter((r) => r.volumeShare > 0).sort((a, b) => b.volumeShare - a.volumeShare);
    const usageRankOf = new Map(byUsage.map((r, i) => [r.playerId, i + 1]));

    /*
     * The displayed room is cut to the men who can plausibly hold or take a
     * role; `list` stays whole so ranks and certainty are still computed
     * against the full chart. Cutting before the ranking would renumber the
     * room and quietly change what "second heaviest share in this room" means.
     */
    const shown = roomMembers(
      list.map((r) => ({ ...r, drafted: r.drafted === 1 })),
      null,
      (r) => r.playerId,
    );

    const room = shown.map((r) => ({
      playerId: r.playerId,
      name: r.name,
      depthRank: r.depthRank,
      usageRank: usageRankOf.get(r.playerId) ?? null,
      volumeShare: r.volumeShare,
      shareTeam: r.usageTeam && r.usageTeam !== r.team ? r.usageTeam : null,
      ...(() => {
        const v = vulnerabilityOf(risk.get(r.playerId)?.expectedGames ?? null, r.age, r.pos, r.usageGrade, r.volumeShare);
        return {
          vulnerability: v.p,
          vulnerabilityKnown: v.known,
          /*
           * A share is computed over the weeks he APPEARED (bug #2), so it says
           * nothing about how often he appears. Aidan O'Connell took 78% of the
           * pass snaps in the one game he played and read as a man holding a
           * role — then as a man LOSING it, because his games were low.
           *
           * That is bug #40 in a new place: a healthy backup wearing the shape
           * of an injured starter. The share and the games have to clear the
           * floor together before there is a job to describe.
           */
          hasRole: v.hasRole && (r.gamesPlayed ?? 0) >= ROLE_GAMES_FLOOR,
          /*
           * The measured reason, carried rather than re-worded. `vulnerabilityOf`
           * already returns "5.4 games a year" or "age 32"; the trend used to
           * replace that with "misses time or is past the age curve" — an OR of
           * two unrelated causes told as one story, which is what made #75 a
           * sentence a reader could catch being false.
           */
          vulnerabilityReason: v.reason,
        };
      })(),
      trend: 'holding' as 'rising' | 'holding' | 'slipping',
      trendReason: '',
      isSelf: false,
    }));

    /*
     * Direction — rebuilt, because the old rules fired on artefacts.
     *
     * Three separate faults, all of which produced a confident arrow with
     * nothing behind it:
     *
     * 1. RANKS OVER TWO DIFFERENT POPULATIONS. `depthRank > usageRank` was the
     *    rising test, but `depthRank` counts every man in the room while
     *    `usageRank` counts only those with any share at all. In a room with
     *    fifteen listed receivers and three role-holders, the third
     *    role-holder reads depth 14 against usage rank 3 and came out RISING,
     *    "out-produced the men listed above him" — when the men he out-produced
     *    are camp bodies with no usage whatsoever. Ricky Pearsall carried
     *    exactly that. Family #3 and #5: two ranks that are not on the same
     *    scale, compared as though they were.
     *
     * 2. SHARES COMPARED ACROSS TEAMS. `volumeShare` is the share of the team
     *    he played for LAST season, which bug #42 already established can be a
     *    different roster. So Brian Thomas Jr, Jacksonville's WR1, read
     *    SLIPPING because Jakobi Meyers arrived from Las Vegas with a bigger
     *    share of the RAIDERS' targets. That is not a fact about Jacksonville's
     *    room and cannot be evidence about who is losing a job in it.
     *
     * 3. "DIRECTLY ABOVE" MEANT ANY. `above.find(fragile)` returns the first
     *    match in listing order, so a third-stringer rose because the STARTER
     *    was fragile, skipping the man actually in front of him. Same shape as
     *    #37 and #7 — a queue that has to be respected and was not.
     *
     * And the wording was wrong on top of the logic: "produced more per game"
     * described a target or carry SHARE, which is not a per-game figure at all
     * (family #7). Jaxson Dart, a starter at 81% of the snaps, read SLIPPING
     * because a career backup carried a larger share.
     *
     * WHAT REPLACES IT. Only two things move an arrow, and both are facts about
     * THIS room:
     *   - the listing disagrees with what men on this same roster actually did
     *   - the man directly in front of him is the fragile one
     * Everyone else holds, which is what most of a depth chart is doing.
     *
     * A player who arrived from elsewhere is stated as an arrival and holds. He
     * may well take the job — but his old share is evidence about his old team,
     * and the honest surface for "we cannot tell" is to say so rather than to
     * pick an arrow.
     */
    for (const m of room) {
      // Same-roster comparisons only. `shareTeam` is non-null exactly when the
      // share was earned somewhere else, which is the case that cannot compare.
      const sameTeam = (x: (typeof room)[number]) => x.shareTeam === null && x.hasRole;
      const above = room.filter((x) => x.depthRank < m.depthRank);
      const below = room.filter((x) => x.depthRank > m.depthRank);
      const directlyAbove = above.length ? above[above.length - 1]! : null;

      const biggerShareBelow = sameTeam(m)
        ? below.filter(sameTeam).find((x) => x.volumeShare > m.volumeShare)
        : undefined;
      const smallerShareAbove = sameTeam(m)
        ? above.filter(sameTeam).find((x) => x.volumeShare < m.volumeShare)
        : undefined;
      const fragileDirectlyAbove =
        directlyAbove &&
        directlyAbove.hasRole &&
        directlyAbove.vulnerabilityKnown &&
        directlyAbove.vulnerability >= 0.5
          ? directlyAbove
          : null;

      if (!m.hasRole) {
        m.trend = 'holding';
        m.trendReason = 'no real role';
      } else if (m.shareTeam) {
        // New arrival. Real, unquantifiable from a share earned elsewhere, and
        // said plainly instead of being turned into an arrow.
        m.trend = 'holding';
        m.trendReason = `arrived from ${m.shareTeam}, last season's share was earned there`;
      } else if (biggerShareBelow) {
        m.trend = 'slipping';
        m.trendReason = `${biggerShareBelow.name} is listed below him and took more of the work here`;
      } else if (
        /*
         * A man can only slip on his own availability if he is the one holding
         * the job. Brady Cook, listed third, read "5.0 games a year" and an arrow
         * pointing down — a statement about losing something he does not have.
         * The number was true and the claim was not, which is worse than either.
         *
         * Backup quarterbacks made this obvious because `pass_snap_share` is
         * conditional on appearing (bug #2), so anyone who mops up for a game
         * reads 90%+. But it applied everywhere: a TE2 at 33 and a WR8 who
         * played six games both carried a losing-ground arrow.
         *
         * LISTED FIRST, and nothing else. "Heaviest usage in the room" was the
         * obvious second hatch and it lets the same artefact straight back in —
         * Brady Cook's 97% off five appearances is the biggest share in the
         * room and he is still the third quarterback. Where the listing and the
         * usage genuinely disagree, the two room-fact rules either side of this
         * one already say so from both directions.
         */
        m.depthRank === 1 &&
        m.vulnerabilityKnown &&
        m.vulnerability >= 0.5 &&
        m.vulnerabilityReason
      ) {
        m.trend = 'slipping';
        m.trendReason = m.vulnerabilityReason;
      } else if (smallerShareAbove) {
        m.trend = 'rising';
        m.trendReason = `took more of the work here than ${smallerShareAbove.name} listed above him`;
      } else if (fragileDirectlyAbove) {
        m.trend = 'rising';
        m.trendReason = `${fragileDirectlyAbove.name} directly ahead of him is the fragile one`;
      } else {
        m.trend = 'holding';
        m.trendReason = 'listing and production agree';
      }
    }

    for (const player of list) {
      const own = vulnerabilityOf(risk.get(player.playerId)?.expectedGames ?? null, player.age, player.pos, player.usageGrade, player.volumeShare);
      const usageRank = usageRankOf.get(player.playerId) ?? null;
      const reasons: string[] = [];

      /*
       * Start from the chance he simply keeps playing, then take away for the
       * two ways a listed role can be less real than it looks: the usage does
       * not back it up, or somebody behind him has a better claim than his
       * listing suggests.
       */
      let certainty = 1 - own.p;
      if (own.reason) reasons.push(own.reason);

      if (usageRank !== null && usageRank > player.depthRank) {
        // Listed ahead of where his production says he belongs.
        const gap = usageRank - player.depthRank;
        certainty -= Math.min(0.3, gap * 0.15);
        reasons.push(
          `listed ${player.pos}${player.depthRank} but only the ${usageRank}${ordinal(usageRank)} heaviest ` +
            `${player.pos === 'RB' ? 'rush' : player.pos === 'QB' ? 'snap' : 'target'} share in this room`,
        );
      } else if (usageRank !== null && usageRank < player.depthRank) {
        // Produced more than his listing implies — the job may be undersold.
        reasons.push(
          `carried the ${usageRank}${usageRank === 1 ? 'st' : usageRank === 2 ? 'nd' : 'rd'} heaviest ` +
            `share in this room while listed ${player.pos}${player.depthRank}`,
        );
        certainty += 0.05;
      }

      // A short sample is not evidence of a secure role either way.
      if ((player.gamesPlayed ?? 0) > 0 && (player.gamesPlayed ?? 0) <= 6) {
        certainty -= 0.1;
        reasons.push(`only ${player.gamesPlayed} games of evidence`);
      }

      // Someone behind him who out-produced him is a live threat.
      const behind = list.filter((r) => r.depthRank > player.depthRank);
      const challenger = behind.find(
        (r) => (usageRankOf.get(r.playerId) ?? 99) < (usageRank ?? 99),
      );
      if (challenger) {
        certainty -= 0.12;
        reasons.push(`${challenger.name} behind him produced more per game`);
      }

      out.set(player.playerId, {
        playerId: player.playerId,
        position: player.pos,
        team: player.team,
        certainty: Math.round(Math.max(0, Math.min(1, certainty)) * 100),
        depthRank: player.depthRank,
        usageRank,
        ownVulnerability: own.p,
        certaintyKnown: own.known,
        reasons,
        room: room.map((m) => ({ ...m, isSelf: m.playerId === player.playerId })),
      });
    }
  }

  return out;
}

/**
 * Ordinal suffix. A hard-coded "th" printed "2th heaviest snap share" inside a
 * reason string that argues for the page's own precision — the same slip as
 * bug #66, one file over.
 */
function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}
