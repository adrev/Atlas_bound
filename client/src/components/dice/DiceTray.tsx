import { useState, useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, Minus, Eye, EyeOff, Settings, X } from 'lucide-react';
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

/**
 * SVG polygon points for each die shape, inscribed in a 100x100 viewBox
 * centered at (50, 50). Each shape is picked to give the die an
 * immediately recognizable silhouette.
 *
 *   d4   — upward triangle
 *   d6   — square
 *   d8   — horizontal diamond (four points)
 *   d10  — kite (elongated diamond)
 *   d12  — regular pentagon
 *   d20  — regular hexagon
 *   d100 — regular hexagon (wider label)
 */
const DIE_POLYGONS: Record<number, string> = {
  4: '50,10 90,85 10,85',
  6: '15,15 85,15 85,85 15,85',
  8: '50,8 92,50 50,92 8,50',
  10: '50,6 88,40 70,92 30,92 12,40',
  12: '50,6 92,36 76,88 24,88 8,36',
  20: '50,6 92,30 92,70 50,94 8,70 8,30',
  100: '50,6 92,30 92,70 50,94 8,70 8,30',
};

export function DiceTray() {
  const [customNotation, setCustomNotation] = useState('');
  const [hiddenRoll, setHiddenRoll] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advantage = useDiceStore((s) => s.advantage);
  const setAdvantage = useDiceStore((s) => s.setAdvantage);
  const lastResult = useDiceStore((s) => s.lastResult);
  const rollHistory = useDiceStore((s) => s.rollHistory);
  const isDM = useSessionStore((s) => s.isDM);

  // Rolling animation state — cycles random values while the die
  // "tumbles". When the server's real result comes back via
  // useDiceStore.lastResult we snap to the final total, then clear.
  const [rollingDie, setRollingDie] = useState<{
    sides: number;
    displayValue: number;
    finalValue: number | null;
  } | null>(null);
  const spinTimeoutRef = useRef<number | null>(null);
  const settleTimeoutRef = useRef<number | null>(null);

  // While rolling, cycle random values every ~60ms for a tumbling feel.
  useEffect(() => {
    if (!rollingDie || rollingDie.finalValue != null) return;
    const id = window.setInterval(() => {
      setRollingDie((prev) =>
        prev && prev.finalValue == null
          ? { ...prev, displayValue: 1 + Math.floor(Math.random() * prev.sides) }
          : prev
      );
    }, 60);
    return () => window.clearInterval(id);
  }, [rollingDie?.sides, rollingDie?.finalValue]);

  // When the server result arrives for the current rolling die, settle.
  useEffect(() => {
    if (!rollingDie || rollingDie.finalValue != null || !lastResult) return;
    // Only settle on results for a single die of the right size.
    const matches =
      lastResult.dice.length >= 1 &&
      lastResult.notation?.toLowerCase().includes(`d${rollingDie.sides}`);
    if (!matches) return;
    setRollingDie((prev) => prev
      ? { ...prev, finalValue: lastResult.total, displayValue: lastResult.total }
      : prev);
    settleTimeoutRef.current = window.setTimeout(() => setRollingDie(null), 900);
    return () => {
      if (settleTimeoutRef.current) window.clearTimeout(settleTimeoutRef.current);
    };
  }, [lastResult, rollingDie?.sides, rollingDie?.finalValue]);

  // Safety net: if the server result never arrives (e.g. offline), end
  // the spin after 1.8s so the overlay doesn't stick forever.
  useEffect(() => {
    if (!rollingDie) return;
    spinTimeoutRef.current = window.setTimeout(() => setRollingDie(null), 1800);
    return () => {
      if (spinTimeoutRef.current) window.clearTimeout(spinTimeoutRef.current);
    };
  }, [rollingDie?.sides]);

  const handleDiceClick = (sides: number) => {
    const notation =
      sides === 20 && advantage !== 'normal'
        ? `2d20 (${advantage})`
        : `1d${sides}`;
    setRollingDie({
      sides,
      displayValue: 1 + Math.floor(Math.random() * sides),
      finalValue: null,
    });
    emitRoll(notation, undefined, hiddenRoll || undefined);
  };

  const handleCustomRoll = () => {
    if (!customNotation.trim()) return;
    emitRoll(customNotation.trim(), undefined, hiddenRoll || undefined);
    setCustomNotation('');
  };

  return (
    <>
      <div style={styles.container}>
        {/* ── Dice buttons + Advanced (all one row) ───────── */}
        <div style={styles.row}>
          {DICE_TYPES.map((die) => (
            <DieTile
              key={die.sides}
              sides={die.sides}
              label={die.label}
              onClick={() => handleDiceClick(die.sides)}
            />
          ))}
          <button
            onClick={() => setShowAdvanced(true)}
            title="Advanced dice options (advantage, custom rolls, history)"
            style={styles.advancedBtn}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = theme.gold.bright;
              e.currentTarget.style.borderColor = theme.gold.primary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = theme.gold.primary;
              e.currentTarget.style.borderColor = theme.gold.border;
            }}
          >
            <Settings size={14} />
          </button>
        </div>

        {/* ── DM Public / Hidden toggle (always visible to DM) ── */}
        {isDM && (
          <>
            <div aria-hidden style={styles.separator} />
            <button
              onClick={() => setHiddenRoll(!hiddenRoll)}
              title={
                hiddenRoll
                  ? 'Hidden — only you see the result'
                  : 'Public — everyone sees the result'
              }
              style={{
                ...styles.hiddenToggle,
                marginLeft: 0,
                ...(hiddenRoll ? styles.hiddenToggleActive : {}),
              }}
            >
              {hiddenRoll ? <EyeOff size={11} /> : <Eye size={11} />}
              <span>{hiddenRoll ? 'HIDDEN' : 'PUBLIC'}</span>
            </button>
          </>
        )}
      </div>

      {/* ── Rolling animation overlay (Roll20-style tumble) ── */}
      {rollingDie && <RollingDieOverlay die={rollingDie} />}

      {showAdvanced && (
        <AdvancedDiceModal
          customNotation={customNotation}
          setCustomNotation={setCustomNotation}
          handleCustomRoll={handleCustomRoll}
          advantage={advantage}
          setAdvantage={setAdvantage}
          lastResult={lastResult}
          rollHistory={rollHistory}
          onClose={() => setShowAdvanced(false)}
        />
      )}
    </>
  );
}

