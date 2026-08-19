/**
 * FantasyFootballCalculator ADP.
 *
 * This is the tool's only external ranking input, and deliberately so: ADP is a
 * record of what drafters actually did, not an analyst's opinion. We touch only
 * /api/v1/adp — FFC also publishes expert rankings, which stay out of scope.
 *
 * Terms as of Aug 2026: free for personal and commercial use, attribution
 * requested, data refreshes once daily, and they ask callers not to poll hard.
 */

const BASE = 'https://fantasyfootballcalculator.com/api/v1/adp';

export type ScoringFormat = 'standard' | 'ppr' | 'half-ppr' | '2qb' | 'dynasty';

export interface FfcPlayer {
  player_id: number;
  name: string;
  position: string;
  team: string | null;
  adp: number;
  adp_formatted: string;
  times_drafted: number;
  high: number;
  low: number;
  stdev: number;
  bye: number | null;
}

export interface FfcResponse {
  status: string;
  meta: {
    type: string;
    teams: number;
    rounds: number;
    total_drafts: number;
    start_date: string;
    end_date: string;
  };
  players: FfcPlayer[];
}

export async function fetchAdp(
  format: ScoringFormat,
  teams: number,
  year: number,
): Promise<FfcResponse> {
  const url = `${BASE}/${format}?teams=${teams}&year=${year}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'nflhelper (personal draft tool)' },
  });
  if (!res.ok) throw new Error(`FFC ${res.status} for ${format}/${teams}/${year}`);

  const json = (await res.json()) as FfcResponse;
  if (json.status !== 'Success') throw new Error(`FFC returned status=${json.status}`);
  return json;
}
