import { accessToken, readCredentials, type YahooCredentials } from './auth';

/**
 * Yahoo Fantasy Sports API client, plus the parsing this API unfortunately
 * requires.
 *
 * The endpoints are a clean REST tree. The payloads are not, because the JSON
 * is a mechanical translation of the XML and carries two habits that no JSON
 * consumer expects:
 *
 * 1. **Collections are objects with numeric string keys**, plus a sibling
 *    `count`. A list of twelve teams arrives as `{"0":{...},...,"count":12}`,
 *    which `Array.isArray` rejects and `Object.values` corrupts by including
 *    the count.
 *
 * 2. **Entity metadata is an array of single-key objects**, sometimes nested
 *    one array deeper: `[[{"team_key":"..."},{"team_id":"1"}],{...}]`. Every
 *    field sits in its own object, so nothing can be read by property access
 *    until the array is merged.
 *
 * Both are handled below by `collection()` and `flatten()`, and every reader in
 * `league.ts` goes through them rather than indexing into positions. Indexing
 * works right up until Yahoo adds a field, which it does.
 *
 * Numbers arrive as strings throughout — `"12"` not `12` — so anything numeric
 * goes through `num()`.
 */

const BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * Yahoo's numeric-keyed pseudo-array to a real array.
 *
 * Tolerates a genuine array too, because a few sub-resources do ship as one and
 * the difference is not documented anywhere.
 */
export function collection(node: Any): Any[] {
  if (node == null) return [];
  if (Array.isArray(node)) return node;
  if (typeof node !== 'object') return [];
  const out: Any[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'count') continue;
    if (!/^\d+$/.test(k)) continue;
    out.push(v);
  }
  return out;
}

/**
 * Merge Yahoo's array-of-single-key-objects into one plain object.
 *
 * Recurses through nested arrays, which is how the metadata block and its
 * sub-resources arrive at the same level. Collections are left as they are —
 * merging a twelve-team list into its parent would flatten the league into a
 * soup of numeric keys.
 */
export function flatten(node: Any): Record<string, Any> {
  const out: Record<string, Any> = {};
  const visit = (n: Any): void => {
    if (n == null) return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (typeof n !== 'object') return;
    const keys = Object.keys(n);
    // A collection, not metadata. Keep it whole under its own key upstream.
    if (keys.length && keys.every((k) => /^\d+$/.test(k) || k === 'count')) return;
    for (const [k, v] of Object.entries(n)) {
      if (out[k] === undefined) out[k] = v;
    }
  };
  visit(node);
  return out;
}

/**
 * First value for `key` anywhere in the tree.
 *
 * Used instead of a literal path for sub-resources whose nesting depth varies
 * with the request (`/team/{k}/roster` and `/league/{k}/teams/roster` bury
 * `players` at different depths). A path that is right for one call and wrong
 * for the other is the kind of breakage that shows up as an empty roster rather
 * than an error.
 */
export function deepFind(node: Any, key: string): Any {
  if (node == null || typeof node !== 'object') return undefined;
  if (!Array.isArray(node) && node[key] !== undefined) return node[key];
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = deepFind(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Yahoo sends every number as a string. */
export function num(v: Any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: Any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

export class YahooClient {
  private creds: YahooCredentials;
  /** Requests made this run — printed by the ingest so usage stays visible. */
  requests = 0;

  constructor(creds?: YahooCredentials) {
    this.creds = creds ?? readCredentials();
  }

  async get(path: string): Promise<Any> {
    const token = await accessToken(this.creds);
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BASE}${path}${sep}format=json`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    this.requests += 1;
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Yahoo ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      // An HTML body here means the token was rejected upstream of the API.
      throw new Error(`Yahoo returned non-JSON on ${path}: ${body.slice(0, 200)}`);
    }
  }

  /** The payload under `fantasy_content`, which wraps every response. */
  async content(path: string): Promise<Any> {
    const body = await this.get(path);
    return body?.fantasy_content ?? body;
  }
}
