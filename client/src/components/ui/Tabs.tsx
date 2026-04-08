import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <Tabs>
 *
 * The unified rune-slab / book-chapter style tab bar. Any tabbed UI
 * in the app — main sidebar, character sheet tabs, compendium
 * filters, etc. — routes through this one primitive so the look
 * stays consistent.
 *
 * ### Visual language
 * - Each tab is a "rune slab" tile with a subtle parchment gradient
 * - Thin gold carved separators between tiles
 * - Active tab has a warm gold glow + bottom "chapter ribbon" border
 * - Rounded top corners evoke a book-chapter tab
 *
 * ### Usage
 * ```tsx
 * <Tabs
 *   activeId={activeTab}
 *   onChange={setActiveTab}
 *   items={[
 *     { id: 'combat', label: 'Combat', icon: <Swords size={16} /> },
 *     { id: 'hero',   label: 'Hero',   icon: <BookOpen size={16} /> },
 *     { id: 'wiki',   label: 'Wiki',   icon: <Library size={16} /> },
 *   ]}
 * />
 * ```
 *
 * ### Variants
 * - `default` — main sidebar style (full-width cells, labels under icons)
 * - `pills`   — inline pill row (content-width, horizontal icon+label)
 * - `compact` — smaller vertical rhythm, for dense sub-tabs inside modals
 */

export type TabsVariant = 'default' | 'pills' | 'compact';

export interface TabItem<Id extends string = string> {
  id: Id;
  label: string;
  icon?: ReactNode;
  /** Optional emoji accent shown before the label. */
  emoji?: string;
  disabled?: boolean;
  /** Hidden from render (e.g. DM-only tabs for non-DM users). */
  hidden?: boolean;
}

export interface TabsProps<Id extends string = string> {
  items: TabItem<Id>[];
  activeId: Id;
  onChange: (id: Id) => void;
  variant?: TabsVariant;
  /** Extra styles for the container. */
  style?: CSSProperties;
}

