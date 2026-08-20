import type { TagInput } from './tags';
import type { Tone } from './blend';

/**
 * The case for and against a player — one verdict, then the argument.
 *
 * WHY THIS REPLACED THE TAG LIST. Tags were flat peers, so a player could carry
 * GEM and NO UPSIDE at once and the page had no way to say which one it meant.
 * Matthew Golden carried both, plus "lottery ticket", plus "volume vacated" —
 * four price and risk claims, drawn from four different evidence bases of wildly
 * different quality, rendered as four identical chips.
 *
 * The fix is structural rather than a precedence table. There is exactly ONE
 * verdict. Everything else is evidence, and evidence is SUPPOSED to conflict —
 * that is what "the case against" means. A reader seeing "worth a late pick on
 * capital" followed by "his comparables never broke out, but they are matched on
 * the role he holds now, which is the role in question" has been told something
 * true and useful. A reader seeing GEM next to NO UPSIDE has been told nothing.
 *
 * EVERY POINT CARRIES ITS STRENGTH, and the strength is not a judgment:
 *
 *   measured — a calibration in this project backs it, and the point quotes the
 *              number. `calibrate:gems`, `calibrate:blend`, `calibrate:risk`.
 *   weak     — a real but small effect, |r| under about 0.15, or a thin sample.
 *              Said out loud so it cannot be read as a finding.
 *   fact     — descriptive. A target share, a depth-chart slot, a coaching
 *              change. Makes no claim about next season on its own.
 *   unknown  — measured to carry NO forward signal, but too material to hide.
 *              Vacated volume is the whole of this category; see below.
 *
 * VACATED VOLUME IS AN UNKNOWN, NOT A CASE FOR. `calibrate:opportunity` fitted
 * `nextShare = a + b x priorShare + c x vacated` over 1,117 incumbent seasons.
 * The inheritance rate c is −0.022 for the first receiver in line (t = −1.1) and
 * −0.027 for the first back (t = −0.5); no queue position in either pool reaches
 * two standard errors, and every point estimate is negative against a shipped
 * assumption of 0.60. It does not predict points either — partial −0.038 after
 * the player's own prior share. But the spread is enormous: Jaxon Smith-Njigba
 * went 24% -> 36% and DJ Moore 27% -> 16%, both with 20%+ walking out. Mean zero,
 * huge variance, which is the definition of something to flag and refuse to
 * forecast.
 */

export type Strength = 'measured' | 'weak' | 'fact' | 'unknown';

export interface CasePoint {
  /** The claim, in the language someone would use out loud. */
  text: string;
  strength: Strength;
  /** The number behind it and where that number came from. */
  basis: string;
}

