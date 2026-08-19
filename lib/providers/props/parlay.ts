import type { PropsProvider, RawPropLine } from './types';

/**
 * ParlayAPI adapter.
 *
 * Two things about this provider are worth knowing, both found the hard way:
 *
 * 1. The documented `/sports/{sport}/props` endpoint returns an empty array for
 *    every sport — including ones mid-season — and still bills 3 credits for
 *    the empty response. The endpoint that actually carries data is
 *    `/sports/{sport}/odds/props`, which appears only in the OpenAPI spec.
 *
 * 2. Season-long and per-game props arrive interleaved with no scope field.
 *    Separating them is the classifier's job, not the adapter's; this layer
 *    reports what was posted and nothing more.
 */

const BASE = 'https://parlay-api.com/v1';
const SPORT = 'americanfootball_nfl';

interface ParlayPropRow {
  player?: string | null;
  bookmaker?: string | null;
  market_key?: string | null;
  line?: number | null;
  over_price?: number | null;
  under_price?: number | null;
  event_id?: string | null;
  game_date?: string | null;
  home_team?: string | null;
  away_team?: string | null;
}

export interface ParlayUsage {
  creditsUsed: number;
  creditsRemaining: number;
  creditsTotal: number;
  tier: string;
  periodEnd: string;
}

export class ParlayProvider implements PropsProvider {
  readonly name = 'parlay';
  creditsUsed = 0;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('PARLAY_API_KEY is not set');
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'X-API-Key': this.apiKey },
    });
    // The provider reports what the call cost on the way out; empty responses
    // are billed too, so this is tracked whether or not data came back.
    this.creditsUsed += Number(res.headers.get('x-requests-last') ?? 0);

    const body = await res.text();
    if (!res.ok) throw new Error(`ParlayAPI ${res.status} on ${path}: ${body.slice(0, 200)}`);
    return JSON.parse(body);
  }

  /** Account state. Free — no credits, so safe to call before and after a run. */
  async usage(): Promise<ParlayUsage> {
    const j = (await this.get('/usage')) as {
      credits_used: number;
      credits_remaining: number;
      credits_total: number;
      tier: string;
      period_end: string;
    };
    return {
      creditsUsed: j.credits_used,
      creditsRemaining: j.credits_remaining,
      creditsTotal: j.credits_total,
      tier: j.tier,
      periodEnd: j.period_end,
    };
  }

  async fetchNflProps(): Promise<RawPropLine[]> {
    const rows = (await this.get(
      `/sports/${SPORT}/odds/props?limit=5000`,
    )) as ParlayPropRow[];

    if (!Array.isArray(rows)) throw new Error('unexpected props payload shape');

    return rows
      .filter((r) => r.player && r.market_key)
      .map((r) => ({
        rawPlayer: String(r.player),
        book: String(r.bookmaker ?? 'unknown'),
        marketKey: String(r.market_key),
        line: r.line ?? null,
        overPrice: r.over_price ?? null,
        underPrice: r.under_price ?? null,
        eventId: r.event_id ?? null,
        gameDate: r.game_date ?? null,
        homeTeam: r.home_team ?? null,
        awayTeam: r.away_team ?? null,
      }));
  }
}

/**
 * Season-long props come from a very small number of books — currently only
 * Underdog posts them for NFL — so a run returning nothing is a real condition
 * worth surfacing rather than an error.
 */
export function summarise(rows: RawPropLine[]) {
  const books = new Map<string, number>();
  const markets = new Map<string, number>();
  for (const r of rows) {
    books.set(r.book, (books.get(r.book) ?? 0) + 1);
    markets.set(r.marketKey, (markets.get(r.marketKey) ?? 0) + 1);
  }
  return { books, markets, total: rows.length };
}
