import type { CSSProperties } from 'react';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';

/**
 * Atlas Bound primitive: <HPBar>
 *
 * THE single source of truth for HP visualization. Before unification
 * the app had 3 different HP bar implementations:
 *   • CharacterSheet used C.green = '#45a049'
 *   • CharacterSheetFull used theme.hp.full = '#27ae60'
 *   • TokenTooltip used a 4th set of colors
 *
 * All three now render the same bar with the same colors and the
 * same temp-HP overlay behavior.
 *
 * ### Color tiers (auto-computed from HP ratio)
 * - Green  (theme.state.success) when HP > 50%
 * - Orange (theme.state.warning) when HP 25-50%
 * - Red    (theme.state.danger)  when HP < 25%
 *
 * Temp HP renders as a blue overlay stacked on top of the current HP.
 *
 * ### Size variants
 * - `compact` — narrow bar, small numeric readout (for tooltips)
 * - `normal`  — default, used in sidebars & tables
 * - `large`   — prominent, used in character sheet & stat blocks
 *
 * ### Usage
 * ```tsx
 * <HPBar current={15} max={20} temp={4} size="large" showEmoji />
 * ```
 */

export type HPBarSize = 'compact' | 'normal' | 'large';

export interface HPBarProps {
  current: number;
  max: number;
  temp?: number;
  size?: HPBarSize;
  /** Render a leading ❤️/🩸 emoji. Off by default to keep the bar clean in tables. */
  showEmoji?: boolean;
  /** Render the numeric readout (e.g. "15 / 20"). Default: true. */
  showNumeric?: boolean;
  /** Label override (e.g. "HP" prefix). */
  label?: string;
  style?: CSSProperties;
}

function hpColor(ratio: number): string {
  if (ratio > 0.5) return theme.state.success;
  if (ratio > 0.25) return theme.state.warning;
  return theme.state.danger;
}

const HEIGHT: Record<HPBarSize, number> = {
  compact: 6,
  normal: 8,
  large: 12,
};

const FONT: Record<HPBarSize, number> = {
  compact: 10,
  normal: 12,
  large: 14,
};

export function HPBar({
  current,
  max,
  temp = 0,
  size = 'normal',
  showEmoji = false,
  showNumeric = true,
  label,
  style,
}: HPBarProps) {
  const safeMax = Math.max(1, max);
  const safeCurrent = Math.max(0, Math.min(current, safeMax));
  const ratio = safeCurrent / safeMax;
  const color = hpColor(ratio);
  const tempRatio = Math.min(1, temp / safeMax);
  const emoji =
    ratio > 0.5 ? EMOJI.hp.full :
    ratio > 0 ? EMOJI.hp.low :
    EMOJI.combat.dead;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        width: '100%',
        ...style,
      }}
    >
      {(showNumeric || label || showEmoji) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space.xs,
            fontSize: FONT[size],
            fontFamily: theme.font.body,
            color: theme.text.secondary,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {showEmoji && <span style={{ fontSize: FONT[size] }}>{emoji}</span>}
            {label ?? 'HP'}
          </span>
          {showNumeric && (
            <span
              style={{
                color: theme.text.primary,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {safeCurrent}
              <span style={{ color: theme.text.muted, fontWeight: 400 }}> / {safeMax}</span>
              {temp > 0 && (
                <span style={{ color: theme.blue, marginLeft: 4 }}>(+{temp})</span>
              )}
            </span>
          )}
        </div>
      )}
      <div
        style={{
          position: 'relative',
          height: HEIGHT[size],
          background: 'rgba(0, 0, 0, 0.55)',
          borderRadius: HEIGHT[size] / 2,
          border: `1px solid ${theme.border.default}`,
          overflow: 'hidden',
        }}
      >
        {/* Current HP fill */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${ratio * 100}%`,
            background: `linear-gradient(180deg, ${color}, ${color}cc)`,
            transition: `width ${theme.motion.slow}, background ${theme.motion.normal}`,
          }}
        />
        {/* Temp HP overlay (blue, stacked on top of current HP area) */}
        {temp > 0 && (
          <div
            style={{
              position: 'absolute',
              left: `${ratio * 100}%`,
              top: 0,
              bottom: 0,
              width: `${tempRatio * 100}%`,
              background: `${theme.blue}cc`,
              borderLeft: `1px solid ${theme.blue}`,
            }}
          />
        )}
      </div>
    </div>
  );
}
