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
      <a className="rail-brand" href="/" aria-label="NFLhelper home">
        <span className="rail-mark">N</span>
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