// ── Advanced dice modal ─────────────────────────────────────
interface AdvancedDiceModalProps {
  customNotation: string;
  setCustomNotation: (v: string) => void;
  handleCustomRoll: () => void;
  advantage: 'normal' | 'advantage' | 'disadvantage';
  setAdvantage: (v: 'normal' | 'advantage' | 'disadvantage') => void;
  lastResult: ReturnType<typeof useDiceStore.getState>['lastResult'];
  rollHistory: ReturnType<typeof useDiceStore.getState>['rollHistory'];
  onClose: () => void;
}

function AdvancedDiceModal(props: AdvancedDiceModalProps) {
  const {
    customNotation, setCustomNotation, handleCustomRoll,
    advantage, setAdvantage, lastResult, rollHistory, onClose,
  } = props;

  return (
    <div onClick={onClose} style={modalStyles.overlay}>
      <div onClick={(e) => e.stopPropagation()} style={modalStyles.panel}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>Advanced Dice</span>
          <button onClick={onClose} style={modalStyles.closeBtn} title="Close">
            <X size={16} />
          </button>
        </div>

        <div style={modalStyles.body}>
          {/* Roll mode */}
          <section style={modalStyles.section}>
            <div style={modalStyles.label}>Roll Mode</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <AdvButton
                active={advantage === 'advantage'}
                variant="advantage"
                onClick={() => setAdvantage(advantage === 'advantage' ? 'normal' : 'advantage')}
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
                onClick={() => setAdvantage(advantage === 'disadvantage' ? 'normal' : 'disadvantage')}
                title="Disadvantage (roll 2d20 keep lower)"
              >
                <ChevronDown size={12} />
                <span>DIS</span>
              </AdvButton>
            </div>
          </section>

          {/* Custom notation */}
          <section style={modalStyles.section}>
            <div style={modalStyles.label}>Custom Roll</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                autoFocus
                style={{ ...styles.customInput, flex: 1, width: 'auto' }}
                placeholder="2d6+3"
                value={customNotation}
                onChange={(e) => setCustomNotation(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCustomRoll();
                    onClose();
                  }
                }}
              />
              <button
                style={styles.rollBtn}
                onClick={() => { handleCustomRoll(); onClose(); }}
              >
                Roll
              </button>
            </div>
          </section>

          {/* Last result */}
          {lastResult && (
            <section style={modalStyles.section}>
              <div style={modalStyles.label}>Last Roll</div>
              <div style={styles.resultPanel}>
                <span style={styles.resultTotal}>{lastResult.total}</span>
                <span style={styles.resultBreakdown}>
                  [{lastResult.dice.map((d) => d.value).join(', ')}]
                  {lastResult.modifier !== 0 &&
                    ` ${lastResult.modifier > 0 ? '+' : ''}${lastResult.modifier}`}
                </span>
              </div>
            </section>
          )}

          {/* Recent history */}
          {rollHistory.length > 0 && (
            <section style={modalStyles.section}>
              <div style={modalStyles.label}>Recent Rolls</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {rollHistory.slice(0, 8).map((roll, i) => (
                  <div key={i} style={modalStyles.historyRow}>
                    <span style={{ color: theme.text.muted, fontFamily: 'monospace' }}>
                      {roll.notation}
                    </span>
                    <span style={{ color: theme.gold.primary, fontWeight: 700 }}>
                      {roll.total}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Individual die — renders an SVG polygon shape ──────────
function DieTile({
  sides, label, onClick, size = 38,
}: { sides: number; label: string; onClick: () => void; size?: number }) {
  const points = DIE_POLYGONS[sides] ?? DIE_POLYGONS[20];
  // d100 shows "100" instead of the "d100" string; other dice show just
  // the number ("4", "6", etc.) which reads more like a real die face.
  const faceLabel = sides === 100 ? '100' : String(sides);
  return (
    <button
      onClick={onClick}
      title={`Roll ${label}`}
      style={styles.dieButton}
      onMouseEnter={(e) => {
        const svg = e.currentTarget.querySelector('svg');
        if (svg) svg.style.transform = 'translateY(-2px) rotate(-6deg)';
      }}
      onMouseLeave={(e) => {
        const svg = e.currentTarget.querySelector('svg');
        if (svg) svg.style.transform = 'translateY(0) rotate(0deg)';
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        style={styles.dieSvg}
      >
        <defs>
          <linearGradient id={`die-grad-${sides}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={theme.parchmentEdge} />
            <stop offset="100%" stopColor={theme.bg.deep} />
          </linearGradient>
        </defs>
        <polygon
          points={points}
          fill={`url(#die-grad-${sides})`}
          stroke={theme.gold.primary}
          strokeWidth={3}
          strokeLinejoin="round"
          className="die-polygon"
        />
        <text
          x="50"
          y="58"
          textAnchor="middle"
          fontFamily={theme.font.display}
          fontWeight={700}
          fontSize={sides === 100 ? 28 : 34}
          fill={theme.gold.primary}
          className="die-label"
        >
          {faceLabel}
        </text>
      </svg>
    </button>
  );
}

// ── Rolling animation overlay ──────────────────────────────
function RollingDieOverlay({
  die,
}: {
  die: { sides: number; displayValue: number; finalValue: number | null };
}) {
  const points = DIE_POLYGONS[die.sides] ?? DIE_POLYGONS[20];
  const settled = die.finalValue != null;
  return (
    <div style={overlayStyles.backdrop}>
      <div
        style={{
          ...overlayStyles.dieWrap,
          animation: settled ? 'none' : 'diceTumble 0.7s linear infinite',
        }}
      >
        <svg width={160} height={160} viewBox="0 0 100 100">
          <defs>
            <linearGradient id="die-overlay-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.parchmentEdge} />
              <stop offset="100%" stopColor={theme.bg.deep} />
            </linearGradient>
            <filter id="die-glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <polygon
            points={points}
            fill="url(#die-overlay-grad)"
            stroke={settled ? theme.gold.bright : theme.gold.primary}
            strokeWidth={4}
            strokeLinejoin="round"
            filter="url(#die-glow)"
          />
          <text
            x="50"
            y="60"
            textAnchor="middle"
            fontFamily={theme.font.display}
            fontWeight={700}
            fontSize={38}
            fill={settled ? theme.gold.bright : theme.gold.primary}
          >
            {die.displayValue}
          </text>
        </svg>
        <div style={overlayStyles.caption}>
          {settled ? `d${die.sides} = ${die.finalValue}` : `Rolling d${die.sides}…`}
        </div>
      </div>
      <style>{`
        @keyframes diceTumble {
          0%   { transform: rotate(0deg)   scale(1); }
          25%  { transform: rotate(90deg)  scale(1.05); }
          50%  { transform: rotate(180deg) scale(0.95); }
          75%  { transform: rotate(270deg) scale(1.05); }
          100% { transform: rotate(360deg) scale(1); }
        }
      `}</style>
    </div>
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
  dieButton: {
    width: 44,
    height: TILE_HEIGHT + 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    outline: 'none',
    flexShrink: 0,
  },
  dieSvg: {
    transition: 'transform 0.15s ease',
    filter: `drop-shadow(0 2px 3px rgba(0, 0, 0, 0.4))`,
  },
  advancedBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: TILE_HEIGHT,
    height: TILE_HEIGHT,
    background: `linear-gradient(180deg, ${theme.parchmentEdge} 0%, ${theme.bg.deep} 100%)`,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    boxShadow: `inset 0 -1px 0 ${theme.border.default}, inset 0 1px 0 rgba(232, 196, 85, 0.15)`,
    color: theme.gold.primary,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
    outline: 'none',
    flexShrink: 0,
    marginLeft: 4,
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

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  panel: {
    width: 360,
    maxHeight: '80vh',
    background: theme.bg.card,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: 10,
    boxShadow: `0 12px 40px rgba(0,0,0,0.7), ${theme.goldGlow.soft}`,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
  },
  title: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: theme.gold.dim,
    textTransform: 'uppercase',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: theme.text.muted,
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: 16,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: theme.gold.dim,
    textTransform: 'uppercase',
  },
  historyRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '4px 8px',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    borderRadius: 4,
    fontSize: 11,
  },
};

const overlayStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1500,
    pointerEvents: 'none',
  },
  dieWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 14,
    filter: `drop-shadow(0 8px 24px rgba(0, 0, 0, 0.7)) drop-shadow(0 0 18px ${theme.gold.primary})`,
  },
  caption: {
    fontSize: 13,
    fontWeight: 700,
    color: theme.gold.bright,
    fontFamily: theme.font.display,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    textShadow: '0 0 6px rgba(0,0,0,0.8)',
  },
};
