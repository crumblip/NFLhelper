/**
 * Fantasy scoring. One implementation, used for both directions: scoring real
 * nflverse box scores when fitting the baseline, and scoring the stat line
 * implied by sportsbook props when valuing a player.
 *
 * They must never diverge — a baseline fit under different rules than the
 * projection it is compared against would produce a value gap that is pure
 * artefact.
 */

export interface StatLine {
  passingYards?: number | null;
  passingTds?: number | null;
  interceptions?: number | null;
  rushingYards?: number | null;
  rushingTds?: number | null;
  receptions?: number | null;
  receivingYards?: number | null;
  receivingTds?: number | null;
  fumblesLost?: number | null;
  twoPointConversions?: number | null;
}

export interface ScoringRules {
  passingYardsPerPoint: number;
  passingTd: number;
  interception: number;
  rushingYardsPerPoint: number;
  rushingTd: number;
  reception: number;
  receivingYardsPerPoint: number;
  receivingTd: number;
  fumbleLost: number;
  twoPointConversion: number;
}

export const SCORING: Record<'standard' | 'half-ppr' | 'ppr', ScoringRules> = {
  standard: {
    passingYardsPerPoint: 0.04,
    passingTd: 4,
    interception: -2,
    rushingYardsPerPoint: 0.1,
    rushingTd: 6,
    reception: 0,
    receivingYardsPerPoint: 0.1,
    receivingTd: 6,
    fumbleLost: -2,
    twoPointConversion: 2,
  },
  'half-ppr': {
    passingYardsPerPoint: 0.04,
    passingTd: 4,
    interception: -2,
    rushingYardsPerPoint: 0.1,
    rushingTd: 6,
    reception: 0.5,
    receivingYardsPerPoint: 0.1,
    receivingTd: 6,
    fumbleLost: -2,
    twoPointConversion: 2,
  },
  ppr: {
    passingYardsPerPoint: 0.04,
    passingTd: 4,
    interception: -2,
    rushingYardsPerPoint: 0.1,
    rushingTd: 6,
    reception: 1,
    receivingYardsPerPoint: 0.1,
    receivingTd: 6,
    fumbleLost: -2,
    twoPointConversion: 2,
  },
};

const n = (v: number | null | undefined) => v ?? 0;

export function scoreStatLine(line: StatLine, rules: ScoringRules): number {
  return (
    n(line.passingYards) * rules.passingYardsPerPoint +
    n(line.passingTds) * rules.passingTd +
    n(line.interceptions) * rules.interception +
    n(line.rushingYards) * rules.rushingYardsPerPoint +
    n(line.rushingTds) * rules.rushingTd +
    n(line.receptions) * rules.reception +
    n(line.receivingYards) * rules.receivingYardsPerPoint +
    n(line.receivingTds) * rules.receivingTd +
    n(line.fumblesLost) * rules.fumbleLost +
    n(line.twoPointConversions) * rules.twoPointConversion
  );
}

export type ScoringFormatKey = keyof typeof SCORING;

export function rulesFor(format: string): ScoringRules {
  const rules = SCORING[format as ScoringFormatKey];
  if (!rules) throw new Error(`unknown scoring format: ${format}`);
  return rules;
}
