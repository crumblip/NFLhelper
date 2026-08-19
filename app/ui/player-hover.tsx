'use client';


import * as HoverCard from '@radix-ui/react-hover-card';
import type { ReactNode } from 'react';
import { teamOf, teamStyle, positionColor } from '../../lib/teams';

export interface HoverFacts {
  name: string;
  position: string;
  team: string | null;
  adp: number | null;
  bye: number | null;
  rows: Array<{ label: string; value: string; tone?: 'pos' | 'neg' }>;
  /** The explanation the card face deliberately does not carry. */
  note?: string | null;
  /** Durability or regression warnings, shown apart from the opportunity note. */
  warn?: string | null;
}

/**
 * A preview on the player's name, so comparing two players does not cost two
 * page loads and a back button. Opens on hover and on keyboard focus.
 */
export default function PlayerHover({
  children,
  facts,
}: {
  children: ReactNode;
  facts: HoverFacts;
}) {
  const team = teamOf(facts.team);

  return (
    <HoverCard.Root openDelay={220} closeDelay={110}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="hovercard"
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={14}
          style={{ ...teamStyle(facts.team), ['--pos-color' as string]: positionColor(facts.position) }}
        >
          <div className="hovercard-head">
            <div className="hovercard-name">{facts.name}</div>
            <div className="hovercard-meta">
              {facts.position} · {team.nick}
              {facts.bye ? ` · bye ${facts.bye}` : ''}
              {facts.adp !== null ? ` · ADP ${facts.adp.toFixed(1)}` : ' · undrafted'}
            </div>
          </div>
          <div className="hovercard-body">
            <dl style={{ margin: 0 }}>
              {facts.rows.map((r) => (
                <div className="hovercard-row" key={r.label}>
                  <dt>{r.label}</dt>
                  <dd style={r.tone ? { color: `var(--${r.tone === 'pos' ? 'value' : 'reach'})` } : undefined}>
                    {r.value}
                  </dd>
                </div>
              ))}
            </dl>
            {facts.note && (
              <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--value)' }}>
                {facts.note}
              </p>
            )}
            {facts.warn && (
              <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--warn)' }}>
                {facts.warn}
              </p>
            )}
            <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--faint)' }}>
              Click for the full breakdown
            </p>
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
