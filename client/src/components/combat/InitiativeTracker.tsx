import { SkipForward, X } from 'lucide-react';
import { useCombatStore } from '../../stores/useCombatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitNextTurn, emitEndCombat } from '../../socket/emitters';
import { ActionEconomy } from './ActionEconomy';
import { theme } from '../../styles/theme';

export function InitiativeTracker() {
  const combatants = useCombatStore((s) => s.combatants);
  const currentTurnIndex = useCombatStore((s) => s.currentTurnIndex);
  const roundNumber = useCombatStore((s) => s.roundNumber);
  const active = useCombatStore((s) => s.active);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);

  if (!active || combatants.length === 0) return null;

  const currentCombatant = combatants[currentTurnIndex];
  const isMyTurn = isDM || currentCombatant?.characterId === userId;

  return (
    <div style={styles.container}>
      {/* Round counter */}
      <div style={styles.header}>
        <span style={styles.roundLabel}>Round {roundNumber}</span>
        {isDM && (
          <button
            className="btn-icon"
            onClick={() => emitEndCombat()}
            title="End Combat"
            style={{ color: theme.danger }}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Initiative strip */}
      <div style={styles.strip}>
        {combatants.map((combatant, index) => {
          const isCurrent = index === currentTurnIndex;
          const hpRatio = combatant.maxHp > 0 ? combatant.hp / combatant.maxHp : 1;
          const hpColor =
            hpRatio > 0.5 ? theme.hp.full : hpRatio > 0.25 ? theme.hp.half : theme.hp.low;

          return (
            <div
              key={combatant.tokenId}
              style={{
                ...styles.combatant,
                ...(isCurrent ? styles.combatantActive : {}),
              }}
            >
              {/* Portrait */}
              <div
                style={{
                  ...styles.portrait,
                  ...(isCurrent ? styles.portraitActive : {}),
                  borderColor: isCurrent ? theme.gold.primary : theme.border.default,
                }}
              >
                {combatant.portraitUrl ? (
                  <img
                    src={combatant.portraitUrl}
                    alt={combatant.name}
                    style={styles.portraitImg}
                  />
                ) : (
                  <span style={styles.portraitInitial}>
                    {combatant.name.charAt(0).toUpperCase()}
                  </span>
                )}
                {/* Initiative number */}
                <span style={styles.initiativeNum}>{combatant.initiative}</span>
              </div>

              {/* Name */}
              <span
                style={{
                  ...styles.name,
                  color: isCurrent ? theme.gold.primary : theme.text.secondary,
                }}
              >
                {combatant.name}
              </span>

              {/* HP bar */}
              <div style={styles.hpBarBg}>
                <div
                  style={{
                    ...styles.hpBarFill,
                    width: `${Math.max(0, hpRatio * 100)}%`,
                    background: hpColor,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Action economy for current turn */}
      {isMyTurn && <ActionEconomy />}

      {/* End turn button */}
      {isMyTurn && (
        <button
          className="btn-primary"
          onClick={() => emitNextTurn()}
          style={{ margin: '8px 12px', width: 'calc(100% - 24px)' }}
        >
          <SkipForward size={16} />
          End Turn
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px 0',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
  },
  roundLabel: {
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '1px',
    color: theme.gold.primary,
  },
  strip: {
    display: 'flex',
    gap: 4,
    overflowX: 'auto',
    padding: '4px 12px',
  },
  combatant: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: 6,
    borderRadius: theme.radius.md,
    minWidth: 56,
    transition: 'all 0.2s ease',
  },
  combatantActive: {
    background: theme.gold.bg,
  },
  portrait: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    border: '2px solid',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.elevated,
    position: 'relative' as const,
    flexShrink: 0,
  },
  portraitActive: {
    boxShadow: `0 0 12px rgba(212, 168, 67, 0.5)`,
  },
  portraitImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  portraitInitial: {
    fontSize: 16,
    fontWeight: 700,
    color: theme.text.secondary,
  },
  initiativeNum: {
    position: 'absolute' as const,
    bottom: -2,
    right: -2,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    fontSize: 9,
    fontWeight: 700,
    color: theme.text.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: 10,
    fontWeight: 600,
    maxWidth: 56,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
  },
  hpBarBg: {
    width: '100%',
    height: 3,
    background: 'rgba(0,0,0,0.4)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  hpBarFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
};
