import { NFLVERSE_EXTRA, download, streamCsv, str, int } from './sources';
import { normalizeTeam } from '../match/normalize';

/**
 * Scoring opportunity from play-by-play.
 *
 * Touchdowns are the largest single swing in fantasy scoring, and who a team
 * hands the ball to inside the 5 is a coaching tendency that persists across
 * seasons. That makes goal-line *chances* worth measuring even though
 * touchdown *rate* is mostly luck and regresses hard.
 *
 * Only the current-season file needs refetching in-season; prior seasons are
 * frozen, so the ~100 MB per season is a one-time cost each.
 */

/** Inside the opponent's 20-yard line. */
const RED_ZONE = 20;
/** Inside the 5 — the goal-line role specifically. */
const GOAL_LINE = 5;

export interface RedZoneTotals {
  rzCarries: number;
  rzTargets: number;
  goalLineCarries: number;
  goalLineTargets: number;
  rzTds: number;
  totalTds: number;
}

export interface RedZoneSeason {
  byPlayer: Map<string, RedZoneTotals>;
  /** Keyed `team|week`, so a player's share counts only the weeks he played. */
  teamRzPlaysByWeek: Map<string, number>;
  teamGoalLinePlaysByWeek: Map<string, number>;
  playerTeam: Map<string, string>;
}

const empty = (): RedZoneTotals => ({
  rzCarries: 0,
  rzTargets: 0,
  goalLineCarries: 0,
  goalLineTargets: 0,
  rzTds: 0,
  totalTds: 0,
});

export async function loadRedZone(
  season: number,
  maxAgeMs: number,
): Promise<RedZoneSeason | null> {
  let path: string;
  try {
    path = await download(`play_by_play_${season}.csv`, NFLVERSE_EXTRA.pbp(season), maxAgeMs);
  } catch {
    console.log(`  skip pbp ${season} (not published)`);
    return null;
  }

  const out: RedZoneSeason = {
    byPlayer: new Map(),
    teamRzPlaysByWeek: new Map(),
    teamGoalLinePlaysByWeek: new Map(),
    playerTeam: new Map(),
  };

  const get = (id: string) => {
    const e = out.byPlayer.get(id) ?? empty();
    out.byPlayer.set(id, e);
    return e;
  };

  await streamCsv(path, (r) => {
    const team = normalizeTeam(str(r.posteam));
    const rusher = str(r.rusher_player_id);
    const receiver = str(r.receiver_player_id);
    const yardline = int(r.yardline_100);
    const isRush = str(r.rush_attempt) === '1';
    const isPass = str(r.pass_attempt) === '1';

    // Every touchdown counts, wherever it came from — the red-zone split is a
    // separate question from total scoring.
    const tdPlayer = str(r.td_player_id);
    if (tdPlayer && str(r.touchdown) === '1') {
      const e = get(tdPlayer);
      e.totalTds++;
      if (yardline !== null && yardline <= RED_ZONE) e.rzTds++;
    }

    if (team) {
      if (rusher) out.playerTeam.set(rusher, team);
      if (receiver) out.playerTeam.set(receiver, team);
    }

    if (yardline === null || yardline > RED_ZONE) return;
    if (!isRush && !isPass) return;

    const week = int(r.week);
    if (team && week !== null) {
      const wk = `${team}|${week}`;
      out.teamRzPlaysByWeek.set(wk, (out.teamRzPlaysByWeek.get(wk) ?? 0) + 1);
      if (yardline <= GOAL_LINE) {
        out.teamGoalLinePlaysByWeek.set(wk, (out.teamGoalLinePlaysByWeek.get(wk) ?? 0) + 1);
      }
    }

    if (isRush && rusher) {
      const e = get(rusher);
      e.rzCarries++;
      if (yardline <= GOAL_LINE) e.goalLineCarries++;
    }
    // Targets, not receptions: an incomplete pass in the end zone is still a
    // scoring chance the coach chose to give this player.
    if (isPass && receiver) {
      const e = get(receiver);
      e.rzTargets++;
      if (yardline <= GOAL_LINE) e.goalLineTargets++;
    }
  });

  return out;
}
