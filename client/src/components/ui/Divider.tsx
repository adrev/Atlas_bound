import type { CSSProperties } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <Divider>
 *
 * Separators between sections. Three variants:
 *   • `plain` — 1px solid border.default (default, low-key)
 *   • `ornate` — gold gradient with center diamond (DM vibe, use sparingly)
 *   • `spaced` — same as plain but with larger margins
 *
 * Use ornate dividers as visual "chapter breaks" — between major
 * sections on a page, or as headers above primary content. Don't
 * use them on dense screens like the character sheet spell list.
 */

export interface DividerProps {
  variant?: 'plain' | 'ornate' | 'spaced';
  marginY?: number;
  style?: CSSProperties;
}

export function Divider({ variant = 'plain', marginY, style }: DividerProps) {
  if (variant === 'ornate') {
    return (
      <div
        aria-hidden
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 16,
          margin: `${marginY ?? theme.space.lg}px 0`,
          ...style,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            height: 1,
            background: theme.ornate.divider,
            transform: 'translateY(-0.5px)',
          }}
        />
        {/* Small gold diamond in the center */}
        <div
          style={{
            position: 'relative',
            width: 8,
            height: 8,
            background: theme.gold.bright,
            transform: 'rotate(45deg)',
            boxShadow: theme.goldGlow.soft,
          }}
        />
      </div>
    );
  }

  return (
    <hr
      style={{
        border: 'none',
        borderTop: `1px solid ${theme.border.default}`,
        margin: `${marginY ?? (variant === 'spaced' ? theme.space.lg : theme.space.md)}px 0`,
        ...style,
      }}
    />
  );
}
