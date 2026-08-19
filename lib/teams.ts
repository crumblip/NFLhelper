/**
 * Team identity, for the UI only.
 *
 * Nothing here touches a projection. It exists because a board of 300 rows is
 * read by scanning, and a colour the eye already associates with a team is a
 * faster index than three letters of text. Both official colours are carried so
 * a card can use the pair the way the team does.
 *
 * `primary` is the colour the team leads with. Several are near-black (Raiders,
 * Jaguars, Saints) or very dark (Browns brown, Bears navy), which reads as mud
 * on a dark background — so `bright` names the vivid one of the pair and is what
 * badges and accents use. Where the primary is already vivid the two match.
 */

export interface Team {
  abbr: string;
  /** City plus nickname, for tooltips and the card face. */
  name: string;
  nick: string;
  primary: string;
  secondary: string;
  /** The vivid colour of the pair — safe as an accent in either theme. */
  bright: string;
}

const T = (
  abbr: string,
  name: string,
  nick: string,
  primary: string,
  secondary: string,
  bright = primary,
): Team => ({ abbr, name, nick, primary, secondary, bright });

export const TEAMS: Record<string, Team> = {
  ARI: T('ARI', 'Arizona Cardinals', 'Cardinals', '#97233F', '#FFB612'),
  ATL: T('ATL', 'Atlanta Falcons', 'Falcons', '#A71930', '#A5ACAF'),
  BAL: T('BAL', 'Baltimore Ravens', 'Ravens', '#241773', '#9E7C0C', '#7B5BD6'),
  BUF: T('BUF', 'Buffalo Bills', 'Bills', '#00338D', '#C60C30', '#2A6BE0'),
  CAR: T('CAR', 'Carolina Panthers', 'Panthers', '#0085CA', '#101820'),
  CHI: T('CHI', 'Chicago Bears', 'Bears', '#0B162A', '#C83803', '#E8551B'),
  CIN: T('CIN', 'Cincinnati Bengals', 'Bengals', '#FB4F14', '#101820'),
  CLE: T('CLE', 'Cleveland Browns', 'Browns', '#311D00', '#FF3C00', '#FF5C1F'),
  DAL: T('DAL', 'Dallas Cowboys', 'Cowboys', '#003594', '#869397', '#3D6FD1'),
  DEN: T('DEN', 'Denver Broncos', 'Broncos', '#FB4F14', '#002244'),
  DET: T('DET', 'Detroit Lions', 'Lions', '#0076B6', '#B0B7BC'),
  GB: T('GB', 'Green Bay Packers', 'Packers', '#203731', '#FFB612'),
  HOU: T('HOU', 'Houston Texans', 'Texans', '#03202F', '#A71930', '#C8253C'),
  IND: T('IND', 'Indianapolis Colts', 'Colts', '#002C5F', '#A2AAAD', '#2F6BB0'),
  JAX: T('JAX', 'Jacksonville Jaguars', 'Jaguars', '#101820', '#D7A22A', '#00A5AD'),
  KC: T('KC', 'Kansas City Chiefs', 'Chiefs', '#E31837', '#FFB81C'),
  LA: T('LA', 'Los Angeles Rams', 'Rams', '#003594', '#FFA300', '#3D6FD1'),
  LAR: T('LAR', 'Los Angeles Rams', 'Rams', '#003594', '#FFA300', '#3D6FD1'),
  LAC: T('LAC', 'Los Angeles Chargers', 'Chargers', '#0080C6', '#FFC20E'),
  LV: T('LV', 'Las Vegas Raiders', 'Raiders', '#101820', '#A5ACAF', '#9AA3A8'),
  MIA: T('MIA', 'Miami Dolphins', 'Dolphins', '#008E97', '#FC4C02'),
  MIN: T('MIN', 'Minnesota Vikings', 'Vikings', '#4F2683', '#FFC62F', '#8256C8'),
  NE: T('NE', 'New England Patriots', 'Patriots', '#002244', '#C60C30', '#3B6FA8'),
  NO: T('NO', 'New Orleans Saints', 'Saints', '#101820', '#D3BC8D', '#C9AE72'),
  NYG: T('NYG', 'New York Giants', 'Giants', '#0B2265', '#A71930', '#33569E'),
  NYJ: T('NYJ', 'New York Jets', 'Jets', '#125740', '#FFFFFF', '#1E9464'),
  PHI: T('PHI', 'Philadelphia Eagles', 'Eagles', '#004C54', '#A5ACAF', '#118A96'),
  PIT: T('PIT', 'Pittsburgh Steelers', 'Steelers', '#FFB612', '#101820'),
  SEA: T('SEA', 'Seattle Seahawks', 'Seahawks', '#002244', '#69BE28', '#69BE28'),
  SF: T('SF', 'San Francisco 49ers', '49ers', '#AA0000', '#B3995D', '#C81E1E'),
  TB: T('TB', 'Tampa Bay Buccaneers', 'Buccaneers', '#D50A0A', '#FF7900'),
  TEN: T('TEN', 'Tennessee Titans', 'Titans', '#0C2340', '#4B92DB', '#4B92DB'),
  WAS: T('WAS', 'Washington Commanders', 'Commanders', '#5A1414', '#FFB612', '#9E2B2B'),
};

/** Free agents and stale abbreviations fall back to a neutral identity. */
const NEUTRAL: Team = {
  abbr: 'FA',
  name: 'Free agent',
  nick: 'Free agent',
  primary: '#6b6a66',
  secondary: '#a8a7a2',
  bright: '#8a8984',
};

export function teamOf(abbr: string | null | undefined): Team {
  if (!abbr) return NEUTRAL;
  return TEAMS[abbr.toUpperCase()] ?? { ...NEUTRAL, abbr: abbr.toUpperCase(), nick: abbr };
}

/**
 * Inline custom properties for a team-coloured element.
 *
 * Returned as a style object rather than a class so the 32 palettes do not each
 * need a stylesheet rule; the CSS reads `var(--team)` and stays generic.
 */
export function teamStyle(abbr: string | null | undefined): React.CSSProperties {
  const t = teamOf(abbr);
  return {
    ['--team' as string]: t.primary,
    ['--team-2' as string]: t.secondary,
    ['--team-bright' as string]: t.bright,
  };
}

/** Position accent colours, shared by badges, the card frame and the board. */
export const POSITION_COLOR: Record<string, string> = {
  QB: '#c2410c',
  RB: '#15803d',
  WR: '#1d4ed8',
  TE: '#7e22ce',
};

export function positionColor(pos: string | null | undefined): string {
  return POSITION_COLOR[(pos ?? '').toUpperCase()] ?? '#6b6a66';
}
