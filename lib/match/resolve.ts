import { db, sqlite } from '../db/index';
import { players } from '../db/schema';
import {
  normalizeName,
  normalizeTeam,
  normalizePosition,
  nameTokens,
  unflipName,
  jaroWinkler,
} from './normalize';

/**
 * Resolves an external name string to a canonical gsis_id.
 *
 * A silent mismatch is worse than a miss: a wrong join hangs one player's props
 * on another player's card, and nothing downstream would flag it. So every
 * resolution records the method and a confidence, unresolved names are kept as
 * rows rather than dropped, and anything below REVIEW_FLOOR is left for a human.
 */

export const REVIEW_FLOOR = 0.92;

export interface ExternalName {
  rawName: string;
  position?: string | null;
  team?: string | null;
  /**
   * The season the name was observed in. This is the decisive signal for
   * same-name collisions, which are almost always cross-era: two players named
   * Irv Smith (1993-1999 and 2019-2025), or Frank Gore against Frank Gore Jr.
   * once suffix stripping collapses them onto the same key.
   */
  season?: number | null;
}

export interface Resolution {
  playerId: string | null;
  method: string;
  confidence: number;
}

interface Candidate {
  gsisId: string;
  displayName: string;
  normalizedName: string;
  position: string | null;
  latestTeam: string | null;
  status: string | null;
  rookieSeason: number | null;
  lastSeason: number | null;
  footballName: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** Was this player on a roster in the given season? Nulls stay permissive. */
function activeIn(c: Candidate, season: number | null | undefined): boolean {
  if (season == null) return true;
  if (c.rookieSeason !== null && season < c.rookieSeason) return false;
  if (c.lastSeason !== null && season > c.lastSeason) return false;
  return true;
}

export class PlayerIndex {
  private byNormalized = new Map<string, Candidate[]>();
  private byVariant = new Map<string, Candidate[]>();
  private byPosition = new Map<string, Candidate[]>();
  private all: Candidate[] = [];

  constructor(rows: Candidate[]) {
    this.all = rows;
    for (const c of rows) {
      push(this.byNormalized, c.normalizedName, c);
      if (c.position) push(this.byPosition, c.position, c);

      // Books and ADP feeds often use the short form ("Cam Ward" where nflverse
      // display_name is "Cameron Ward"), so index those spellings too.
      if (c.footballName && c.lastName) {
        push(this.byVariant, normalizeName(`${c.footballName} ${c.lastName}`), c);
      }
      if (c.firstName && c.lastName) {
        push(this.byVariant, normalizeName(`${c.firstName} ${c.lastName}`), c);
      }
    }
  }

  static load(): PlayerIndex {
    const rows = db
      .select({
        gsisId: players.gsisId,
        displayName: players.displayName,
        normalizedName: players.normalizedName,
        position: players.position,
        latestTeam: players.latestTeam,
        status: players.status,
        rookieSeason: players.rookieSeason,
        lastSeason: players.lastSeason,
        footballName: players.footballName,
        firstName: players.firstName,
        lastName: players.lastName,
      })
      .from(players)
      .all();
    return new PlayerIndex(rows);
  }

  resolve(input: ExternalName): Resolution {
    const raw = unflipName(input.rawName.trim());
    const norm = normalizeName(raw);
    const pos = normalizePosition(input.position);
    const team = normalizeTeam(input.team);
    const season = input.season ?? null;
    if (!norm) return { playerId: null, method: 'empty', confidence: 0 };

    // 1. Exact normalized name.
    const exact = this.narrow(this.byNormalized.get(norm) ?? [], pos, season);
    if (exact.length === 1) return hit(exact[0]!, 'exact', 1);
    if (exact.length > 1) return this.disambiguate(exact, team, season, 'exact');

    // 2. Alternate spellings of the same person.
    const variant = this.narrow(this.byVariant.get(norm) ?? [], pos, season);
    if (variant.length === 1) return hit(variant[0]!, 'variant', 0.95);
    if (variant.length > 1) return this.disambiguate(variant, team, season, 'variant');

    // 3. First initial + surname, but only inside a known position and team —
    //    "J. Jones" is far too common to trust on the name alone.
    const tokens = nameTokens(raw);
    if (tokens.length >= 2 && pos && team) {
      const surname = tokens[tokens.length - 1]!;
      const initial = tokens[0]![0]!;
      const pool = (this.byPosition.get(pos) ?? []).filter(
        (c) =>
          c.latestTeam === team &&
          c.lastName &&
          normalizeName(c.lastName) === normalizeName(surname) &&
          (c.firstName ?? '').toLowerCase().startsWith(initial),
      );
      if (pool.length === 1) return hit(pool[0]!, 'initial+team', 0.9);
    }

    // 4. Fuzzy, scoped to the position so a WR never resolves to a QB.
    const scoped = pos ? (this.byPosition.get(pos) ?? []) : this.all;
    const pool = season === null ? scoped : scoped.filter((c) => activeIn(c, season));
    let best: Candidate | null = null;
    let bestScore = 0;
    for (const c of pool) {
      const score = jaroWinkler(norm, c.normalizedName);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best && bestScore >= 0.9) {
      // A team agreement is strong corroboration for a fuzzy hit; disagreement
      // is a reason to trust it less, not to reject it outright (players move).
      const teamAgrees = team && best.latestTeam === team;
      const confidence = Math.min(0.99, bestScore + (teamAgrees ? 0.04 : -0.03));
      return { playerId: best.gsisId, method: 'fuzzy', confidence };
    }

    return { playerId: null, method: 'unresolved', confidence: 0 };
  }

