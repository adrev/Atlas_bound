import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <Button>
 *
 * The single source of truth for all clickable actions in the app.
 * Replaces the 8+ divergent inline button styles that existed before
 * the unification pass.
 *
 * ### Variants
 * - `primary` — gold gradient + glow, used for main CTAs ("Move Players Here", "Save", "Confirm")
 * - `danger`  — red with danger glow, used for destructive or combat CTAs ("End Combat", "Delete", "Attack")
 * - `ghost`   — transparent border, used for secondary actions ("Cancel", "Back")
 * - `text`    — no border, used for inline links ("Learn more")
 * - `icon`    — square, icon-only (see `IconButton` for a dedicated wrapper)
 *
 * ### Sizes
 * - `sm` — compact, fits in dense lists and tooltips
 * - `md` — default, used in most forms and section actions
 * - `lg` — prominent, used for hero CTAs
 *
 * ### Usage
 * ```tsx
 * <Button variant="primary" onClick={handleSave}>Save</Button>
 * <Button variant="ghost" leadingIcon={<X size={14} />}>Cancel</Button>
 * <Button variant="danger" size="lg" loading={isDeleting}>End Combat</Button>
 * ```
 */

export type ButtonVariant = 'primary' | 'danger' | 'ghost' | 'text' | 'icon';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
  /** Allow caller style overrides; merged on top of the variant base. */
  style?: CSSProperties;
}

const SIZE_PADDING: Record<ButtonSize, string> = {
  sm: `${theme.space.xs}px ${theme.space.md}px`,
  md: `${theme.space.md}px ${theme.space.lg + 2}px`,
  lg: `${theme.space.lg}px ${theme.space.xl + 4}px`,
};

const SIZE_FONT: Record<ButtonSize, number> = {
  sm: 11,
  md: 13,
  lg: 14,
};

function variantStyle(variant: ButtonVariant, disabled: boolean): CSSProperties {
  // Common baseline — every variant inherits this.
  const base: CSSProperties = {
    borderRadius: theme.radius.sm,
    fontFamily: theme.font.body,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: `all ${theme.motion.normal}`,
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.sm,
    lineHeight: 1.2,
    outline: 'none',
  };

  switch (variant) {
    case 'primary':
      return {
        ...base,
        color: '#0a0a12',
        background: `linear-gradient(135deg, ${theme.gold.dim}, ${theme.gold.primary})`,
        border: `1px solid ${theme.gold.border}`,
        boxShadow: disabled ? 'none' : theme.goldGlow.soft,
      };
    case 'danger':
      return {
        ...base,
        color: '#fff',
        background: `linear-gradient(135deg, ${theme.dangerDim}, ${theme.danger})`,
        border: `1px solid ${theme.danger}`,
        boxShadow: disabled ? 'none' : theme.dangerGlow,
      };
    case 'ghost':
      return {
        ...base,
        color: theme.text.secondary,
        background: 'transparent',
        border: `1px solid ${theme.border.default}`,
      };
    case 'text':
      return {
        ...base,
        color: theme.gold.primary,
        background: 'transparent',
        border: 'none',
        padding: 0,
      };
    case 'icon':
      return {
        ...base,
        color: theme.text.secondary,
        background: theme.bg.elevated,
        border: `1px solid ${theme.border.default}`,
      };
  }
}

/** Simple inline spinner (no external dep). */
function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `2px solid currentColor`,
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'atlas-spin 0.7s linear infinite',
      }}
    />
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    leadingIcon,
    trailingIcon,
    loading = false,
    fullWidth = false,
    disabled,
    children,
    style: styleOverride,
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  const variantCss = variantStyle(variant, isDisabled);

  const merged: CSSProperties = {
    ...variantCss,
    padding: variant === 'text' ? 0 : SIZE_PADDING[size],
    fontSize: SIZE_FONT[size],
    width: fullWidth ? '100%' : undefined,
    opacity: isDisabled ? 0.45 : 1,
    ...styleOverride,
  };

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      {...rest}
      style={merged}
      onMouseEnter={(e) => {
        if (!isDisabled) {
          const el = e.currentTarget;
          if (variant === 'primary') el.style.boxShadow = theme.goldGlow.medium;
          else if (variant === 'danger') el.style.boxShadow = `0 0 18px rgba(192, 57, 43, 0.6)`;
          else if (variant === 'ghost' || variant === 'icon') el.style.background = theme.bg.hover;
          else if (variant === 'text') el.style.color = theme.gold.bright;
        }
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        if (variant === 'primary') el.style.boxShadow = isDisabled ? 'none' : theme.goldGlow.soft;
        else if (variant === 'danger') el.style.boxShadow = isDisabled ? 'none' : theme.dangerGlow;
        else if (variant === 'ghost') el.style.background = 'transparent';
        else if (variant === 'icon') el.style.background = theme.bg.elevated;
        else if (variant === 'text') el.style.color = theme.gold.primary;
        onMouseLeave?.(e);
      }}
      onFocus={(e) => {
        if (!isDisabled) {
          e.currentTarget.style.boxShadow = `${theme.focus.ring}, ${
            variant === 'primary' ? theme.goldGlow.soft :
            variant === 'danger' ? theme.dangerGlow : 'none'
          }`;
        }
        onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow =
          variant === 'primary' && !isDisabled ? theme.goldGlow.soft :
          variant === 'danger' && !isDisabled ? theme.dangerGlow : 'none';
        onBlur?.(e);
      }}
    >
      {loading ? <Spinner size={SIZE_FONT[size]} /> : leadingIcon}
      {children}
      {!loading && trailingIcon}
    </button>
  );
});

// Inject the spinner keyframes once on module load. Safe to call
// multiple times — the check prevents duplicate insertion.
if (typeof document !== 'undefined' && !document.getElementById('atlas-button-keyframes')) {
  const style = document.createElement('style');
  style.id = 'atlas-button-keyframes';
  style.textContent = '@keyframes atlas-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}
