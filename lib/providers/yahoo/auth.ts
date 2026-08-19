import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Yahoo OAuth2, sized for a single-user local tool.
 *
 * This deliberately does NOT implement the web-app flow. There is no session,
 * no cookie, no callback route, because there is one user and he is sitting at
 * the machine. What it implements is the only part that matters: turn a consent
 * granted once in a browser into a refresh token on disk, then trade that for
 * an hour-long access token whenever an ingest runs.
 *
 * The awkward part of Yahoo's setup is the redirect URI. Yahoo requires HTTPS
 * and has historically rejected bare `localhost`, which pushes web tutorials
 * toward ngrok or a self-signed certificate — both of which are a lot of
 * apparatus for a script that runs once a week. The way around it is that the
 * authorization code appears in the browser's address bar regardless of whether
 * anything is listening at the redirect. So the registered URI can be any HTTPS
 * URL you control (or none at all): consent, then copy the `code` parameter out
 * of the bar. `npm run yahoo:auth` walks through exactly that.
 *
 * Credentials and state are split across two files on purpose. The client id
 * and secret are config a person pastes once and should be able to hand-edit;
 * the refresh token is state this code rotates. Writing both to `.env.local`
 * would mean the app rewrites a file the user maintains.
 */

const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';

/** Read-only fantasy scope. Nothing here ever needs to set a lineup. */
export const SCOPE = 'fspt-r';

const TOKEN_PATH = process.env.YAHOO_TOKEN_PATH ?? './data/yahoo-token.json';

export interface StoredToken {
  refreshToken: string;
  /** Kept only so a warm process can skip a refresh; never trusted after restart. */
  accessToken?: string;
  expiresAt?: number;
  /** The URI the code was issued against. Yahoo re-checks it on every refresh. */
  redirectUri: string;
  savedAt: number;
}

export interface YahooCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Yahoo's own default for an app with no real callback. Anything registered on
 * the app works as long as the same string is used at consent and at exchange.
 */
export const DEFAULT_REDIRECT = 'https://localhost:3000/api/yahoo/callback';

export function readCredentials(): YahooCredentials {
  const clientId = process.env.YAHOO_CLIENT_ID ?? '';
  const clientSecret = process.env.YAHOO_CLIENT_SECRET ?? '';
  const redirectUri = process.env.YAHOO_REDIRECT_URI ?? DEFAULT_REDIRECT;
  if (!clientId || !clientSecret) {
    throw new Error(
      'YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET are not set.\n' +
        'Register an app at https://developer.yahoo.com/apps/create/ with Fantasy Sports\n' +
        'read permission, then put the id and secret in .env.local.',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function consentUrl(c: YahooCredentials): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    language: 'en-us',
  });
  return `${AUTH_URL}?${q.toString()}`;
}

export function loadToken(): StoredToken | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')) as StoredToken;
  } catch {
    return null;
  }
}

export function saveToken(t: StoredToken): void {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2));
}

export function tokenPath(): string {
  return TOKEN_PATH;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

async function postToken(
  c: YahooCredentials,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ redirect_uri: c.redirectUri, ...body }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // Yahoo's errors here are terse and the cause is nearly always one of three
    // things, so say which rather than printing the raw body alone.
    throw new Error(
      `Yahoo token exchange failed (${res.status}): ${text.slice(0, 300)}\n` +
        'Usually one of: the redirect URI does not match the one registered on the app, ' +
        'the authorization code was already used or has expired (they last minutes), ' +
        'or the app lacks Fantasy Sports read permission.',
    );
  }
  return JSON.parse(text) as TokenResponse;
}

/** One-time: turn a pasted authorization code into a stored refresh token. */
export async function exchangeCode(c: YahooCredentials, code: string): Promise<StoredToken> {
  const r = await postToken(c, { grant_type: 'authorization_code', code });
  if (!r.refresh_token) throw new Error('Yahoo returned no refresh token; re-run consent.');
  const token: StoredToken = {
    refreshToken: r.refresh_token,
    accessToken: r.access_token,
    expiresAt: Date.now() + r.expires_in * 1000,
    redirectUri: c.redirectUri,
    savedAt: Date.now(),
  };
  saveToken(token);
  return token;
}

/** Sixty seconds of headroom so a long ingest cannot expire mid-run. */
const SKEW_MS = 60_000;

/**
 * The access token for this run, refreshing if needed.
 *
 * Yahoo sometimes rotates the refresh token on use and sometimes returns the
 * same one, so whatever comes back is persisted. Dropping a rotated token is
 * the failure mode where auth works all week and then silently stops.
 */
export async function accessToken(c: YahooCredentials): Promise<string> {
  const stored = loadToken();
  if (!stored) {
    throw new Error(
      `No Yahoo token at ${TOKEN_PATH}. Run: npm run yahoo:auth`,
    );
  }
  if (stored.accessToken && stored.expiresAt && stored.expiresAt - SKEW_MS > Date.now()) {
    return stored.accessToken;
  }
  const creds = { ...c, redirectUri: stored.redirectUri || c.redirectUri };
  const r = await postToken(creds, {
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
  });
  saveToken({
    refreshToken: r.refresh_token ?? stored.refreshToken,
    accessToken: r.access_token,
    expiresAt: Date.now() + r.expires_in * 1000,
    redirectUri: creds.redirectUri,
    savedAt: Date.now(),
  });
  return r.access_token;
}