export interface PlayerCase {
  /** The single verdict. There is never more than one. */
  headline: string;
  tone: Tone;
  for: CasePoint[];
  against: CasePoint[];
  /** Material, and measured to carry no direction. Never counted either way. */
  unknowns: CasePoint[];
  /** How much the model can back the view, evidence quality, not player quality. */
  confidence: 'high' | 'medium' | 'low';
  confidenceWhy: string;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

/**
 * "3rd", not "3th". Bugs #66 and #79 were this exact slip in two other files,
 * and the argument for fixing it is not typography: a page that argues for its
 * own rigour and then prints "3th" loses the reader for every decimal after it.
 */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * Whose volume left, named correctly for the 27 players who moved.
 *
 * A vacancy belongs to the team a player is ON, because that is the offence he
 * will be taking snaps in. `whose()` in `tags.ts` answers the opposite question
 * — it attributes a USAGE share to the roster it was earned on, so A.J. Brown's
 * 29.5% is Philadelphia's — and reusing it here labelled New England's vacancy
 * "27% of PHI's volume". Right number, wrong team, on every player who changed
 * roster: the stale-fact family (#29) arriving through a helper that was correct
 * for its own question.
 */
function vacancyTeam(i: TagInput): string {
  return i.currentTeam ? `${i.currentTeam}'s` : "his team's";
}

/**
 * The draft band decides which price evidence is admissible.
 *
 * Correlation between the slot gap and what a player went on to return relative
 * to his price: rounds 1-3 **0.296**, rounds 4-6 0.190, rounds 7-10 **0.041**,
 * rounds 11+ 0.135. So the same number is the best signal on the board in the
 * first three rounds and pure noise in rounds 7-10, and the case has to know the
 * difference rather than quoting it uniformly.
 */
function priceReliability(adp: number): { strength: Strength; note: string } {
  if (adp <= 36) return { strength: 'measured', note: 'the strongest stretch on this board, the draft order predicts about 4 times better in the first 60 picks (0.47) than through the middle rounds (0.10)' };
  if (adp <= 72) return { strength: 'weak', note: 'still worth something here, though weaker than the first three rounds' };
  if (adp <= 120) return { strength: 'unknown', note: 'the middle rounds, where this and every other signal here weakens' };
  return { strength: 'weak', note: 'slight this late, though the late rounds do recover some signal' };
}

/**
 * The late-round profile that actually holds, and the only "gem" claim here that
 * is allowed to call itself measured.
 *
 * Over 193 picks at ADP 100+ (2022-2025), against a 31% base rate for clearing
 * replacement: a short record AND real draft capital hits **59%** (n=37). It
 * beats the base rate in all four seasons and is general across positions.
 */
function lateProfile(i: TagInput): { hit: boolean; rate: string } {
  const shortRecord = i.isRookie || i.seasonsObserved <= 1;
  const capital = (i.draftPick ?? 999) <= 60;
  return {
    hit: i.adp >= 100 && shortRecord && capital,
    rate: '59% cleared replacement against a 31% base rate (n=37, holds in all four seasons)',
  };
}

export function buildCase(i: TagInput): PlayerCase {
  const forPts: CasePoint[] = [];
  const against: CasePoint[] = [];
  const unknowns: CasePoint[] = [];
  const isRb = i.position === 'RB';
  const price = priceReliability(i.adp);

  /* ------------------------------------------------------------ the case FOR */

  const profile = lateProfile(i);
  if (profile.hit) {
    forPts.push({
      text: `A short NFL record and real draft capital, pick ${i.draftPick}, going at ${i.adp.toFixed(0)}`,
      strength: 'measured',
      basis: `This is the one late-round shape that actually works: ${profile.rate}. A high pick who has not had his chance yet is a different bet from a career backup, and by this point in the draft the market has stopped telling them apart.`,
    });
  }

  if (i.slotGap !== null && i.slotGap >= 15 && price.strength !== 'unknown') {
    forPts.push({
      text: `The evidence prices him about ${Math.round(i.slotGap)} points ahead of what pick ${i.adp.toFixed(0)} normally returns`,
      strength: price.strength,
      basis: `Slot gap, ${price.note}.`,
    });
  }

  if (i.disagreement !== null && i.disagreement >= 0.5) {
    forPts.push({
      text: `His on-field role is ${i.disagreement.toFixed(1)} standard deviations ahead of what the market is paying for`,
      strength: 'measured',
      basis:
        `Players whose role ran a full step ahead of their price beat that price by a clear margin; those a ` +
        `step behind fell short of it by roughly twice as much. It pointed the right way in all 4 ` +
        `seasons checked, but it is a mild effect, a lean, not a reason to reach.`,
    });
  }

  /*
   * COVERAGE. Every axis speaks for every player, or the case is empty for the
   * ones in the middle.
   *
   * The first version gated each point behind a cutoff — grade 80, 16 games,
   * a 15-point slot gap — and left FOUR board players with no case at all,
   * Saquon Barkley among them, plus 27 of 77 receivers with nothing measured
   * either way. That is the dead-threshold family (#2) in new code: a rule that
   * fires on nobody in a stretch of the distribution carries no information
   * about anyone in it.
   *
   * The fix is not looser cutoffs, which would just move the hole. A middling
   * reading is a real answer — "ordinary opportunity for his position" — so it
   * is stated as a `fact`, which informs the reader and contributes ZERO to the
   * verdict weighting. Direction still needs evidence; presence does not.
   */
  /*
   * Stated as the percentile itself, not as an adjective.
   *
   * A first pass called everything between the 25th and 80th percentile
   * "middling opportunity", which put Saquon Barkley at the 78th percentile
   * under a word that means average. A band wide enough to be safe is too wide
   * to describe anyone in it — family #7, a number given a label its value does
   * not support. The figure says where he sits; the reader can weigh it.
   */
  if (i.usageGrade !== null && i.usageGrade > 25 && i.usageGrade < 80) {
    forPts.push({
      text: `${ordinal(i.usageGrade)} percentile among ${i.position}s on measured opportunity`,
      strength: 'fact',
      basis:
        `Where his workload ranks against his own position. Close enough to the middle that it does not ` +
        `argue for him or against him, so it is here as a fact rather than as evidence.`,
    });
  }
  if (i.expectedGames !== null && i.expectedGames > 13 && i.expectedGames < 16) {
    forPts.push({
      text: `Ordinary availability, projects for ${i.expectedGames.toFixed(1)} games`,
      strength: 'fact',
      basis: `What his own injury history suggests he will play. Close enough to a full season to be neither a plus nor a minus.`,
    });
  }

  if (i.usageGrade !== null && i.usageGrade >= 80) {
    forPts.push({
      /* A 100th-percentile player printed "Top 0%", which reads as a rounding
         error rather than as the best in his position. The floor of 1 says what
         is meant; the same slip in reverse is guarded below. */
      text: `Top ${Math.max(1, 100 - i.usageGrade)}% of ${i.position}s on measured opportunity`,
      strength: 'measured',
      basis:
        `How much work his coaches actually gave him, ranked against his own position. The model behind ` +
        `it is scored on seasons it was never shown, and gets about 58% of the way to explaining a ` +
        `receiver's next year, 48% for a back. Most trustworthy for receivers and backs; at tight end ` +
        `and quarterback last season's points alone do about as well.`,
    });
  }

  if (i.expectedGames !== null && i.expectedGames >= 16) {
    forPts.push({
      text: `Durable, projects for ${i.expectedGames.toFixed(1)} games`,
      strength: 'measured',
      basis: `Staying healthy is one of the most repeatable things a player does. Someone who missed 4+ games last year misses time again about 73% of the time; someone who stayed healthy, about 41%.`,
    });
  }

  if (i.teamOffenseRank !== null && i.teamOffenseRank <= 8) {
    forPts.push({
      text: `Plays in the ${ordinal(i.teamOffenseRank)}-best scoring offence`,
      strength: 'weak',
      basis: `Players in offences that score a lot pick up more touchdowns than their own workload would suggest. A real effect, and a small one.`,
    });
  }

  /* -------------------------------------------------------- the case AGAINST */

  if (i.slotGap !== null && i.slotGap <= -15 && price.strength !== 'unknown') {
    against.push({
      text: `Going about ${Math.round(Math.abs(i.slotGap))} points earlier than the evidence supports`,
      strength: price.strength,
      basis: `Slot gap, ${price.note}.`,
    });
  }

  if (i.disagreement !== null && i.disagreement <= -0.5) {
    against.push({
      text: `Priced ${Math.abs(i.disagreement).toFixed(1)} standard deviations ahead of the role he actually held`,
      strength: 'measured',
      basis:
        `Players being paid for more than they actually did on the field fell short of that price, and the ` +
        `further ahead the price ran the further they fell, a full step ahead cost about twice what ` +
        `half a step did. Consistent across all 4 seasons, but mild: a reason for caution, not a bust.`,
    });
  }

  if (i.usageGrade !== null && i.usageGrade <= 25 && i.adp <= 72) {
    against.push({
      text: `Bottom ${Math.max(1, i.usageGrade)}% of ${i.position}s on measured opportunity, at a price that assumes otherwise`,
      strength: 'measured',
      basis:
        `Where his workload ranks against his own position, from a model scored on seasons it never saw ` +
        `(about 58% of the way to explaining a receiver's next year). Paying an early pick for someone ` +
        `his coaches were not feeding is the most common shape of a disappointing pick, a lean, not a verdict.`,
    });
  }

  if (i.expectedGames !== null && i.expectedGames <= 13) {
    against.push({
      text: `Availability risk, projects for only ${i.expectedGames.toFixed(1)} games`,
      strength: 'measured',
      basis: `A player who missed 4+ games misses time again about 73% of the time. One who stayed healthy does, about 41% of the time. It is one of the most repeatable things in this data.`,
    });
  }

  /*
   * Age is a case-against for receivers and tight ends and NOT for backs.
   *
   * Against the slot residual: WR r(age) = −0.113, with 30+ receivers returning
   * −17 relative to price against +4 for younger ones. For backs it is +0.060,
   * and 28+ backs return −7 against +7 — a rounding error pointing the other
   * way. The old rule used a LOWER age cutoff for backs, on the theory that they
   * decline faster, and the data does not support charging them for it.
   */
  if (!isRb && (i.age ?? 0) >= 30) {
    against.push({
      text: `Turns ${i.age} this season`,
      strength: 'weak',
      basis: `Receivers past 30 have returned a little less than their draft slot normally pays, and younger ones a little more. Deliberately NOT applied to running backs, the same test on backs comes out the other way round, so charging them for age would be inventing a penalty.`,
    });
  }

  if ((i.tdOverExpected ?? 0) >= 3 && (i.usageGrade ?? 100) <= 55) {
    against.push({
      text: `Scored ${i.tdOverExpected!.toFixed(1)} touchdowns above what his red-zone volume supports, without the role to repeat it`,
      strength: 'weak',
      basis: `Scoring more touchdowns than your goal-line workload supports is mostly luck, and luck does not repeat. Only counted against him when the workload is not carrying him anyway, genuinely elite players outscore their volume because they are elite.`,
    });
  }

  if (i.coachChanged && isRb) {
    against.push({
      text: `New play caller${i.currentCoach ? ` (${i.currentCoach})` : ''}`,
      strength: 'weak',
      basis: `Backs who stayed put lost about twice as much ground under a new coach as under the same one. Applied to running backs only, the same test barely moves for receivers and not at all for tight ends, because a new staff rebuilds a backfield more than it rebuilds a route tree.`,
    });
  }

  /* --------------------------------------------- what he does per opportunity
   *
   * Everything above this point argues from VOLUME, PRICE or AVAILABILITY: how
   * much work he gets, what it costs, whether he is on the field. None of it
   * says whether he is any good with the ball.
   *
   * That was the gap behind two complaints at once — cases reading thin, and
   * 68% of the board sitting at LOW confidence. The average case carried
   * **1.14 measured points**, and `high` needs three. Meanwhile every one of
   * these metrics was already calibrated, already computed and already on the
   * scouting panel one scroll down. The argument simply never used them.
   *
   * Rules, so this does not become a list of everything:
   *
   *  - a metric with a NULL weight is dead for this position and is not
   *    evidence at all. This is what stops a quarterback's first-down rate
   *    entering as a measured point on a correlation of .055.
   *  - `measured` needs a partial of 0.15+; below that it is `weak`, matching
   *    the strength definitions used everywhere else here.
   *  - only the extremes argue. The 40th to 70th percentile is the middle of
   *    his own position and is left to the opportunity line, which already
   *    covers "he is unremarkable" — adding four more middling points would
   *    bury the two that matter (#88).
   *  - at most three, best partial first, so a strong signal is not outvoted by
   *    a longer list of weak ones.
   */
  const perTouch = (i.indicators ?? [])
    .filter((ind) => ind.weight !== null && ind.percentile !== null)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  const strongAt = perTouch.filter((ind) => (ind.percentile ?? 0) >= 75).slice(0, 3);
  const weakAt = perTouch.filter((ind) => (ind.percentile ?? 100) <= 25).slice(0, 3);

  for (const ind of strongAt) {
    forPts.push({
      text: `${ind.label} of ${ind.display}, ${ordinal(ind.percentile!)} percentile among ${i.position}s`,
      strength: (ind.weight ?? 0) >= 0.15 ? 'measured' : 'weak',
      basis: ind.detail,
    });
  }

  for (const ind of weakAt) {
    against.push({
      text: `${ind.label} of ${ind.display}, only ${ordinal(ind.percentile!)} percentile among ${i.position}s`,
      strength: (ind.weight ?? 0) >= 0.15 ? 'measured' : 'weak',
      basis: ind.detail,
    });
  }

  /*
   * The five-filter receiver screen, which is the strongest single screen here
   * and was not in the case at all.
   *
   * Both directions are worth stating and they are not symmetric. Clearing all
   * five is a three-fold lift on a startable season. Missing one or two is not
   * a condemnation — Jefferson in 2022 missed only his quarterback's ranking
   * and Chase in 2024 missed 2.27 against a 2.30 line — so a near miss is
   * reported as a near miss, with the filters he failed named.
   */
  if (i.screenPassed !== null && i.screenPassed !== undefined) {
    if (i.screenClears) {
      forPts.push({
        text: 'Clears all five filters of the WR1 screen',
        strength: 'measured',
        basis:
          'Under 30, a quarter of his team’s targets, 2.3 yards per route, a top-11 scoring ' +
          'offence and a top-10 quarterback. Receivers clearing all five went on to average 228 ' +
          'points the following season with 62% finishing top-12, against 142 points and 20% for ' +
          'receivers who held a real role and did not clear. A three-fold lift, and the strongest ' +
          'single screen in this project.',
      });
    } else if (i.screenPassed >= 3) {
      forPts.push({
        text: `Clears ${i.screenPassed} of the five WR1 filters${i.screenMissing?.length ? `, missing on ${i.screenMissing.join(' and ')}` : ''}`,
        strength: 'weak',
        basis:
          'The five are a profile rather than a law: of the WR1 seasons on record, Jefferson in ' +
          '2022 missed only on his quarterback ranking 12th rather than top-10, and Chase in 2024 ' +
          'missed only on 2.27 yards per route against a 2.30 line. Three of five is the shape ' +
          'without the confirmation.',
      });
    } else if (i.screenPassed <= 1) {
      against.push({
        text: `Clears only ${i.screenPassed} of the five WR1 filters`,
        strength: 'weak',
        basis:
          'Age, target share, yards per route, the offence around him and his quarterback. ' +
          'Failing four or five of them does not make a bust, but it puts him a long way from ' +
          'the profile that produced a 62% top-12 rate.',
      });
    }
  }

  /* ------------------------------------------------------------- the UNKNOWNS */

  if ((i.vacated ?? 0) >= 0.15) {
    unknowns.push({
      text: `${pct(i.vacated)} of ${vacancyTeam(i)} volume from last season has left the roster, and that is not a forecast in either direction`,
      strength: 'unknown',
      basis:
        `It is tempting to assume the next man up inherits this. Checked across more than a thousand ` +
        `cases, he does not, teams sign and draft replacements instead of promoting, and a ` +
        `first-round rookie walks straight into a fifth of the targets or half the carries. Individual ` +
        `players do swing hard in both directions: Jaxon Smith-Njigba went from 24% of his team's ` +
        `targets to 36%, DJ Moore went from 27% down to 16%, and both had a fifth of the offence ` +
        `leave. So this makes his range wider, not his projection higher.`,
    });
  }

  if (price.strength === 'unknown' && i.slotGap !== null && Math.abs(i.slotGap) >= 8) {
    unknowns.push({
      text: `His price looks ${i.slotGap > 0 ? 'cheap' : 'expensive'} by ${Math.round(Math.abs(i.slotGap))} points, and through the middle rounds that reading means little`,
      strength: 'unknown',
      basis:
        `Through the middle rounds this number stops meaning much, and so does everything else. The ` +
        `draft order predicts about a fifth as well here as it does in round one, and last season's ` +
        `points do the same. It also reads positive for four players in five down here, because what ` +
        `picks historically return falls away faster than projections do. Judge him on his role.`,
    });
  }

  if (i.contingentShare !== null && i.contingentShare >= 0.15 && (i.upsideGain ?? 0) >= 25) {
    unknowns.push({
      text: `Worth about ${Math.round(i.upsideGain!)} points more if the job ahead of him opens, which happens ${pct(i.upsideChance)} of the time`,
      strength: 'unknown',
      basis:
        `The same fitted model re-run at the share vector he would hold, with the probability from ` +
        `exact enumeration over who is available. It is a conditional, not an expectation: it says ` +
        `how big the branch is, not that it pays. Note this is IN-SEASON replacement, a starter ` +
        `going down in October, which is a different mechanism from the offseason departures ` +
        `measured in \`calibrate:opportunity\`, and is not covered by that null result.`,
    });
  }

  /* --------------------------------------------------------------- the VERDICT */

  /*
   * One headline, chosen by which side of the argument is both heavier AND
   * better evidenced. Weight counts `measured` points double, because a case
   * built on calibrated findings should not be outvoted by a longer list of
   * descriptive ones — which is precisely how GEM lost to NO UPSIDE.
   */
  const heft = (pts: CasePoint[]) =>
    pts.reduce((a, p) => a + (p.strength === 'measured' ? 2 : p.strength === 'weak' ? 1 : 0), 0);
  const forHeft = heft(forPts);
  const againstHeft = heft(against);

  let headline: string;
  let tone: Tone;

  /*
   * The late-and-below-replacement branch runs FIRST, but only where there is no
   * real case either way.
   *
   * An earlier version gated on `vorp < 0 && adp >= 100` before looking at the
   * evidence at all, which handed Zach Charbonnet — three points for, none
   * against — the headline "a bench flier whose direction is unknown". Being
   * below replacement is the NORMAL state of a pick after round eight (mean VORP
   * −35 in round 8, −34 in round 9), so on its own it says nothing; it only
   * decides the read when the argument is otherwise empty.
   */
  const noRealCase = forHeft === 0 && againstHeft === 0;
  if (i.vorp !== null && i.vorp < 0 && i.adp >= 100 && (noRealCase || profile.hit)) {
    if (profile.hit) {
      headline = 'Worth a late pick on profile, not on his current role';
      tone = 'gem';
    } else if (unknowns.length) {
      headline = 'A bench flier whose range is wide and whose direction is unknown';
      tone = 'caution';
    } else {
      headline = 'No case for a roster spot';
      tone = 'caution';
    }
  } else if (forHeft > againstHeft + 1) {
    headline = profile.hit
      ? 'Worth a late pick on profile, the strongest late-round shape there is'
      : i.adp <= 36
        ? 'The evidence backs the price and then some'
        : i.vorp !== null && i.vorp < 0
          ? 'A bench pick with a real case behind him'
          : 'More here than the price is paying for';
    tone = forHeft >= 4 ? 'gem' : 'solid';
  } else if (againstHeft > forHeft + 1) {
    headline = i.adp <= 36
      ? 'Paying a first-three-rounds price for a case that does not support it'
      : 'The price is ahead of the evidence';
    tone = againstHeft >= 4 ? 'bust' : 'caution';
  } else if (forHeft === 0 && againstHeft === 0) {
    headline = unknowns.length
      ? 'Nothing here points either way, read the unknowns'
      : 'No strong read in either direction';
    tone = 'unknown';
  } else {
    headline = 'The case cuts both ways at this price';
    tone = 'solid';
  }

  /*
   * Confidence describes the EVIDENCE, never the player. A well-covered veteran
   * the model dislikes is a high-confidence negative read.
   */
  const measuredCount = [...forPts, ...against].filter((p) => p.strength === 'measured').length;
  let confidence: PlayerCase['confidence'];
  let confidenceWhy: string;
  if (measuredCount >= 3 && i.signal === 'full') {
    confidence = 'high';
    confidenceWhy = `${measuredCount} calibrated findings apply to him and the sportsbooks price him fully.`;
  } else if (measuredCount >= 2) {
    confidence = 'medium';
    confidenceWhy = `${measuredCount} calibrated findings apply${i.signal !== 'full' ? ', but no book prices him, so the market view is missing' : ''}.`;
  } else {
    confidence = 'low';
    confidenceWhy =
      measuredCount === 0
        ? 'Nothing calibrated in this project applies to him, everything below is descriptive.'
        : 'Only one calibrated finding applies to him; the rest is description.';
  }

  return { headline, tone, for: forPts, against, unknowns, confidence, confidenceWhy };
}
