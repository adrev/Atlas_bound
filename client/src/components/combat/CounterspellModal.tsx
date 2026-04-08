import { useEffect, useState, useCallback } from 'react';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { emitSystemMessage, emitCharacterUpdate, emitUseAction } from '../../socket/emitters';
import { theme } from '../../styles/theme';

/**
 * Counterspell prompt.
 *
 * When a player casts a leveled spell, every other player whose
 * character has Counterspell prepared (and an unspent reaction +
 * a slot of level >= the incoming spell's level OR a 3rd-level slot)
 * sees this prompt. Auto-dismisses after 8 seconds.
 *
 * Counterspell rules (PHB):
 *   • Casting time: 1 reaction
 *   • Range: 60 ft
 *   • Cancels a spell of 3rd level or lower automatically
 *   • Spells of 4th+ level require an ability check (DC 10 + spell level),
 *     attacker rolls a spellcasting ability check
 *   • Can be upcast: a 4th-level Counterspell auto-cancels 4th-level
 *     spells, a 5th cancels 5th, etc.
 */
interface CounterspellPromptData {
  casterTokenId: string;
  casterName: string;
  spellName: string;
  spellLevel: number;
  /** A unique cast id so the prompt can confirm/deny against it. */
  castId: string;
}

const DISMISS_MS = 8_000;

const queue: CounterspellPromptData[] = [];
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

/** Push a counterspell opportunity onto the prompt queue. */
export function pushCounterspellOpportunity(data: CounterspellPromptData) {
  if (queue.some((q) => q.castId === data.castId)) return;
  queue.push(data);
  notify();
}

