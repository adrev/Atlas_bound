import { useCallback } from 'react';
import { QuickActions } from '../quickactions/QuickActions';
import { DiceTray } from '../dice/DiceTray';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitCharacterUpdate } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import type { SpellSlot } from '@dnd-vtt/shared';

/**
 * Bottom bar -- the persistent rune-slab action bar at the base of
 * the screen. Replaces the old MMO-style drag-drop Hotbar with
 * one-click access to the 5e standard actions (Dodge, Dash, etc.)
 * plus Short/Long rest, alongside the redesigned dice tray.
 *
 * Layout:
 *   [ QuickActions ............... | divider | ... DiceTray ]
 *
 * Audio controls + the "now playing" ambience status pill used to
 * live here next to the dice tray. Both moved up into the top bar
 * (next to Settings / the Free Roam badge) so session state lives
 * in one strip and the bottom bar stays focused on per-turn actions.
 */
export function BottomBar() {
  // Mirror HeroTab's defensive ownership filter: a player must only
  // ever see spell slots for a character they actually own. The DM
  // (who swaps between party members via HeroTab) keeps the active
  // character's slots without restriction. Prevents stale localStorage
  // / socket sync from leaking another PC's slot tracker to a player.
  const rawMyCharacter = useCharacterStore((s) => s.myCharacter);
  const userId = useSessionStore((s) => s.userId);
  const isDM = useSessionStore((s) => s.isDM);
  const myCharacter =
    rawMyCharacter && (isDM || rawMyCharacter.userId === userId)
      ? rawMyCharacter
      : null;

  const hasSpellSlots =
    myCharacter?.spellSlots &&
    Object.values(myCharacter.spellSlots).some((s: SpellSlot) => s.max > 0);

  return (
    <div style={styles.container}>
      <div style={styles.quickActionsSection}>
        <QuickActions />
      </div>
      {hasSpellSlots && myCharacter && (
        <>
          <div aria-hidden style={styles.divider} />
          <SpellSlotTracker
            spellSlots={myCharacter.spellSlots}
            characterId={myCharacter.id}
          />
        </>
      )}
      <div aria-hidden style={styles.divider} />
      <div style={styles.diceSection}>
        <DiceTray />
      </div>
    </div>
  );
}

function SpellSlotTracker({
  spellSlots,
  characterId,
}: {
  spellSlots: Record<number, SpellSlot>;
  characterId: string;
}) {
  const handleSlotClick = useCallback(
    (level: number, slot: SpellSlot) => {
      const newSlots = { ...spellSlots };
      if (slot.used < slot.max) {
        // Use a slot
        newSlots[level] = { ...slot, used: slot.used + 1 };
      } else {
        // Recover a slot
        newSlots[level] = { ...slot, used: Math.max(0, slot.used - 1) };
      }
      useCharacterStore.getState().updateCharacter({ spellSlots: newSlots });
      emitCharacterUpdate(characterId, { spellSlots: newSlots });
    },
    [spellSlots, characterId]
  );

  const handlePipClick = useCallback(
    (level: number, pipIndex: number, isAvailable: boolean) => {
      const slot = spellSlots[level];
      if (!slot) return;
      const newSlots = { ...spellSlots };
      if (isAvailable) {
        // Mark this slot as used
        newSlots[level] = { ...slot, used: slot.used + 1 };
      } else {
        // Recover this slot
        newSlots[level] = { ...slot, used: Math.max(0, slot.used - 1) };
      }
      useCharacterStore.getState().updateCharacter({ spellSlots: newSlots });
      emitCharacterUpdate(characterId, { spellSlots: newSlots });
    },
    [spellSlots, characterId]
  );

  const levels = Object.entries(spellSlots)
    .map(([k, v]) => [Number(k), v] as [number, SpellSlot])
    .filter(([, v]) => v.max > 0)
    .sort((a, b) => a[0] - b[0]);

  if (levels.length === 0) return null;

  return (
    <div style={slotStyles.container}>
      {levels.map(([level, slot]) => {
        const available = slot.max - slot.used;
        return (
          <div key={level} style={slotStyles.levelRow}>
            <span style={slotStyles.levelLabel}>{level}</span>
            <div style={slotStyles.pipsRow}>
              {Array.from({ length: slot.max }, (_, i) => {
                const isAvailable = i < available;
                return (
                  <button
                    key={i}
                    onClick={() => handlePipClick(level, i, isAvailable)}
                    title={
                      isAvailable
                        ? `Level ${level} slot — click to use`
                        : `Level ${level} slot (used) — click to recover`
                    }
                    style={{
                      ...slotStyles.pip,
                      background: isAvailable ? theme.gold.primary : theme.bg.deepest,
                      borderColor: isAvailable ? theme.gold.dim : theme.border.default,
                      boxShadow: isAvailable ? '0 0 4px rgba(212, 168, 67, 0.4)' : 'none',
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const slotStyles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    padding: '0 4px',
  },
  levelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
  },
  levelLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: theme.text.muted,
    fontFamily: theme.font.body,
    minWidth: 8,
    textAlign: 'center' as const,
  },
  pipsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
  },
  pip: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    border: '1.5px solid',
    padding: 0,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
    outline: 'none',
    flexShrink: 0,
  },
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    padding: `0 ${theme.space.lg}px`,
    gap: theme.space.lg,
    overflowX: 'auto',
    overflowY: 'hidden',
    // Layered background matching the tab bar's rune-slab look so the
    // bottom bar reads as a companion piece to the sidebar tabs.
    background: `linear-gradient(180deg, ${theme.bg.base} 0%, ${theme.parchmentEdge} 100%)`,
    borderTop: `1px solid ${theme.gold.border}`,
    boxShadow: `inset 0 1px 0 ${theme.border.default}`,
  },
  quickActionsSection: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  // Rune-slab vertical separator matching the tab bar spacers.
  divider: {
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
  diceSection: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    marginLeft: 'auto',
  },
};
