import { SkipForward, X } from 'lucide-react';
import { useCombatStore } from '../../stores/useCombatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
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
  const tokens = useMapStore((s) => s.tokens);

  if (!active || combatants.length === 0) return null;

  const currentCombatant = combatants[currentTurnIndex];
  // The current turn's token owner can also end their own turn now (the
  // server-side check matches). Used to be DM-only.
  const currentToken = currentCombatant ? tokens[currentCombatant.tokenId] : null;
  const isCurrentOwner = currentToken?.ownerUserId === userId;
  const isMyTurn = isDM || isCurrentOwner;

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

      {/* Initiative list — vertical so we can see the whole turn order
          at a glance and each combatant row has room for HP + init +
          name on one line. */}
      <div style={styles.list}>
        {combatants.map((combatant, index) => {
          const isCurrent = index === currentTurnIndex;
          const hpRatio = combatant.maxHp > 0 ? combatant.hp / combatant.maxHp : 1;
          const hpColor =
            hpRatio > 0.5 ? theme.hp.full : hpRatio > 0.25 ? theme.hp.half : theme.hp.low;
          const isDown = combatant.hp <= 0;

          return (
            <div
              key={combatant.tokenId}
              onClick={() => {
                // Select the token AND pan the camera to it. BattleMap
                // listens for 'canvas-center-on' and moves the viewport
                // at the current zoom level so the party can instantly
                // jump to the active combatant.
                useMapStore.getState().selectToken(combatant.tokenId);
                window.dispatchEvent(new CustomEvent('canvas-center-on', {
                  detail: { tokenId: combatant.tokenId },
                }));
              }}
              title={`${combatant.name} — Initiative ${combatant.initiative} • HP ${combatant.hp}/${combatant.maxHp} • AC ${combatant.armorClass}\nClick to jump camera to this combatant`}
              style={{
                ...styles.row,
                ...(isCurrent ? styles.rowActive : {}),
                ...(isDown ? styles.rowDown : {}),
              }}
            >
              {/* Initiative number on the left */}
              <div
                style={{
                  ...styles.initBadge,
                  color: isCurrent ? theme.gold.primary : theme.text.secondary,
                  borderColor: isCurrent ? theme.gold.primary : theme.border.default,
                }}
              >
                {combatant.initiative}
              </div>

              {/* Portrait */}
              <div
                style={{
                  ...styles.rowPortrait,
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
              </div>

              {/* Name + HP bar stacked on the right */}
              <div style={styles.rowInfo}>
                <span
                  style={{
                    ...styles.rowName,
                    color: isCurrent ? theme.gold.primary : theme.text.primary,
                  }}
                >
                  {combatant.name}
                </span>
                <div style={styles.hpRow}>
                  <div style={styles.hpBarBg}>
                    <div
                      style={{
                        ...styles.hpBarFill,
                        width: `${Math.max(0, hpRatio * 100)}%`,
                        background: hpColor,
                      }}
                    />
                  </div>
                  <span style={styles.hpText}>
                    {combatant.hp}/{combatant.maxHp}
                  </span>
                </div>
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
    // Fill the parent initiativeSection (max 45vh) so the inner list
    // can take whatever vertical space is left after the header /
    // action economy / end turn button and scroll inside that area.
    maxHeight: '100%',
    minHeight: 0,
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
  /* Vertical list of combatants. The parent `initiativeSection` in
     Sidebar.tsx caps the whole tracker at ~45% of the viewport and
     scrolls the overflow, so we don't need our own inner scroll
     anymore — keeping the list unconstrained means the action economy
     and End Turn button stay pinned to the bottom of whatever is
     visible. */
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '4px 8px',
  },
  /* Single row per combatant: [init] [portrait] [name + hp] */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: theme.radius.md,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    background: 'transparent',
  },
  rowActive: {
    background: theme.gold.bg,
    boxShadow: `inset 0 0 0 1px ${theme.gold.primary}`,
  },
  rowDown: {
    opacity: 0.4,
    filter: 'grayscale(0.7)',
  },
  /* Large, clearly visible initiative number on the left side */
  initBadge: {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: '2px solid',
    background: theme.bg.deep,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 800,
    flexShrink: 0,
  },
  rowPortrait: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '2px solid',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.elevated,
    flexShrink: 0,
  },
  portraitImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  portraitInitial: {
    fontSize: 14,
    fontWeight: 700,
    color: theme.text.secondary,
  },
  rowInfo: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  rowName: {
    fontSize: 12,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hpRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  hpBarBg: {
    flex: 1,
    height: 4,
    background: 'rgba(0,0,0,0.4)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  hpBarFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
  hpText: {
    fontSize: 9,
    fontWeight: 600,
    color: theme.text.muted,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
};
