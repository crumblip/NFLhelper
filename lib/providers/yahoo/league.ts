import { YahooClient, collection, flatten, deepFind, num, str } from './client';

/**
 * Typed readers for the handful of Yahoo resources this tool needs.
 *
 * Scope is deliberately small: who is in the league, what they are called, and
 * which players they hold. No transactions, no scoreboards, no projections —
 * Yahoo's projections in particular would sit oddly next to a board built from
 * calibrated usage, and mixing someone else's opinion into this one is what the
 * ADP-only rule upstream exists to avoid.
 *
 * ROSTERS ARE FETCHED ONE TEAM AT A TIME, and that is a choice worth defending.
 * `/league/{key}/teams/roster` returns all twelve in a single call, but it
 * returns them as nested anonymous collections where a player's owner is
 * implied by his position in the tree. Twelve requests cost nothing on a script
 * that runs a few times a week, and in exchange every player arrives attached to
 * a team key that came from the URL rather than from counting brackets.
 * Ownership is the one fact here that must not be wrong.
 */

export interface YahooLeagueSummary {
  leagueKey: string;
  leagueId: string;
  name: string;
  season: number;
  numTeams: number;
  scoringType: string | null;
  draftStatus: string | null;
  currentWeek: number | null;
}

export interface YahooTeamRow {
  teamKey: string;
  teamId: number;
  name: string;
  managerName: string | null;
  logoUrl: string | null;
  isMine: boolean;
  waiverPriority: number | null;
  faabBalance: number | null;
}

export interface YahooPlayerRow {
  playerKey: string;
  playerId: string;
  name: string;
  position: string | null;
  nflTeam: string | null;
  selectedPosition: string | null;
  injuryStatus: string | null;
  eligiblePositions: string[];
}

function parseLeague(node: unknown): YahooLeagueSummary | null {
  const m = flatten(node);
  const key = str(m.league_key);
  if (!key) return null;
  return {
    leagueKey: key,
    leagueId: str(m.league_id) ?? key,
    name: str(m.name) ?? key,
    season: num(m.season) ?? 0,
    numTeams: num(m.num_teams) ?? 0,
    scoringType: str(m.scoring_type),
    draftStatus: str(m.draft_status),
    currentWeek: num(m.current_week),
  };
}

/**
 * Every NFL league the authenticated user is in.
 *
 * `game_keys=nfl` is the alias for the current season's game, so this needs no
 * hard-coded game key that would silently go stale each September.
 */
