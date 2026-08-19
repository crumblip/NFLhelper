'use client';

import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/**
 * Explanations were previously carried on the native `title` attribute, which
 * waits about a second before appearing, cannot be styled, and never shows on a
 * touch device. Every number on this board needs a sentence explaining where it
 * came from, so that delay was the difference between the explanations being
 * read and being invisible.
 */

export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={180} skipDelayDuration={300}>
      {children}
    </Tooltip.Provider>
  );
}

export function Tip({
  children,
  content,
  side = 'top',
}: {
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  if (!content) return <>{children}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6} collisionPadding={12}>
          {content}
          <Tooltip.Arrow className="tip-arrow" width={11} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * A column heading that explains itself.
 *
 * `asChild` on the trigger would fight the sticky `th`, so the trigger is the
 * cell's inner span and the sort click stays on the `th` itself.
 */
export function TipHead({ label, help }: { label: string; help: ReactNode }) {
  return (
    <Tip content={help} side="bottom">
      {/* A bare span is not focusable, so without tabIndex the explanation is
          mouse-only — which would give up the reason for using a real tooltip
          primitive over the native attribute in the first place. */}
      <span
        tabIndex={0}
        style={{ cursor: 'help', borderBottom: '1px dotted currentColor', paddingBottom: 1 }}
      >
        {label}
      </span>
    </Tip>
  );
}
