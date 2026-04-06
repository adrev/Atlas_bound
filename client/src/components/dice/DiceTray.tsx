import { useState } from 'react';
import { ChevronUp, ChevronDown, Minus, Eye, EyeOff } from 'lucide-react';
import { emitRoll } from '../../socket/emitters';
import { useDiceStore } from '../../stores/useDiceStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { theme } from '../../styles/theme';

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
      {/* Dice buttons */}
      <div style={styles.diceRow}>
        {DICE_TYPES.map((die) => (
          <button
            key={die.sides}
            style={styles.dieButton}
            onClick={() => handleDiceClick(die.sides)}
            title={`Roll ${die.label}`}
          >
            <span style={styles.dieSides}>{die.label}</span>
          </button>
        ))}
      </div>

      {/* Advantage / Disadvantage toggles */}
      <div style={styles.advRow}>
        <button
          style={{
            ...styles.advButton,
            ...(advantage === 'advantage' ? styles.advActive : {}),
          }}
          onClick={() =>
            setAdvantage(advantage === 'advantage' ? 'normal' : 'advantage')
          }
          title="Advantage"
        >
          <ChevronUp size={14} />
        </button>
        <button
          style={{
            ...styles.advButton,
            ...(advantage === 'normal' ? styles.advNormal : {}),
          }}
          onClick={() => setAdvantage('normal')}
          title="Normal"
        >
          <Minus size={14} />
        </button>
        <button
          style={{
            ...styles.advButton,
            ...(advantage === 'disadvantage' ? styles.advDisadvantage : {}),
          }}
          onClick={() =>
            setAdvantage(
              advantage === 'disadvantage' ? 'normal' : 'disadvantage'
            )
          }
          title="Disadvantage"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      {/* Hidden roll toggle (DM only) */}
      {isDM && (
        <button
          style={{
            ...styles.advButton,
            ...(hiddenRoll ? styles.hiddenActive : {}),
            width: 'auto',
            height: 28,
            padding: '0 8px',
            gap: 4,
            display: 'flex',
            alignItems: 'center',
          }}
          onClick={() => setHiddenRoll(!hiddenRoll)}
          title={hiddenRoll ? 'Hidden roll (only you see the result)' : 'Public roll (everyone sees)'}
        >
          {hiddenRoll ? <EyeOff size={14} /> : <Eye size={14} />}
          <span style={{ fontSize: 10, fontWeight: 600 }}>{hiddenRoll ? 'Hidden' : 'Public'}</span>
        </button>
      )}

      {/* Custom notation */}
      <div style={styles.customRow}>
        <input
          style={styles.customInput}
          placeholder="2d6+3"
          value={customNotation}
          onChange={(e) => setCustomNotation(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCustomRoll()}
        />
        <button className="btn-primary" style={styles.rollBtn} onClick={handleCustomRoll}>
          Roll
        </button>
      </div>

      {/* Last result */}
      {showResult && lastResult && (
        <div style={styles.result} className="animate-scale-in">
          <span style={styles.resultTotal}>{lastResult.total}</span>
          <span style={styles.resultBreakdown}>
            [{lastResult.dice.map((d) => d.value).join(', ')}]
            {lastResult.modifier !== 0 &&
              ` ${lastResult.modifier > 0 ? '+' : ''}${lastResult.modifier}`}
          </span>
        </div>
      )}

      {/* Mini history */}
      {rollHistory.length > 1 && (
        <div style={styles.history}>
          {rollHistory.slice(1, 4).map((roll, i) => (
            <span key={i} style={styles.historyItem}>
              {roll.notation}: {roll.total}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: '100%',
  },
  diceRow: {
    display: 'flex',
    gap: 4,
  },
  dieButton: {
    width: 40,
    height: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    color: theme.text.primary,
  },
  dieSides: {
    fontSize: 12,
    fontWeight: 700,
    color: theme.gold.primary,
  },
  advRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  advButton: {
    width: 28,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
    color: theme.text.muted,
    transition: 'all 0.15s ease',
  },
  advActive: {
    background: 'rgba(39, 174, 96, 0.2)',
    borderColor: theme.heal,
    color: theme.heal,
  },
  advNormal: {
    background: 'rgba(255,255,255,0.05)',
    color: theme.text.secondary,
  },
  advDisadvantage: {
    background: 'rgba(192, 57, 43, 0.2)',
    borderColor: theme.danger,
    color: theme.danger,
  },
  hiddenActive: {
    background: 'rgba(155, 89, 182, 0.2)',
    borderColor: '#9b59b6',
    color: '#9b59b6',
  },
  customRow: {
    display: 'flex',
    gap: 4,
  },
  customInput: {
    width: 80,
    padding: '6px 8px',
    fontSize: 13,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    fontFamily: 'monospace',
    outline: 'none',
  },
  rollBtn: {
    padding: '6px 12px',
    fontSize: 12,
  },
  result: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
  },
  resultTotal: {
    fontSize: 24,
    fontWeight: 700,
    color: theme.gold.primary,
    fontFamily: theme.font.display,
  },
  resultBreakdown: {
    fontSize: 11,
    color: theme.text.muted,
    fontFamily: 'monospace',
  },
  history: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  historyItem: {
    fontSize: 10,
    color: theme.text.muted,
    fontFamily: 'monospace',
  },
};
