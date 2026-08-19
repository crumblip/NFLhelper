import { sqlite } from '../db/index';
import { normalizeName, unflipName } from '../match/normalize';

/**
 * Who is actually available, in one particular league.
 *
 * The waiver wire used to answer this from `adp_raw`: anyone the national market
 * drafts is not on the wire. That is a proxy, and it is wrong in both directions
 * at once. A player drafted everywhere but cut in this league never appeared,
 * all season. A player nobody drafts nationally but someone stashed in August
 * showed as free until December. Neither error is visible from the inside —
 * both produce a plausible-looking board.
 *
 * With a league connected the proxy becomes unnecessary: ownership is a fact
 * Yahoo will simply state. What this module does is decide which of the two
 * sources is answering, and make that decision legible to everything downstream,
 * because a fallback presented as a measurement is family #6 and accounts for a
 * third of the bug list in this project.
 *
 * THE FALLBACK RULE, and why it is not just "use Yahoo if present": before the
 * draft every roster in the league is empty. Ownership would then be perfectly
 * accurate and perfectly useless — it would report all 500 players as available,
 * which is true and tells a drafter nothing. So Yahoo takes over only once there
 * is a drafted roster to read, exactly the shape of `resolveUsageSeason()`,
 * which goes live only when games have been played AND rows exist to read.
 */

export type AvailabilitySource = 'yahoo' | 'adp';

export interface OwnerInfo {
  teamKey: string;
  teamName: string;
  managerName: string | null;
  isMine: boolean;
  /** The lineup slot the owner has him in. 'BN' is a bench stash. */
  selectedPosition: string | null;
}

export interface Availability {
  source: AvailabilitySource;
  leagueKey: string | null;
  leagueName: string | null;
  draftStatus: string | null;
  /** Everyone who cannot be added: rostered or mid-waiver-claim. */
  unavailable: Set<string>;
  ownerOf: Map<string, OwnerInfo>;
  /** gsis id to the date a waiver claim resolves. */
  waiverUntil: Map<string, string | null>;
  /**
   * Yahoo rows whose name did not resolve to a gsis id.
   *
   * Reported rather than buried. These players are still excluded — by
   * normalized name, see `unavailableNames` — but an unresolved row is a hole in
   * the join and the count is the honest measure of how big it is.
   */
  unresolved: number;
  /** Rostered players, total. Zero before a draft. */
  rosteredCount: number;
}

export interface LeagueTeam {
  teamKey: string;
  teamId: number;
  name: string;
  managerName: string | null;
  logoUrl: string | null;
  isMine: boolean;
  waiverPriority: number | null;
  faabBalance: number | null;
}

export interface ConnectedLeague {
  leagueKey: string;
  name: string;
  season: number;
  numTeams: number;
  scoringType: string | null;
  draftStatus: string | null;
  currentWeek: number | null;
  rosterPositions: Record<string, number>;
  fetchedAt: number;
}

interface LeagueRow {
  league_key: string;
  name: string;
  season: number;
  num_teams: number;
  scoring_type: string | null;
  draft_status: string | null;
  current_week: number | null;
  roster_positions: string | null;
  fetched_at: number;
}

/** The connected league for a season, or null if none has been ingested. */
export function connectedLeague(season: number): ConnectedLeague | null {
  const row = sqlite
    .prepare(`SELECT * FROM yahoo_league WHERE season = ? ORDER BY fetched_at DESC LIMIT 1`)
    .get(season) as LeagueRow | undefined;
  if (!row) return null;

  let rosterPositions: Record<string, number> = {};
  try {
    rosterPositions = row.roster_positions ? JSON.parse(row.roster_positions) : {};
  } catch {
    rosterPositions = {};
  }

  return {
    leagueKey: row.league_key,
    name: row.name,
    season: row.season,
    numTeams: row.num_teams,
    scoringType: row.scoring_type,
    draftStatus: row.draft_status,
    currentWeek: row.current_week,
    rosterPositions,
    fetchedAt: row.fetched_at,
  };
}

export function leagueTeams(leagueKey: string): LeagueTeam[] {
  return (
    sqlite
      .prepare(`SELECT * FROM yahoo_team WHERE league_key = ? ORDER BY team_id`)
      .all(leagueKey) as Array<{
      team_key: string;
      team_id: number;
      name: string;
      manager_name: string | null;
      logo_url: string | null;
      is_mine: number;
      waiver_priority: number | null;
      faab_balance: number | null;
    }>
  ).map((r) => ({
    teamKey: r.team_key,
    teamId: r.team_id,
    name: r.name,
    managerName: r.manager_name,
    logoUrl: r.logo_url,
    isMine: !!r.is_mine,
    waiverPriority: r.waiver_priority,
    faabBalance: r.faab_balance,
  }));
}

export interface RosteredPlayer {
  yahooPlayerKey: string;
  playerId: string | null;
  name: string;
  position: string | null;
  nflTeam: string | null;
  selectedPosition: string | null;
  injuryStatus: string | null;
}

