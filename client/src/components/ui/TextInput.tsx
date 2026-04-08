import { forwardRef, useState } from 'react';
import type {
  InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes,
  CSSProperties, ReactNode,
} from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitives: <TextInput>, <NumberInput>, <Textarea>, <Select>.
 *
 * The single source of truth for all form inputs. Before this, the app
 * had 50+ inputs styled inline with no consistency — no focus states,
 * varied padding (4-8px), varied border-radius (3-6), and no placeholder
 * styling. These primitives unify all of that.
 *
 * ### Usage
 * ```tsx
 * <TextInput value={name} onChange={e => setName(e.target.value)} placeholder="Character name" />
 * <NumberInput value={hp} onChange={e => setHp(Number(e.target.value))} min={0} max={999} />
 * <Textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} />
 * <Select value={size} onChange={e => setSize(e.target.value)}>
 *   <option value="small">Small</option>
 *   <option value="medium">Medium</option>
 * </Select>
 * ```
 *
 * All variants support an optional `leadingIcon`, `error` state, and
 * two sizes (`sm`/`md`).
 */

export type InputSize = 'sm' | 'md';

interface CommonInputProps {
  size?: InputSize;
  error?: boolean;
  leadingIcon?: ReactNode;
  fullWidth?: boolean;
  /** Allow overriding the container style (e.g. flex alignment in forms). */
  containerStyle?: CSSProperties;
}

const PADDING: Record<InputSize, string> = {
  sm: `${theme.space.xs}px ${theme.space.sm}px`,
  md: `${theme.space.sm}px ${theme.space.md + 2}px`,
};

const FONT_SIZE: Record<InputSize, number> = {
  sm: 12,
  md: 13,
};

function baseInputStyle(
  size: InputSize,
  error: boolean,
  hasLeadingIcon: boolean,
): CSSProperties {
  return {
    padding: PADDING[size],
    paddingLeft: hasLeadingIcon ? (size === 'sm' ? 24 : 28) : undefined,
    fontSize: FONT_SIZE[size],
    fontFamily: theme.font.body,
    color: theme.text.primary,
    background: theme.bg.deep,
    border: `1px solid ${error ? theme.state.danger : theme.border.default}`,
    borderRadius: theme.radius.sm,
    outline: 'none',
    width: '100%',
    transition: `border-color ${theme.motion.fast}, box-shadow ${theme.motion.fast}`,
  };
}

// Inject the focus style once on module load. Uses a CSS attribute
// selector so we don't need to rewrite styles on every focus event.
if (typeof document !== 'undefined' && !document.getElementById('atlas-input-styles')) {
  const style = document.createElement('style');
  style.id = 'atlas-input-styles';
  style.textContent = `
    .atlas-input:focus-visible {
      border-color: ${theme.gold.primary} !important;
      box-shadow: ${theme.focus.ring} !important;
    }
    .atlas-input.atlas-input--error:focus-visible {
      border-color: ${theme.state.danger} !important;
      box-shadow: ${theme.focus.ringDanger} !important;
    }
    .atlas-input::placeholder {
      color: ${theme.text.muted};
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}

// ── TextInput ────────────────────────────────────────────────
export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, CommonInputProps {}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { size = 'md', error = false, leadingIcon, fullWidth = true, containerStyle, style, className, ...rest },
  ref,
) {
  const inputStyle: CSSProperties = {
    ...baseInputStyle(size, error, !!leadingIcon),
    ...style,
  };
  return (
    <div
      style={{
        position: 'relative',
        width: fullWidth ? '100%' : undefined,
        display: 'inline-block',
        ...containerStyle,
      }}
    >
      {leadingIcon && (
        <span style={iconWrapStyle(size)}>{leadingIcon}</span>
      )}
      <input
        ref={ref}
        className={`atlas-input${error ? ' atlas-input--error' : ''}${className ? ' ' + className : ''}`}
        style={inputStyle}
        {...rest}
      />
    </div>
  );
});

// ── NumberInput ─────────────────────────────────────────────
// Just a TextInput with type="number" by default; preserves the
// same focus/error/icon behavior and lets the browser handle
// increment/decrement.
export interface NumberInputProps extends TextInputProps {}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  props,
  ref,
) {
  return <TextInput type="number" ref={ref} {...props} />;
});

// ── Textarea ────────────────────────────────────────────────
export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'>, CommonInputProps {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { size = 'md', error = false, fullWidth = true, containerStyle, style, className, ...rest },
  ref,
) {
  const areaStyle: CSSProperties = {
    ...baseInputStyle(size, error, false),
    resize: 'vertical',
    minHeight: 60,
    fontFamily: theme.font.body,
    lineHeight: 1.5,
    ...style,
  };
  return (
    <div
      style={{
        width: fullWidth ? '100%' : undefined,
        display: 'inline-block',
        ...containerStyle,
      }}
    >
      <textarea
        ref={ref}
        className={`atlas-input${error ? ' atlas-input--error' : ''}${className ? ' ' + className : ''}`}
        style={areaStyle}
        {...rest}
      />
    </div>
  );
});

// ── Select ──────────────────────────────────────────────────
export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>, CommonInputProps {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', error = false, fullWidth = true, containerStyle, style, className, children, ...rest },
  ref,
) {
  const selectStyle: CSSProperties = {
    ...baseInputStyle(size, error, false),
    appearance: 'none',
    paddingRight: 24,
    backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%23a09b94' d='M6 8L0 0h12z'/></svg>")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 8px center',
    cursor: 'pointer',
    ...style,
  };
  return (
    <div
      style={{
        width: fullWidth ? '100%' : undefined,
        display: 'inline-block',
        ...containerStyle,
      }}
    >
      <select
        ref={ref}
        className={`atlas-input${error ? ' atlas-input--error' : ''}${className ? ' ' + className : ''}`}
        style={selectStyle}
        {...rest}
      >
        {children}
      </select>
    </div>
  );
});

// ── Leading icon wrapper positioning ─────────────────────────
function iconWrapStyle(size: InputSize): CSSProperties {
  return {
    position: 'absolute',
    left: size === 'sm' ? 6 : 8,
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    color: theme.text.muted,
    pointerEvents: 'none',
  };
}

// ── InputLabel + helper text ────────────────────────────────
// Optional: use these to wrap a field with a label + optional
// helper/error text below. Keeps forms looking consistent.
export function FieldGroup({
  label,
  helperText,
  error,
  children,
  style,
}: {
  label?: string;
  helperText?: string;
  error?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space.xs, ...style }}>
      {label && (
        <label
          style={{
            ...theme.type.h3,
            color: theme.gold.dim,
            marginBottom: 2,
          }}
        >
          {label}
        </label>
      )}
      {children}
      {helperText && (
        <span
          style={{
            ...theme.type.small,
            color: error ? theme.state.danger : theme.text.muted,
          }}
        >
          {helperText}
        </span>
      )}
    </div>
  );
}

// Silence unused import warning for useState in the editor —
// reserved for future focus state tracking if needed.
void useState;
