import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  consentUrl,
  exchangeCode,
  loadToken,
  readCredentials,
  tokenPath,
  DEFAULT_REDIRECT,
} from '../lib/providers/yahoo/auth';
import { YahooClient } from '../lib/providers/yahoo/client';
import { discoverLeagues } from '../lib/providers/yahoo/league';

/**
 * One-time Yahoo consent.
 *
 * The flow is a paste rather than a callback, and that is the whole trick that
 * makes this practical locally. Yahoo requires an HTTPS redirect URI and will
 * not accept a bare localhost one, which normally forces a tunnel or a
 * self-signed certificate. But the authorization code lands in the browser's
 * address bar whether or not anything is listening at the other end — so the
 * registered URI can point nowhere, the page can fail to load, and the code is
 * still right there to copy.
 *
 * Run once. After this the refresh token on disk carries every later ingest.
 */

async function main(): Promise<void> {
  const existing = loadToken();
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    let creds;
    try {
      creds = readCredentials();
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      console.error('Set these in .env.local, then run this again:\n');
      console.error('  YAHOO_CLIENT_ID=...');
      console.error('  YAHOO_CLIENT_SECRET=...');
      console.error(`  YAHOO_REDIRECT_URI=${DEFAULT_REDIRECT}   # must match the app exactly\n`);
      process.exitCode = 1;
      return;
    }

    if (existing) {
      console.log(`A Yahoo token already exists at ${tokenPath()}.`);
      const again = await rl.question('Re-authorise from scratch? [y/N] ');
      if (!/^y/i.test(again.trim())) {
        await listLeagues();
        return;
      }
    }

    console.log('\n1. Open this URL and approve access:\n');
    console.log(`   ${consentUrl(creds)}\n`);
    console.log('2. Yahoo will redirect to your registered URI. That page will almost');
    console.log('   certainly fail to load — that is expected and does not matter.');
    console.log('   Copy the value of the `code=` parameter out of the address bar.\n');
    console.log(`   (Registered redirect in use: ${creds.redirectUri})\n`);

    const raw = await rl.question('3. Paste the code here: ');
    const code = extractCode(raw);
    if (!code) {
      console.error('No code found in that input.');
      process.exitCode = 1;
      return;
    }

    await exchangeCode(creds, code);
    console.log(`\nAuthorised. Refresh token saved to ${tokenPath()}.`);
    await listLeagues();
  } finally {
    rl.close();
  }
}

/**
 * Accepts either a bare code or the whole redirected URL.
 *
 * Pasting the entire address bar is the obvious thing to do and it is easier to
 * handle it than to explain why it is wrong.
 */
function extractCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (s.includes('code=')) {
    const m = s.match(/[?&]code=([^&\s]+)/);
    if (m) return decodeURIComponent(m[1]!);
  }
  return s.split(/\s+/)[0] ?? null;
}

async function listLeagues(): Promise<void> {
  const client = new YahooClient();
  const leagues = await discoverLeagues(client);

  if (leagues.length === 0) {
    console.log('\nNo NFL leagues found on this Yahoo account for the current season.');
    return;
  }

  console.log(`\nNFL leagues on this account (${leagues.length}):\n`);
  for (const l of leagues) {
    const bits = [
      `${l.numTeams} teams`,
      l.scoringType ? `scoring: ${l.scoringType}` : null,
      l.draftStatus ? `draft: ${l.draftStatus}` : null,
    ].filter(Boolean);
    console.log(`  ${l.name}  (${l.season})`);
    console.log(`    ${l.leagueKey}  —  ${bits.join(' · ')}`);
  }

  console.log('\nAdd the one you draft in to .env.local:\n');
  console.log(`  YAHOO_LEAGUE_KEY=${leagues[0]!.leagueKey}\n`);
  console.log('Then: npm run ingest:yahoo');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
