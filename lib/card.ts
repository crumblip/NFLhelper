import type { SeasonContext } from './player';
import type { ToppsSeason } from '../app/ui/topps-card';

/**
 * How a player card is filled, in one place.
 *
 * These were private helpers on the player page until the compare view needed
 * the same card. Copying them would have been the third time this project made
 * two definitions of one quantity and watched them drift (#71, #86), so they
 * moved here instead.
 *
 * Imports nothing that reaches the database, so a client component can use it.
 */

/** Four stat columns per position, as two-line headings. */
export function cardColumns(position: string): Array<[string, string]> {
  if (position === 'QB') {
    return [['PASS', 'YDS'], ['PASS', 'TD'], ['RUSH', 'YDS'], ['RUSH', 'TD']];
  }
  if (position === 'RB') {
    return [['RUSH', 'ATT'], ['RUSH', 'YDS'], ['REC', ''], ['TOTAL', 'TD']];
  }
  return [['TGT', ''], ['REC', ''], ['REC', 'YDS'], ['REC', 'TD']];
}

export function cardSeasons(position: string, context: SeasonContext[]): ToppsSeason[] {
  return context.map((c) => {
    const base = { season: c.season, games: c.games, points: c.fantasyPointsHalf };
    if (position === 'QB') {
      return { ...base, a: c.passingYards, b: c.passingTds, c: c.rushingYards, d: c.rushingTds };
    }
    if (position === 'RB') {
      return {
        ...base,
        a: c.carries,
        b: c.rushingYards,
        c: c.receptions,
        d: (c.rushingTds ?? 0) + (c.receivingTds ?? 0),
      };
    }
    return { ...base, a: c.targets, b: c.receptions, c: c.receivingYards, d: c.receivingTds };
  });
}

/**
 * The corner badge: value over replacement where he has a price, usage grade
 * where he does not.
 *
 * The two are on different scales and must never appear under one label, which
 * is why the label travels with the number.
 */
export function cardBadge(
  vorp: number | null | undefined,
  grade: number | null | undefined,
): { value: string; label: string; good: boolean } | null {
  if (vorp !== null && vorp !== undefined) {
    return { value: (vorp > 0 ? '+' : '') + vorp.toFixed(0), label: 'value', good: vorp > 0 };
  }
  if (grade !== null && grade !== undefined) {
    return { value: String(Math.round(grade)), label: 'grade', good: grade >= 60 };
  }
  return null;
}