export async function discoverLeagues(c: YahooClient): Promise<YahooLeagueSummary[]> {
  const content = await c.content('/users;use_login=1/games;game_keys=nfl/leagues');
  const leagues = deepFind(content, 'leagues');
  const out: YahooLeagueSummary[] = [];
  for (const entry of collection(leagues)) {
    const parsed = parseLeague(deepFind(entry, 'league') ?? entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface YahooSettings {
  rosterPositions: Record<string, number>;
  statModifiers: Record<string, number>;
}

/**
 * Roster slots and scoring modifiers.
 *
 * Stored rather than applied. Replacement level here is derived from roster
 * slots by `replacementRanks()`, and the scoring rules drive the baseline fit —
 * so adopting these automatically would silently re-cut calibrations measured
 * under half-PPR. Reading them is cheap, and it lets the app say whether the
 * league it is connected to is the league it was tuned for.
 */
export async function leagueSettings(c: YahooClient, leagueKey: string): Promise<YahooSettings> {
  const content = await c.content(`/league/${leagueKey}/settings`);
  const settings = deepFind(content, 'settings');

  const rosterPositions: Record<string, number> = {};
  for (const rp of collection(deepFind(settings, 'roster_positions'))) {
    const p = flatten(deepFind(rp, 'roster_position') ?? rp);
    const pos = str(p.position);
    if (pos) rosterPositions[pos] = (rosterPositions[pos] ?? 0) + (num(p.count) ?? 1);
  }

  const statModifiers: Record<string, number> = {};
  for (const sm of collection(deepFind(deepFind(settings, 'stat_modifiers'), 'stats'))) {
    const s = flatten(deepFind(sm, 'stat') ?? sm);
    const id = str(s.stat_id);
    const v = num(s.value);
    if (id && v !== null) statModifiers[id] = v;
  }

  return { rosterPositions, statModifiers };
}

/**
 * Yahoo's stat id to human name mapping, read from the game rather than guessed.
 *
 * Scoring modifiers arrive keyed by numeric stat id, and the obvious shortcut is
 * a hard-coded table copied off a forum post — "11 is receptions" — which is
 * both unverifiable and exactly the kind of assertion this project keeps finding
 * bugs in. `/game/nfl/stat_categories` publishes the mapping, so one extra
 * request buys the difference between reading the league's scoring and guessing
 * at it.
 */
export async function statCategories(c: YahooClient): Promise<Map<string, string>> {
  const content = await c.content('/game/nfl/stat_categories');
  const out = new Map<string, string>();
  for (const entry of collection(deepFind(deepFind(content, 'stat_categories'), 'stats'))) {
    const s = flatten(deepFind(entry, 'stat') ?? entry);
    const id = str(s.stat_id);
    const name = str(s.display_name) ?? str(s.name);
    if (id && name) out.set(id, name);
  }
  return out;
}

export async function leagueMeta(c: YahooClient, leagueKey: string): Promise<YahooLeagueSummary> {
  const content = await c.content(`/league/${leagueKey}`);
  const parsed = parseLeague(deepFind(content, 'league'));
  if (!parsed) throw new Error(`could not read league ${leagueKey}`);
  return parsed;
}

/** The managers, with the authenticated user's own team marked. */
export async function leagueTeams(c: YahooClient, leagueKey: string): Promise<YahooTeamRow[]> {
  const content = await c.content(`/league/${leagueKey}/teams`);
  const out: YahooTeamRow[] = [];

  for (const entry of collection(deepFind(content, 'teams'))) {
    const node = deepFind(entry, 'team') ?? entry;
    const m = flatten(node);
    const key = str(m.team_key);
    if (!key) continue;

    // Managers is a collection even in a single-manager league.
    let managerName: string | null = null;
    let isMine = false;
    for (const mgr of collection(deepFind(node, 'managers'))) {
      const g = flatten(deepFind(mgr, 'manager') ?? mgr);
      managerName ??= str(g.nickname);
      // Yahoo marks the logged-in user's manager row, and only that row.
      if (num(g.is_current_login) === 1) isMine = true;
    }

    let logoUrl: string | null = null;
    for (const lg of collection(deepFind(node, 'team_logos'))) {
      const l = flatten(deepFind(lg, 'team_logo') ?? lg);
      logoUrl ??= str(l.url);
    }

    out.push({
      teamKey: key,
      teamId: num(m.team_id) ?? 0,
      name: str(m.name) ?? key,
      managerName,
      logoUrl,
      isMine,
      waiverPriority: num(m.waiver_priority),
      faabBalance: num(m.faab_balance),
    });
  }
  return out;
}

function parsePlayer(node: unknown): YahooPlayerRow | null {
  const p = flatten(node);
  const key = str(p.player_key);
  if (!key) return null;

  const nameNode =
    p.name && typeof p.name === 'object' ? (p.name as Record<string, unknown>) : {};
  const full =
    str(nameNode.full) ?? [str(nameNode.first), str(nameNode.last)].filter(Boolean).join(' ');

  const eligible: string[] = [];
  for (const e of collection(p.eligible_positions)) {
    const pos = str(flatten(e).position);
    if (pos) eligible.push(pos);
  }

  // selected_position is itself an array of single-key objects, and carries a
  // `position` that would collide with the player's own if merged blindly.
  const sel = p.selected_position ? flatten(p.selected_position) : {};

  return {
    playerKey: key,
    playerId: str(p.player_id) ?? key,
    name: full || key,
    position: str(p.display_position) ?? str(p.primary_position),
    nflTeam: str(p.editorial_team_abbr),
    selectedPosition: str(sel.position),
    injuryStatus: str(p.status),
    eligiblePositions: eligible,
  };
}

/** One team's roster. The owner comes from the URL, never from tree position. */
export async function teamRoster(c: YahooClient, teamKey: string): Promise<YahooPlayerRow[]> {
  const content = await c.content(`/team/${teamKey}/roster`);
  const out: YahooPlayerRow[] = [];
  for (const entry of collection(deepFind(content, 'players'))) {
    const parsed = parsePlayer(deepFind(entry, 'player') ?? entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Players currently on waivers.
 *
 * A separate state from free agency, and a meaningful one here: someone dropped
 * on Monday cannot simply be added, he has to be claimed, and the claim resolves
 * on a date. Yahoo pages these 25 at a time.
 */
export async function waiverPlayers(
  c: YahooClient,
  leagueKey: string,
  max = 200,
): Promise<Array<YahooPlayerRow & { waiverDate: string | null }>> {
  const out: Array<YahooPlayerRow & { waiverDate: string | null }> = [];
  const PAGE = 25;
  for (let start = 0; start < max; start += PAGE) {
    const content = await c.content(
      `/league/${leagueKey}/players;status=W;start=${start};count=${PAGE}`,
    );
    const entries = collection(deepFind(content, 'players'));
    if (entries.length === 0) break;
    for (const entry of entries) {
      const node = deepFind(entry, 'player') ?? entry;
      const parsed = parsePlayer(node);
      if (!parsed) continue;
      const ownership = flatten(deepFind(node, 'ownership'));
      out.push({ ...parsed, waiverDate: str(ownership.waiver_date) });
    }
    if (entries.length < PAGE) break;
  }
  return out;
}
