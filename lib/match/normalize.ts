/**
 * Name and team normalization shared by every source that arrives as a string
 * rather than an id — FFC ADP and all sportsbooks.
 *
 * The rule is that normalization must be lossy in the same way on both sides.
 * "Ja'Marr" -> "jamarr" and "Amon-Ra" -> "amonra" are fine precisely because
 * nflverse names get the identical treatment.
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

export function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics: Peñix -> Penix
    .toLowerCase()
    .replace(/[.'’`]/g, '') // A.J. -> aj, Ja'Marr -> jamarr
    .replace(/[-_]/g, ' ') // Amon-Ra -> amon ra, collapsed below
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok && !SUFFIXES.has(tok))
    .join(' ')
    .trim()
    .replace(/\s+/g, '');
}

/** Keeps word boundaries, used for initial+surname matching. */
export function nameTokens(input: string): string[] {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9 -]/g, ' ')
    .split(/[\s-]+/)
    .filter((tok) => tok && !SUFFIXES.has(tok));
}

/** "Chase, Ja'Marr" -> "Ja'Marr Chase". Some feeds invert; most don't. */
export function unflipName(input: string): string {
  const m = input.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]!.trim()} ${m[1]!.trim()}` : input;
}

const TEAM_ALIASES: Record<string, string> = {
  JAC: 'JAX',
  LA: 'LAR',
  STL: 'LAR',
  SD: 'LAC',
  OAK: 'LV',
  LVR: 'LV',
  WSH: 'WAS',
  WFT: 'WAS',
  ARZ: 'ARI',
  BLT: 'BAL',
  CLV: 'CLE',
  HST: 'HOU',
  SFO: 'SF',
  TAM: 'TB',
  GNB: 'GB',
  KAN: 'KC',
  NWE: 'NE',
  NOR: 'NO',
  NNY: 'NYG',
};

export function normalizeTeam(input: string | null | undefined): string | null {
  if (!input) return null;
  const up = input.trim().toUpperCase();
  if (!up || up === 'FA' || up === 'NONE') return null;
  return TEAM_ALIASES[up] ?? up;
}

/** RB/WR/TE/QB only, everything else is out of scope by design. */
export const SCOPED_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

export function normalizePosition(input: string | null | undefined): string | null {
  if (!input) return null;
  const up = input.trim().toUpperCase();
  if (up === 'FB') return 'RB'; // nflverse splits FB; fantasy treats it as RB
  if (up === 'PK' || up === 'K' || up === 'DEF' || up === 'DST') return null;
  return up;
}

/**
 * Jaro-Winkler. Chosen over Levenshtein because the errors we see are
 * transpositions and dropped letters near the start ("Deebo"/"DeeBo",
 * "Chigoziem"/"Chig"), which Winkler's prefix bonus handles well.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}
