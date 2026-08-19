import type { Outlook } from './comparables';

/**
 * What the model thinks of a player, in sentences.
 *
 * Everything else on the page is a number with an explanation attached. This is
 * the opposite: the conclusion first, in the language someone would use out
 * loud, with the numbers as support. A reader should be able to open a player,
 * read four sentences, and know whether to draft him and what would have to be
 * true for that to be wrong.
 *
 * Every clause is generated from a measured quantity — nothing here is a
 * template with adjectives sprinkled on. Where the model has no opinion it says
 * so rather than reaching for a neutral-sounding phrase, because "fairly priced"
 * applied to a third of the board is what this replaced.
 */

export interface ReadInput {
  name: string;
  position: string;
  adp: number | null;
  /** Projected points and what they are worth over a free replacement. */
  points: number | null;
  vorp: number | null;
  replacement: number | null;
  /** Where his VALUE puts him on the historical draft curve. */
  equivalentPick: number | null;
  signal: string | null;
  /** Market and usage percentiles within position, and their disagreement. */
  usageGrade: number | null;
  marketPct: number | null;
  /** How secure the job is, 0-100. */
  certainty: number | null;
  depthRank: number | null;
  /** Exactly what dragged role certainty down, as recorded — never inferred. */
  certaintyReasons: string[];
  outlook: Outlook | null;
  archetype: string | null;
  /** Risk tags already computed, most notable first. */
  risks: Array<{ label: string; detail: string }>;
  expectedGames: number | null;
  /** Undrafted players have no price, so the read changes shape. */
  undrafted: boolean;
  /**
   * The case's confidence, which owns the label when it exists. One page must
   * not carry two answers to "how sure is the model" — see the conviction block.
   */
  caseConfidence?: "high" | "medium" | "low" | null;
}

export interface PlayerRead {
  /** One line: the conclusion. */
  headline: string;
  /** Supporting sentences, in reading order. */
  body: string[];
  /** How strongly the model holds this view. */
  conviction: 'high' | 'medium' | 'low';
  convictionWhy: string;
}

const round = (v: number) => Math.round(v);

/**
 * How replacement level works, said once and properly.
 *
 * Negative VALUE is the single most misread number on the board — it looks like
 * a verdict on the player and is really a statement about his position's supply.
 * Only 12 quarterbacks, 29 backs, 43 receivers and 13 tight ends can be above
 * replacement by construction, so roughly half of a 174-player board is negative
 * every year and always will be.
 */
function replacementSentence(i: ReadInput): string | null {
  if (i.vorp === null || i.replacement === null || i.points === null) return null;
  if (i.vorp >= 0) return null;

  const short = Math.abs(round(i.vorp));
  const free =
    i.position === 'QB'
      ? 'the 12th-best quarterback'
      : i.position === 'RB'
        ? 'the 29th-best back'
        : i.position === 'WR'
          ? 'the 43rd-best receiver'
          : 'the 13th-best tight end';

  return (
    `His VALUE is negative, and that is a statement about supply rather than about him. ` +
    `VALUE measures points above ${free} — the man you can have for nothing in a 12-team league — ` +
    `and that bar sits at ${round(i.replacement)} points for a ${i.position}. ` +
    `At ${round(i.points)} projected he lands ${short} short of it, ` +
    (i.undrafted
      ? `so in his current role a claim on him gains you nothing over whoever else is sitting on the wire. `
      : `so drafting him buys you ${short} points less than doing nothing would. `) +
    (i.position === 'QB'
      ? `Quarterbacks run negative more than anyone: one starts, twelve are startable, and the ` +
        `replacement bar is the highest of any position at ${round(i.replacement)}. Most of the ` +
        `position reads negative here and that is correct — it is why the board puts so few ` +
        `quarterbacks near the top.`
      : i.undrafted
        ? `That is the normal state of a backup rather than a mark against him — which is why what ` +
          `he is worth if the job opens matters more here than the projection does.`
        : `About half of any draft board reads negative for this reason; it is the definition ` +
          `working, not a fault.`)
  );
}

