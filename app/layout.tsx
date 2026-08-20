import type { ReactNode } from 'react';
import './globals.css';
import { getSearchIndex } from '../lib/search';
import { TipProvider } from './ui/tip';
import GlobalSearch from './ui/global-search';
import Rail from './ui/rail';
import ThemeToggle from './ui/theme-toggle';

export const metadata = {
  title: 'ChipShip · fantasy football analytics',
  icons: { icon: '/icon.png', apple: '/icon.png' },
  description: 'Sportsbook props and on-field usage against ADP',
};

const FORMAT = process.env.SCORING_FORMAT ?? 'half-ppr';
const TEAMS = Number(process.env.LEAGUE_TEAMS ?? 12);
const SEASON = Number(process.env.SEASON ?? 2026);

/*
 * The saved theme is applied before first paint.
 *
 * A theme decided inside React lands a paint too late, so every load flashes
 * white before going dark. This runs synchronously in <head>, reads the stored
 * choice and stamps the root element; the stylesheet keys off `data-theme` and
 * falls back to the OS preference when nothing is stored. Kept deliberately
 * tiny and wrapped in try/catch, because it blocks rendering.
 */
const NO_FLASH = `
try {
  var t = localStorage.getItem('chipship-theme') || localStorage.getItem('nflhelper-theme');
  if (t === 'dark' || t === 'light') {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('chipship-theme', t);
  }
} catch (e) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  // Built once per data change and cached, so this costs nothing per navigation.
  const index = getSearchIndex(FORMAT, TEAMS, SEASON);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>
        <TipProvider>
          <div className="shell">
            <Rail />
            <div className="shell-main">
              <header className="topbar">
                <div className="topbar-inner">
                  {/*
                    The name is set in TYPE here rather than as part of the rail
                    mark. A 42px rail slot cannot carry a wordmark legibly, and
                    the topbar has the width for it, so the two halves of the
                    lockup are split across the two places each one fits.
                  */}
                  <a className="brandmark" href="/">
                    <b>CHIP</b>SHIP
                  </a>
                  <GlobalSearch index={index} />
                  <span className="spacer" />
                  <ThemeToggle />
                </div>
              </header>
              <div className="shell-content">{children}</div>
            </div>
          </div>
        </TipProvider>
      </body>
    </html>
  );
}
