import { sqlite } from '../db/index';
import { normalizeName } from '../match/normalize';
import type { NewsCategory } from '../news-shared';
import { TEAMS } from '../teams';
import type { RawNewsItem } from '../providers/news/types';

/**
 * Turning a feed into fantasy news: who it is about, and why it matters.
 *
 * Two jobs, and they fail in different ways, so they are kept apart.
 *
 * **Attribution** is a fact question and is answered with ids wherever a source
 * supplies one. Where it does not, a name is matched against the registry and
 * the row records that it was matched by name — `method` on every mention — so
 * the page can distinguish "ESPN told us this is Ja'Marr Chase" from "we found
 * that string in a paragraph".
 *
 * **Relevance** is a judgement and is treated as one. There is no score. An
 * item is placed in a category by the phrase that put it there, that phrase is
 * stored (`categoryBasis`), and anything no rule matched is filed `general` and
 * left out of the tab rather than being given a low number. A number would
 * imply a measurement nobody made, which is family #6 and a third of this
 * project's bug list.
 *
 * The categories are ordered by how much they change a lineup decision, and an
 * item takes the first that matches. A trade that happens because of an injury
 * is filed under the injury, because that is the thing a drafter acts on.
 */

/*
 * The category vocabulary lives in `lib/news-shared.ts` rather than here, and
 * has to stay there: this module reads the database, so anything importing it
 * pulls `better-sqlite3` along — which a client component cannot bundle, and
 * which fails as `Can't resolve 'fs'` at the route rather than at the import.
 * The filter chips need these labels, so they live in a file that imports
 * nothing at all.
 */
export {
  FANTASY_CATEGORIES,
  CATEGORY_LABEL,
  CATEGORY_BLURB,
  type NewsCategory,
} from '../news-shared';

/**
 * The phrase lists.
 *
 * These are matched as whole words against the headline and body together.
 * They are judgement, exactly like the tag thresholds elsewhere in this project
 * are judgement, and they are held to the same standard: a rule that fires on
 * nearly everything or on nearly nothing carries no information (family #2).
 * `npm run check:news` prints the firing rate per category over everything
 * stored, which is how that gets checked rather than assumed.
 *
 * Phrases, not single words, wherever a single word is ambiguous. "out" matches
 * "out of the backfield", "sold out" and "out for the season"; "out for" and
 * "ruled out" do not.
 *
 * Some of them have to be patterns rather than phrases, and the reason is
 * worth stating because it decides how to extend this list.
 *
 * A literal phrase list fails on the intervening word. "returns to practice" is
 * a good rule that misses "returns to joint practice" and "returns to Tuesday's
 * practice" — both of which are the same event, and both of which were sitting
 * unclassified. Answering that by adding every variant as its own literal is
 * how a keyword list rots: it grows without getting better, because the next
 * variant is always one word away.
 *
 * So where the signal is a relationship between two words rather than a fixed
 * string, it is written as a pattern with a bounded gap. The gap is bounded on
 * purpose — an unbounded `.*` between "return" and "practice" would match two
 * unrelated sentences in the same paragraph.
 *
 * The matched text is what gets stored as the basis, so a pattern is no less
 * auditable than a phrase: the reader still sees the words that decided it.
 */
