'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The icon rail.
 *
 * A permanent, always-dark column of destinations. It is dark in both themes on
 * purpose: it is chrome rather than content, and holding it fixed gives the eye
 * a stable left edge to return to while the content beside it inverts.
 *
 * Labels sit under the icons rather than in a tooltip. This is a tool used in a
 * hurry during a live draft, and a destination you have to hover to identify is
 * a destination you will misclick.
 */
const ITEMS: Array<{ href: string; label: string; icon: ReactNode }> = [
  {
    href: '/',
    label: 'Board',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
      </svg>
    ),
  },
  {
    href: '/waiver',
    label: 'Wire',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17.5 9 11l4 4 8-8.5" />
        <path d="M21 6.5h-5.2M21 6.5v5.2" />
      </svg>
    ),
  },
  {
    href: '/compare',
    label: 'Compare',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v18" />
        <path d="M6 8 3 14h6zM18 8l-3 6h6z" />
        <path d="M3 14a3 3 0 0 0 6 0M15 14a3 3 0 0 0 6 0" />
        <path d="M7 6h10" />
      </svg>
    ),
  },
  {
    href: '/news',
    label: 'News',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 4H5.5A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5V8" />
        <path d="M17 4v4h4" />
        <path d="M7 10h7M7 13.5h7M7 17h4" />
      </svg>
    ),
  },
  {
    href: '/injuries',
    label: 'Injuries',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" />
      </svg>
    ),
  },
  {
    href: '/league',
    label: 'League',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20" />
        <circle cx="9.5" cy="7.5" r="3.4" />
        <path d="M21 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.6 4.3a3.4 3.4 0 0 1 0 6.4" />
      </svg>
    ),
  },
  {
    href: '/legend',
    label: 'Legend',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16.5v-4.8M12 8.2h.01" />
      </svg>
    ),
  },
];

export default function Rail() {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  return (
    <aside className="rail">
      <a className="rail-brand" href="/" aria-label="ChipShip home">
        {/*
          The mark is an <img> stacked OVER a monogram, not one or the other.
          `onError` hides the image and leaves the letters showing, so the rail
          is never a broken-image glyph while the logo is being generated. Same
          fallback the player card uses for a missing portrait (#106).

          No wordmark here on purpose. The slot is 42px across, and a lockup
          whose text is already small at 1024px wide renders as grey mush at
          that size. Shrinking a good mark until it smudges is not using it, so
          the name is set in type in the topbar where type belongs.
        */}
        <span className="rail-mark">
          <b aria-hidden>CS</b>
          <img
            src="/chipship-mark.png"
            alt=""
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        </span>
      </a>
      <nav className="rail-nav">
        {ITEMS.map((i) => (
          <a key={i.href} href={i.href} className="rail-item" data-active={active(i.href)}>
            <span className="rail-icon">{i.icon}</span>
            <span className="rail-label">{i.label}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
}
