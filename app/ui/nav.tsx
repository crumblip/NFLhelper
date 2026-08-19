'use client';

import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Draft board' },
  { href: '/waiver', label: 'Waiver wire' },
  { href: '/legend', label: 'Legend' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <a
          key={l.href}
          href={l.href}
          data-active={l.href === '/' ? path === '/' : path.startsWith(l.href)}
        >
          {l.label}
        </a>
      ))}
    </nav>
  );
}
