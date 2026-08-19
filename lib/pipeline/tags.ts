/**
 * The read: what a player actually is, said in tags rather than a single word.
 *
 * A one-word verdict was doing no work — a third of the board came out "fairly
 * priced", which is not a scouting opinion, it is the absence of one. And a
 * single overall grade goes too far the other way, flattening a bell-cow back
 * and a boom-bust deep threat into the same letter.
 *
 * So the read is a set of specific, checkable claims. Each tag states one fact,
 * carries the number behind it, and can be sorted on. Together they say whether
 * the price is right and why; individually they survive being questioned.
 */

import { GAP_DEAD_BAND, type Tone } from './blend';

export type TagKind = 'price' | 'role' | 'opportunity' | 'risk' | 'coverage';

export interface Tag {
  id: string;
  label: string;
  kind: TagKind;
  /** Shown on hover: what the tag means and the number behind it. */
  detail: string;
  /** Sort weight within kind — higher is more notable. */
  weight: number;
}

export interface TagInput {
  position: string;
  adp: number;
  age: number | null;
  slotGap: number | null;
  vorp: number | null;
  usageGrade: number | null;
  disagreement: number | null;
  vacated: number | null;
  expectedGames: number | null;
  tdOverExpected: number | null;
  /** Completed seasons with a real role. Short records are where late hits live. */
  seasonsObserved: number;
  signal: string;
  extrapolatedStats: number;
  isRookie: boolean;
  targetShare: number | null;
  rushShare: number | null;
  routeShare: number | null;
  goalLineShare: number | null;
  rzShare: number | null;
  gamesLastSeason: number | null;
  /** Share of comparable historical seasons that finished top-12 at the position. */
  breakoutRate: number | null;
  /** Share that failed to clear replacement — the complement of the hit rate. */
  bustRate: number | null;
  /**
   * Where those rates sit among late picks at the SAME position, 0-100.
   *
   * The raw rates cannot be compared across positions. "Top-12 at the position"
   * is a fixed bar measured against pools of wildly different size — replacement
   * is TE13 but WR43 — so a late tight end's 25th percentile breakout rate (28%)
   * is higher than the best receiver or back on the board (23-25%). An absolute
   * threshold does not select the players with upside, it selects tight ends.
   */
  breakoutPctile: number | null;
  bustPctile: number | null;
  /** Volume he stands to inherit if the man ahead of him falls over. */
  contingentShare: number | null;
  contingentNote: string | null;
  /** His offence's touchdowns last season, relative to the league. */
  teamOffenseRank: number | null;
  /** The head coach changed between the measured season and now. */
  coachChanged: boolean;
  priorCoach: string | null;
  currentCoach: string | null;
  /** Mean share of team carries this coach's lead back has taken. */
  coachTopBackShare: number | null;
  draftPick: number | null;
  /** Where his current team lists him at his own position, 1 = nobody ahead. */
  depthRank: number | null;
  /**
   * Where he ranked in his own team's pecking order LAST season, by the share
   * that defines his position. Compared against `depthRank`, this is what makes
   * a promotion visible rather than inferred from an arbitrary share threshold.
   */
  priorRoleRank: number | null;
  /**
   * The team the usage shares were actually measured on.
   *
   * 27 board players changed teams. A share earned somewhere else is still a
   * real fact about the player, but reporting it as "his team's targets" points
   * at the wrong roster — A.J. Brown's alpha-target share was earned in
   * Philadelphia, not New England.
   */
  usageTeam: string | null;
  /** His team for the coming season, from the ADP feed. */
  currentTeam: string | null;
  /**
   * The replacement level his VORP was measured against, in the same units.
   *
   * Needed because a fixed points margin means completely different things by
   * position: replacement is 296 for a quarterback and 122 for a receiver, so
   * "seven points below" is a rounding error for one and a real gap for the
   * other.
   */
  replacementLevel: number | null;
  /**
   * What he is worth if the job ahead of him opens, and how likely that is.
   *
   * A backup's distribution is a coin flip, not a bell curve, so his expectation
   * describes neither outcome. This carries the conditional explicitly.
   */
  upsidePoints: number | null;
  upsideChance: number | null;
  upsideGain: number | null;
  /**
   * The verdict the case reached, so a chip can never contradict the headline.
   * Set by the caller after `buildCase`; see the bust tag for why.
   */
  caseTone?: Tone;
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/**
 * "his team" is wrong for anyone who moved in the offseason, so the team is
 * named whenever the usage was measured somewhere else.
 */
function whose(i: TagInput): string {
  return i.usageTeam && i.currentTeam && i.usageTeam !== i.currentTeam
    ? `${i.usageTeam}'s`
    : "his team's";
}

export function buildTags(i: TagInput): Tag[] {
  const tags: Tag[] = [];
  const isRb = i.position === 'RB';
  const isQb = i.position === 'QB';

  /*
   * Gem and bust, defined the way a drafter means them rather than as a price
   * label.
   *
   * A gem goes late, may not have the job on day one, and has a path to one —
   * the profile of a back who is cheap in August and starting by October. A
   * bust is the reverse: paid for early, with the specific things that precede
   * a disappointing season. High draft capital into a bad offence is the rookie
   * version of it.
   */
  const totalOpportunity = (i.vacated ?? 0) + (i.contingentShare ?? 0);
  const late = i.adp >= 60;
  const early = i.adp <= 60;

  /**
   * The stretch of the draft where the slot gap carries no information at all —
   * measured r = 0.041 against what players returned relative to their price,
   * against 0.296 in rounds 1-3. Bounds live in `blend.ts` so the audit checks
   * the same range the tag uses. See the tag that fires on it.
   */
  const deadBand = i.adp >= GAP_DEAD_BAND.from && i.adp <= GAP_DEAD_BAND.to;

  /*
   * A gem is a young player going late with a role coming to him.
   *
   * Three conditions, all required. Cheap, because a gem you pay up for is just
   * a good player. Ascending, because the profile being described is a Quinshon
   * Judkins — someone whose season outruns his draft slot, not a veteran backup
   * whose value is that the starter is old. And a genuine route to the work.
   *
   * Earlier versions missed on all three axes: firing on opportunity alone made
   * DK Metcalf a gem at an 8% breakout rate, and with no age condition the list
   * filled with career backups. Handcuffs have value, but they are not what the
   * word means.
   */
  const ascending = (i.age ?? 99) <= 25 || i.isRookie;

  /*
   * The late-round gem, and the two things that made it fire on NOBODY.
   *
   * It required a raw breakout rate of 15%. That is an absolute cutoff on a
   * quantity whose distribution differs enormously by position — late tight ends
   * run a 40% median breakout rate against 8-10% for receivers and backs — so
   * the bar selected tight ends and quarterbacks and excluded the entire
   * population the tag exists to find. `breakoutPctile`, which ranks within
   * position AND within the same stretch of the draft, was built for exactly
   * this and is used correctly by two neighbouring tags; this one reached past
   * it for the raw number (family #3).
   *
   * Then it AND-ed that against a 25% opportunity requirement. Each condition on
   * its own is defensible; together they cleared 0 of 179 players. A tag that
   * fires on nobody is the same failure as one that fires on everybody (family
   * #2) — it just looks less obviously wrong.
   *
   * Now: upper quartile for upside among players at his position going this
   * late, young, and with either vacated work or a genuine path through the man
   * ahead of him. Opportunity is relaxed to 15% because "top quarter of upside
   * for his position" is already doing the selection work; requiring both at the
   * upper quartile was multiplying two filters that are not independent.
   */
  /*
   * ...and the price has to actually be a discount.
   *
   * Without this, Quentin Johnston came back tagged GEM at a slot gap of −29:
   * top-quartile upside for a receiver going that late, a real path to volume,
   * and the market already paying twenty-nine picks ahead of the historical
   * return. Every clause of that is true and the label on top of it is not. A
   * gem is something you get cheaply; if the price has run past the value it is
   * a lottery ticket, which is a different tag with a different meaning.
   */
  const notOverpaying = (i.slotGap ?? 0) >= -5;

  /*
   * "Late" for a gem is round 10, not round 5.
   *
   * ADP 60 is the fifth round, which is where a starting tight end normally
   * goes — so the tag was calling Tyler Warren at pick 72 a gem for being a
   * good TE at the price tight ends cost. That is not what the word means. The
   * players it should describe went in the double-digit rounds or off the wire
   * and then earned a role: a back taken around pick 130 who takes over a
   * backfield, a rookie nobody drafted who is starting by October. What makes
   * them gems is that the ROLE arrives, not that they were mispriced by four
   * picks.
   *
   * So: pick 120 or later — round 10 in a 12-team league — young, not already
   * overpriced, upper quartile of upside for his position at that stage of the
   * draft, and a real claim on work. The waiver-wire version of this population
   * is on `/waiver`, where the same profile appears without an ADP at all.
   */
  const trulyLate = i.adp >= 120;

  /*
   * Upside for this archetype is CONTINGENT, not historical.
   *
   * Gating on breakout rate was fighting bug #36: comparables match on the role
   * a player holds now, so a backup's comps are other backups and his breakout
   * rate is low by construction. Zach Charbonnet — pick 129, 28% of the work
   * ahead of him already vacated, priced 83 picks behind his projection — reads
   * 12% there, and he is precisely the profile the tag exists to find.
   *
   * The right signal is the one this project built for exactly that problem:
   * what he is worth IF the job opens, and how much of the work is already
   * loose. A late gem is a claim on volume that has not been priced, not a
   * player whose past resembles a starter's.
   */
  const contingentPath =
    totalOpportunity >= 0.25 || ((i.upsideGain ?? 0) >= 25 && (i.upsideChance ?? 0) >= 0.2);

  /*
   * The measured late-round profile: a short record and real NFL draft capital.
   *
   * Requiring a contingent path was the reason this tag cleared one player. It
   * is a true description of Charbonnet and a partial one of the population —
   * so it stays, as one of two routes rather than as the gate.
   *
   * The other route is measured. Over 193 picks at ADP 100+ (2022-2025), against
   * a 31% base rate for clearing replacement:
   *
   *   young (<=25 or rookie)                    36%  (n=100)
   *   short record (rookie or <=1 season)       39%  (n= 83)
   *   capital inside pick 100                   38%  (n= 98)
   *   short record AND capital <= 100           46%  (n= 50)
   *   short record AND capital <= 60            59%  (n= 37)   <-- this
   *   veteran with 3+ seasons, for contrast     30%  (n= 47)
   *
   * Mean VORP goes from -35 for the band to -10 for the gate, and it beats the
   * base rate in all four seasons (67/48, 33/28, 38/26, 50/34). It names Josh
   * Jacobs 2022, Brian Thomas Jr 2024, Brock Bowers 2024, Sam LaPorta 2023 —
   * the actual late hits, in the season they hit.
   *
   * Draft capital is doing work here that it does NOT do on the projection,
   * where ADP already prices it (pick adds 0.206 for WR after ADP and -0.104 for
   * RB). The difference is the population: among players the market has already
   * given up on, capital is what separates a former high pick who has not had
   * his chance from a career backup. That is a conditional signal, not a
   * contradiction of the earlier finding.
   */
  const measuredProfile =
    (i.isRookie || i.seasonsObserved <= 1) && (i.draftPick ?? 999) <= 60;

  /*
   * "Late" for the measured profile is pick 100, not 120 — that is the range it
   * was measured over. And the price gate is dropped inside the dead band, where
   * the slot gap carries r = 0.04: refusing to call someone a gem because of a
   * number known to be uninformative there would be the same error the
   * `gap-unreliable` tag exists to name.
   */
  const gemLate = i.adp >= 100;
  const priceOk = deadBand || notOverpaying;

  if (gemLate && priceOk && (measuredProfile || (trulyLate && ascending && contingentPath))) {
    tags.push({
      id: 'gem', label: 'GEM', kind: 'price', weight: 12,
      detail:
        `Going at ${i.adp.toFixed(0)}, ${i.age !== null ? `aged ${i.age}, ` : ''}` +
        (measuredProfile
          ? `on the one late-round profile that has held up: a player with barely any NFL record ` +
            `and real draft capital behind him (pick ${i.draftPick}). Backtested over 2022-2025, ` +
            `players matching this at ADP 100+ cleared replacement 59% of the time against a 31% ` +
            `base rate, and beat the base rate in all four seasons. `
          : `with a real claim on volume nobody is paying for. `) +
        (i.upsideGain !== null && i.upsideGain >= 25
          ? `If the man ahead of him stops playing he is worth ${i.upsideGain.toFixed(0)} more, and that ` +
            `happens ${pct(i.upsideChance)} of the time. `
          : '') +
        (totalOpportunity >= 0.15
          ? `${Math.round(totalOpportunity * 100)}% of the work ahead of him is either already vacated or held by someone likely to lose it.`
          : ''),
    });
  }

  /*
   * Bust risk needs a reason that survives the player being good.
   *
   * Touchdown regression on its own flagged Gibbs, Nacua, Smith-Njigba and
   * Jonathan Taylor — elite players score above volume *because* they are
   * elite, and the correction lands them back at very good. So regression only
   * counts as a bust signal when the underlying role is not carrying him.
   *
   * The rookie-into-bad-offence rule now checks that he is actually a rookie.
   * It was reading a veteran's college draft pick and calling Justin Jefferson
   * a bust on the strength of where Minnesota took him in 2020.
   */
  const weakUnderneath = (i.usageGrade ?? 100) <= 55;
  const bustReasons: string[] = [];

  /*
   * Ranked against his own position at his own stage of the draft, never against
   * an absolute rate. Quarterbacks sit at a 33-40% bust rate as a class, because
   * "bust" means failing to clear replacement and QB replacement is 296 — the
   * highest of any position. An absolute 20% cutoff flagged 25 of 25 QBs and so
   * flagged Lamar Jackson, which told the reader nothing.
   */
  if ((i.bustPctile ?? 0) >= 70) {
    bustReasons.push(
      `${Math.round((i.bustRate ?? 0) * 100)}% of comparable seasons busted outright, the worst ` +
        `third among ${i.position}s going this early`,
    );
  }
  if ((i.tdOverExpected ?? 0) >= 3 && weakUnderneath) {
    bustReasons.push(
      `scored ${i.tdOverExpected!.toFixed(1)} touchdowns above his volume with a role that does not support it`,
    );
  }
  if (i.isRookie && (i.teamOffenseRank ?? 16) >= 25 && (i.draftPick ?? 999) <= 40) {
    bustReasons.push(
      `first-round rookie landing in the ${i.teamOffenseRank}th-ranked offence, where the situation caps him`,
    );
  }
  /*
   * Age is a bust reason for receivers and tight ends only.
   *
   * Measured against the SLOT residual — what a player returned relative to what
   * his pick historically returns, which is what "bust" means to a drafter —
   * across 2022-2025 early picks: WR r(age) = -0.113, and receivers at 30+
   * returned -17 against price where younger ones returned +4. Weak, but the
   * right sign. For BACKS it is r = +0.060, with 28+ at -7 against price and
   * younger at +7: a rounding error pointing the other way. The cutoff was
   * lower for backs precisely because their decline is supposed to be sharper,
   * and the data does not support charging them for it.
   */
  if (!isRb && (i.expectedGames ?? 17) <= 12 && (i.age ?? 0) >= 30) {
    bustReasons.push('aging and already missing time');
  }

  /*
   * The price itself is evidence, but only where it has been shown to be.
   *
   * Correlation between the slot gap and what a player actually returned
   * against his price, by band: rounds 1-3 **0.296**, rounds 4-6 0.190, rounds
   * 7-10 **0.041**, rounds 11+ 0.135. So the gap is worth quoting as a bust
   * reason in the first three rounds and worth nothing at all in rounds 7-10 —
   * which is also where 82% of the board carries a positive gap. Restricting
   * this to picks 1-36 is not a judgment call about draft strategy, it is the
   * range where the quantity was measured to carry information.
   */
  if (i.adp <= 36 && (i.slotGap ?? 0) <= -20) {
    bustReasons.push(
      `the evidence prices him about ${Math.round(Math.abs(i.slotGap!))} points below what pick ` +
        `${i.adp.toFixed(0)} normally returns — and inside the first three rounds that gap is the one ` +
        `price signal on this board that has actually held up`,
    );
  }

  /*
   * Named a lean rather than a verdict, because the evidence does not support a
   * verdict. Every candidate signal for "which early pick busts" lands inside
   * +/-0.15 within position, and the disagreement between the market and usage
   * — the strongest thing on the board — carries r = 0.115. A tag that says BUST
   * RISK on r = 0.115 is claiming more than it can back, which is the same
   * failure as showing a default as a measurement.
   */
  /*
   * The chip may not contradict the headline.
   *
   * DeVonta Smith read "bust lean" under a case that concluded the argument cuts
   * both ways — the tag fired on one comparables-derived reason while the case
   * weighed that against a measured durability record and reached no verdict.
   * Two surfaces, one player, opposite impressions, which is the whole failure
   * this rebuild exists to remove.
   *
   * So the tag is gated on the case having actually landed negative. The case is
   * the arbiter because it is the thing that weighs evidence BY STRENGTH; the
   * tag list cannot, and should not get to overrule it from the sidebar.
   */
  const caseWentNegative = i.caseTone === 'bust' || i.caseTone === 'caution';
  if (early && bustReasons.length && caseWentNegative) {
    tags.push({
      id: 'bust', label: 'bust lean', kind: 'risk', weight: 12,
      detail:
        `Priced at ${i.adp.toFixed(0)} — ${bustReasons.join('; ')}. Read it as a lean rather than a ` +
        `verdict: nothing known before a season starts picks out which early picks disappoint with ` +
        `much confidence, and most of what looks like it does turns out to be noise.`,
    });
  }

  /*
   * Late picks were never assessed at all.
   *
   * The bust tag was gated on `adp <= 60`, so no player taken after round five
   * could be flagged however hopeless he looked — and past pick 72 the board
   * carried zero risk tags. It also could not praise a late pick, so every
   * player beyond round eight showed the same negative VALUE and the board had
   * nothing to say about which of them to actually take.
   *
   * Expected points is the wrong currency down there. Almost everyone available
   * in round ten projects below replacement, which is what "replacement" means;
   * saying so about forty players in a row is true and useless. The question
   * that separates them is whether there is any path to a startable season, and
   * the comparables already answer it: the share of the forty most similar
   * historical seasons that finished top-12 at the position, against the share
   * that failed to clear replacement.
   *
   * Thresholds are absolute rather than slot-relative because the two ends are
   * unambiguous at any slot. John Metchie at 0% breakout and 90% bust is a
   * wasted pick whether he goes at 121 or 200; Dallas Goedert at 45% and 13% is
   * a starter whoever else is on the board.
   */
  /*
   * A real lottery ticket, stated as the two numbers that define it.
   *
   * The comparables cannot see this case: they match on the role a player holds
   * NOW, so a backup's comparables are other backups and his breakout rate
   * describes people who stayed backups. Justice Hill came out "NO UPSIDE" while
   * sitting one Derrick Henry injury away from a 137-point season.
   */
  const realUpside =
    i.upsidePoints !== null &&
    i.upsideChance !== null &&
    i.upsideGain !== null &&
    i.upsideGain >= 10 &&
    i.upsideChance >= 0.2;

  if (realUpside && !early) {
    tags.push({
      id: 'handcuff', label: 'one injury away', kind: 'opportunity', weight: 11,
      detail:
        `Leads his position group in ${Math.round(i.upsideChance! * 100)}% of outcomes and is worth ` +
        `${i.upsidePoints!.toFixed(0)} points there, against ` +
        `${((i.vorp ?? 0) + (i.replacementLevel ?? 0)).toFixed(0)} in the role he holds today. The ` +
        `chance is the product over everyone ahead of him, not the chance any one of them falls — ` +
        `a third-string back needs two absences, not one. VALUE averages every branch together, ` +
        `which describes none of them.`,
    });
  }

  // "No upside" must mean no upside of any kind, including contingent.
  if (!early && !realUpside && (i.breakoutPctile ?? 100) <= 20 && (i.bustPctile ?? 0) >= 70) {
    tags.push({
      id: 'dead-end', label: 'NO UPSIDE', kind: 'risk', weight: 11,
      detail:
        `Of the 40 most similar historical seasons, ${pct(i.breakoutRate)} finished top-12 at the ` +
        `position and ${pct(i.bustRate)} were worth less than a player you could have had for free — ` +
        `bottom fifth for upside and top third for outright failure among ${i.position}s going ` +
        `this late. There is no version of this pick that wins you a week.`,
    });
  }

  if (!early && (i.breakoutPctile ?? 0) >= 75) {
    tags.push({
      id: 'late-upside', label: 'startable upside', kind: 'price', weight: 10,
      detail:
        `${pct(i.breakoutRate)} of comparable seasons finished top-12 at his position, against ` +
        `${pct(i.bustRate)} that returned nothing — the top quarter for upside among ${i.position}s ` +
        `going this late. His projection sits below replacement like everyone else down here; the ` +
        `difference is that this profile has actually paid off before.`,
    });
  }

  /*
   * The depth chart is a fact about this season; usage is a fact about last one.
   *
   * Every projection here runs on prior usage, which cannot see a player who has
   * changed jobs since. Alec Pierce is listed WR1 in Indianapolis on a new
   * contract while carrying a 16% blended target share from being the third
   * option — the model reads the target share and has no way to know the role
   * moved. Nothing in the projection is wrong; it is answering a question about
   * last season.
   *
   * This is deliberately a tag rather than an adjustment to the number. There
   * are no historical depth charts in the database, so how much a promotion is
   * worth cannot be measured — and an uncalibrated multiplier on the projection
   * would be exactly the kind of heuristic the rest of this tool refuses. The
   * fact is worth surfacing; inventing a coefficient for it is not.
   */
  if (
    i.depthRank !== null &&
    i.priorRoleRank !== null &&
    i.depthRank <= 2 &&
    i.priorRoleRank - i.depthRank >= 2 &&
    !i.isRookie
  ) {
    tags.push({
      id: 'promoted', label: 'promoted since last season', kind: 'opportunity', weight: 8,
      detail:
        `He was his team's number ${i.priorRoleRank} option at ${i.position} last season by ` +
        `${isRb ? 'rush share' : 'target share'}, and is listed ${i.position}${i.depthRank} now. ` +
        `The projection is built on that older role, because usage is the only thing measured — ` +
        `so it understates him by however much the promotion is worth. That amount is NOT ` +
        `quantified here: there are no historical depth charts in this database to calibrate it ` +
        `against, and an invented multiplier would be a guess dressed as a number.`,
    });
  }

  if (i.contingentNote) {
    tags.push({
      id: 'contingent', label: 'has a branch', kind: 'opportunity', weight: 7,
      detail:
        `${i.contingentNote}. This is about the man ahead getting hurt or benched during the season, which ` +
        `is a different thing from volume leaving in the offseason — and unlike that, it does reach ` +
        `the backup. It is still a branch, not an expectation: it says how big the outcome would be, ` +
        `not that it will happen.`,
    });
  }

  if ((i.teamOffenseRank ?? 0) >= 26) {
    tags.push({
      id: 'bad-offense', label: 'weak offence', kind: 'risk', weight: 6,
      detail:
        `His offence ranked ${i.teamOffenseRank} of 32 in touchdowns. Team scoring predicts a ` +
        `player's next-season touchdown rate at +0.15 even after his own red-zone share is ` +
        `accounted for — the environment matters on top of the role.`,
    });
  } else if ((i.teamOffenseRank ?? 33) <= 6) {
    tags.push({
      id: 'good-offense', label: 'potent offence', kind: 'opportunity', weight: 6,
      detail:
        `His offence ranked ${i.teamOffenseRank} of 32 in touchdowns. Good offences lift their ` +
        `players independently of individual usage (+0.15 on next-season scoring).`,
    });
  }

  /* ---- price: the headline, is he worth his ADP ---- */
  if (i.slotGap !== null && i.vorp !== null) {
    if (i.vorp <= 0 && (i.vacated ?? 0) >= 0.3) {
      tags.push({
        id: 'lottery', label: 'lottery ticket', kind: 'price', weight: 5,
        detail:
          `Projects below a player you could pick up for free, and ${pct(i.vacated)} of his team's volume ` +
          `has left. The name is meant literally. Teams replace departed work rather than handing it ` +
          `down, so nobody is owed this — it is a wide range on a bench spot, not a job waiting for him.`,
      });
    } else if (i.vorp <= 0) {
      /*
       * How far below replacement he is, as a share of replacement itself.
       *
       * Every negative player used to get the same "no path visible to change
       * that" — a spread running from −161 to −1, with 18 players inside ten
       * points of the line. Lamar Jackson at −7 against a 296-point quarterback
       * replacement is two percent under it, which is a coin flip, not a verdict.
       */
      const shortfall =
        i.replacementLevel && i.replacementLevel > 0
          ? Math.abs(i.vorp) / i.replacementLevel
          : null;

      if (shortfall !== null && shortfall <= 0.05) {
        tags.push({
          id: 'replacement-level', label: 'replacement level', kind: 'price', weight: 4,
          detail:
            `Projects within ${Math.round(shortfall * 100)}% of the freely available player at his ` +
            `position — effectively a coin flip against streaming the spot. Not a reason to spend ` +
            `a pick, and not the same as having no path.`,
        });
      } else {
        tags.push({
          id: 'bench', label: 'not startable', kind: 'price', weight: 4,
          detail:
            `Projects ${Math.abs(i.vorp).toFixed(0)} points below replacement — the freely ` +
            `available player at his position outscores him by a clear margin.`,
        });
      }
    } else if (deadBand && Math.abs(i.slotGap) >= 8) {
      /*
       * Rounds 7-10 get told the truth instead of a price verdict.
       *
       * The slot gap's correlation with what a player went on to return against
       * his price, by band: rounds 1-3 0.296, rounds 4-6 0.190, **rounds 7-10
       * 0.041**, rounds 11+ 0.135. In that one stretch it carries no
       * information — and it is also where the gap is largest and most
       * flattering, mean +17.3 with 82% of the band positive, because the
       * historical return craters after round 7 faster than projections do.
       * So the board was at its loudest exactly where it knew least.
       *
       * Demeaning the gap within the band was tested as a fix and REJECTED:
       * pooled correlation fell from 0.250 to 0.160, and within a band a
       * monotone recentring cannot change the ordering anyway. The gap is not
       * miscalibrated here, it is uninformative here, and the honest response to
       * an uninformative number is to say so rather than to rescale it.
       */
      tags.push({
        id: 'gap-unreliable', label: 'price read unreliable here', kind: 'price', weight: 3,
        detail:
          `His projection sits ${Math.round(Math.abs(i.slotGap))} points ${i.slotGap > 0 ? 'above' : 'below'} ` +
          `what pick ${i.adp.toFixed(0)} normally returns — and through the middle rounds that number ` +
          `is not worth acting on. Everything weakens here, not just this: the draft order itself ` +
          `predicts about a fifth as well as it does in round one, and so does last season's ` +
          `production. It also reads positive for 4 players in 5 down here regardless of who they ` +
          `are. Judge him on his role instead.`,
      });
    } else if (i.slotGap >= 25) {
      tags.push({
        id: 'value', label: 'clear value', kind: 'price', weight: 9,
        detail:
          `Worth roughly ${Math.round(i.slotGap)} picks more than his ADP of ${i.adp.toFixed(1)}. ` +
          `The evidence prices him well ahead of where he is going.` +
          (i.adp <= 36
            ? ` Inside the first three rounds this is the most reliable price signal on the board ` +
              `(r 0.30 against what players went on to return).`
            : ''),
      });
    } else if (i.slotGap >= 8) {
      tags.push({
        id: 'slight-value', label: 'mild value', kind: 'price', weight: 7,
        detail: `About ${Math.round(i.slotGap)} picks of surplus against his ADP. Fine at cost, not a steal.`,
      });
    } else if (i.slotGap <= -25) {
      tags.push({
        id: 'reach', label: 'overpriced', kind: 'price', weight: 8,
        detail:
          `Going roughly ${Math.round(Math.abs(i.slotGap))} picks earlier than the evidence supports. ` +
          `Let someone else take him.`,
      });
    } else if (i.slotGap <= -8) {
      tags.push({
        id: 'slight-reach', label: 'slight reach', kind: 'price', weight: 6,
        detail: `About ${Math.round(Math.abs(i.slotGap))} picks expensive. Playable if he falls.`,
      });
    } else {
      tags.push({
        id: 'at-cost', label: 'priced right', kind: 'price', weight: 3,
        detail:
          `Projection and ADP agree within eight picks. Take him if the board falls that way; ` +
          `there is no edge either direction.`,
      });
    }
  } else {
    tags.push({
      id: 'unknown', label: 'no read', kind: 'price', weight: 0,
      detail: 'Not enough evidence to price him. Shown with ADP only.',
    });
  }

  /* ---- role: what he is on the field ---- */

  /*
   * Quarterbacks are graded on their own terms.
   *
   * The receiving branch below was applied to every non-back, which meant a
   * quarterback was measured on target share. Bryce Young came out tagged
   * "depth target — only 0% of team targets", which is true of every quarterback
   * who has ever played and says nothing about any of them. He was also tagged
   * "never off field — 98% of pass plays", which is what being the quarterback
   * means rather than a finding about him.
   *
   * What separates quarterbacks is whether they start, and how much they run.
   * Rushing volume is the difference between a top-five finish and a twelfth
   * place on the same passing line.
   */
  if (isQb) {
    /*
     * "Not the starter" is a claim about THIS season, so it has to be checked
     * against this season's depth chart — not inferred from last season's snap
     * share.
     *
     * Reading the share alone, the tag fired on exactly one player in the league
     * and got him wrong: Malik Willis is listed QB1 in Miami, and was carrying
     * "not the starter" and "promoted since last season" simultaneously. A 40%
     * snap share behind Jordan Love is a fact about 2025, not about the job he
     * holds now. Requiring an explicit listing at QB2 or lower means the tag
     * only speaks when the depth chart actually supports it.
     */
    if (i.routeShare !== null && i.routeShare <= 0.5 && (i.depthRank ?? 0) >= 2) {
      tags.push({
        id: 'qb-backup', label: 'not the starter', kind: 'role', weight: 9,
        detail:
          `Listed QB${i.depthRank} on his team's current depth chart, and on the field for only ` +
          `${pct(i.routeShare)} of dropbacks last season. Being the starter is the single largest ` +
          `fact about a quarterback's fantasy value — it is the strongest term in the quarterback ` +
          `model at +50 points per standard deviation.`,
      });
    }

    // Median starting quarterback takes 12% of his team's carries and the 75th
    // percentile 18%, so a 10% cutoff fired on nearly every one of them and said
    // nothing. 18% marks the ones whose legs actually change the projection.
    if (i.rushShare !== null && i.rushShare >= 0.18) {
      tags.push({
        id: 'qb-rusher', label: 'runs the ball', kind: 'role', weight: 8,
        detail:
          `Took ${pct(i.rushShare)} of ${whose(i)} carries last season. Rushing volume is what separates ` +
          `quarterbacks who finish top five from those who throw for the same yardage and ` +
          `finish twelfth — it adds points the passing line never shows.`,
      });
    }

    if (i.goalLineShare !== null && i.goalLineShare >= 0.2) {
      tags.push({
        id: 'qb-sneak', label: 'goal-line carries', kind: 'role', weight: 7,
        detail:
          `Took ${pct(i.goalLineShare)} of ${whose(i)} work inside the 5 last season. Quarterback sneaks are ` +
          `rushing touchdowns at six points each, and the assignment tends to stay with the ` +
          `same player.`,
      });
    }

  } else {
  const primary = isRb ? i.rushShare : i.targetShare;
  if (primary !== null && ((isRb && primary >= 0.6) || (!isRb && primary >= 0.25))) {
    tags.push({
      id: 'workhorse', label: isRb ? 'bell cow' : 'alpha target', kind: 'role', weight: 9,
      detail: isRb
        ? `Took ${pct(primary)} of ${whose(i)} carries last season. Volume this concentrated is ` +
          `the most reliable thing a back can have.`
        : `Commanded ${pct(primary)} of ${whose(i)} targets last season. Target share is the ` +
          `single strongest predictor of receiver scoring.`,
    });
  } else if (primary !== null && ((isRb && primary <= 0.35) || (!isRb && primary <= 0.14))) {
    tags.push({
      id: 'committee', label: isRb ? 'committee back' : 'depth target', kind: 'role', weight: 4,
      detail: isRb
        ? `Took only ${pct(primary)} of ${whose(i)} carries last season — splitting work. A team's listed RB1 can still be in a committee, so this describes volume, not depth-chart position.`
        : `Took only ${pct(primary)} of ${whose(i)} targets last season. Not a focal point of the passing game.`,
    });
  }

  if (i.goalLineShare !== null && i.goalLineShare >= 0.35) {
    tags.push({
      id: 'goal-line', label: 'goal-line role', kind: 'role', weight: 8,
      detail:
        `Took ${pct(i.goalLineShare)} of ${whose(i)} work inside the 5 last season. Touchdowns are the biggest ` +
        `single swing in scoring, and this job tends to stay with the same player.`,
    });
  }

  /*
   * Full-time is a per-position judgement, because pass-snap share is not
   * comparable across positions.
   *
   * A flat 0.85 cutoff fired on 38% of receivers and 42% of tight ends but only
   * 4% of backs — not because backs are rarely full-time, but because even a
   * bell cow leaves the field on obvious passing downs, so his pass-snap share
   * tops out far lower than a WR1's. The tag was measuring position, not role
   * (family #3, the same error as bugs #23 and #49).
   *
   * The thresholds are the 90th percentile of pass-snap share within each
   * position, measured over role-holders in the last completed season (WR n=181,
   * TE n=99, RB n=105). "Never off field" therefore means the same thing —
   * top-decile for his own position — wherever it appears. Picking round numbers
   * by feel is what produced the original problem; a first pass at this fix used
   * 0.82 for tight ends and fired on 58% of them.
   *
   * Quarterbacks are excluded outright. The median starter is at 0.94 and the
   * 90th percentile at 0.99, so any cutoff either catches every starter or none
   * — a dead threshold (family #2). "Is he the starter" is already what starter
   * share says, and it says it better.
   */
  const EVERY_DOWN: Record<string, number> = { WR: 0.91, TE: 0.86, RB: 0.64 };
  const fullTimeLine = EVERY_DOWN[i.position];

  if (fullTimeLine !== undefined && i.routeShare !== null && i.routeShare >= fullTimeLine) {
    tags.push({
      id: 'every-down', label: 'never off field', kind: 'role', weight: 6,
      detail:
        `On the field for ${pct(i.routeShare)} of pass plays last season — top of the ` +
        `${i.position} distribution, where the bar is ${pct(fullTimeLine)} because ` +
        `${isRb ? 'even a bell cow comes off on obvious passing downs' : 'full-time receivers rarely leave the field'}. ` +
        `A full-time role, though it was earned ${i.usageTeam && i.currentTeam && i.usageTeam !== i.currentTeam ? `at ${i.usageTeam} before his move` : 'in this offence'}.`,
    });
  } else if (!isRb && i.routeShare !== null && i.routeShare <= 0.55) {
    tags.push({
      id: 'rotational', label: 'rotational', kind: 'role', weight: 3,
      detail: `Only ${pct(i.routeShare)} of pass plays last season — came off the field, which caps his ceiling.`,
    });
  }
  }

  /* ---- opportunity: a window is open, and nobody knows who walks through it ---- */
  /*
   * This tag used to end "Someone inherits that work, and he is in line for it."
   * The second clause is false and now measured to be false.
   *
   * `calibrate:opportunity` regressed next season's share on prior share and
   * vacated share across 1,117 incumbent seasons. The share of a vacancy that
   * reaches the man behind it is −0.022 for the first receiver in line (t −1.1)
   * and −0.027 for the first back (t −0.5) — no queue position in either pool
   * within two standard errors of zero, every point estimate negative, against a
   * shipped assumption of 0.60. Teams replace departed volume instead: a
   * first-round rookie takes 20% of the targets or 56% of the carries in year
   * one. And the spread is enormous in both directions — Jaxon Smith-Njigba 24%
   * to 36%, DJ Moore 27% to 16%, both with a fifth of the offence leaving.
   *
   * So the fact stays and the inference goes. The label says what happened; it
   * no longer says what it means, because it does not reliably mean anything.
   */
  if (i.vacated !== null && i.vacated >= 0.3) {
    tags.push({
      id: 'volume-open', label: 'volume vacated', kind: 'opportunity', weight: 9,
      detail:
        `${pct(i.vacated)} of the ${isRb ? 'carries' : 'targets'} he competes for left the roster. Whether ` +
        `any of it reaches him is genuinely unknown — checked across more than a thousand cases, the ` +
        `next man up gains nothing on average, because teams sign and draft replacements instead of ` +
        `promoting. Individual players swing hard both ways. Read it as his range widening, not as ` +
        `volume he is owed.`,
    });
  }

  if (i.disagreement !== null && i.disagreement >= 1) {
    tags.push({
      id: 'role-ahead', label: 'role beats price', kind: 'opportunity', weight: 8,
      detail:
        `His on-field usage ranks well above what sportsbook lines imply. The market has not ` +
        `caught up to what he was actually doing.`,
    });
  } else if (i.disagreement !== null && i.disagreement <= -1) {
    tags.push({
      id: 'role-behind', label: 'price beats role', kind: 'risk', weight: 8,
      detail:
        `Sportsbooks price him well above what his actual usage supports. Paying for a role ` +
        `he has not held.`,
    });
  }

  /* ---- risk ---- */
  if (i.expectedGames !== null && i.expectedGames <= 13) {
    tags.push({
      id: 'injury', label: 'injury prone', kind: 'risk', weight: 9,
      detail:
        `Averages ${i.expectedGames.toFixed(1)} games a season. A receiver who missed four or more ` +
        `games misses time again 73% of the time — availability is one of the most repeatable ` +
        `things in the data.`,
    });
  }

  if (i.tdOverExpected !== null && i.tdOverExpected >= 2.5) {
    tags.push({
      id: 'td-regress', label: 'TD regression', kind: 'risk', weight: 7,
      detail:
        `Scored ${i.tdOverExpected.toFixed(1)} touchdowns more than his red-zone volume supports. ` +
        `Scoring above volume carries over at r=0.12 — it is mostly luck and it does not repeat.`,
    });
  } else if (i.tdOverExpected !== null && i.tdOverExpected <= -2) {
    tags.push({
      id: 'td-rebound', label: 'TD rebound', kind: 'opportunity', weight: 6,
      detail:
        `Scored ${Math.abs(i.tdOverExpected).toFixed(1)} fewer touchdowns than his red-zone volume ` +
        `implies. The chances were there; the finishing should normalise.`,
    });
  }

  /*
   * A new play caller is a running back's risk, and measured as one.
   *
   * Backs who stayed with their team through a coaching change lost 24.5 points
   * the following season against 12.5 for backs whose coach stayed — a 12-point
   * penalty, on 150 changes against 188 non-changes. Receivers lose 4.5 and
   * tight ends nothing, so this is deliberately restricted to backs rather than
   * applied to everyone as a generic "uncertainty" flag.
   *
   * Quarterbacks show +19.6, which is not a benefit: coaches get fired BECAUSE
   * the quarterback played badly, so the following season regresses upward. That
   * is a confound, not a finding, and no tag is drawn from it.
   */
  if (isRb && i.coachChanged) {
    tags.push({
      id: 'new-caller', label: 'new play caller', kind: 'risk', weight: 7,
      detail:
        `${i.priorCoach ?? 'His previous coach'} is gone${i.currentCoach ? `; ${i.currentCoach} takes over` : ''}. ` +
        `Backs who stayed put through a coaching change lost 24.5 points the next season against ` +
        `12.5 for backs who kept their coach — about 12 points of cost, measured over 338 cases. ` +
        `Backfield usage is a coaching decision more than a talent one, and a new staff has no ` +
        `stake in the last one's depth chart.`,
    });
  }

  /*
   * How concentrated this coach's backfield runs, when it is a real signal
   * either way. Concentration repeats at r=0.337 under the same coach against
   * r=0.107 when the team changes coach, so it travels with the man — but on
   * two to five seasons each, so it is reported and never scored.
   */
  if (isRb && i.coachTopBackShare !== null && i.currentCoach) {
    if (i.coachTopBackShare >= 0.62) {
      tags.push({
        id: 'feeds-one-back', label: 'feeds one back', kind: 'opportunity', weight: 5,
        detail:
          `${i.currentCoach}'s lead back has averaged ${pct(i.coachTopBackShare)} of team carries. ` +
          `Backfield concentration follows the coach — it repeats at r=0.337 when he stays and only ` +
          `r=0.107 when a team changes coach — so whoever wins this job should get the whole of it. ` +
          `Two to five seasons per coach, so treat it as a lean rather than a law.`,
      });
    } else if (i.coachTopBackShare <= 0.47) {
      tags.push({
        id: 'splits-backfield', label: 'splits the backfield', kind: 'risk', weight: 5,
        detail:
          `${i.currentCoach}'s lead back has averaged only ${pct(i.coachTopBackShare)} of team ` +
          `carries. That tendency follows the coach rather than the roster, so the workload here is ` +
          `likely to be shared however the depth chart reads. Two to five seasons per coach — a ` +
          `lean, not a law.`,
      });
    }
  }

  const ageLimit = isRb ? 28 : 30;
  if (i.age !== null && i.age >= ageLimit) {
    tags.push({
      id: 'aging', label: `age ${i.age}`, kind: 'risk', weight: 6,
      detail:
        `Past the point where production reliably holds. With current role accounted for, age still ` +
        `predicts next season at −0.18 for backs and −0.27 for receivers.`,
    });
  }

  /* ---- coverage: how much to trust any of this ---- */
  if (i.isRookie) {
    tags.push({
      id: 'rookie', label: 'rookie', kind: 'coverage', weight: 5,
      detail:
        `No NFL usage to model. Projected from draft capital and depth-chart position, which is ` +
        `the strongest rookie signal available but far coarser than a real usage history.`,
    });
  }

  if (i.signal === 'none') {
    tags.push({
      id: 'no-market', label: 'no betting lines', kind: 'coverage', weight: 4,
      detail:
        `No sportsbook prices the stats that define his position, so this read rests entirely on ` +
        `on-field usage. Half the normal evidence.`,
    });
  } else if (i.signal === 'partial') {
    tags.push({
      id: 'partial-market', label: 'partial lines', kind: 'coverage', weight: 3,
      detail:
        `Sportsbooks price only part of what he does — usually a back with no receiving line, worth ` +
        `about 77 points. The market side is a floor, so the read leans on usage.`,
    });
  } else if (i.extrapolatedStats > 0) {
    tags.push({
      id: 'wk1-line', label: 'week 1 line only', kind: 'coverage', weight: 3,
      detail:
        `Part of the projection is scaled up from a single Week 1 line rather than a season-long ` +
        `one, so it carries that matchup's noise.`,
    });
  }

  if (i.gamesLastSeason !== null && i.gamesLastSeason <= 6 && !i.isRookie) {
    tags.push({
      id: 'thin-sample', label: 'thin sample', kind: 'coverage', weight: 4,
      detail: `Only ${i.gamesLastSeason} games of usage last season. The role numbers are unreliable.`,
    });
  }

  /*
   * Resolution. Two tags that cannot both be true must not both survive.
   *
   * Tags are built independently, each from its own evidence, which is what
   * allowed Matthew Golden to carry GEM, "lottery ticket" and NO UPSIDE at once
   * — three price and risk claims of completely different quality shown as three
   * identical chips. The case section fixes the primary read structurally by
   * having exactly one verdict; this keeps the chip list underneath from saying
   * something different.
   *
   * The winner is named explicitly rather than taken by weight, because weight
   * orders how NOTABLE a tag is and this question is about which claim rests on
   * better evidence. GEM beats NO UPSIDE because GEM is the measured late-round
   * profile (59% against a 31% base rate, holding in all four seasons) while
   * NO UPSIDE comes from comparables matched on the role the player holds NOW —
   * bug #36 — which for a backup is the very thing in question.
   */
  const SUPERSEDES: Array<[winner: string, loser: string]> = [
    ['gem', 'dead-end'],
    ['gem', 'lottery'],
    ['gem', 'late-upside'],
    ['volume-open', 'dead-end'],
    ['late-upside', 'dead-end'],
    ['value', 'slight-value'],
    ['reach', 'slight-reach'],
  ];
  const present = new Set(tags.map((t) => t.id));
  const suppressed = new Set(
    SUPERSEDES.filter(([w]) => present.has(w)).map(([, l]) => l),
  );

  /*
   * And at most one price tag. `kind` already implies these are alternatives —
   * a player is cheap or fairly priced or expensive, not two of them — but
   * nothing enforced it, so 33 board rows carried two.
   */
  const kept = tags.filter((t) => !suppressed.has(t.id)).sort((a, b) => b.weight - a.weight);
  const seenPrice = { done: false };
  return kept.filter((t) => {
    if (t.kind !== 'price') return true;
    if (seenPrice.done) return false;
    seenPrice.done = true;
    return true;
  });
}
