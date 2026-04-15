import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Shared palette + tiny UI primitives reused across the character
 * sheet (CharacterSheetFull + its extracted tab components).
 *
 * Keeps every tab rendering with the same D&D Beyond-style red/black
 * aesthetic without each tab reaching back into the 2700-line parent.
 */
export const C = {
  bgDeep: theme.bg.deep,
  bgCard: theme.bg.card,
  bgElevated: theme.bg.elevated,
  bgHover: theme.bg.hover,
  red: theme.state.danger,
  redDim: theme.dangerDim,
  redGlow: theme.dangerGlow,
  textPrimary: theme.text.primary,
  textSecondary: theme.text.secondary,
  textMuted: theme.text.muted,
  textDim: theme.text.muted,
  border: theme.border.default,
  borderDim: theme.border.default,
  green: theme.state.success,
  blue: theme.blue,
  purple: theme.purple,
  gold: theme.gold.primary,
} as const;

/**
 * Uppercase red-underlined section header used at the top of each
 * group within the sheet (Organizations, Backstory, etc.).
 */
export function SectionHeader({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '1px',
        color: C.red,
        padding: '8px 0 4px',
        borderBottom: `1px solid ${C.borderDim}`,
        marginBottom: 6,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function stripHtml(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
