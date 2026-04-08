import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <IconButton>
 *
 * Square button for icon-only actions: close buttons, context menu
 * triggers, drawing tool buttons, etc. Takes EITHER a lucide icon OR
 * an emoji character (never both) per the emoji style guide.
 *
 * ### Usage
 * ```tsx
 * <IconButton icon={<X size={16} />} onClick={onClose} />
 * <IconButton emoji="🗑️" onClick={onDelete} variant="danger" />
 * <IconButton icon={<Dice6 size={14} />} size="sm" />
 * ```
 */

export type IconButtonSize = 'sm' | 'md' | 'lg';
export type IconButtonVariant = 'default' | 'gold' | 'danger' | 'ghost';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  icon?: ReactNode;
  emoji?: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  active?: boolean;
  tooltipTitle?: string;
  style?: CSSProperties;
}

const DIMENSION: Record<IconButtonSize, number> = {
  sm: 24,
  md: 30,
  lg: 36,
};

const EMOJI_SIZE: Record<IconButtonSize, number> = {
  sm: 12,
  md: 14,
  lg: 18,
};

function variantStyle(variant: IconButtonVariant, active: boolean): CSSProperties {
  const base: CSSProperties = {
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    color: theme.text.secondary,
  };
  if (variant === 'gold' || active) {
    return {
      background: theme.gold.bg,
      border: `1px solid ${theme.gold.border}`,
      color: theme.gold.primary,
    };
  }
  if (variant === 'danger') {
    return {
      background: theme.state.dangerBg,
      border: `1px solid rgba(192, 57, 43, 0.4)`,
      color: theme.state.danger,
    };
  }
  if (variant === 'ghost') {
    return {
      background: 'transparent',
      border: `1px solid transparent`,
      color: theme.text.secondary,
    };
  }
  return base;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    emoji,
    size = 'md',
    variant = 'default',
    active = false,
    disabled,
    tooltipTitle,
    style,
    onMouseEnter,
    onMouseLeave,
    ...rest
  },
  ref,
) {
  const dim = DIMENSION[size];
  const v = variantStyle(variant, active);

  return (
    <button
      ref={ref}
      title={tooltipTitle}
      disabled={disabled}
      {...rest}
      style={{
        ...v,
        width: dim,
        height: dim,
        borderRadius: theme.radius.sm,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        padding: 0,
        fontSize: EMOJI_SIZE[size],
        lineHeight: 1,
        fontFamily: theme.font.body,
        transition: `all ${theme.motion.fast}`,
        outline: 'none',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.background =
            variant === 'danger'
              ? 'rgba(192, 57, 43, 0.28)'
              : variant === 'gold' || active
                ? 'rgba(212, 168, 67, 0.22)'
                : theme.bg.hover;
        }
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = v.background as string;
        onMouseLeave?.(e);
      }}
    >
      {icon ?? emoji}
    </button>
  );
});