  /**
   * Narrows on season first, then position. Season is applied before position
   * because a two-way player's nflverse position disagrees with their fantasy
   * one (Travis Hunter is listed CB), and each filter falls back to the wider
   * list rather than returning nothing.
   */
  private narrow(list: Candidate[], pos: string | null, season: number | null): Candidate[] {
    if (list.length <= 1) return list;

    let out = list;
    if (season !== null) {
      const inEra = out.filter((c) => activeIn(c, season));
      if (inEra.length) out = inEra;
    }
    if (pos && out.length > 1) {
      const byPos = out.filter((c) => c.position === pos);
      if (byPos.length) out = byPos;
    }
    return out;
  }

  /** Still tied, prefer the right team, then whoever was actually playing. */
  private disambiguate(
    list: Candidate[],
    team: string | null,
    season: number | null,
    base: string,
  ): Resolution {
    if (team) {
      const onTeam = list.filter((c) => c.latestTeam === team);
      if (onTeam.length === 1) return hit(onTeam[0]!, `${base}+team`, 0.97);
    }
    const ranked = [...list].sort(
      (a, b) =>
        Number(activeIn(b, season)) - Number(activeIn(a, season)) ||
        Number(b.status === 'ACT') - Number(a.status === 'ACT') ||
        (b.lastSeason ?? 0) - (a.lastSeason ?? 0),
    );
    return hit(ranked[0]!, `${base}+ambiguous`, 0.7);
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function hit(c: Candidate, method: string, confidence: number): Resolution {
  return { playerId: c.gsisId, method, confidence };
}

/**
 * Persists resolutions. Manual corrections win over anything computed, so a
 * hand-fixed row survives every future re-run.
 */
export function saveAliases(
  source: string,
  entries: Array<ExternalName & Resolution>,
): { written: number; skippedManual: number } {
  const manual = new Set(
    sqlite
      .prepare(`SELECT alias_text FROM player_aliases WHERE source = ? AND is_manual = 1`)
      .all(source)
      .map((r) => (r as { alias_text: string }).alias_text),
  );

  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO player_aliases
     (alias_text, source, player_id, raw_name, position, team, method, confidence, is_manual, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );

  let written = 0;
  let skippedManual = 0;
  const now = Date.now();

  const run = sqlite.transaction(() => {
    for (const e of entries) {
      const alias = normalizeName(unflipName(e.rawName));
      if (!alias) continue;
      if (manual.has(alias)) {
        skippedManual++;
        continue;
      }
      stmt.run(
        alias,
        source,
        e.playerId,
        e.rawName,
        normalizePosition(e.position),
        normalizeTeam(e.team),
        e.method,
        e.confidence,
        now,
      );
      written++;
    }
  });
  run();

  return { written, skippedManual };
}

/** Looks up a previously resolved name. Returns null for unresolved rows. */
export function lookupAlias(source: string, rawName: string): string | null {
  const alias = normalizeName(unflipName(rawName));
  const row = sqlite
    .prepare(`SELECT player_id FROM player_aliases WHERE alias_text = ? AND source = ?`)
    .get(alias, source) as { player_id: string | null } | undefined;
  return row?.player_id ?? null;
}