export function Tabs<Id extends string = string>({
  items,
  activeId,
  onChange,
  variant = 'default',
  style,
}: TabsProps<Id>) {
  const visible = items.filter((t) => !t.hidden);

  const styles = getStyles(variant);

  return (
    <div style={{ ...styles.bar, ...style }}>
      {visible.map((tab, idx) => {
        const isActive = tab.id === activeId;
        return (
          <div
            key={tab.id}
            style={{
              display: 'flex',
              alignItems: 'stretch',
              flex: variant === 'default' ? 1 : 'none',
              minWidth: 0,
            }}
          >
            <button
              type="button"
              disabled={tab.disabled}
              title={tab.label}
              onClick={() => !tab.disabled && onChange(tab.id)}
              style={{
                ...styles.tab,
                ...(isActive ? styles.tabActive : {}),
                ...(tab.disabled ? styles.tabDisabled : {}),
              }}
            >
              {tab.icon}
              <span style={styles.label}>
                {tab.emoji && <span style={{ marginRight: 3 }}>{tab.emoji}</span>}
                {tab.label}
              </span>
            </button>
            {idx < visible.length - 1 && (
              <div aria-hidden style={styles.separator} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Variant-specific style tables ────────────────────────────
function getStyles(variant: TabsVariant): {
  bar: CSSProperties;
  tab: CSSProperties;
  tabActive: CSSProperties;
  tabDisabled: CSSProperties;
  label: CSSProperties;
  separator: CSSProperties;
} {
  switch (variant) {
    case 'default':
      return {
        bar: {
          display: 'flex',
          alignItems: 'stretch',
          // Layered background for the rune-slab parchment look: warm
          // stone edge at the top with a cooler base below.
          background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 2px, ${theme.bg.base} 100%)`,
          borderBottom: `1px solid ${theme.gold.border}`,
          boxShadow: `inset 0 -1px 0 ${theme.border.default}`,
          flexShrink: 0,
          overflow: 'hidden',
          padding: `4px 4px 0`,
        },
        tab: {
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          padding: `${theme.space.md}px ${theme.space.xs}px`,
          background: 'transparent',
          border: 'none',
          borderRadius: `${theme.radius.sm}px ${theme.radius.sm}px 0 0`,
          color: theme.text.muted,
          cursor: 'pointer',
          transition: `all ${theme.motion.normal}`,
          whiteSpace: 'nowrap',
          minWidth: 0,
          position: 'relative',
          outline: 'none',
        },
        tabActive: {
          color: theme.gold.primary,
          background: `linear-gradient(180deg, rgba(232, 196, 85, 0.08), ${theme.gold.bg})`,
          boxShadow: `inset 0 -2px 0 ${theme.gold.primary}, inset 0 1px 0 rgba(232, 196, 85, 0.3)`,
          transform: 'translateY(-1px)',
        },
        tabDisabled: {
          opacity: 0.4,
          cursor: 'not-allowed',
        },
        label: {
          fontSize: 9,
          fontWeight: 700,
          fontFamily: theme.font.body,
          textTransform: 'uppercase',
          letterSpacing: '0.3px',
          whiteSpace: 'nowrap',
        },
        separator: {
          width: 2,
          alignSelf: 'stretch',
          background: `
            linear-gradient(90deg,
              rgba(0,0,0,0.35) 0%,
              rgba(0,0,0,0.35) 50%,
              rgba(232, 196, 85, 0.5) 50%,
              rgba(232, 196, 85, 0.5) 100%
            )
          `,
          margin: `${theme.space.sm}px 0`,
          flexShrink: 0,
        },
      };

    case 'pills':
      return {
        bar: {
          display: 'flex',
          alignItems: 'stretch',
          gap: 0,
          padding: `${theme.space.xs}px`,
          background: theme.bg.deep,
          border: `1px solid ${theme.border.default}`,
          borderRadius: theme.radius.md,
          overflow: 'hidden',
        },
        tab: {
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space.sm,
          padding: `${theme.space.sm}px ${theme.space.lg}px`,
          background: 'transparent',
          border: 'none',
          borderRadius: theme.radius.sm,
          color: theme.text.muted,
          cursor: 'pointer',
          transition: `all ${theme.motion.normal}`,
          whiteSpace: 'nowrap',
          outline: 'none',
        },
        tabActive: {
          color: theme.gold.primary,
          background: theme.gold.bg,
          boxShadow: `inset 0 0 0 1px ${theme.gold.border}`,
        },
        tabDisabled: {
          opacity: 0.4,
          cursor: 'not-allowed',
        },
        label: {
          fontSize: 11,
          fontWeight: 700,
          fontFamily: theme.font.body,
          textTransform: 'uppercase',
          letterSpacing: '0.4px',
          whiteSpace: 'nowrap',
        },
        separator: {
          width: 1,
          alignSelf: 'stretch',
          background: `linear-gradient(180deg, transparent, ${theme.border.default} 30%, ${theme.border.default} 70%, transparent)`,
          margin: `${theme.space.xs}px 0`,
          flexShrink: 0,
        },
      };

    case 'compact':
      return {
        bar: {
          display: 'flex',
          alignItems: 'stretch',
          background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 2px, ${theme.bg.card} 100%)`,
          borderBottom: `1px solid ${theme.gold.border}`,
          boxShadow: `inset 0 -1px 0 ${theme.border.default}`,
          flexShrink: 0,
          overflow: 'hidden',
          padding: `2px 2px 0`,
        },
        tab: {
          flex: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          padding: `${theme.space.sm}px ${theme.space.xs}px`,
          background: 'transparent',
          border: 'none',
          borderRadius: `${theme.radius.sm}px ${theme.radius.sm}px 0 0`,
          color: theme.text.muted,
          cursor: 'pointer',
          transition: `all ${theme.motion.normal}`,
          whiteSpace: 'nowrap',
          minWidth: 0,
          outline: 'none',
        },
        tabActive: {
          color: theme.gold.primary,
          background: `linear-gradient(180deg, rgba(232, 196, 85, 0.08), ${theme.gold.bg})`,
          boxShadow: `inset 0 -2px 0 ${theme.gold.primary}`,
        },
        tabDisabled: {
          opacity: 0.4,
          cursor: 'not-allowed',
        },
        label: {
          fontSize: 10,
          fontWeight: 700,
          fontFamily: theme.font.body,
          textTransform: 'uppercase',
          letterSpacing: '0.3px',
          whiteSpace: 'nowrap',
        },
        separator: {
          width: 1,
          alignSelf: 'stretch',
          background: `
            linear-gradient(90deg,
              rgba(0,0,0,0.3) 0%,
              rgba(0,0,0,0.3) 50%,
              rgba(232, 196, 85, 0.4) 50%,
              rgba(232, 196, 85, 0.4) 100%
            )
          `,
          margin: `${theme.space.xs}px 0`,
          flexShrink: 0,
        },
      };
  }
}