export function CounterspellModal() {
  const [, force] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(DISMISS_MS / 1000);

  const myCharacter = useCharacterStore((s) => s.myCharacter);
  const userId = useSessionStore((s) => s.userId);
  const tokens = useMapStore((s) => s.tokens);

  useEffect(() => {
    const handler = () => force((n) => n + 1);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  // Verify we actually CAN counterspell — has the spell, has slot,
  // has reaction, in range. We do this here on the prompt instead
  // of relying on the server, so the player can pick the level to
  // upcast at.
  const head = queue[0];

  // Auto-dismiss
  useEffect(() => {
    if (!head) return;
    setSecondsLeft(Math.ceil(DISMISS_MS / 1000));
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, DISMISS_MS - elapsed);
      setSecondsLeft(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        clearInterval(tick);
        queue.shift();
        notify();
      }
    }, 200);
    return () => clearInterval(tick);
  }, [head?.castId]);

  // Look up my character's spells / slots / token / reaction state
  const eligibility = head ? checkEligibility(head, myCharacter, userId, tokens) : null;

  const handleCounter = useCallback((slotLevel: number) => {
    if (!head || !eligibility?.canCounter) return;

    // Burn the slot
    const slots = eligibility.slots;
    const slotKey = String(slotLevel);
    const updated = {
      ...slots,
      [slotKey]: { ...slots[slotKey], used: (slots[slotKey]?.used ?? 0) + 1 },
    };
    if (myCharacter) {
      emitCharacterUpdate(myCharacter.id, { spellSlots: updated });
      useCharacterStore.getState().applyRemoteUpdate(myCharacter.id, { spellSlots: updated });
    }

    // Burn the reaction (only fires if I'm the current combatant
    // but the server allows reaction-burn off-turn anyway).
    emitUseAction('reaction');

    // Determine outcome: auto-cancel if slotLevel >= spell.level, else needs check
    const success = slotLevel >= head.spellLevel;
    const message = success
      ? `🛑 ${myCharacter?.name ?? 'Caster'} casts COUNTERSPELL — ${head.casterName}'s ${head.spellName} (level ${head.spellLevel}) is canceled! (Counterspell at level ${slotLevel})`
      : `🛑 ${myCharacter?.name ?? 'Caster'} casts COUNTERSPELL — needs DC ${10 + head.spellLevel} ability check to cancel ${head.spellName} (DM resolves manually)`;
    emitSystemMessage(message);

    // Dispatch a window event the cast resolver listens for so it
    // can short-circuit the spell. Same-tab only — counterspeller
    // and target caster are usually the same room but the resolver
    // also listens to the chat broadcast as a fallback.
    if (success) {
      window.dispatchEvent(new CustomEvent('spell-counterspelled', {
        detail: { castId: head.castId },
      }));
    }

    queue.shift();
    notify();
  }, [head, eligibility, myCharacter]);

  const handleDecline = useCallback(() => {
    if (!head) return;
    queue.shift();
    notify();
  }, [head]);

  // Auto-dismiss ineligible prompts in an effect (NOT during render).
  // The previous version used `setTimeout(..., 0)` inline in the render
  // body, which triggered React 19's "setState during render" warning
  // because the listener-notify it eventually called could fire while
  // another component was mid-render.
  useEffect(() => {
    if (head && eligibility && !eligibility.canCounter) {
      queue.shift();
      notify();
    }
  }, [head, eligibility?.canCounter]);

  if (!head) return null;
  if (!eligibility) return null;
  if (!eligibility.canCounter) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '8vh',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          background: theme.bg.deep,
          border: `2px solid ${theme.purple}`,
          borderRadius: theme.radius.lg,
          padding: '18px 22px',
          minWidth: 380,
          maxWidth: 460,
          boxShadow: `0 0 40px rgba(155,89,182,0.5), ${theme.shadow.lg}`,
          animation: 'cs-slide 0.3s ease-out',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22 }}>🛑</span>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: theme.purple,
              textTransform: 'uppercase', letterSpacing: '1px',
            }}>
              Counterspell Opportunity
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: theme.text.primary, marginTop: 2 }}>
              {head.casterName} is casting {head.spellName}!
            </div>
          </div>
          <div style={{
            fontSize: 10, fontWeight: 700, color: theme.text.muted,
            padding: '2px 8px', background: theme.bg.elevated,
            borderRadius: 10,
          }}>
            {secondsLeft}s
          </div>
        </div>

        <div style={{
          fontSize: 12, color: theme.text.secondary, lineHeight: 1.5,
          padding: '8px 0',
          borderTop: `1px solid ${theme.border.default}`,
          borderBottom: `1px solid ${theme.border.default}`,
          marginBottom: 12,
        }}>
          <strong style={{ color: theme.text.primary }}>{head.spellName}</strong> is a level{' '}
          <strong style={{ color: theme.purple }}>{head.spellLevel}</strong> spell.
          You can cast Counterspell at level {head.spellLevel} or higher to{' '}
          <strong>auto-cancel</strong>, or at a lower level to make a DC{' '}
          {10 + head.spellLevel} ability check.
        </div>

        {/* Slot picker */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {eligibility.availableSlots.map((s) => (
            <button
              key={s}
              onClick={() => handleCounter(s)}
              style={{
                padding: '8px 12px',
                background: s >= head.spellLevel ? 'rgba(155,89,182,0.2)' : theme.gold.bg,
                border: `1px solid ${s >= head.spellLevel ? theme.purple : theme.gold.primary}`,
                borderRadius: theme.radius.sm,
                color: s >= head.spellLevel ? theme.purple : theme.gold.primary,
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: theme.font.body,
              }}
            >
              Slot L{s}{s >= head.spellLevel ? ' (auto)' : ' (check)'}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleDecline}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: 'transparent',
              border: `1px solid ${theme.border.default}`,
              borderRadius: theme.radius.sm,
              color: theme.text.secondary,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: theme.font.body,
            }}
          >
            Let it through
          </button>
        </div>
      </div>

      <style>{`
        @keyframes cs-slide {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

interface Eligibility {
  canCounter: boolean;
  availableSlots: number[];
  slots: Record<string, { max: number; used: number }>;
}

function checkEligibility(
  head: CounterspellPromptData,
  myCharacter: any,
  userId: string | null,
  tokens: Record<string, any>,
): Eligibility {
  const empty: Eligibility = { canCounter: false, availableSlots: [], slots: {} };
  if (!myCharacter) return empty;

  // Don't counterspell yourself.
  const myToken = Object.values(tokens).find((t: any) => t.characterId === myCharacter.id || t.ownerUserId === userId);
  if (!myToken || (myToken as any).id === head.casterTokenId) return empty;

  // Must have Counterspell in spell list.
  const spells = parseJson<any[]>(myCharacter.spells, []);
  const hasCounterspell = spells.some((s) => s?.name?.toLowerCase() === 'counterspell');
  if (!hasCounterspell) return empty;

  // Must have at least one slot of level 3 or higher.
  const slots = parseJson<Record<string, { max: number; used: number }>>(myCharacter.spellSlots, {});
  const availableSlots: number[] = [];
  for (let lvl = 3; lvl <= 9; lvl++) {
    const s = slots[lvl] || slots[String(lvl)];
    if (s && (s.max - s.used) > 0) availableSlots.push(lvl);
  }
  if (availableSlots.length === 0) return empty;

  // Reaction must be available — only checkable when in combat AND
  // we have an action economy entry. We don't gate on this strictly
  // because Counterspell can be cast off-turn.
  const economy = useCombatStore.getState().actionEconomy;
  if (economy.reaction) return empty;

  // Range check (60 ft) — needs both tokens.
  const caster = tokens[head.casterTokenId];
  if (caster) {
    const dx = (caster as any).x - (myToken as any).x;
    const dy = (caster as any).y - (myToken as any).y;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const gridSize = useMapStore.getState().currentMap?.gridSize ?? 70;
    const distFt = (distPx / gridSize) * 5;
    if (distFt > 60) return empty;
  }

  return { canCounter: true, availableSlots, slots };
}

function parseJson<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return (val as T) ?? fallback;
}
