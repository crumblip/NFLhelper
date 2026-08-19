import { normalizeTeam } from '../../match/normalize';
import type { NewsFetch, RawInjury, RawNewsItem } from './types';

/**
 * ESPN's public site API. No key, no quota, no account.
 *
 * Two endpoints earn their place:
 *
 *  - `/news` returns the last 50 articles with a `categories` array that tags
 *    each one with team ids and **athlete ids**. That athlete id joins straight
 *    to `players.espn_id`, so player attribution is a key lookup rather than a
 *    name match. Measured on a live pull: 148 of 182 athlete tags resolved, and
 *    every miss was a lineman or a defensive back — for the four positions this
 *    project models, the join is effectively complete.
 *
 *  - `/injuries` returns all 32 teams at once, ~800 rows, and is much the
 *    richer of the two. Besides a status it carries `shortComment` (the beat
 *    report) and `longComment` (a written fantasy read that routinely names who
 *    gains from the absence). That paragraph is the reason the injury tab is
 *    worth building rather than being a status column on the board.
 *
 * The one trap: the injuries payload has **no `athlete.id` field**. The id is
 * only recoverable from the player's own web link
 * (`…/nfl/player/_/id/4870808/jeremiyah-love`), which is why `espnIdFromLinks`
 * exists. Pulling it out lifts the join from name matching to an id match —
 * measured at 453 of 459 skill-position rows, against 3 that then matched on
 * name and 3 genuine misses (two undrafted camp bodies and one two-way player
 * nflverse does not list at receiver).
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

/** ESPN caps the news feed at 50 whatever `limit` says. Verified at 100 and 200. */
const NEWS_LIMIT = 50;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': 'nflhelper/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/**
 * Digs the numeric athlete id out of whichever link carries it.
 *
 * The injuries endpoint omits `athlete.id` but every athlete object still
 * carries web links containing it. Without this the whole feed falls back to
 * name matching, which is where nicknames bite — ESPN files Marquise Brown as
 * "Hollywood Brown", and nflverse does not.
 */
function espnIdFromLinks(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const href = typeof l?.href === 'string' ? l.href : null;
    const m = href?.match(/\/id\/(\d+)/);
    if (m) return m[1]!;
  }
  return null;
}

/** The league-wide article feed. Team and athlete tags come from the payload. */
export async function fetchEspnNews(): Promise<NewsFetch> {
  try {
    const data = await getJson(`${BASE}/news?limit=${NEWS_LIMIT}`);
    const items: RawNewsItem[] = [];

    for (const a of data.articles ?? []) {
      const published = Date.parse(a.published ?? a.lastModified ?? '');
      if (!Number.isFinite(published)) continue;

      const categories = Array.isArray(a.categories) ? a.categories : [];
      const athletes = categories
        .filter((c: any) => c?.type === 'athlete')
        .map((c: any) => ({
          name: String(c.description ?? ''),
          espnId: c.athleteId != null ? String(c.athleteId) : espnIdFromLinks(c.athlete?.links),
        }))
        .filter((x: any) => x.name);

      const teams: string[] = categories
        .filter((c: any) => c?.type === 'team' && c.team?.abbreviation)
        .map((c: any) => normalizeTeam(c.team.abbreviation))
        .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0);

      items.push({
        externalId: String(a.id),
        headline: String(a.headline ?? '').trim(),
        body: a.description ? String(a.description).trim() : null,
        url: a.links?.web?.href ?? null,
        publishedAt: published,
        athletes,
        teams: [...new Set(teams)],
      });
    }

    return { source: 'espn', items };
  } catch (err) {
    return { source: 'espn', items: [], error: (err as Error).message };
  }
}

/**
 * Every injury ESPN lists, all 32 teams in one call.
 *
 * Team comes from the grouping rather than from the athlete, which is the right
 * way round: the feed is organised by team, so that attribution is the
 * publisher's own and needs no inference from us.
 */
export async function fetchEspnInjuries(): Promise<{ rows: RawInjury[]; error?: string }> {
  try {
    const data = await getJson(`${BASE}/injuries`);
    const rows: RawInjury[] = [];

    for (const group of data.injuries ?? []) {
      const team = normalizeTeam(abbrOf(group));
      for (const inj of group.injuries ?? []) {
        const a = inj.athlete;
        if (!a) continue;
        const name = String(a.displayName ?? '').trim();
        if (!name) continue;

        const reported = Date.parse(inj.date ?? '');
        rows.push({
          espnId: espnIdFromLinks(a.links),
          name,
          position: a.position?.abbreviation ?? null,
          // The athlete's own team is present too, but the group is the
          // publisher's grouping and cannot disagree with itself.
          team: team ?? normalizeTeam(a.team?.abbreviation),
          status: String(inj.status ?? a.status?.name ?? 'Unknown'),
          bodyPart: inj.type?.description ?? inj.details?.type ?? null,
          detail: inj.shortComment ? String(inj.shortComment).trim() : null,
          analysis: inj.longComment ? String(inj.longComment).trim() : null,
          reportedAt: Number.isFinite(reported) ? reported : null,
        });
      }
    }

    return { rows };
  } catch (err) {
    return { rows: [], error: (err as Error).message };
  }
}

/**
 * The injuries feed identifies a group by display name ("Arizona Cardinals")
 * rather than by abbreviation, so the abbreviation has to come from a team link
 * where one exists and from the name otherwise.
 */
function abbrOf(group: any): string | null {
  if (group?.abbreviation) return String(group.abbreviation);
  const fromLink = espnTeamAbbrFromLinks(group?.links) ?? espnTeamAbbrFromLinks(group?.team?.links);
  if (fromLink) return fromLink;
  const name = String(group?.displayName ?? '');
  return NAME_TO_ABBR[name] ?? null;
}

function espnTeamAbbrFromLinks(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const m = typeof l?.href === 'string' ? l.href.match(/\/team\/_\/name\/([a-z]+)/i) : null;
    if (m) return m[1]!.toUpperCase();
  }
  return null;
}

/**
 * Display name to abbreviation, for the case where no link carries one.
 *
 * Written out rather than derived from `lib/teams.ts` because that file is
 * keyed by abbreviation and this needs the inverse, and because a silent miss
 * here drops a whole team's injuries — the exact shape of bug #63, where one
 * unmapped abbreviation removed all 32 Rams from every season.
 */
const NAME_TO_ABBR: Record<string, string> = {
  'Arizona Cardinals': 'ARI',
  'Atlanta Falcons': 'ATL',
  'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF',
  'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN',
  'Cleveland Browns': 'CLE',
  'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN',
  'Detroit Lions': 'DET',
  'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU',
  'Indianapolis Colts': 'IND',
  'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC',
  'Las Vegas Raiders': 'LV',
  'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LAR',
  'Miami Dolphins': 'MIA',
  'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE',
  'New Orleans Saints': 'NO',
  'New York Giants': 'NYG',
  'New York Jets': 'NYJ',
  'Philadelphia Eagles': 'PHI',
  'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF',
  'Seattle Seahawks': 'SEA',
  'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN',
  'Washington Commanders': 'WAS',
};