export function buildRead(i: ReadInput): PlayerRead {
  const body: string[] = [];

  /* --------------------------------------------------------- the headline */

  let headline: string;
  if (i.undrafted) {
    if (i.equivalentPick !== null && i.equivalentPick <= 130) {
      headline = `Free, and projects like a pick inside the top ${Math.ceil(i.equivalentPick / 12) * 12}.`;
    } else if ((i.outlook?.breakoutRate ?? 0) >= 0.25) {
      headline = 'Nobody is drafting him, but the comparable roles broke out often enough to watch.';
    } else {
      headline = 'A depth piece unless something changes ahead of him.';
    }
  } else if (i.vorp === null) {
    headline = 'Not enough to price him.';
  } else if (i.vorp >= 60) {
    headline = 'A genuine starter, and worth what he costs.';
  } else if (i.vorp >= 20) {
    headline = 'Comfortably better than what the position gives away for free.';
  } else if (i.vorp >= 0) {
    headline = 'Barely above replacement — a roster spot, not an advantage.';
  } else if (i.vorp >= -25) {
    headline = 'Projects below the free option at his position.';
  } else {
    headline = 'The model sees no case for drafting him.';
  }

  /* ------------------------------------------------------ what he is worth */

  if (i.points !== null && i.vorp !== null && i.replacement !== null) {
    const cmp =
      i.vorp >= 0
        ? `${round(i.vorp)} more than the freely available ${i.position}`
        : `${Math.abs(round(i.vorp))} fewer than the freely available ${i.position}`;
    let s = `The projection is ${round(i.points)} half-PPR points across a full season — ${cmp}, who is worth ${round(i.replacement)}.`;
    if (!i.undrafted && i.adp !== null && i.equivalentPick !== null) {
      const gap = i.adp - i.equivalentPick;
      s +=
        Math.abs(gap) < 8
          ? ` That is about what pick ${i.adp.toFixed(0)} has historically returned, so the price is fair.`
          : gap > 0
            ? ` Picks that have returned this much have gone around ${i.equivalentPick.toFixed(0)}, and he is available at ${i.adp.toFixed(0)} — roughly ${Math.abs(round(gap))} picks of value.`
            : ` Picks that have returned this much have gone around ${i.equivalentPick.toFixed(0)}, and he is going at ${i.adp.toFixed(0)} — you are paying about ${Math.abs(round(gap))} picks ahead of the return.`;
    }
    if (i.undrafted && i.equivalentPick !== null) {
      s += ` Nobody drafts him, but that production has historically come off the board around pick ${i.equivalentPick.toFixed(0)}.`;
    } else if (i.undrafted) {
      /*
       * Null here means he is below the whole draft curve, not that the curve is
       * missing. Saying "projects like pick 200" was the old behaviour and it was
       * a clamp reported as a comparison — it applied to 83% of the wire.
       */
      s +=
        ` There is no draft pick this compares to: the curve ends at 200 and he projects below it,` +
        ` which is where most of the wire sits before a role opens.`;
    }
    body.push(s);
  }

  const replSentence = replacementSentence(i);
  if (replSentence) body.push(replSentence);

  /* ------------------------------------------------- where the number came from */

  if (i.signal === 'none') {
    body.push(
      `No sportsbook posts season props on him, so this is entirely his on-field role — no market ` +
        `opinion is folded in. That is not a knock: books price the players people bet on, and ` +
        `silence usually means uncertainty about whether he plays rather than about how good he is.`,
    );
  } else if (i.usageGrade !== null && i.marketPct !== null) {
    const gap = i.usageGrade - i.marketPct;
    if (Math.abs(gap) >= 20) {
      body.push(
        gap > 0
          ? `The two views disagree, and that is the interesting part: his role ranks ${i.usageGrade} of 100 among ${i.position}s while the betting market prices him at ${i.marketPct}. The field is slower to him than the film is.`
          : `The two views disagree: the market prices him at ${i.marketPct} of 100 among ${i.position}s while his actual role ranks only ${i.usageGrade}. Somebody is paying for a job he did not hold last season.`,
      );
    } else {
      body.push(
        `The market and his on-field role agree closely — ${i.marketPct} and ${i.usageGrade} out of 100 among ${i.position}s — so there is no hidden edge here in either direction.`,
      );
    }
  }

  /* ------------------------------------------------------------- the role */

  if (i.certainty !== null) {
    const where = i.depthRank ? `listed ${i.position}${i.depthRank}` : 'unlisted';
    /*
     * Low certainty has two very different causes and they must not be told as
     * one story. A player listed first who misses time is a availability
     * problem; a player listed second who was out-produced by the man below him
     * is a job problem. Saying "the projection may be describing a job he does
     * not hold" about Joe Burrow — QB1 by any reading, and hurt — is simply
     * false, and the kind of false that makes a reader stop believing the page.
     */
    /*
     * The reason is READ, not inferred.
     *
     * `buildRoleCertainty` already records exactly what dragged the number down
     * — "age 30", "listed RB1 but only the 2nd heaviest rush share in this
     * room", "Joe Flacco behind him produced more per game". Guessing a
     * narrative from the score instead told Christian McCaffrey that "the depth
     * chart and last season's production do not entirely agree" when the only
     * flag on him is his age and he is the unambiguous RB1. Inventing a cause
     * that the data does not support is worse than saying nothing.
     */
    const why = i.certaintyReasons.filter(Boolean);

    body.push(
      i.certainty >= 65 && !why.length
        ? `The job looks safe: ${where}, and the depth chart, his production and his availability all point the same way.`
        : i.certainty >= 65
          ? `The job looks safe — ${where} — with one flag on it: ${why.join('; ')}.`
          : i.certainty >= 40
            ? `The job is not fully settled. ${where[0]!.toUpperCase()}${where.slice(1)}, and what pulls the certainty down is ${why.length ? why.join('; ') : 'a mix of depth-chart position and availability'}.`
            : `The role itself is the risk — ${where}, and the evidence conflicts: ${why.length ? why.join('; ') : 'the depth chart and last season’s production point different ways'}. The projection above may be describing a job he does not hold.`,
    );
  }

  /* ------------------------------------------------------------ the range */

  if (i.outlook && !i.outlook.sparse) {
    const o = i.outlook;
    body.push(
      `Players who looked like this went on to a median of ${round(o.median)} points — ${o.medianPpg.toFixed(1)} a game — ` +
        `with the middle 60% landing between ${round(o.floor)} and ${round(o.ceiling)}. ` +
        // The bust rate is stated once on this page, in the comparables panel
        // below. Repeating it here as its complement made one measurement look
        // like two findings a few inches apart.
        `${Math.round(o.breakoutRate * 100)}% of them finished top-12 at the position` +
        (o.vanishRate > 0.05
          ? `, while ${Math.round(o.vanishRate * 100)}% never played another snap.`
          : '.'),
    );
  } else if (i.outlook?.sparse) {
    /*
     * This used to say the range could not be drawn. It is drawn now — the
     * backtest says a remote neighbourhood breaks the midpoint and leaves the
     * spread working — so the sentence has to describe what is actually on the
     * page a few inches below it. A written read that contradicts its own chart
     * is the family that produced #75 and #78, and it costs the reader's trust
     * in everything else here.
     */
    const o = i.outlook;
    body.push(
      `No historical season resembles his closely, which is itself a finding: the profile is ` +
        `unusual. The least-unlike roles spread between ${round(o.floor)} and ${round(o.ceiling)} ` +
        `points, and that width is worth reading — the single middle number is not, because it ` +
        `roughly doubles in error when the comparison is this loose.`,
    );
  }

  /* ------------------------------------------------------------ the risks */

  if (i.risks.length) {
    const named = i.risks.slice(0, 3).map((r) => r.label.toLowerCase());
    body.push(
      `What would make this wrong: ${named.join(', ')}${i.risks.length > 3 ? `, and ${i.risks.length - 3} more flagged above` : ''}.`,
    );
  }

  /* ---------------------------------------------------------- conviction */

  /*
   * How much the model's own evidence supports the view, rather than how good
   * the player is. A confident opinion about a well-covered starter and a guess
   * about a backup should not look the same on the page.
   */
  let score = 0;
  const reasons: string[] = [];
  if (i.signal === 'full') { score += 2; reasons.push('a full market read'); }
  else if (i.signal === 'partial') { score += 1; reasons.push('a partial market read'); }
  else reasons.push('no market read');

  if (i.outlook && !i.outlook.sparse) {
    if (i.outlook.support === 'strong') { score += 2; reasons.push('close historical comparables'); }
    else if (i.outlook.support === 'fair') { score += 1; reasons.push('reasonable comparables'); }
    else reasons.push('thin comparables');
  } else reasons.push('no usable comparables');

  if ((i.certainty ?? 0) >= 65) { score += 1; reasons.push('a settled role'); }
  else if ((i.certainty ?? 100) < 40) { score -= 1; reasons.push('a contested role'); }

  if ((i.expectedGames ?? 17) < 14) { score -= 1; reasons.push('an injury history'); }

  /*
   * ONE confidence label on the page, and the case owns it.
   *
   * This scored its own conviction from coverage, comparables, role certainty
   * and injury history, and rendered it directly above the case's confidence,
   * which counts how many calibrated findings actually apply. They disagreed:
   * DeVonta Smith read HIGH CONVICTION here and MEDIUM CONFIDENCE two inches
   * below, on the same screen, about the same player. That is the third verdict
   * system on this page and the same failure the case was built to remove — a
   * reader cannot be handed two answers and told to pick.
   *
   * So when the case is available its confidence wins, and the reasons gathered
   * here still travel because they explain the evidence in words the case's own
   * counter cannot. Where no case exists — the waiver population — the local
   * score still stands rather than leaving the label blank.
   */
  const localConviction = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
  const conviction = i.caseConfidence ?? localConviction;

  return {
    headline,
    body,
    conviction,
    convictionWhy:
      `Based on ${reasons.join(', ')}.` +
      (i.caseConfidence && i.caseConfidence !== localConviction
        ? ` The label itself comes from how many calibrated findings apply to him, which is what the case below counts.`
        : ''),
  };
}
