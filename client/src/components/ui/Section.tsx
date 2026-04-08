import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <Section>
 *
 * The "h3 + body" container that's repeated across every sidebar tab.
 * Before the unification pass, each tab (DMToolbar, CharacterSheet, etc.)
 * defined its own inline Section function. This primitive consolidates
 * them into one shared component.
 *
 * ### Usage
 * ```tsx
 * <Section title="Scenes" action={<Button size="sm">+ Add Map</Button>}>
 *   <SceneCard ... />
 *   <SceneCard ... />
 * </Section>
 * ```
 *
 * ### Props
 * - `title`   — section label (uppercase, gold-dim, letter-spaced)
 * - `emoji`   — optional emoji accent prepended to the title
 * - `action`  — optional right-aligned slot (usually a small button)
 * - `divider` — `'none' | 'plain' | 'ornate'` — whether to render a
 *    divider BELOW this section's content
 * - `spacing` — `'compact' | 'normal' | 'relaxed'` — controls body gap
 */

export interface SectionProps {
  title?: string;
  emoji?: string;
  action?: ReactNode;
  children: ReactNode;
  divider?: 'none' | 'plain' | 'ornate';
  spacing?: 'compact' | 'normal' | 'relaxed';
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}

const GAP: Record<NonNullable<SectionProps['spacing']>, number> = {
  compact: theme.space.sm,
  normal: theme.space.md,
  relaxed: theme.space.lg,
};

export function Section({
  title,
  emoji,
  action,
  children,
  divider = 'none',
  spacing = 'normal',
  style,
  bodyStyle,
}: SectionProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space.md,
        paddingBottom: divider !== 'none' ? theme.space.lg : 0,
        marginBottom: divider !== 'none' ? theme.space.lg : 0,
        ...(divider === 'plain'
          ? { borderBottom: `1px solid ${theme.border.default}` }
          : {}),
        ...style,
      }}
    >
      {(title || action) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space.md,
          }}
        >
          {title && (
            <span
              style={{
                ...theme.type.h3,
                color: theme.gold.dim,
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space.sm,
              }}
            >
              {emoji && <span style={{ fontSize: 13 }}>{emoji}</span>}
              {title}
            </span>
          )}
          {action && <div>{action}</div>}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: GAP[spacing],
          ...bodyStyle,
        }}
      >
        {children}
      </div>

      {divider === 'ornate' && (
        <div
          aria-hidden
          style={{
            height: 1,
            marginTop: theme.space.md,
            background: theme.ornate.divider,
          }}
        />
      )}
    </div>
  );
}
