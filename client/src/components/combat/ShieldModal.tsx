import { useEffect, useState, useCallback } from 'react';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { emitShieldCast, emitCharacterUpdate, emitUseAction, emitSystemMessage } from '../../socket/emitters';

/**
 * Shield spell prompt.
 *
 * When an attack rolls high enough to hit a target, the target's
 * client is notified via `combat:attack-hit-attempt`. If the target's
 * character has Shield prepared, has a 1st-level slot, and has an
 * unspent reaction, this modal pops with a 1.4-second window to cast
 * Shield (+5 AC retroactively turns the hit into a miss if the new
 * AC makes it so).
 *
 * Shield rules (PHB):
 *   • Casting time: 1 reaction (when you are hit by an attack OR
 *     targeted by Magic Missile)
 *   • Range: Self
 *   • Duration: 1 round (until the start of your next turn)
 *   • Effect: +5 bonus to AC, including against the triggering attack;
 *     immune to Magic Missile until the spell ends
 */
interface ShieldPromptData {
  attackId: string;
  targetTokenId: string;
  attackerName: string;
  attackTotal: number;
  currentAC: number;
}

const DISMISS_MS = 1_400;

const queue: ShieldPromptData[] = [];
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

export function pushShieldOpportunity(data: ShieldPromptData) {
  if (queue.some((q) => q.attackId === data.attackId)) return;
  queue.push(data);
  notify();
}

