import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <Badge>
 *
 * Pill-shaped tag used for condition chips, spell levels, loot
 * rarity, player-ribbon indicator, map token counts, etc.
 *
 * ### Variants
 * - `gold`    — default primary accent
 * - `bright`  — brighter gold with glow (player ribbon indicator)
 * - `danger`  — red (critical, damage, combat)
 * - `success` — green (heal, saved, success)
 * - `warning` — orange (warning, half-HP)
 * - `info`    — blue (info, spell slots)
 * - `muted`   — neutral grey (inactive, count badges)
 *
 * ### Usage
 * ```tsx
 * <Badge variant="bright" emoji="🟡">PLAYERS</Badge>
 * <Badge variant="danger">CR 5</Badge>
 * <Badge variant="muted" size="sm">3 tokens</Badge>
 * ```
 */

export type BadgeVariant =
  | 'gold' | 'bright' | 'danger' | 'success' | 'warning' | 'info' | 'muted';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  emoji?: string;
  glow?: boolean;
  children: ReactNode;
  style?: CSSProperties;
  title?: string;
}

const COLOR: Record<BadgeVariant, { fg: string; bg: string; border: string }> = {
  gold:    { fg: theme.gold.primary, bg: theme.gold.bg, border: theme.gold.border },
  bright:  { fg: theme.gold.bright, bg: 'rgba(232, 196, 85, 0.18)', border: 'rgba(232, 196, 85, 0.55)' },
  danger:  { fg: theme.state.danger, bg: theme.state.dangerBg, border: 'rgba(192, 57, 43, 0.4)' },
  success: { fg: theme.state.success, bg: theme.state.successBg, border: 'rgba(39, 174, 96, 0.4)' },
  warning: { fg: theme.state.warning, bg: theme.state.warningBg, border: 'rgba(243, 156, 18, 0.4)' },
  info:    { fg: theme.state.info, bg: theme.state.infoBg, border: 'rgba(52, 152, 219, 0.4)' },
  muted:   { fg: theme.text.muted, bg: theme.bg.elevated, border: theme.border.default },
};

const SIZES: Record<BadgeSize, { padding: string; font: number }> = {
  sm: { padding: '1px 6px', font: 9 },
  md: { padding: '2px 8px', font: 10 },
};

export function Badge({
  variant = 'gold',
  size = 'md',
  emoji,
  glow = false,
  children,
  style,
  title,
}: BadgeProps) {
  const c = COLOR[variant];
  const s = SIZES[size];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: s.padding,
        fontSize: s.font,
        fontWeight: 700,
        fontFamily: theme.font.body,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.04em',
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 20,
        whiteSpace: 'nowrap',
        boxShadow: glow ? theme.goldGlow.soft : undefined,
        ...style,
      }}
    >
      {emoji && <span style={{ fontSize: s.font + 1 }}>{emoji}</span>}
      {children}
    </span>
  );
}
