import type { CSSProperties } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <StatBlock>
 *
 * The unified ability score display. Before this, three different
 * implementations existed in CharacterSheet, CharacterSheetFull, and
 * TokenTooltip — each with slightly different sizing, colors, and
 * modifier formatting.
 *
 * ### Layout
 * Six boxes in a row: STR, DEX, CON, INT, WIS, CHA. Each box shows:
 *   • Ability label (uppercase, gold dim)
 *   • Base score (large, primary color)
 *   • Modifier pill (smaller, tabular, +X or -X)
 *   • Optional proficiency dot (for save proficiency)
 *
 * ### Size variants
 * - `compact` — small boxes for token tooltips (24px wide)
 * - `normal`  — default for sidebar (40px wide)
 * - `large`   — prominent for character sheet (56px wide)
 *
 * ### Usage
 * ```tsx
 * <StatBlock
 *   scores={{ str: 10, dex: 16, con: 14, int: 12, wis: 13, cha: 18 }}
 *   saveProficiencies={['dex', 'con']}
 *   size="large"
 * />
 * ```
 */

export type AbilityName = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
export type StatBlockSize = 'compact' | 'normal' | 'large';

export interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export interface StatBlockProps {
  scores: AbilityScores;
  saveProficiencies?: AbilityName[];
  /** Highlight on click — only renders cursor/hover if set. */
  onRollSave?: (ability: AbilityName) => void;
  size?: StatBlockSize;
  style?: CSSProperties;
}

const ABILITIES: AbilityName[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const SIZE_CONFIG: Record<StatBlockSize, {
  boxSize: number;
  labelFont: number;
  scoreFont: number;
  modFont: number;
  gap: number;
}> = {
  compact: { boxSize: 32, labelFont: 8, scoreFont: 13, modFont: 9, gap: 3 },
  normal:  { boxSize: 44, labelFont: 9, scoreFont: 16, modFont: 11, gap: 4 },
  large:   { boxSize: 60, labelFont: 10, scoreFont: 20, modFont: 12, gap: 6 },
};

function mod(score: number): number {
  return Math.floor((score - 10) / 2);
}

function modString(m: number): string {
  return m >= 0 ? `+${m}` : `${m}`;
}

export function StatBlock({
  scores,
  saveProficiencies = [],
  onRollSave,
  size = 'normal',
  style,
}: StatBlockProps) {
  const cfg = SIZE_CONFIG[size];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gap: cfg.gap,
        ...style,
      }}
    >
      {ABILITIES.map((ability) => {
        const score = scores[ability];
        const m = mod(score);
        const isProficient = saveProficiencies.includes(ability);
        const interactive = !!onRollSave;
        return (
          <button
            key={ability}
            type="button"
            disabled={!interactive}
            onClick={() => onRollSave?.(ability)}
            style={{
              position: 'relative',
              background: theme.bg.deep,
              border: `1px solid ${isProficient ? theme.gold.border : theme.border.default}`,
              borderRadius: theme.radius.sm,
              padding: cfg.gap,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: cfg.boxSize,
              cursor: interactive ? 'pointer' : 'default',
              transition: `all ${theme.motion.fast}`,
              fontFamily: theme.font.body,
            }}
            onMouseEnter={(e) => {
              if (interactive) {
                e.currentTarget.style.background = theme.bg.hover;
                e.currentTarget.style.borderColor = theme.gold.border;
              }
            }}
            onMouseLeave={(e) => {
              if (interactive) {
                e.currentTarget.style.background = theme.bg.deep;
                e.currentTarget.style.borderColor = isProficient
                  ? theme.gold.border
                  : theme.border.default;
              }
            }}
          >
            {/* Proficiency dot — top-right */}
            {isProficient && (
              <span
                aria-label="proficient"
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: theme.gold.bright,
                  boxShadow: theme.goldGlow.soft,
                }}
              />
            )}
            {/* Ability label */}
            <span
              style={{
                fontSize: cfg.labelFont,
                fontWeight: 700,
                color: theme.gold.dim,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {ability}
            </span>
            {/* Score */}
            <span
              style={{
                fontSize: cfg.scoreFont,
                fontWeight: 700,
                color: theme.text.primary,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {score}
            </span>
            {/* Modifier */}
            <span
              style={{
                fontSize: cfg.modFont,
                color: m >= 0 ? theme.state.success : theme.state.danger,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {modString(m)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
