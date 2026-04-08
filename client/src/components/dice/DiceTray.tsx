import { useState } from 'react';
import { ChevronUp, ChevronDown, Minus, Eye, EyeOff } from 'lucide-react';
import { emitRoll } from '../../socket/emitters';
import { useDiceStore } from '../../stores/useDiceStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { theme } from '../../styles/theme';

/**
 * Dice Tray — rune-slab redesign.
 *
 * Rewritten for the UI unification pass to match the sidebar tab bar's
 * carved-stone aesthetic. All colors route through theme tokens, dice
 * buttons are rune-slab tiles with gold rune edges, advantage toggles
 * are clearer, and the result display uses large gold numerics inscribed
 * on a parchment panel.
 */
const DICE_TYPES = [
  { sides: 4, label: 'd4' },
  { sides: 6, label: 'd6' },
  { sides: 8, label: 'd8' },
  { sides: 10, label: 'd10' },
  { sides: 12, label: 'd12' },
  { sides: 20, label: 'd20' },
  { sides: 100, label: 'd100' },
];

export function DiceTray() {
  const [customNotation, setCustomNotation] = useState('');
  const [hiddenRoll, setHiddenRoll] = useState(false);
  const advantage = useDiceStore((s) => s.advantage);
  const setAdvantage = useDiceStore((s) => s.setAdvantage);
  const lastResult = useDiceStore((s) => s.lastResult);
  const showResult = useDiceStore((s) => s.showResult);
  const rollHistory = useDiceStore((s) => s.rollHistory);
  const isDM = useSessionStore((s) => s.isDM);

  const handleDiceClick = (sides: number) => {
    const notation =
      sides === 20 && advantage !== 'normal'
        ? `2d20 (${advantage})`
        : `1d${sides}`;
    emitRoll(notation, undefined, hiddenRoll || undefined);
  };

  const handleCustomRoll = () => {
    if (!customNotation.trim()) return;
    emitRoll(customNotation.trim(), undefined, hiddenRoll || undefined);
    setCustomNotation('');
  };

  return (
    <div style={styles.container}>
      {/* ── Dice buttons ────────────────────── */}
      <div style={styles.row}>
        {DICE_TYPES.map((die) => (
          <DieTile
            key={die.sides}
            label={die.label}
            onClick={() => handleDiceClick(die.sides)}
          />
        ))}
      </div>

      <div aria-hidden style={styles.separator} />

      {/* ── Advantage toggles ──────────────── */}
      <div style={styles.row}>
        <AdvButton
          active={advantage === 'advantage'}
          variant="advantage"
          onClick={() =>
            setAdvantage(advantage === 'advantage' ? 'normal' : 'advantage')
          }
          title="Advantage (roll 2d20 keep higher)"
        >
          <ChevronUp size={12} />
          <span>ADV</span>
        </AdvButton>
        <AdvButton
          active={advantage === 'normal'}
          variant="normal"
          onClick={() => setAdvantage('normal')}
          title="Normal roll"
        >
          <Minus size={12} />
          <span>NORM</span>
        </AdvButton>
        <AdvButton
          active={advantage === 'disadvantage'}
          variant="disadvantage"
          onClick={() =>
            setAdvantage(
              advantage === 'disadvantage' ? 'normal' : 'disadvantage'
            )
          }
          title="Disadvantage (roll 2d20 keep lower)"
        >
          <ChevronDown size={12} />
          <span>DIS</span>
        </AdvButton>
        {isDM && (
          <button
            onClick={() => setHiddenRoll(!hiddenRoll)}
            title={
              hiddenRoll
                ? 'Hidden — only you see the result'
                : 'Public — everyone sees the result'
            }
            style={{
              ...styles.hiddenToggle,
              ...(hiddenRoll ? styles.hiddenToggleActive : {}),
            }}
          >
            {hiddenRoll ? <EyeOff size={11} /> : <Eye size={11} />}
            <span>{hiddenRoll ? 'HIDDEN' : 'PUBLIC'}</span>
          </button>
        )}
      </div>

      <div aria-hidden style={styles.separator} />

      {/* ── Custom notation + Roll button ──── */}
      <div style={styles.row}>
        <input
          style={styles.customInput}
          placeholder="2d6+3"
          value={customNotation}
          onChange={(e) => setCustomNotation(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCustomRoll()}
        />
        <button style={styles.rollBtn} onClick={handleCustomRoll}>
          Roll
        </button>
      </div>

      {/* ── Last result panel ───────────────── */}
      {showResult && lastResult && (
        <>
          <div aria-hidden style={styles.separator} />
          <div style={styles.resultPanel}>
            <span style={styles.resultTotal}>{lastResult.total}</span>
            <span style={styles.resultBreakdown}>
              [{lastResult.dice.map((d) => d.value).join(', ')}]
              {lastResult.modifier !== 0 &&
                ` ${lastResult.modifier > 0 ? '+' : ''}${lastResult.modifier}`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Individual die rune-slab tile ───────────────────────────
function DieTile({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`Roll ${label}`}
      style={styles.dieTile}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = theme.gold.bright;
        e.currentTarget.style.background = `linear-gradient(180deg, rgba(232, 196, 85, 0.14), ${theme.gold.bg})`;
        e.currentTarget.style.boxShadow = `inset 0 -2px 0 ${theme.gold.primary}, ${theme.goldGlow.soft}`;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = theme.gold.primary;
        e.currentTarget.style.background = `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`;
        e.currentTarget.style.boxShadow = `inset 0 -1px 0 ${theme.border.default}, inset 0 1px 0 rgba(232, 196, 85, 0.15)`;
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {label}
    </button>
  );
}

// ── Advantage-mode button ───────────────────────────────────
function AdvButton({
  children,
  active,
  variant,
  onClick,
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  variant: 'advantage' | 'normal' | 'disadvantage';
  onClick: () => void;
  title: string;
}) {
  const activeColor =
    variant === 'advantage' ? theme.state.success :
    variant === 'disadvantage' ? theme.state.danger :
    theme.gold.primary;
  const activeBg =
    variant === 'advantage' ? theme.state.successBg :
    variant === 'disadvantage' ? theme.state.dangerBg :
    theme.gold.bg;
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        ...styles.advTile,
        ...(active
          ? {
              color: activeColor,
              background: activeBg,
              boxShadow: `inset 0 -2px 0 ${activeColor}`,
            }
          : {}),
      }}
    >
      {children}
    </button>
  );
}

// ── Styles ─────────────────────────────────────────────────
const TILE_HEIGHT = 40;

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.space.sm,
    height: '100%',
    padding: `0 ${theme.space.md}px`,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
  },
  separator: {
    width: 1,
    height: 28,
    background: 'rgba(232, 196, 85, 0.35)',
    flexShrink: 0,
    margin: `0 ${theme.space.xs}px`,
  },
  dieTile: {
    width: 38,
    height: TILE_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    boxShadow: `inset 0 -1px 0 ${theme.border.default}, inset 0 1px 0 rgba(232, 196, 85, 0.15)`,
    color: theme.gold.primary,
    cursor: 'pointer',
    transition: `all ${theme.motion.normal}`,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: theme.font.display,
    letterSpacing: '0.02em',
    outline: 'none',
    flexShrink: 0,
  },
  advTile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    width: 46,
    height: TILE_HEIGHT,
    background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.muted,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.05em',
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
    outline: 'none',
    fontFamily: theme.font.body,
    flexShrink: 0,
  },
  hiddenToggle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    height: TILE_HEIGHT,
    padding: `0 ${theme.space.sm}px`,
    marginLeft: 4,
    background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.muted,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.05em',
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
    outline: 'none',
    fontFamily: theme.font.body,
    flexShrink: 0,
  },
  hiddenToggleActive: {
    background: 'rgba(155, 89, 182, 0.2)',
    borderColor: theme.purple,
    color: theme.purple,
    boxShadow: `inset 0 -2px 0 ${theme.purple}`,
  },
  customInput: {
    width: 80,
    height: TILE_HEIGHT,
    padding: `0 ${theme.space.sm}px`,
    fontSize: 12,
    background: theme.bg.deepest,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    fontFamily: 'monospace',
    outline: 'none',
    boxShadow: `inset 0 1px 3px rgba(0,0,0,0.4)`,
    flexShrink: 0,
  },
  rollBtn: {
    padding: `0 ${theme.space.md}px`,
    height: TILE_HEIGHT,
    fontSize: 11,
    fontWeight: 700,
    color: '#0a0a12',
    background: `linear-gradient(135deg, ${theme.gold.dim}, ${theme.gold.primary})`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
    fontFamily: theme.font.body,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    boxShadow: theme.goldGlow.soft,
    transition: `all ${theme.motion.normal}`,
    outline: 'none',
    flexShrink: 0,
  },
  resultPanel: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.space.sm,
    padding: `0 ${theme.space.md}px`,
    background: `linear-gradient(180deg, ${theme.parchment} 0%, ${theme.bg.deepest} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    boxShadow: `inset 0 1px 0 rgba(232, 196, 85, 0.2), ${theme.goldGlow.soft}`,
    minWidth: 70,
    height: TILE_HEIGHT,
    flexShrink: 0,
  },
  resultTotal: {
    fontSize: 20,
    fontWeight: 700,
    color: theme.gold.bright,
    fontFamily: theme.font.display,
    lineHeight: 1,
    textShadow: `0 0 8px rgba(232, 196, 85, 0.4)`,
  },
  resultBreakdown: {
    fontSize: 10,
    color: theme.text.muted,
    fontFamily: 'monospace',
  },
};