/** One team's roster as stored. Ordered so starters lead and the bench follows. */
export function rosterFor(teamKey: string): RosteredPlayer[] {
  const SLOT_ORDER = ['QB', 'WR', 'RB', 'TE', 'W/R/T', 'FLEX', 'K', 'DEF', 'BN', 'IR'];
  const rows = sqlite
    .prepare(
      `SELECT yahoo_player_key, player_id, name, position, nfl_team,
              selected_position, injury_status
       FROM yahoo_ownership WHERE team_key = ? AND status = 'rostered'`,
    )
    .all(teamKey) as Array<{
    yahoo_player_key: string;
    player_id: string | null;
    name: string;
    position: string | null;
    nfl_team: string | null;
    selected_position: string | null;
    injury_status: string | null;
  }>;

  return rows
    .map((r) => ({
      yahooPlayerKey: r.yahoo_player_key,
      playerId: r.player_id,
      name: r.name,
      position: r.position,
      nflTeam: r.nfl_team,
      selectedPosition: r.selected_position,
      injuryStatus: r.injury_status,
    }))
    .sort((a, b) => {
      const ai = SLOT_ORDER.indexOf(a.selectedPosition ?? 'BN');
      const bi = SLOT_ORDER.indexOf(b.selectedPosition ?? 'BN');
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.name.localeCompare(b.name);
    });
}

/**
 * Names of everyone unavailable, normalized.
 *
 * The second lock on the door. Exclusion runs on gsis id, but a Yahoo row whose
 * name failed to resolve has no id to exclude by — and the consequence of
 * missing one is not a blank row, it is a rostered player advertised as a free
 * add. Matching on the normalized name as well means a resolution miss degrades
 * to "correctly hidden" rather than "confidently wrong".
 */
function unavailableNameSet(leagueKey: string): Set<string> {
  const rows = sqlite
    .prepare(`SELECT name FROM yahoo_ownership WHERE league_key = ?`)
    .all(leagueKey) as Array<{ name: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    const n = normalizeName(unflipName(r.name));
    if (n) out.add(n);
  }
  return out;
}

export interface AvailabilityWithNames extends Availability {
  /** Normalized names of the unavailable, for the id-miss fallback above. */
  unavailableNames: Set<string>;
}

/**
 * Resolve who is unavailable, from Yahoo if a drafted league is connected and
 * from national ADP otherwise.
 */
export function resolveAvailability(
  format: string,
  teams: number,
  season: number,
): AvailabilityWithNames {
  const league = connectedLeague(season);

  const rosteredCount = league
    ? (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM yahoo_ownership
             WHERE league_key = ? AND status = 'rostered'`,
          )
          .get(league.leagueKey) as { n: number }
      ).n
    : 0;

  // The guard: a connected league with nobody drafted cannot answer the question.
  const useYahoo = !!league && rosteredCount > 0;

  if (!useYahoo) {
    const drafted = new Set(
      (
        sqlite
          .prepare(
            `SELECT player_id FROM adp_raw WHERE year = ? AND format = ? AND teams = ?
             AND player_id IS NOT NULL`,
          )
          .all(season, format, teams) as Array<{ player_id: string }>
      ).map((r) => r.player_id),
    );
    return {
      source: 'adp',
      leagueKey: league?.leagueKey ?? null,
      leagueName: league?.name ?? null,
      draftStatus: league?.draftStatus ?? null,
      unavailable: drafted,
      ownerOf: new Map(),
      waiverUntil: new Map(),
      unresolved: 0,
      rosteredCount,
      unavailableNames: new Set(),
    };
  }

  const teamRows = new Map(leagueTeams(league!.leagueKey).map((t) => [t.teamKey, t]));

  const rows = sqlite
    .prepare(
      `SELECT player_id, name, status, team_key, selected_position, waiver_date
       FROM yahoo_ownership WHERE league_key = ?`,
    )
    .all(league!.leagueKey) as Array<{
    player_id: string | null;
    name: string;
    status: string;
    team_key: string | null;
    selected_position: string | null;
    waiver_date: string | null;
  }>;

  const unavailable = new Set<string>();
  const ownerOf = new Map<string, OwnerInfo>();
  const waiverUntil = new Map<string, string | null>();
  let unresolved = 0;

  for (const r of rows) {
    if (!r.player_id) {
      unresolved++;
      continue;
    }
    unavailable.add(r.player_id);
    if (r.status === 'waivers') {
      waiverUntil.set(r.player_id, r.waiver_date);
      continue;
    }
    const team = r.team_key ? teamRows.get(r.team_key) : undefined;
    if (team) {
      ownerOf.set(r.player_id, {
        teamKey: team.teamKey,
        teamName: team.name,
        managerName: team.managerName,
        isMine: team.isMine,
        selectedPosition: r.selected_position,
      });
    }
  }

  return {
    source: 'yahoo',
    leagueKey: league!.leagueKey,
    leagueName: league!.name,
    draftStatus: league!.draftStatus,
    unavailable,
    ownerOf,
    waiverUntil,
    unresolved,
    rosteredCount,
    unavailableNames: unavailableNameSet(league!.leagueKey),
  };
}
