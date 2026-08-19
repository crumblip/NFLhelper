/**
 * Provider-agnostic prop shape. Everything downstream of this — devigging,
 * implied stats, the value engine — is written against these types, so
 * swapping providers means writing one adapter and nothing else.
 */

export interface RawPropLine {
  rawPlayer: string;
  book: string;
  marketKey: string;
  line: number | null;
  overPrice: number | null;
  underPrice: number | null;
  eventId?: string | null;
  gameDate?: string | null;
  /**
   * Blank on season-long props: the provider files them against a synthetic
   * container event with no teams. This is the strongest scope signal available
   * — see markets.ts.
   */
  homeTeam?: string | null;
  awayTeam?: string | null;
}

export interface PropsProvider {
  readonly name: string;
  /** Fetches every currently posted NFL player prop. */
  fetchNflProps(): Promise<RawPropLine[]>;
  /** Credits or requests consumed so far this run, for budget reporting. */
  readonly creditsUsed: number;
}
