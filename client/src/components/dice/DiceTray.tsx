import { useState } from 'react';
import { ChevronUp, ChevronDown, Minus, Eye, EyeOff } from 'lucide-react';
import { emitRoll } from '../../socket/emitters';
import { useDiceStore } from '../../stores/useDiceStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';

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
      <div style={styles.group}>
        <div style={styles.groupTitle}>
          <span>{EMOJI.dice.d20}</span> Dice
        </div>
        <div style={styles.diceRow}>
          {DICE_TYPES.map((die) => (
            <DieTile
              key={die.sides}
              label={die.label}
              onClick={() => handleDiceClick(die.sides)}
            />
          ))}
        </div>
      </div>

      <div aria-hidden style={styles.separator} />

      {/* ── Advantage toggles + DM Hidden ───── */}
      <div style={styles.group}>
        <div style={styles.groupTitle}>Mode</div>
        <div style={styles.advRow}>
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
        </div>
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
            <span>{hiddenRoll ? 'Hidden' : 'Public'}</span>
          </button>
        )}
      </div>

      <div aria-hidden style={styles.separator} />

      {/* ── Custom notation + Roll button ──── */}
      <div style={styles.group}>
        <div style={styles.groupTitle}>Custom</div>
        <div style={styles.customRow}>
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

      {/* ── Recent history (last 2) ─────────── */}
      {rollHistory.length > 1 && (
        <div style={styles.history}>
          {rollHistory.slice(1, 3).map((roll, i) => (
            <span key={i} style={styles.historyItem}>
              {roll.notation}: <strong style={{ color: theme.gold.dim }}>{roll.total}</strong>
            </span>
          ))}
        </div>
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
const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.space.md,
    height: '100%',
  },
  group: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
    gap: 2,
  },
  groupTitle: {
    ...theme.type.micro,
    color: theme.gold.dim,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 2,
  },
  separator: {
    width: 2,
    height: 52,
    background: `
      linear-gradient(90deg,
        rgba(0,0,0,0.35) 0%,
        rgba(0,0,0,0.35) 50%,
        rgba(232, 196, 85, 0.5) 50%,
        rgba(232, 196, 85, 0.5) 100%
      )
    `,
    flexShrink: 0,
    alignSelf: 'center',
  },
  diceRow: {
    display: 'flex',
    gap: 3,
  },
  dieTile: {
    width: 38,
    height: 42,
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
  },
  advRow: {
    display: 'flex',
    gap: 2,
  },
  advTile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    width: 40,
    height: 22,
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
  },
  hiddenToggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.muted,
    fontSize: 9,
    fontWeight: 700,
    cursor: 'pointer',
    marginTop: 2,
    transition: `all ${theme.motion.fast}`,
    outline: 'none',
    fontFamily: theme.font.body,
  },
  hiddenToggleActive: {
    background: 'rgba(155, 89, 182, 0.2)',
    borderColor: theme.purple,
    color: theme.purple,
    boxShadow: `inset 0 -2px 0 ${theme.purple}`,
  },
  customRow: {
    display: 'flex',
    gap: 3,
  },
  customInput: {
    width: 90,
    height: 42,
    padding: `0 ${theme.space.md}px`,
    fontSize: 13,
    background: theme.bg.deepest,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    fontFamily: 'monospace',
    outline: 'none',
    boxShadow: `inset 0 1px 3px rgba(0,0,0,0.4)`,
  },
  rollBtn: {
    padding: `0 ${theme.space.lg}px`,
    height: 42,
    fontSize: 12,
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
  },
  resultPanel: {
    display: 'flex',
    alignItems: 'baseline',
    gap: theme.space.sm,
    padding: `${theme.space.xs}px ${theme.space.md}px`,
    background: `linear-gradient(180deg, ${theme.parchment} 0%, ${theme.bg.deepest} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    boxShadow: `inset 0 1px 0 rgba(232, 196, 85, 0.2), ${theme.goldGlow.soft}`,
    minWidth: 80,
    height: 46,
  },
  resultTotal: {
    fontSize: 24,
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
  history: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    marginLeft: theme.space.xs,
  },
  historyItem: {
    fontSize: 10,
    color: theme.text.muted,
    fontFamily: 'monospace',
    whiteSpace: 'nowrap' as const,
  },
};