export function ShieldModal() {
  const [, force] = useState(0);
  const myCharacter = useCharacterStore((s) => s.myCharacter);
  const userId = useSessionStore((s) => s.userId);
  const tokens = useMapStore((s) => s.tokens);

  useEffect(() => {
    const handler = () => force((n) => n + 1);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const head = queue[0];

  // Auto-dismiss after DISMISS_MS — Shield is the most time-sensitive
  // reaction so it gets the shortest window.
  useEffect(() => {
    if (!head) return;
    const t = setTimeout(() => {
      queue.shift();
      notify();
    }, DISMISS_MS);
    return () => clearTimeout(t);
  }, [head?.attackId]);

  const eligibility = head ? checkEligibility(head, myCharacter, userId, tokens) : null;

  const handleCast = useCallback(() => {
    if (!head || !eligibility?.canCast) return;
    // Burn a 1st-level slot (or higher)
    const slots = eligibility.slots;
    const slotKey = String(eligibility.slotLevel);
    const updated = {
      ...slots,
      [slotKey]: { ...slots[slotKey], used: (slots[slotKey]?.used ?? 0) + 1 },
    };
    if (myCharacter) {
      emitCharacterUpdate(myCharacter.id, { spellSlots: updated });
      useCharacterStore.getState().applyRemoteUpdate(myCharacter.id, { spellSlots: updated });
    }
    // Burn the reaction
    emitUseAction('reaction');
    // Apply the `shield-spell` condition. The roll engine reads
    // this as +5 AC (separate from Shield of Faith's `shielded`
    // which is +2). It clears at the start of the defender's next
    // turn — same flow that clears Dodge/Disengage in the server's
    // next-turn handler.
    const myToken = Object.values(tokens).find((t: any) =>
      t.characterId === myCharacter?.id || t.ownerUserId === userId,
    ) as any;
    if (myToken) {
      const next = [...((myToken.conditions || []) as string[])];
      if (!next.includes('shield-spell')) next.push('shield-spell');
      useMapStore.getState().updateToken(myToken.id, { conditions: next as any });
    }
    // Broadcast the shield cast so the attacker's resolver recomputes
    emitShieldCast({
      attackId: head.attackId,
      defenderName: myCharacter?.name ?? 'Caster',
    });
    emitSystemMessage(
      `🛡 ${myCharacter?.name ?? 'Caster'} casts SHIELD — +5 AC against ${head.attackerName}'s attack (1st-level slot, reaction)`,
    );
    queue.shift();
    notify();
  }, [head, eligibility, myCharacter, tokens, userId]);

  const handleDecline = useCallback(() => {
    if (!head) return;
    queue.shift();
    notify();
  }, [head]);

  // Auto-dismiss ineligible prompts in an effect (NOT during render).
  // The previous version used `setTimeout(..., 0)` inline in the render
  // body, which triggered React 19's "setState during render" warning
  // because the listeners.notify() it eventually called could fire
  // during a still-in-progress render of another modal in the queue.
  useEffect(() => {
    if (head && eligibility && !eligibility.canCast) {
      queue.shift();
      notify();
    }
  }, [head, eligibility?.canCast]);

  if (!head) return null;
  if (!eligibility?.canCast) return null;

  // Will Shield actually save us? Compute the new AC.
  const newAC = head.currentAC + 5;
  const stillHits = head.attackTotal >= newAC;

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
          background: '#1a1a1a',
          border: '2px solid #3498db',
          borderRadius: 12,
          padding: '18px 22px',
          minWidth: 360,
          maxWidth: 440,
          boxShadow: '0 0 40px rgba(52,152,219,0.5), 0 16px 48px rgba(0,0,0,0.7)',
          animation: 'sh-slide 0.2s ease-out',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22 }}>🛡</span>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#3498db',
              textTransform: 'uppercase', letterSpacing: '1px',
            }}>
              Shield Reaction
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#eee', marginTop: 2 }}>
              {head.attackerName} hits you ({head.attackTotal} vs AC {head.currentAC})
            </div>
          </div>
        </div>

        <div style={{
          fontSize: 12, color: '#bbb', lineHeight: 1.5,
          padding: '8px 0', borderTop: '1px solid #333',
          borderBottom: '1px solid #333', marginBottom: 12,
        }}>
          Cast <strong style={{ color: '#3498db' }}>Shield</strong> as a reaction (1st-level slot)
          for <strong>+5 AC</strong> until your next turn.{' '}
          {stillHits ? (
            <span style={{ color: '#c53131' }}>
              New AC {newAC} still won't block this attack.
            </span>
          ) : (
            <span style={{ color: '#2ecc71' }}>
              New AC {newAC} would turn this hit into a miss!
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleCast}
            style={{
              flex: 1,
              padding: '10px 14px',
              background: '#3498db',
              border: 'none',
              borderRadius: 6,
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontFamily: 'inherit',
              boxShadow: '0 0 12px rgba(52,152,219,0.4)',
            }}
          >
            🛡 Cast Shield
          </button>
          <button
            onClick={handleDecline}
            style={{
              flex: 1,
              padding: '10px 14px',
              background: 'transparent',
              border: '1px solid #444',
              borderRadius: 6,
              color: '#aaa',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Take the hit
          </button>
        </div>
      </div>

      <style>{`
        @keyframes sh-slide {
          from { transform: translateY(-10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

interface Eligibility {
  canCast: boolean;
  slotLevel: number;
  slots: Record<string, { max: number; used: number }>;
}

function checkEligibility(
  head: ShieldPromptData,
  myCharacter: any,
  userId: string | null,
  tokens: Record<string, any>,
): Eligibility {
  const empty: Eligibility = { canCast: false, slotLevel: 0, slots: {} };
  if (!myCharacter) return empty;

  // Must be the target.
  const myToken = Object.values(tokens).find((t: any) =>
    t.characterId === myCharacter.id || t.ownerUserId === userId,
  ) as any;
  if (!myToken || myToken.id !== head.targetTokenId) return empty;

  // Must have Shield in spell list.
  const spells = parseJson<any[]>(myCharacter.spells, []);
  if (!spells.some((s) => s?.name?.toLowerCase() === 'shield')) return empty;

  // Must have a slot of level ≥ 1.
  const slots = parseJson<Record<string, { max: number; used: number }>>(myCharacter.spellSlots, {});
  let slotLevel = 0;
  for (let lvl = 1; lvl <= 9; lvl++) {
    const s = slots[lvl] || slots[String(lvl)];
    if (s && (s.max - s.used) > 0) { slotLevel = lvl; break; }
  }
  if (slotLevel === 0) return empty;

  // Reaction available?
  const economy = useCombatStore.getState().actionEconomy;
  if (economy.reaction) return empty;

  return { canCast: true, slotLevel, slots };
}

function parseJson<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return (val as T) ?? fallback;
}