const RULES: Array<{ category: NewsCategory; phrases: string[]; patterns?: RegExp[] }> = [
  {
    category: 'injury',
    phrases: [
      'injury', 'injured', 'injuries', 'ruled out', 'out for', 'will miss', 'expected to miss',
      'sidelined', 'questionable', 'doubtful', 'day-to-day', 'week-to-week', 'placed on ir',
      'injured reserve', 'pup list', 'physically unable', 'surgery', 'sprain', 'strain',
      'concussion', 'hamstring', 'ankle', 'knee', 'shoulder', 'groin', 'quad', 'calf',
      'achilles', 'acl', 'mcl', 'hip', 'foot', 'toe', 'wrist', 'elbow', 'ribs', 'back injury',
      'mri', 'x-rays', 'carted off', 'left the game', 'did not practice', 'limited practice',
      'missed practice', 'non-contact', 'return to practice', 'returns to practice',
      'returned to practice', 'designated to return', 'rest day', 'veteran rest',
      'maintenance day', 'load management',
      'cleared to', 'setback', 'rehab', 'recovering', 'ailment', 'banged up', 'tightness',
      'soreness', 'illness', 'health', 'activated off',
    ],
    patterns: [
      // "exits joint practice", "left Tuesday's practice", "pulled from scrimmage"
      /\b(exits?|exited|leaves|left|pulled from|held out of)\b[a-z0-9'’\- ]{0,24}\b(practice|scrimmage|the game|drills)\b/,
      // "returns to joint practice", "returned to Tuesday's practice"
      /\b(returns?|returned|back)\b[a-z0-9'’\- ]{0,24}\b(practice|the field|action)\b/,
      // "first step toward return", "on track to return"
      /\b(step toward|track to|timeline for|nearing)\b[a-z0-9'’\- ]{0,16}\breturn\b/,
    ],
  },
  {
    category: 'transaction',
    phrases: [
      'signed', 'signs', 'sign', 'signing', 'agreed to terms', 'traded', 'trade',
      'trade talks', 'acquired', 'released', 'release',
      'waived', 'cut ', 'claimed off', 'extension', 'restructured', 'holdout', 'hold-in',
      'suspended', 'suspension', 'discipline', 'activated', 'promoted to the active',
      'practice squad',
      'contract', 'franchise tag', 'retire', 'retired', 'reinstated', 'released from',
      'joins the', 'lands with', 'agrees to', 'adding', 'inquired about', 'tryout', 'tryouts',
      'workout', 'visit', 'visits',
    ],
    patterns: [
      // "Bengals contact Packers about Carrington Valentine"
      /\b(contact(ed)?|called|inquired with)\b[a-z0-9'’\- ]{0,24}\babout\b/,
    ],
  },
  {
    category: 'role',
    phrases: [
      'starter', 'starting job', 'will start', 'named the starter', 'first-team',
      'first team reps', 'depth chart', 'depth-chart', 'snap share', 'snap count', 'snaps',
      'workload', 'touches', 'carries', 'targets', 'target share', 'lead back', 'bell cow',
      'committee', 'timeshare', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te1', 'qb1', 'qb2',
      'backup', 'no. 1 role', 'top of the depth', 'reps with the', 'increased role',
      'bigger role', 'expanded role', 'lose reps', 'losing reps', 'benched', 'demoted',
      'promoted', 'rotation', 'goal-line', 'goal line', 'red-zone role', 'third-down back',
      'pass-catching role', 'featured back', 'expected to lead', 'in line for',
      // Camp reporting is role reporting: these articles exist to say who is
      // winning a job. "competition" alone would be too loose, so it is bound to
      // the thing being competed for.
      'training camp', 'camp battle', 'position battle', 'qb competition',
      'quarterback competition', 'competition for the', 'battle for the',
      'practice report', 'practice takeaways', 'practice notes', 'camp notes',
      'news and notes',
    ],
    patterns: [
      // "won't get a chance to start", "competing to start"
      /\b(chance|competing|compete|shot|opportunity)\b[a-z0-9'’\- ]{0,12}\bto start\b/,
      // "will start at quarterback", "starting at running back"
      /\b(start|starting|starts)\b[a-z0-9'’\- ]{0,8}\bat (quarterback|running back|receiver|tight end)\b/,
    ],
  },
  {
    category: 'scheme',
    phrases: [
      'run the ball more', 'run more', 'pass more', 'throw more', 'run-heavy', 'pass-heavy',
      'play-calling', 'play caller', 'playcaller', 'offensive coordinator', 'offensive scheme',
      'new scheme', 'system', 'up-tempo', 'tempo', 'no-huddle', 'establish the run',
      'balanced attack', 'game plan', 'personnel package', '11 personnel', '12 personnel',
      'spread the ball', 'get him the ball', 'want to feature', 'plan to use',
      'offense will', 'offence will', 'philosophy', 'identity on offense',
    ],
    patterns: [
      // "will have Davis Webb calling his plays", "calls the plays"
      /\bcall(s|ing|ed)?\b[a-z0-9'’\- ]{0,12}\bplays\b/,
      // "run the ball more", "throw it more often"
      /\b(run|throw|pass)\b[a-z0-9'’\- ]{0,14}\b(more often|more|less)\b/,
    ],
  },
  {
    /*
     * Somebody else's fantasy read, rather than a thing that happened.
     *
     * It sits BELOW the four fact categories on purpose. "Fantasy football buzz:
     * Colts sign Keenan Allen" is a signing that a fantasy column happened to
     * report, and the signing is what a drafter acts on — so `transaction`
     * takes it first and only genuine commentary reaches here.
     *
     * Matching on the word "fantasy" is broad, and here that is correct rather
     * than sloppy: this is a fantasy tool, so an item that says "fantasy" is
     * on-topic by construction. The looseness is bounded by everything above it
     * having already had its turn.
     */
    category: 'analysis',
    phrases: [
      'fantasy', 'rankings', 'ranks', 'draft guide', 'mock draft', 'sleeper',
      'sleepers', 'busts', 'breakouts', 'be drafted', 'draft board', 'adp',
      'start/sit', 'waiver wire', 'dynasty', 'best ball', 'value pick', 'target him',
    ],
  },
  {
    category: 'performance',
    phrases: [
      'touchdown', 'touchdowns', 'rushed for', 'passed for', 'caught', 'receptions',
      'receiving yards', 'rushing yards', 'yards on', 'standout', 'impressed', 'stood out',
      'turned heads', 'best practice', 'strong camp', 'preseason debut', 'scored',
      'big day', 'career-high', 'broke out', 'red-zone target', 'explosive play',
    ],
  },
];

/**
 * Reasons an item is NOT fantasy news, checked before any category is tried.
 *
 * This exists because the first version of this pipeline put **36 of 85 items —
 * 42% of the tab — in front of the reader with no fantasy player in them at
 * all**: edge rushers signing, an offensive tackle carted off, four separate
 * write-ups of one joint-practice brawl, and a coach's wife being shot, which
 * the classifier filed under *scheme*.
 *
 * The cause was structural rather than a bad keyword. Categorisation asked
 * "does this text talk about injuries / roles / signings" and every one of
 * those items does — a linebacker's contract is a signing. Nothing anywhere
 * asked the prior question: **is this about somebody who can score fantasy
 * points.** So the veto runs first, and an item that fails it never reaches a
 * category.
 *
 * Two of the three rules are conditional on no skill player having been found,
 * and that ordering matters: "Saints workout pair of wide receivers after
 * Tyson injury" mentions a defender and is still receiver news, so a veto that
 * fired regardless of who else is named would throw away real items.
 *
 * Vetoed items are stored, filed `general`, and carry the phrase that vetoed
 * them — the same standard as a category basis. They are set aside, not
 * deleted, so `check:news` can show what is being withheld and why.
 */
const OFF_FIELD = [
  // Nothing here changes a lineup, and several are somebody's bad day rather
  // than football at all. A brawl is the single most over-covered non-event in
  // camp: one joint practice produced four items across three sources.
  'fight', 'fights', 'fighting', 'brawl', 'brawls', 'scuffle', 'altercation',
  'ejected', 'ejection', 'punch', 'shoved', 'melee',
  'arrest', 'arrested', 'charged with', 'lawsuit', 'sued', 'court', 'trial',
  'shot', 'shooting', 'died', 'dies', 'death', 'passed away', 'funeral',
  'hall of fame', 'expansion', 'anthem', 'stadium deal', 'where to watch',
  'ticket', 'jersey sales', 'social media post', 'apologiz', 'apologis',
];

/**
 * Positions this project does not model. Naming one is a strong signal the item
 * is about a player who cannot score fantasy points — but only when no skill
 * player turned up, since a receiver's item may mention the corner covering him.
 */
const NON_FANTASY_POSITIONS = [
  'pass rusher', 'edge rusher', 'edge defender', 'linebacker', 'cornerback',
  'safety', 'defensive end', 'defensive tackle', 'defensive lineman',
  'defensive line', 'nose tackle', 'defensive back', 'secondary',
  'offensive tackle', 'offensive lineman', 'offensive line', 'left tackle',
  'right tackle', 'left guard', 'right guard', 'long snapper',
  'kicker', 'punter', 'special teams', 'return specialist',
  'defensive coordinator', 'defensive depth', 'o-line', 'd-line',
  /*
   * The abbreviations feeds use in headlines — "LB Shaq Thompson, DL DaQuan
   * Jones visit Patriots".
   *
   * Only the ones that cannot be ordinary English. An earlier version included
   * `'s '` for safety and it vetoed "Patriots training camp competitionS,
   * updated…" — a two-character rule matching every plural and possessive in
   * the language. `'de '`, `'ot '` and `'og '` came out for the same reason.
   * This is family #2 in new code: a rule that fires on ordinary text carries
   * no information about football.
   */
  'lb ', 'dl ', 'cb ', 'dt ', 'nt ',
];

/**
 * Words that say an item IS about the positions this project models.
 *
 * Their job is to STOP a veto rather than cause one. "Roob's Observations: the
 * challenge Howie Roseman faces deciding what WRs to keep" is receiver news
 * that happens to name a front-office man, and without this it was thrown away
 * as "about players this tool does not model".
 */
const FANTASY_POSITION_WORDS = [
  'quarterback', 'running back', 'wide receiver', 'tight end', 'receiver',
  'backfield', 'rushing attack', 'passing game', 'skill position',
  'qb', 'rb', 'wr', 'te', 'qbs', 'rbs', 'wrs', 'tes',
];

export interface Veto {
  reason: string;
  basis: string;
}

/**
 * Whether an item is about anybody who can score fantasy points.
 *
 * `skillPlayers` is how many resolved to a modelled position, `nonSkill` how
 * many resolved to a real player at a position this tool ignores.
 */
export function vetoOf(
  headline: string,
  body: string | null | undefined,
  skillPlayers: number,
  nonSkill: number,
): Veto | null {
  const flat = (s: string) =>
    ` ${s.toLowerCase().replace(/[^a-z0-9.\- ]/g, ' ').replace(/\s+/g, ' ')} `;
  const head = flat(headline);
  const hay = flat(`${headline} ${body ?? ''}`);

  /*
   * Off-field, and only when it is in the HEADLINE.
   *
   * The incident has to be the story, not a sentence in it. Checking the body
   * too threw away "Day 13 News and Notes from Broncos Camp" and "no update on
   * Packers' Josh Jacobs" — a camp roundup and a running back's availability —
   * because a scuffle was mentioned somewhere further down. Every item worth
   * vetoing here announces itself in the headline: four separate write-ups of
   * one joint-practice brawl all did.
   */
  for (const p of OFF_FIELD) {
    if (head.includes(` ${p}`)) return { reason: 'not football', basis: p.trim() };
  }

  // Everything below is only decidable once we know nobody relevant is in it.
  if (skillPlayers > 0) return null;

  // An item that talks about the modelled positions is about them, whoever
  // else it names. This gate has to come before both remaining rules.
  const aboutFantasy = FANTASY_POSITION_WORDS.some((w) =>
    new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(hay),
  );
  if (aboutFantasy) return null;

  if (nonSkill > 0) {
    return {
      reason: 'about players this tool does not model',
      basis: `${nonSkill} named player${nonSkill === 1 ? '' : 's'}, none at QB/RB/WR/TE`,
    };
  }

  for (const p of NON_FANTASY_POSITIONS) {
    if (hay.includes(` ${p}`)) return { reason: 'not a fantasy position', basis: p.trim() };
  }

  return null;
}

export interface Classification {
  category: NewsCategory;
  /** The phrase that decided it. Null only when nothing matched. */
  basis: string | null;
}

/**
 * Places an item in one category, first match wins, ordered by decision value.
 *
 * Word-boundary matching rather than `includes`, because substring matching on
 * short phrases is how "acl" matches "spectacle" and "hip" matches "championship"
 * — a whole category of false positives from three-letter medical terms.
 */
export function classify(headline: string, body?: string | null): Classification {
  const hay = ` ${(headline + ' ' + (body ?? '')).toLowerCase().replace(/[^a-z0-9.\- ]/g, ' ').replace(/\s+/g, ' ')} `;

  for (const rule of RULES) {
    for (const phrase of rule.phrases) {
      const p = phrase.trim();
      // A phrase already containing a space is specific enough to match plainly;
      // a single token has to sit on word boundaries.
      const hit = p.includes(' ')
        ? hay.includes(` ${p}`) || hay.includes(`${p} `)
        : new RegExp(`(^|[^a-z0-9])${escapeRe(p)}([^a-z0-9]|$)`).test(hay);
      if (hit) return { category: rule.category, basis: p };
    }
    for (const pattern of rule.patterns ?? []) {
      const m = hay.match(pattern);
      // The matched text, not the pattern source — a reader checking the call
      // needs the words that fired, not the regex that found them.
      if (m) return { category: rule.category, basis: m[0]!.trim() };
    }
  }
  return { category: 'general', basis: null };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------------- */

export interface RegistryPlayer {
  playerId: string;
  name: string;
  normalized: string;
  position: string;
  espnId: string | null;
  /** His team NOW, the depth chart's answer, not last season's usage row. */
  team: string | null;
  /** True when he is on a current depth chart or carries an ADP. */
  current: boolean;
}

export interface PlayerRegistry {
  byEspn: Map<string, RegistryPlayer>;
  byName: Map<string, RegistryPlayer[]>;
  /** Only players who are actually around, for scanning free text. */
  current: RegistryPlayer[];
  /**
   * Everyone this project deliberately does not model — linemen, defenders,
   * kickers — indexed by ESPN id and by name.
   *
   * This exists to keep two different outcomes apart. A news item tagging Vita
   * Vea is not a resolution failure: he is a defensive tackle and this tool
   * models four positions on purpose. Reporting him alongside a genuine miss
   * turns a correct exclusion into an apparent bug, and hides the real misses
   * in a list nobody reads (family #6 — a default presented as a measurement,
   * one level up).
   */
  outOfScope: {
    byEspn: Set<string>;
    byName: Set<string>;
    /**
     * Display names of non-skill players who are ON A ROSTER NOW.
     *
     * Scanned against the prose so an item that names only defenders can be
     * recognised as such. Yahoo tags nothing, so "Kyle Shanahan says Nick Bosa
     * is making progress in rehab" arrives as plain text with a team nickname
     * in it, and without this it reads as 49ers injury news.
     *
     * Restricted to current players for the same reason the skill list is: the
     * registry holds every player in nflverse history, and matching a name from
     * 2014 would veto items about nobody.
     */
    currentNames: string[];
  };
}

/**
 * Every player a news item could be about, with the team he plays for now.
 *
 * The team ladder is the one from bug #100 — position-matched depth chart, then
 * any depth-chart listing, then the roster field, then last season's usage row.
 * News is the surface where getting this wrong is most visible, because a move
 * is often the very thing being reported: filing a Jahan Dotson item under
 * Philadelphia while he plays for Atlanta puts it in a room he has left.
 *
 * `current` is the subset worth scanning free text against. Matching the full
 * historical registry would let a paragraph mentioning a retired player attach
 * a 2019 name to today's news, and there are eight thousand of those.
 */
export function buildRegistry(season: number): PlayerRegistry {
  const rows = sqlite
    .prepare(
      `SELECT p.gsis_id AS playerId, p.display_name AS name, p.normalized_name AS normalized,
              p.position AS position, p.espn_id AS espnId,
              COALESCE(dcp.team, dca.team, p.latest_team, u.team) AS team,
              /*
               * "Current" is on a depth chart, OR being drafted, OR played last
               * season. That last clause is what covers a free agent: Chase
               * Claypool and Josh Reynolds are receivers on nobody's chart, and
               * without it "Chase Claypool, Josh Reynolds get tryouts with the
               * Saints" attached to neither of them — which is the same
               * free-agent gap the non-skill scan had, on the other side.
               */
              CASE WHEN dca.player_id IS NOT NULL OR a.player_id IS NOT NULL
                        OR p.last_season >= ?
                   THEN 1 ELSE 0 END AS current
       FROM players p
       LEFT JOIN (SELECT player_id, pos_abb, team, MIN(pos_rank) AS rank
                  FROM depth_chart WHERE season = ? GROUP BY player_id, pos_abb) dcp
         ON dcp.player_id = p.gsis_id AND dcp.pos_abb = p.position
       LEFT JOIN (SELECT player_id, team, MIN(pos_rank) AS rank
                  FROM depth_chart WHERE season = ? GROUP BY player_id) dca
         ON dca.player_id = p.gsis_id
       LEFT JOIN (SELECT player_id, MAX(season) s FROM player_usage GROUP BY player_id) lu
         ON lu.player_id = p.gsis_id
       LEFT JOIN player_usage u ON u.player_id = p.gsis_id AND u.season = lu.s
       LEFT JOIN (SELECT DISTINCT player_id FROM adp_raw WHERE year = ? AND player_id IS NOT NULL) a
         ON a.player_id = p.gsis_id
       WHERE p.position IN ('QB','RB','WR','TE')`,
    )
    .all(season - 1, season, season, season) as Array<
      Omit<RegistryPlayer, 'current'> & { current: number }
    >;

  const byEspn = new Map<string, RegistryPlayer>();
  const byName = new Map<string, RegistryPlayer[]>();
  const current: RegistryPlayer[] = [];

  for (const r of rows) {
    const p: RegistryPlayer = { ...r, current: r.current === 1 };
    if (p.espnId) byEspn.set(String(p.espnId), p);
    const list = byName.get(p.normalized) ?? [];
    list.push(p);
    byName.set(p.normalized, list);
    if (p.current) current.push(p);
  }

  const offEspn = new Set<string>();
  const offName = new Set<string>();
  for (const r of sqlite
    .prepare(
      `SELECT normalized_name AS n, espn_id AS e FROM players
       WHERE position IS NOT NULL AND position NOT IN ('QB','RB','WR','TE')`,
    )
    .all() as Array<{ n: string; e: string | null }>) {
    offName.add(r.n);
    if (r.e) offEspn.add(String(r.e));
  }

  /*
   * Recently active rather than currently listed.
   *
   * Keying this on the depth chart missed exactly the players the news is
   * about: a free agent has no listing until he signs, so "Falcons sign veteran
   * Za'Darius Smith to aid pass rush" and "The Bills really needed to sign a
   * player like Greg Gaines" both read as fantasy news — the two men are a
   * defensive end and a defensive tackle who played in 2025 and appear on no
   * 2026 chart. Two seasons of recency covers a signing, a holdout and a
   * comeback, and costs 760 extra strings to scan.
   */
  const offCurrent = (
    sqlite
      .prepare(
        `SELECT DISTINCT display_name AS name FROM players
         WHERE position IS NOT NULL AND position NOT IN ('QB','RB','WR','TE')
           AND last_season >= ? AND LENGTH(display_name) > 6`,
      )
      .all(season - 2) as Array<{ name: string }>
  ).map((r) => r.name);

  return {
    byEspn,
    byName,
    current,
    outOfScope: { byEspn: offEspn, byName: offName, currentNames: offCurrent },
  };
}

/**
 * Nicknames to abbreviations, derived from `lib/teams.ts` so the two cannot
 * drift — a hand-written second list is how bug #63 dropped every Ram.
 *
 * Nicknames only, not city names: "New York" and "Los Angeles" are each two
 * teams, and "Washington" is also a state that appears in unrelated sentences.
 * A nickname is unambiguous across all 32.
 *
 * `LA` is skipped because `lib/teams.ts` carries it as an alias of `LAR` and
 * including both would file every Rams item twice.
 */
const TEAM_NICKNAMES: Array<[string, string]> = Object.entries(TEAMS)
  .filter(([abbr]) => abbr !== 'LA')
  .map(([abbr, t]) => [t.nick, abbr] as [string, string]);

export interface ResolvedMention {
  playerId: string | null;
  rawName: string;
  position: string | null;
  team: string | null;
  /**
   * How the mention was attributed.
   *
   * `out_of_scope` is a success, not a failure: the name resolved to a real
   * player at a position this project does not model. Only `unresolved` means
   * "we do not know who this is".
   */
  method: 'espn_id' | 'name' | 'team' | 'out_of_scope' | 'unresolved';
  isTeamLevel: boolean;
}

/**
 * Who an item is about.
 *
 * Three passes, most trustworthy first, and each one records how it got there.
 *
 *  1. the source's own athlete id, which is a key lookup and cannot be wrong;
 *  2. the source's own athlete name, matched against the registry;
 *  3. failing both, a scan of the text for the names of players who are
 *     currently on a roster.
 *
 * A name the registry does not know is still stored, with a null id, so a team
 * whose news failed to resolve shows an unattributed item rather than quietly
 * showing fewer items. The same reasoning as `yahoo_ownership`: an absent row
 * is itself a claim, so a failure has to be visible.
 *
 * Teams the source tags are added as team-level mentions, which is what carries
 * "the Bengals will run more" — an item with no player in it at all, and one of
 * the things worth reading.
 */
export function resolveMentions(
  item: RawNewsItem,
  reg: PlayerRegistry,
): ResolvedMention[] {
  const out = new Map<string, ResolvedMention>();

  for (const a of item.athletes ?? []) {
    const name = a.name.trim();
    if (!name) continue;

    /*
     * A RESOLVED mention is stored under the player's canonical display name,
     * not under whatever the source called him.
     *
     * Two reasons, and the second is the one that bites. A creator's subject
     * arrives as a hashtag — `#jamescook`, `#amonrastbrown` — so keying on the
     * raw string renders a chip reading "amonrastbrown" at the reader. And
     * because the row key is (news_id, raw_name), one item naming a man in both
     * a hashtag and its prose stored him twice, as two different people.
     * Canonicalising fixes the display and collapses the duplicate at once.
     *
     * The raw string is kept only when nothing resolved, where it is the only
     * information there is.
     */
    const byId = a.espnId ? reg.byEspn.get(String(a.espnId)) : undefined;
    if (byId) {
      out.set(byId.playerId, {
        playerId: byId.playerId, rawName: byId.name, position: byId.position,
        team: byId.team, method: 'espn_id', isTeamLevel: false,
      });
      continue;
    }

    const cands = reg.byName.get(normalizeName(name)) ?? [];
    // Prefer a player who is actually on a roster: the registry holds every
    // player in nflverse history, so a plain name match can land on a namesake
    // who last played in 2014.
    const pick = cands.find((c) => c.current) ?? cands[0];
    if (pick) {
      out.set(pick.playerId, {
        playerId: pick.playerId, rawName: pick.name, position: pick.position,
        team: pick.team, method: 'name', isTeamLevel: false,
      });
    } else {
      // Not a skill player we hold — but is he a real player at a position this
      // project does not model? That is a correct exclusion, and saying so is
      // the difference between a clean run and 33 phantom failures.
      const norm = normalizeName(name);
      // A guess that did not land is not a finding. Hashtags are ours, not the
      // source's, so an unresolved one is dropped rather than filed as a miss.
      if (a.speculative) continue;
      const known =
        (a.espnId && reg.outOfScope.byEspn.has(String(a.espnId))) ||
        reg.outOfScope.byName.has(norm);
      out.set(name, {
        playerId: null, rawName: name, position: null, team: null,
        method: known ? 'out_of_scope' : 'unresolved', isTeamLevel: false,
      });
    }
  }

  // Only scan prose when the source tagged nobody. A source that tags athletes
  // has already answered the question, and scanning on top of it would attach
  // every player named in passing to an item that is not about him.
  if (out.size === 0) {
    const hay = `${item.headline} ${item.body ?? ''}`;
    for (const p of reg.current) {
      if (!hay.includes(p.name)) continue;
      out.set(p.playerId, {
        playerId: p.playerId, rawName: p.name, position: p.position,
        team: p.team, method: 'name', isTeamLevel: false,
      });
    }
  }

  // Team tags from the source. Stored even when a player mention already covers
  // the team, because an item can be about a team and a player at once and the
  // team filter must find it either way.
  const covered = new Set([...out.values()].map((m) => m.team).filter(Boolean));
  const tagged = item.teams ?? [];
  for (const t of tagged) {
    if (covered.has(t)) continue;
    const key = `team:${t}`;
    if (out.has(key)) continue;
    out.set(key, {
      playerId: null, rawName: key, position: null, team: t,
      method: 'team', isTeamLevel: true,
    });
  }

  /*
   * Last resort: read the team out of the prose.
   *
   * Only when the source tagged none, which in practice means Yahoo and
   * RotoWire — ESPN tags its own and scanning on top of that would file an
   * article in every room it mentions in passing.
   *
   * It is worth doing because the alternative is losing the item entirely. A
   * headline like "Saints workout pair of wide receivers after Tyson injury"
   * names its team plainly and attaches to no skill player, so without this it
   * belongs to nobody and appears on no team's page — 30 of 85 relevant items
   * were landing that way, and roughly half of those were this, not genuinely
   * league-wide.
   */
  if (tagged.length === 0) {
    const hay = `${item.headline} ${item.body ?? ''}`;
    for (const [nick, abbr] of TEAM_NICKNAMES) {
      if (covered.has(abbr)) continue;
      if (!new RegExp(`\\b${nick}\\b`).test(hay)) continue;
      const key = `team:${abbr}`;
      if (out.has(key)) continue;
      out.set(key, {
        playerId: null, rawName: key, position: null, team: abbr,
        method: 'team', isTeamLevel: true,
      });
    }
  }

  return [...out.values()];
}

/**
 * Who an item is about, counted by whether this project models them.
 *
 * `skill` counts resolved QB/RB/WR/TE. `nonSkill` counts real players at other
 * positions — both the ones a source tagged and the ones only the prose names,
 * because the sources that tag nothing are exactly the ones that need it.
 */
export function subjectCounts(
  item: RawNewsItem,
  mentions: ResolvedMention[],
  reg: PlayerRegistry,
): { skill: number; nonSkill: number } {
  const skill = mentions.filter((m) => m.playerId).length;
  let nonSkill = mentions.filter((m) => m.method === 'out_of_scope').length;

  if (skill === 0 && nonSkill === 0) {
    const hay = `${item.headline} ${item.body ?? ''}`;
    for (const name of reg.outOfScope.currentNames) {
      if (hay.includes(name)) {
        nonSkill++;
        break; // One is enough to answer the question this feeds.
      }
    }
  }

  return { skill, nonSkill };
}
