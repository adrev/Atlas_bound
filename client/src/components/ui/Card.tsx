import { forwardRef } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <Card>
 *
 * Generic container with optional left-edge "accent bar" — used by the
 * Scene Manager to render the yellow ribbon (player map) and the gold
 * DM-viewing highlight. Reused across CreatureLibrary, loot cards,
 * combatant rows, etc.
 *
 * ### Variants
 * - `default` — normal card (`bg.card` background)
 * - `elevated` — slightly lifted (`bg.elevated` background)
 * - `parchment` — warm-toned DM vibe (`theme.parchment`)
 *
 * ### AccentBar
 * Left-edge colored bar (3px wide) that runs the full height of the
 * card. Used to indicate state: 'gold' for DM-viewing, 'bright-gold'
 * for player-ribbon, 'danger' for combat-active, 'info' for informational.
 *
 * ### Usage
 * ```tsx
 * <Card accentBar="bright-gold" onClick={handleSelect} interactive>
 *   <Thumbnail src={map.imageUrl} />
 *   <CardBody>...</CardBody>
 * </Card>
 * ```
 */

export type CardVariant = 'default' | 'elevated' | 'parchment';
export type CardAccent = 'none' | 'gold' | 'bright-gold' | 'danger' | 'info' | 'success';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
  variant?: CardVariant;
  accentBar?: CardAccent;
  /** Whether the card is clickable (adds hover lift + cursor). */
  interactive?: boolean;
  /** Highlight border (e.g. for "currently selected" state). */
  highlighted?: boolean;
  /** Add a gold glow box-shadow when highlighted (used for ribbon cards). */
  glow?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: ReactNode;
  style?: CSSProperties;
}

const BG: Record<CardVariant, string> = {
  default: theme.bg.card,
  elevated: theme.bg.elevated,
  parchment: theme.parchment,
};

const EDGE: Record<CardVariant, string> = {
  default: theme.border.default,
  elevated: theme.border.light,
  parchment: theme.parchmentEdge,
};

const ACCENT: Record<CardAccent, string> = {
  none: 'transparent',
  gold: theme.gold.primary,
  'bright-gold': theme.gold.bright,
  danger: theme.danger,
  info: theme.blue,
  success: theme.state.success,
};

const PADDING: Record<NonNullable<CardProps['padding']>, number> = {
  none: 0,
  sm: theme.space.sm,
  md: theme.space.md,
  lg: theme.space.lg,
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    variant = 'default',
    accentBar = 'none',
    interactive = false,
    highlighted = false,
    glow = false,
    padding = 'md',
    children,
    style,
    onMouseEnter,
    onMouseLeave,
    ...rest
  },
  ref,
) {
  const borderColor = highlighted ? theme.gold.border : EDGE[variant];
  const accentColor = ACCENT[accentBar];

  const baseStyle: CSSProperties = {
    position: 'relative',
    background: BG[variant],
    border: `1px solid ${borderColor}`,
    borderRadius: theme.radius.md,
    padding: PADDING[padding],
    paddingLeft: accentBar !== 'none' ? PADDING[padding] + 4 : PADDING[padding],
    overflow: 'hidden',
    cursor: interactive ? 'pointer' : 'default',
    transition: `all ${theme.motion.normal}`,
    boxShadow: highlighted && glow
      ? theme.goldGlow.soft
      : highlighted
        ? `0 0 0 1px ${theme.gold.border}`
        : 'none',
    ...style,
  };

  return (
    <div
      ref={ref}
      {...rest}
      style={baseStyle}
      onMouseEnter={(e) => {
        if (interactive) {
          e.currentTarget.style.background = theme.bg.hover;
        }
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (interactive) {
          e.currentTarget.style.background = BG[variant];
        }
        onMouseLeave?.(e);
      }}
    >
      {accentBar !== 'none' && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: accentColor,
          }}
        />
      )}
      {children}
    </div>
  );
});
