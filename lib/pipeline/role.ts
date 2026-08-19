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
    /** False when he holds too little work for the question to mean anything. */
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
              u.games AS gamesPlayed, u.team AS usageTeam
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

    const room = list.map((r) => ({
      playerId: r.playerId,
      name: r.name,
      depthRank: r.depthRank,
      usageRank: usageRankOf.get(r.playerId) ?? null,
      volumeShare: r.volumeShare,
      shareTeam: r.usageTeam && r.usageTeam !== r.team ? r.usageTeam : null,
      ...(() => {
        const v = vulnerabilityOf(risk.get(r.playerId)?.expectedGames ?? null, r.age, r.pos, r.usageGrade, r.volumeShare);
        return { vulnerability: v.p, vulnerabilityKnown: v.known, hasRole: v.hasRole };
      })(),
      trend: 'holding' as 'rising' | 'holding' | 'slipping',
      trendReason: '',
      isSelf: false,
    }));

    /*
     * Direction, decided by two facts the room already contains.
     *
     * A man ahead is SLIPPING when he is fragile — he misses time, he is past
     * the age curve for his position, or somebody below him out-produced him
     * last season despite the listing. A man behind is RISING when he is the one
     * doing that out-producing, or when the player directly above him is the
     * fragile one. Everyone else is holding, which is most of a depth chart and
     * should read that way.
     *
     * This is the same vulnerability model, but pointed at the question that
     * matters: not "how safe is this row" but "which way is this room moving".
     */
    for (const m of room) {
      const above = room.filter((x) => x.depthRank < m.depthRank);
      const below = room.filter((x) => x.depthRank > m.depthRank);
      const outproducedFromBelow = below.find(
        (x) => x.usageRank !== null && m.usageRank !== null && x.usageRank < m.usageRank,
      );
      const fragileAbove = above.find((x) => x.hasRole && x.vulnerabilityKnown && x.vulnerability >= 0.5);

      if (!m.hasRole) {
        m.trend = 'holding';
        m.trendReason = 'no role either way';
      } else if (outproducedFromBelow) {
        m.trend = 'slipping';
        m.trendReason = `${outproducedFromBelow.name} below him produced more per game`;
      } else if (m.vulnerabilityKnown && m.vulnerability >= 0.5) {
        m.trend = 'slipping';
        m.trendReason = 'misses time or is past the age curve';
      } else if (m.usageRank !== null && m.depthRank > m.usageRank) {
        m.trend = 'rising';
        m.trendReason = `out-produced the men listed above him`;
      } else if (fragileAbove) {
        m.trend = 'rising';
        m.trendReason = `${fragileAbove.name} ahead of him is the fragile one`;
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
