import { useState, useEffect, useCallback } from 'react';
import { useCombatStore } from '../../stores/useCombatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useMapStore } from '../../stores/useMapStore';
import { emitRollInitiative, emitSetInitiative } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import type { Combatant } from '@dnd-vtt/shared';

const ACCENT = '#c53131';
const MODAL_BG = '#1a1a1a';

interface InitiativeModalProps {
  onClose: () => void;
}

export function InitiativeModal({ onClose }: InitiativeModalProps) {
  const combatants = useCombatStore((s) => s.combatants);
  const initiativeRolls = useCombatStore((s) => s.initiativeRolls);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const myCharacter = useCharacterStore((s) => s.myCharacter);
  const tokens = useMapStore((s) => s.tokens);
  const [rolledTokenIds, setRolledTokenIds] = useState<Set<string>>(new Set());
  const [autoCloseCountdown, setAutoCloseCountdown] = useState<number | null>(null);

  // Find my combatant. Previously this compared `c.characterId === userId`
  // which is wrong — characterId is a CHARACTER UUID, not a user UUID,
  // so the check never matched and the player's "Roll Initiative"
  // button was never rendered. The correct way is to look up the
  // combatant whose token is owned by the current user, OR whose
  // characterId matches the current user's linked character.
  const myCombatant = combatants.find((c) => {
    if (c.isNPC) return false;
    // Primary: match via the linked character record.
    if (myCharacter && c.characterId && c.characterId === myCharacter.id) {
      return true;
    }
    // Fallback: match via the token's ownerUserId. This covers
    // placeholder characters or tokens that haven't synced their
    // character record yet.
    const tok = tokens[c.tokenId];
    if (tok && tok.ownerUserId === userId) return true;
    return false;
  });

  // Check if all initiatives are set (non-zero initiative OR has a
  // logged roll). The initial combat:started broadcast already carries
  // rolled values, and the server auto-rolls everyone — so we now
  // treat any combatant with non-zero initiative as "ready" even if
  // the initiative-set confirmation hasn't arrived on this client yet.
  const allReady = combatants.length > 0 && combatants.every(
    (c) => initiativeRolls.has(c.tokenId) || (c.initiative !== 0 && Number.isFinite(c.initiative)),
  );

  // Auto-close after all initiatives are ready. We track the
  // countdown via a ref + a separate render-tick state so the
  // setInterval callback never calls a parent setState (which
  // React 19 treats as "setState during render" if it happens
  // inside another setState's updater callback).
  useEffect(() => {
    if (!allReady) {
      setAutoCloseCountdown(null);
      return;
    }
    let remaining = 2;
    setAutoCloseCountdown(remaining);
    const interval = setInterval(() => {
      remaining -= 1;
      setAutoCloseCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        // Defer the parent setState to a microtask so it lands
        // outside any state-updater scope and outside the current
        // render cycle. Without this we hit React 19's "Cannot
        // update a component while rendering a different component"
        // warning when the countdown hits zero.
        Promise.resolve().then(() => onClose());
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [allReady, onClose]);

  const handleRollMyInitiative = useCallback(() => {
    if (!myCombatant) return;
    // Roll d20 + DEX modifier (initiativeBonus)
    const roll = Math.floor(Math.random() * 20) + 1;
    const total = roll + myCombatant.initiativeBonus;
    emitRollInitiative(myCombatant.tokenId, myCombatant.initiativeBonus);
    setRolledTokenIds((prev) => new Set(prev).add(myCombatant.tokenId));
  }, [myCombatant]);

  const handleRollAllNPCs = useCallback(() => {
    const npcs = combatants.filter((c) => c.isNPC && !initiativeRolls.has(c.tokenId));
    for (const npc of npcs) {
      const roll = Math.floor(Math.random() * 20) + 1;
      const total = roll + npc.initiativeBonus;
      emitSetInitiative(npc.tokenId, total);
      setRolledTokenIds((prev) => {
        const next = new Set(prev);
        next.add(npc.tokenId);
        return next;
      });
    }
  }, [combatants, initiativeRolls]);

  // Sort combatants by their known initiative value — prefer the
  // event-confirmed Map entry, fall back to the combatant's own
  // initiative field, and then to 0 (pending).
  const rollFor = (c: Combatant) => {
    const mapRoll = initiativeRolls.get(c.tokenId);
    if (mapRoll !== undefined) return mapRoll;
    if (c.initiative !== 0 && Number.isFinite(c.initiative)) return c.initiative;
    return null;
  };
  const sortedCombatants = [...combatants].sort((a, b) => {
    const ar = rollFor(a);
    const br = rollFor(b);
    if (ar !== null && br !== null) return br - ar;
    if (ar !== null) return -1;
    if (br !== null) return 1;
    return 0;
  });

  const isRolled = (c: Combatant) =>
    initiativeRolls.has(c.tokenId) ||
    (c.initiative !== 0 && Number.isFinite(c.initiative));

  const npcsNeedRoll = isDM && combatants.some(
    (c) => c.isNPC && !isRolled(c),
  );

  const myNeedsRoll = myCombatant && !isRolled(myCombatant) && !rolledTokenIds.has(myCombatant.tokenId);

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        {/* Title */}
        <h2 style={styles.title}>ROLL INITIATIVE!</h2>

        {/* Combatant list */}
        <div style={styles.combatantList}>
          {sortedCombatants.map((combatant) => {
            // Prefer the event-confirmed roll value from the Map, but
            // fall back to the combatant's own initiative field so
            // players see their value even on the instant combat:started
            // fires (before the per-combatant initiative-set events have
            // landed on their client).
            const mapRoll = initiativeRolls.get(combatant.tokenId);
            const rollResult = mapRoll !== undefined
              ? mapRoll
              : (combatant.initiative !== 0 && Number.isFinite(combatant.initiative) ? combatant.initiative : null);
            return (
              <CombatantRow
                key={combatant.tokenId}
                combatant={combatant}
                rollResult={rollResult}
              />
            );
          })}
        </div>

        {/* Action buttons */}
        <div style={styles.actions}>
          {myNeedsRoll && (
            <button style={styles.rollButton} onClick={handleRollMyInitiative}>
              Roll Initiative (d20 + {myCombatant!.initiativeBonus >= 0 ? '+' : ''}{myCombatant!.initiativeBonus})
            </button>
          )}

          {npcsNeedRoll && (
            <button style={styles.rollNpcButton} onClick={handleRollAllNPCs}>
              Roll All NPCs
            </button>
          )}
        </div>

        {/* Auto-close indicator */}
        {allReady && (
          <div style={styles.readyBanner}>
            All initiatives set! Starting combat
            {autoCloseCountdown !== null && ` in ${autoCloseCountdown}s`}...
          </div>
        )}
      </div>
    </div>
  );
}

function CombatantRow({
  combatant,
  rollResult,
}: {
  combatant: Combatant;
  rollResult: number | null;
}) {
  return (
    <div style={{
      ...styles.combatantRow,
      ...(rollResult !== null ? styles.combatantRowReady : {}),
    }}>
      {/* Portrait */}
      <div style={styles.portrait}>
        {combatant.portraitUrl ? (
          <img
            src={combatant.portraitUrl}
            alt={combatant.name}
            style={styles.portraitImg}
          />
        ) : (
          <div style={styles.portraitPlaceholder}>
            {combatant.name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Name */}
      <div style={styles.combatantInfo}>
        <span style={styles.combatantName}>{combatant.name}</span>
        <span style={styles.combatantType}>
          {combatant.isNPC ? 'NPC' : 'Player'}
        </span>
      </div>

      {/* Roll result */}
      <div style={styles.rollResult}>
        {rollResult !== null ? (
          <span style={styles.rollValue}>{rollResult}</span>
        ) : (
          <span style={styles.rollPending}>---</span>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.85)',
    zIndex: 300,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: 'fadeIn 0.3s ease',
  },
  modal: {
    width: '90%',
    maxWidth: 480,
    maxHeight: '80vh',
    background: MODAL_BG,
    borderRadius: 12,
    border: `2px solid ${ACCENT}`,
    boxShadow: `0 0 40px rgba(197, 49, 49, 0.3), 0 16px 64px rgba(0, 0, 0, 0.6)`,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  title: {
    margin: 0,
    padding: '20px 24px 12px',
    fontSize: 28,
    fontWeight: 900,
    color: ACCENT,
    fontFamily: theme.font.display,
    textAlign: 'center',
    letterSpacing: '2px',
    textShadow: '0 0 20px rgba(197, 49, 49, 0.5)',
  },
  combatantList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  combatantRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    transition: 'all 0.2s ease',
  },
  combatantRowReady: {
    background: 'rgba(197, 49, 49, 0.08)',
    border: `1px solid rgba(197, 49, 49, 0.25)`,
  },
  portrait: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    overflow: 'hidden',
    flexShrink: 0,
    border: `2px solid ${theme.border.default}`,
  },
  portraitImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  portraitPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.bg.elevated,
    color: theme.text.muted,
    fontSize: 14,
    fontWeight: 700,
  },
  combatantInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  combatantName: {
    fontSize: 13,
    fontWeight: 600,
    color: theme.text.primary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  combatantType: {
    fontSize: 10,
    color: theme.text.muted,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  rollResult: {
    width: 48,
    textAlign: 'center',
    flexShrink: 0,
  },
  rollValue: {
    fontSize: 20,
    fontWeight: 800,
    color: ACCENT,
    fontFamily: 'monospace',
  },
  rollPending: {
    fontSize: 14,
    color: theme.text.muted,
    letterSpacing: '2px',
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 16px',
  },
  rollButton: {
    padding: '12px 20px',
    background: ACCENT,
    border: 'none',
    borderRadius: 8,
    color: '#ffffff',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    transition: 'all 0.15s',
    boxShadow: `0 0 16px rgba(197, 49, 49, 0.4)`,
  },
  rollNpcButton: {
    padding: '10px 16px',
    background: 'rgba(197, 49, 49, 0.15)',
    border: `1px solid rgba(197, 49, 49, 0.4)`,
    borderRadius: 8,
    color: ACCENT,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  readyBanner: {
    padding: '12px 16px',
    background: 'rgba(197, 49, 49, 0.12)',
    borderTop: `1px solid rgba(197, 49, 49, 0.3)`,
    color: ACCENT,
    fontSize: 13,
    fontWeight: 600,
    textAlign: 'center',
    letterSpacing: '0.5px',
  },
};
