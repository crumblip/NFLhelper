'use client';

import { useEffect, useState } from 'react';

/**
 * Light / dark, chosen explicitly and remembered.
 *
 * Three states matter, not two: "light", "dark", and "whatever the machine
 * says". The last is the default and is deliberately not a third button —
 * the toggle flips between the two visible outcomes, and clearing the choice
 * is not a thing anyone wants a control for. Written to `data-theme` on the
 * root element, which is what the stylesheet keys off.
 *
 * The initial value is applied by an inline script in the layout, BEFORE this
 * component ever mounts, because a theme decided in React lands one paint too
 * late and the reader sees a white flash on every load.
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const explicit = root.getAttribute('data-theme');
    setDark(
      explicit
        ? explicit === 'dark'
        : window.matchMedia('(prefers-color-scheme: dark)').matches,
    );
  }, []);

  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
    try {
      localStorage.setItem('nflhelper-theme', next ? 'dark' : 'light');
    } catch {
      /* private mode — the choice just does not persist */
    }
  };

  return (
    <button
      className="icon-btn"
      onClick={flip}
      // `aria-label` is the accessible name and is enough on its own. The
      // `title` that used to sit beside it said the same thing a second later,
      // unstyleable and invisible on touch — the attribute this project bans.
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      // Nothing is rendered until the client knows which icon is correct, so
      // the button cannot flash the wrong one.
      suppressHydrationWarning
    >
      {dark === null ? (
        <span style={{ width: 18, height: 18, display: 'block' }} />
      ) : dark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2v2.6M12 19.4V22M4.2 4.2l1.9 1.9M17.9 17.9l1.9 1.9M2 12h2.6M19.4 12H22M4.2 19.8l1.9-1.9M17.9 6.1l1.9-1.9" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a7 7 0 0 0 11.1 11.1Z" />
        </svg>
      )}
    </button>
  );
}
