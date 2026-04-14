import { useState, useEffect, useCallback, useRef } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { emitRoll, emitCharacterUpdate, emitTokenUpdate, emitSystemMessage, emitTokenAdd, emitUseAction, emitDash, emitSpellCastAttempt, emitAttackHitAttempt } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import type { ActionType } from '@dnd-vtt/shared';

/**
 * Map a spell's castingTime string or a weapon's use context to the
 * action economy slot it consumes. Returns null for spells/effects
 * that don't fit the standard slots (rituals, 1 minute casts, etc.)
 * so we don't silently burn the main Action.
 */
function actionSlotForCastingTime(castingTime: string | undefined | null): ActionType | null {
  if (!castingTime) return 'action';
  const t = castingTime.toLowerCase();
  if (t.includes('bonus action')) return 'bonusAction';
  if (t.includes('reaction')) return 'reaction';
  if (t.includes('1 action') || t === 'action') return 'action';
  // Rituals, minutes, hours — not a combat action.
  return null;
}

/**
 * Check whether the current combatant still has the named slot
 * available this turn. Returns true if:
 *   • combat is inactive (free-roam rules — anything goes), OR
 *   • the token isn't the current combatant (DM moving other tokens), OR
 *   • the slot hasn't been spent yet.
 * Returns false and shows a toast if the slot is already spent. Used
 * by the weapon / spell / dash resolvers to hard-block second actions.
 */
function canSpendActionSlot(casterTokenId: string, slot: ActionType, label: string): boolean {
  const combat = useCombatStore.getState();
  if (!combat.active) return true;
  const current = combat.combatants[combat.currentTurnIndex];
  if (!current || current.tokenId !== casterTokenId) return true;
  const spent =
    slot === 'action' ? combat.actionEconomy.action :
    slot === 'bonusAction' ? combat.actionEconomy.bonusAction :
    combat.actionEconomy.reaction;
  if (!spent) return true;
  showActionDeniedToast(slot, label);
  return false;
}

/**
 * Tiny transient overlay shown when an action is rejected because the
 * slot is already spent this turn. Mirrors the movement-denied toast
 * style so both look native to the canvas.
 */
function showActionDeniedToast(slot: ActionType, label: string) {
  const slotName = slot === 'action' ? 'Action' : slot === 'bonusAction' ? 'Bonus Action' : 'Reaction';
  const hint = slot === 'reaction'
    ? 'Reactions reset at the start of your next turn.'
    : 'End your turn to reset the action economy.';
  const existing = document.getElementById('action-denied-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'action-denied-toast';
  const titleDiv = document.createElement('div');
  titleDiv.style.cssText = 'font-size:13px;font-weight:700;color:#c53131;margin-bottom:4px';
  titleDiv.textContent = `${slotName} already spent`;
  const detailDiv = document.createElement('div');
  detailDiv.style.cssText = 'font-size:11px;color:#ccc;line-height:1.5';
  detailDiv.textContent = `You've already used your ${slotName} this turn (${label}). ${hint}`;
  toast.appendChild(titleDiv);
  toast.appendChild(detailDiv);
  Object.assign(toast.style, {
    position: 'fixed', top: '18%', left: '50%',
    transform: 'translateX(-50%)',
    padding: '12px 18px', background: theme.bg.deep, color: theme.text.primary,
    borderRadius: `${theme.radius.md}px`, border: `2px solid ${theme.state.danger}`,
    zIndex: '99999', minWidth: '260px', maxWidth: '360px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}
/**
 * Show a brief toast with an Undo button after manual HP changes.
 * Clicking Undo reverts the HP to its previous value.
 */
function showHpUndoToast(
  tokenName: string,
  oldHp: number,
  newHp: number,
  isDamage: boolean,
  onUndo: () => void,
) {
  const existing = document.getElementById('hp-undo-toast');
  if (existing) existing.remove();

  const amount = Math.abs(oldHp - newHp);
  const verb = isDamage ? 'took' : 'healed';
  const amountLabel = isDamage ? `${amount} damage` : `${amount} HP`;

  const toast = document.createElement('div');
  toast.id = 'hp-undo-toast';
  Object.assign(toast.style, {
    position: 'fixed',
    top: '12%',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 16px',
    background: theme.bg.deep,
    color: theme.text.primary,
    borderRadius: `${theme.radius.md}px`,
    border: `2px solid ${isDamage ? theme.state.danger : theme.state.success}`,
    zIndex: '99999',
    minWidth: '240px',
    maxWidth: '400px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '12px',
    animation: 'slideUp 0.15s ease',
  });

  const msgSpan = document.createElement('span');
  msgSpan.style.cssText = 'flex:1;line-height:1.4';
  msgSpan.textContent = `${tokenName} ${verb} ${amountLabel} (${oldHp}\u2192${newHp})`;
  toast.appendChild(msgSpan);

  const undoBtn = document.createElement('button');
  undoBtn.textContent = 'Undo';
  Object.assign(undoBtn.style, {
    padding: '3px 10px',
    fontSize: '11px',
    fontWeight: '700',
    fontFamily: 'inherit',
    background: isDamage ? theme.state.dangerBg : theme.state.successBg,
    color: isDamage ? theme.state.danger : theme.state.success,
    border: `1px solid ${isDamage ? 'rgba(192,57,43,0.4)' : 'rgba(39,174,96,0.4)'}`,
    borderRadius: `${theme.radius.sm}px`,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: '0',
  });
  undoBtn.addEventListener('click', () => {
    onUndo();
    toast.remove();
  });
  toast.appendChild(undoBtn);

  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 5000);
}

import { enrichSpellFromDescription } from '../../utils/spell-enrich';
import { effectiveSpellSaveDC, effectiveSpellAttackBonus } from '../../utils/spell-stats';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Button } from '../ui';
import { lookupCombatAction, lookupCondition, lookupWeaponProperty } from '../../utils/rules-text';
import {
  getOwnRollModifiers,
  getTargetRollModifiers,
  combineAttackModifiers,
  rollAttackWithModifiers,
  rollSaveWithModifiers,
  effectiveAC,
  effectiveSpeed,
  applyDamageWithResist,
  hasMagicResistance,
} from '../../utils/roll-engine';
import { getSpellDurationMeta } from '../../utils/spell-durations';
import { emitApplyConditionWithMeta, emitDamageSideEffects } from '../../socket/emitters';
import { abilityModifier, calculateEquipmentBonuses, SPELL_CONDITIONS, SPELL_BUFFS, getSpellAnimation } from '@dnd-vtt/shared';
import { useEffectStore } from '../../stores/useEffectStore';
import { LootBagPanel } from '../loot/LootBagPanel';

// --- Inline Loot Section for DMs ---
const RARITY_COLORS: Record<string, string> = {
  common: '#9d9d9d', uncommon: '#1eff00', rare: '#0070dd',
  'very rare': '#a335ee', legendary: '#ff8000', artifact: '#e6cc80',
};

interface LootEntry {
  id: string; item_name: string; item_rarity: string; item_slug: string | null; custom_item_id: string | null; quantity: number; equipped?: boolean;
}

function LootButton({ characterId, tokenName }: { characterId: string; tokenName: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/characters/${characterId}/loot`)
      .then(r => r.ok ? r.json() : [])
      .then((data: LootEntry[]) => { if (!cancelled) setCount(data.reduce((s, e) => s + e.quantity, 0)); })
      .catch(() => {});

    const handler = () => {
      fetch(`/api/characters/${characterId}/loot`)
        .then(r => r.ok ? r.json() : [])
        .then((data: LootEntry[]) => { if (!cancelled) setCount(data.reduce((s, e) => s + e.quantity, 0)); })
        .catch(() => {});
    };
    window.addEventListener('loot-updated', handler);
    return () => { cancelled = true; window.removeEventListener('loot-updated', handler); };
  }, [characterId]);

  return (
    <button
      onClick={() => {
        window.dispatchEvent(new CustomEvent('open-loot-editor', {
          detail: { characterId, tokenName },
        }));
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%',
        padding: '6px 10px', marginTop: 4, borderRadius: 6,
        background: `${C.gold}11`, border: `1px solid ${C.gold}33`,
        color: C.gold, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        fontFamily: 'inherit', transition: 'background 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = `${C.gold}22`)}
      onMouseLeave={e => (e.currentTarget.style.background = `${C.gold}11`)}
    >
      <span>💰</span>
      <span style={{ flex: 1, textAlign: 'left' }}>Inventory</span>
      {count > 0 && (
        <span style={{
          fontSize: 9, fontWeight: 700, background: `${C.gold}22`,
          padding: '1px 6px', borderRadius: 8, border: `1px solid ${C.gold}44`,
        }}>{count}</span>
      )}
    </button>
  );
}

// Thin alias over the shared theme tokens. Every color in this panel
// routes through theme.ts so it stays in lockstep with the rest of the
// app. Before the unification pass this was a hardcoded grey palette
// that drifted from theme — e.g. `bg: #1a1a1a` vs theme.bg.deep
// `#12121e` — which made the Hero tab look slightly "off" from every
// other panel.
const C = {
  bg: theme.bg.deep,
  bgCard: theme.bg.card,
  bgHover: theme.bg.hover,
  border: theme.border.default,
  borderDim: theme.border.default,
  text: theme.text.primary,
  textSec: theme.text.secondary,
  textMuted: theme.text.muted,
  red: theme.state.danger,
  green: theme.state.success,
  gold: theme.gold.primary,
  blue: theme.blue,
  purple: theme.purple,
};

function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') try { return JSON.parse(val); } catch { return fallback; }
  return (val as T) ?? fallback;
}

function fmtMod(n: number): string { return n >= 0 ? `+${n}` : String(n); }

/**
 * Eagerly create a character record for a token that doesn't have one.
 * Module-level so it can be called from the fetch-useEffect (before
 * the component returns JSX). Same logic as the instance-level
 * createCharForToken helper but doesn't reference component state.
 */
async function createCharForTokenEager(
  t: { id: string; name: string; imageUrl: string | null },
  comp: any,
  currentHp: number, maxHp: number, armorClass: number, speed: number,
): Promise<string | null> {
  try {
    const resp = await fetch('/api/characters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'npc', name: t.name,
        race: comp?.type || 'monster',
        class: `CR ${comp?.challengeRating || '0'}`,
        level: 1, hitPoints: currentHp, maxHitPoints: maxHp,
        armorClass, speed,
        abilityScores: comp?.abilityScores || {},
        portraitUrl: t.imageUrl,
        compendiumSlug: comp?.slug || null,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      emitTokenUpdate(t.id, { characterId: data.id } as any);
      useCharacterStore.getState().setAllCharacters({
        ...useCharacterStore.getState().allCharacters, [data.id]: { ...data, hitPoints: currentHp },
      });
      return data.id;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Apply damage to a target after running it through the resistance /
 * immunity / vulnerability system. Reads the target character's
 * defenses arrays and any active conditions (Stoneskin, Petrified) to
 * adjust the final amount. Returns the adjusted amount and a chat
 * note describing what happened.
 */
function applyResistedDamage(
  baseAmount: number,
  damageType: string,
  targetChar: unknown,
  targetConditions: string[],
): { final: number; note: string } {
  let defenses: { resistances: string[]; immunities: string[]; vulnerabilities: string[] } = {
    resistances: [], immunities: [], vulnerabilities: [],
  };
  const tc = targetChar as { defenses?: unknown } | null | undefined;
  if (tc?.defenses) {
    if (typeof tc.defenses === 'string') {
      try { defenses = JSON.parse(tc.defenses); } catch { /* ignore */ }
    } else {
      defenses = tc.defenses as typeof defenses;
    }
  }
  const result = applyDamageWithResist(baseAmount, damageType, defenses, targetConditions, true);
  return { final: result.amount, note: result.source };
}

/**
 * Roll dice notation like "2d8", "3d6+2", "1d10" and return the actual total.
 * Used to apply real rolled damage to HP instead of averages.
 * Returns 0 if the notation can't be parsed.
 */
function rollDamageDice(notation: string): number {
  if (!notation) return 0;
  const match = notation.match(/(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?/);
  if (!match) return 0;
  const numDice = parseInt(match[1]) || 0;
  const dieSize = parseInt(match[2]) || 0;
  const sign = match[3] === '-' ? -1 : 1;
  const mod = match[4] ? parseInt(match[4]) * sign : 0;
  let total = 0;
  for (let i = 0; i < numDice; i++) {
    total += Math.floor(Math.random() * dieSize) + 1;
  }
  return Math.max(0, total + mod);
}

/**
 * Props for TokenActionPanel.
 *
 * - `embedded`: when true, render the panel inline (no fixed position,
 *   no close button) so it can be dropped into the Hero sidebar tab
 *   or any other host container. Still respects `embeddedTokenId`.
 * - `embeddedTokenId`: render the panel for a specific token instead
 *   of keying off the map's `selectedTokenId`. Used by the Hero tab
 *   so the player always sees their own character's full action panel
 *   even when another token is selected on the map. Can be undefined
 *   (character has no token placed yet) — the component shows an
 *   empty-state hint in that case.
 */
interface TokenActionPanelProps {
  embedded?: boolean;
  embeddedTokenId?: string;
}

export function TokenActionPanel({ embedded = false, embeddedTokenId }: TokenActionPanelProps = {}) {
  const isEmbedded = embedded;
  const mapSelectedTokenId = useMapStore((s) => s.selectedTokenId);
  // Effective id: when embedded, the prop wins (even if undefined);
  // otherwise fall back to whatever token is selected on the map.
  const selectedTokenId = isEmbedded ? embeddedTokenId : mapSelectedTokenId;
  const tokens = useMapStore((s) => s.tokens);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  // Subscribe to the combat store so the Combat Actions section
  // re-renders when turns advance or the DM ends combat.
  const combatActive = useCombatStore((s) => s.active);
  const currentTurnIdx = useCombatStore((s) => s.currentTurnIndex);
  const currentCombatantId = useCombatStore((s) => s.combatants[s.currentTurnIndex]?.tokenId);

  const isTargeting = useMapStore((s) => s.isTargeting);
  const targetingData = useMapStore((s) => s.targetingData);

  const [fetchedIds] = useState(() => new Set<string>());
  const [visible, setVisible] = useState(false);
  const [compendiumData, setCompendiumData] = useState<any>(null);
  const [localHp, setLocalHp] = useState<number | null>(null);
  const [localCharId, setLocalCharId] = useState<string | null>(null);
  const [lootWeapons, setLootWeapons] = useState<{ name: string; damage: string; damageType: string; properties: string[]; range?: string }[]>([]);

  useEffect(() => {
    // DON'T hide or reset if we're in targeting mode - the user is clicking a target
    const store = useMapStore.getState();
    if (store.isTargeting) return;

    if (selectedTokenId) {
      setVisible(true);
      setCompendiumData(null);
      setLocalHp(null);
      setLocalCharId(null);
      const token = tokens[selectedTokenId];

      // Fetch character data
      if (token?.characterId && !allCharacters[token.characterId] && !fetchedIds.has(token.characterId)) {
        fetchedIds.add(token.characterId);
        fetch(`/api/characters/${token.characterId}`)
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data) useCharacterStore.getState().setAllCharacters({
              ...useCharacterStore.getState().allCharacters, [token.characterId!]: data,
            });
          }).catch(() => {});
      }

      // Fetch compendium data for this creature. Prefer the stored
      // compendiumSlug (set at spawn time by CreatureLibrary) so
      // stats persist even if the token is later renamed. Fall back
      // to deriving the slug from the token name.
      if (token) {
        const char = token.characterId ? allCharacters[token.characterId] : null;
        const storedSlug = (char as any)?.compendiumSlug;
        const derivedSlug = token.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const slug = storedSlug || derivedSlug;
        // Custom homebrew creatures use a different route.
        const route = slug.startsWith('custom-')
          ? `/api/custom/monsters/${slug}`
          : `/api/compendium/monsters/${slug}`;
        fetch(route)
          .then(r => r.ok ? r.json() : null)
          .then(async (data) => {
            if (!data) return;
            setCompendiumData(data);
            // Eagerly create a character record for legacy tokens that
            // were spawned before CreatureLibrary started auto-creating
            // them. Without a characterId, the Inventory button won't
            // show and the combat system can't track HP properly.
            const freshToken = useMapStore.getState().tokens[selectedTokenId!];
            if (freshToken && !freshToken.characterId) {
              const hp = data.hitPoints ?? 10;
              const ac = data.armorClass ?? 10;
              const spd = data.speed?.walk ?? 30;
              const id = await createCharForTokenEager(freshToken, data, hp, hp, ac, spd);
              if (id) setLocalCharId(id);
            }
          })
          .catch(() => {});
      }
    } else {
      setVisible(false);
    }
  }, [selectedTokenId, tokens, allCharacters, fetchedIds]);

  // Handle targeting: MUST be before any early returns (Rules of Hooks)
  useEffect(() => {
    if (!isTargeting || !targetingData) return;

    const handleTargetSelect = async (e: Event) => {
      const currentTargeting = useMapStore.getState().targetingData;
      if (!currentTargeting) return;

      const detail = (e as CustomEvent).detail;
      if (!detail?.tokenId) return;
      const targetTokenId = detail.tokenId;
      const targetToken = useMapStore.getState().tokens[targetTokenId];
      if (!targetToken) return;

      // Range check: calculate distance between caster and target
      const casterTok = useMapStore.getState().tokens[currentTargeting.casterTokenId];
      if (casterTok) {
        const gridSize = useMapStore.getState().currentMap?.gridSize ?? 70;
        const dx = targetToken.x - casterTok.x;
        const dy = targetToken.y - casterTok.y;
        const distFeet = Math.round(Math.sqrt(dx * dx + dy * dy) / gridSize) * 5;

        // Determine max range
        let maxRange = 5; // Default melee range (5ft)
        if (currentTargeting.spell) {
          const rangeStr = currentTargeting.spell.range || '';
          const rangeMatch = rangeStr.match(/(\d+)\s*(feet|ft)/i);
          if (rangeMatch) maxRange = parseInt(rangeMatch[1]);
          else if (rangeStr.toLowerCase().includes('touch')) maxRange = 5;
          else if (rangeStr.toLowerCase().includes('self')) maxRange = 999; // Self spells — AoE from caster, no range limit on target selection
          else maxRange = 30; // Default spell range if not specified
        } else if (currentTargeting.weapon) {
          const props: string[] = currentTargeting.weapon.properties || [];
          const isThrown = props.some((p: string) => p.toLowerCase().includes('thrown'));
          const isRanged = props.some((p: string) => p.toLowerCase().includes('range'));
          // Try to parse actual range from weapon data (e.g. "80/320" or "20/60")
          const weaponRange = currentTargeting.weapon.range;
          const parsedRange = weaponRange ? parseInt(String(weaponRange).split('/')[0]) : 0;

          if (parsedRange > 0) {
            maxRange = parsedRange;
          } else if (isRanged) {
            maxRange = 80;
          } else if (isThrown) {
            maxRange = 20;
          } else {
            maxRange = 5;
          }
        } else if (currentTargeting.action) {
          // Parse range from action description
          const desc = currentTargeting.action.desc || '';
          const rangeMatch = desc.match(/range\s+(\d+)/i);
          if (rangeMatch) maxRange = parseInt(rangeMatch[1]);
          else if (desc.toLowerCase().includes('melee')) maxRange = 5;
          else maxRange = 30;
        }

        // Allow self-targeting (distance 0)
        if (targetTokenId === currentTargeting.casterTokenId) {
          // Self-targeting always allowed
        } else if (distFeet > maxRange) {
          // Show visible toast notification
          const toast = document.createElement('div');
          const titleDiv = document.createElement('div');
          titleDiv.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:4px';
          titleDiv.textContent = 'Out of Range!';
          const detailDiv = document.createElement('div');
          detailDiv.style.cssText = 'font-size:12px;opacity:0.8';
          detailDiv.textContent = `${targetToken.name} is ${distFeet}ft away. Max range: ${maxRange}ft.`;
          toast.appendChild(titleDiv);
          toast.appendChild(detailDiv);
          Object.assign(toast.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            padding: '16px 24px', background: theme.bg.deep, color: theme.text.primary, borderRadius: `${theme.radius.lg}px`,
            border: `2px solid ${theme.state.danger}`, zIndex: '99999', textAlign: 'center',
            boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 15px rgba(197,49,49,0.3)',
          });
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 2500);
          // Don't cancel targeting - let them pick another target
          return;
        }
      }

      let targetChar = targetToken.characterId ? useCharacterStore.getState().allCharacters[targetToken.characterId] : null;

      // Ensure target has a character record
      let charId = targetToken.characterId;
      if (!charId || !targetChar) {
        console.log('[TARGETING] Creating character for', targetToken.name);
        const slug = targetToken.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        try {
          // Try compendium lookup
          const compResp = await fetch(`/api/compendium/monsters/${slug}`);
          const comp = compResp.ok ? await compResp.json() : null;

          const createResp = await fetch('/api/characters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: 'npc',
              name: targetToken.name,
              race: comp?.type || 'monster',
              class: `CR ${comp?.challengeRating || '0'}`,
              level: 1,
              hitPoints: comp?.hitPoints || 10,
              maxHitPoints: comp?.hitPoints || 10,
              armorClass: comp?.armorClass || 10,
              speed: comp?.speed?.walk || 30,
              abilityScores: comp?.abilityScores || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              portraitUrl: targetToken.imageUrl,
            }),
          });

          if (createResp.ok) {
            const charData = await createResp.json();
            charId = charData.id;
            console.log('[TARGETING] Created character:', charId, 'for', targetToken.name);
            // Update token with character link - BOTH server and local store
            emitTokenUpdate(targetToken.id, { characterId: charId } as any);
            useMapStore.getState().updateToken(targetToken.id, { characterId: charId } as any);
            // Add to character store
            useCharacterStore.getState().setAllCharacters({
              ...useCharacterStore.getState().allCharacters,
              [charId!]: charData,
            });
            targetChar = charData;
          } else {
            console.error('[TARGETING] Failed to create character:', await createResp.text());
          }
        } catch (err) {
          console.error('[TARGETING] Error creating character:', err);
        }
      }

      if (!charId) {
        console.error('[TARGETING] Cannot apply damage - no character ID');
        // Still announce the action in chat even if we can't apply damage
      }

      const effectiveCharId: string | null = charId ?? null;
      const targetHp = targetChar?.hitPoints ?? 0;
      const targetMaxHp = targetChar?.maxHitPoints ?? 0;

      // Helper to update HP both on server and locally
      const updateTargetHp = (cid: string, newHp: number) => {
        const chars = useCharacterStore.getState().allCharacters;
        const targetCharData = chars[cid];
        const oldHp = targetCharData?.hitPoints ?? 0;
        const damageTaken = Math.max(0, oldHp - newHp);

        emitCharacterUpdate(cid, { hitPoints: newHp });
        if (targetCharData) {
          useCharacterStore.getState().setAllCharacters({
            ...chars, [cid]: { ...chars[cid], hitPoints: newHp },
          });
        }

        // Concentration save when taking damage
        if (damageTaken > 0 && targetCharData?.concentratingOn) {
          const dc = Math.max(10, Math.floor(damageTaken / 2));
          const conScore = typeof targetCharData.abilityScores === 'string'
            ? JSON.parse(targetCharData.abilityScores).con || 10
            : (targetCharData.abilityScores as any)?.con || 10;
          const conMod = Math.floor((conScore - 10) / 2);
          const saveRoll = Math.floor(Math.random() * 20) + 1;
          const total = saveRoll + conMod;
          const saved = total >= dc;

          setTimeout(() => {
            emitRoll(`1d20+${conMod}`,
              `${targetCharData.name} Concentration Save (DC ${dc}): ${total} — ${saved ? 'MAINTAINED!' : 'LOST!'}`
            );
            if (!saved) {
              emitCharacterUpdate(cid, { concentratingOn: null });
              useCharacterStore.getState().applyRemoteUpdate(cid, { concentratingOn: null });
            }
          }, 800);
        }
      };

      const casterToken = useMapStore.getState().tokens[currentTargeting.casterTokenId];
      const casterChar = casterToken?.characterId ? useCharacterStore.getState().allCharacters[casterToken.characterId] : null;
      // Use the effective DC helpers — they recompute from class+ability if
      // the stored field looks like a stale placeholder default.
      const casterSpellDC = effectiveSpellSaveDC(casterChar);
      const casterSpellAttack = effectiveSpellAttackBonus(casterChar);

      console.log('[TARGETING] Processing action:', {
        spell: currentTargeting.spell?.name,
        weapon: currentTargeting.weapon?.name,
        action: currentTargeting.action?.name,
        effectiveCharId,
        targetHp,
        targetMaxHp,
      });

      if (currentTargeting.spell) {
        const spell = currentTargeting.spell;
        const casterName = currentTargeting.casterName;
        const targetName = targetToken.name;
        const casterId = casterChar?.id || currentTargeting.casterTokenId;

        // --- Phase 9: Trigger spell animation ---
        const spellAnim = getSpellAnimation(spell.name);
        if (spellAnim) {
          const casterPos = casterToken ? { x: (casterToken as any).x, y: (casterToken as any).y } : { x: 0, y: 0 };
          const targetPos = { x: (targetToken as any).x, y: (targetToken as any).y };
          useEffectStore.getState().addAnimation({
            id: `spell-${Date.now()}`,
            casterPosition: casterPos,
            targetPosition: targetPos,
            animationType: spellAnim.type,
            color: spellAnim.color,
            secondaryColor: spellAnim.secondaryColor || spellAnim.color,
            duration: spellAnim.duration,
            particleCount: spellAnim.particleCount || 20,
            startedAt: Date.now(),
          });
        }

        // --- Gate: check that the required action slot is still
        // available BEFORE we spend the spell slot / trigger animations.
        // If the player has already taken their Action this turn and
        // tries to cast another Action-cost spell, we bail out so they
        // don't lose their slot on a refused cast.
        {
          const precheckSlot = actionSlotForCastingTime(spell.castingTime);
          if (precheckSlot && !canSpendActionSlot(
            currentTargeting.casterTokenId,
            precheckSlot,
            spell.name,
          )) {
            useMapStore.getState().cancelTargetingMode();
            return;
          }
        }

        // --- Phase 2: Spell Slot Consumption (with upcast fallback) ---
        // A spell of level N can be cast with any slot ≥ N. Pick the lowest
        // available so we don't waste high-level slots. Block the cast if
        // no slot at level N or higher is available.
        // Two DM overrides bypass both the consumption and the availability
        // check: the GLOBAL toggle (dmIgnoreSpellSlots), and a PER-SPELL
        // flag (spell.dmOverride) for granting individual story-moment
        // spells without unlocking everything.
        //
        // ORDER MATTERS: spell slot is consumed BEFORE the counterspell
        // window (per RAW, a counterspelled spell still burns its slot).
        let castAtLevel = spell.level;
        let dmOverride = false;
        const isRitualCast = !!(spell as any).__isRitual;
        if (spell.level > 0 && casterChar) {
          const dmIgnoreSlots = useSessionStore.getState().dmIgnoreSpellSlots;
          if (dmIgnoreSlots || spell.dmOverride) {
            dmOverride = true;
          } else if (isRitualCast) {
            // Ritual cast — no slot consumed, announce in chat
            dmOverride = true;
            emitSystemMessage(`✦ ${casterName} casts ${spell.name} as a Ritual (no slot, +10 min casting time).`);
          } else {
            const slots = typeof casterChar.spellSlots === 'string'
              ? JSON.parse(casterChar.spellSlots) : (casterChar.spellSlots || {});
            let chosenLevel: number | null = null;
            for (let lvl = spell.level; lvl <= 9; lvl++) {
              const s = slots[lvl] || slots[String(lvl)];
              if (s && (s.max - s.used) > 0) { chosenLevel = lvl; break; }
            }
            if (chosenLevel === null) {
              emitSystemMessage(`✦ ${casterName} tried to cast ${spell.name} (level ${spell.level}) but has no available slots of level ${spell.level} or higher!`);
              useMapStore.getState().cancelTargetingMode();
              return;
            }
            castAtLevel = chosenLevel;
            const slotKey = slots[chosenLevel] ? chosenLevel : String(chosenLevel);
            const slot = slots[slotKey];
            const updatedSlots = { ...slots, [slotKey]: { ...slot, used: slot.used + 1 } };
            emitCharacterUpdate(
              casterChar.id || currentTargeting.casterTokenId,
              { spellSlots: updatedSlots },
            );
          }
        }
        // Stash for the header below
        (spell as any).__dmOverride = dmOverride;

        // --- Action economy consumption ---
        // Per RAW, the Action is spent regardless of whether the spell
        // is counterspelled. Consume it BEFORE the counterspell window
        // so a counterspelled cast still uses up the slot.
        {
          const slot = actionSlotForCastingTime(spell.castingTime);
          const inCombat = useCombatStore.getState().active;
          const current = useCombatStore.getState().combatants[useCombatStore.getState().currentTurnIndex];
          const isCurrentCaster = current?.tokenId === currentTargeting.casterTokenId;
          if (slot && inCombat && isCurrentCaster) {
            emitUseAction(slot);
          }
        }

        // --- Counterspell window ---
        // Broadcast the cast attempt and pause briefly so any other
        // player with Counterspell prepared can respond. If they
        // respond with a counterspell, abort the cast — slot and
        // action are already gone (correct per RAW).
        if (spell.level > 0) {
          const counterspelled = await broadcastCastAndAwaitCounterspell({
            casterTokenId: currentTargeting.casterTokenId,
            casterName,
            spellName: spell.name,
            spellLevel: castAtLevel,
          });
          if (counterspelled) {
            emitSystemMessage(`✦ ${casterName} casts ${spell.name} — COUNTERSPELLED, slot wasted.`);
            useMapStore.getState().cancelTargetingMode();
            return;
          }
        }

        // --- Phase 4: Concentration ---
        // Set ONLY after the counterspell check passes — a
        // counterspelled spell never takes effect, so it shouldn't
        // change concentration state.
        if (spell.isConcentration && casterChar) {
          const currentConc = casterChar.concentratingOn;
          if (currentConc) {
            emitSystemMessage(`✦ ${casterName} drops concentration on ${currentConc}`);
          }
          emitCharacterUpdate(casterId, { concentratingOn: spell.name });
          useCharacterStore.getState().applyRemoteUpdate(casterId, { concentratingOn: spell.name });
        }

        // --- Resolve damage dice and spell properties from description ---
        // Strip HTML for clean parsing
        const cleanDesc = (spell.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
        let damageDice = spell.damage || '';
        let resolvedAttackType = spell.attackType || '';
        let resolvedSavingThrow = spell.savingThrow || '';

        // Parse from spell description
        if (!damageDice) {
          const dmgMatch = cleanDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+\w*\s*damage/i);
          if (dmgMatch) damageDice = dmgMatch[1].replace(/\s/g, '');
        }
        if (!resolvedAttackType) {
          if (cleanDesc.match(/ranged spell attack/i)) resolvedAttackType = 'ranged';
          else if (cleanDesc.match(/melee spell attack/i)) resolvedAttackType = 'melee';
        }
        if (!resolvedSavingThrow) {
          const saveMatch = cleanDesc.match(/(?:must\s+(?:succeed|make)\s+.*?|succeed\s+on\s+.*?)(strength|dexterity|constitution|wisdom|intelligence|charisma)\s+saving\s+throw/i);
          if (saveMatch) {
            const abilityMap: Record<string, string> = { strength: 'str', dexterity: 'dex', constitution: 'con', wisdom: 'wis', intelligence: 'int', charisma: 'cha' };
            resolvedSavingThrow = abilityMap[saveMatch[1].toLowerCase()] || '';
          }
        }

        // Fallback: lookup compendium for damage
        if (!damageDice) {
          try {
            const slug = spell.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const compResp = await fetch(`/api/compendium/spells/${slug}`);
            if (compResp.ok) {
              const compSpell = await compResp.json();
              const compDesc = (compSpell.description || '').replace(/<[^>]*>/g, ' ');
              const descMatch = compDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+\w*\s*damage/i);
              if (descMatch) damageDice = descMatch[1].replace(/\s/g, '');
              if (!resolvedSavingThrow) {
                const saveM = compDesc.match(/(strength|dexterity|constitution|wisdom|intelligence|charisma)\s+saving\s+throw/i);
                if (saveM) {
                  const am: Record<string, string> = { strength: 'str', dexterity: 'dex', constitution: 'con', wisdom: 'wis', intelligence: 'int', charisma: 'cha' };
                  resolvedSavingThrow = am[saveM[1].toLowerCase()] || '';
                }
              }
              if (!resolvedAttackType) {
                if (compDesc.match(/ranged spell attack/i)) resolvedAttackType = 'ranged';
                else if (compDesc.match(/melee spell attack/i)) resolvedAttackType = 'melee';
              }
            }
          } catch {}
        }

        // --- Phase 5: Cantrip scaling ---
        if (spell.level === 0 && damageDice) {
          const casterLevel = casterChar?.level ?? 1;
          const tier = casterLevel >= 17 ? 4 : casterLevel >= 11 ? 3 : casterLevel >= 5 ? 2 : 1;
          if (tier > 1) {
            damageDice = damageDice.replace(/(\d+)d(\d+)/, (_: string, n: string, d: string) => `${parseInt(n) * tier}d${d}`);
          }
        }

        // --- Phase 5b: Upcast scaling (Fireball +1d6/level, etc.) ---
        // Only relevant for leveled spells cast above their base level.
        // Reads the spell description for "the damage increases by Xd6
        // for each slot level above Yth" and adds the bonus dice.
        let upcastNote: string | null = null;
        if (spell.level > 0 && damageDice && castAtLevel > spell.level) {
          const upcast = applyUpcastDamage(
            damageDice,
            spell.description || '',
            spell.level,
            castAtLevel,
          );
          if (upcast.bonusDice) {
            damageDice = upcast.dice;
            upcastNote = `   Upcast: ${upcast.bonusDice} (${upcast.extraLevels} level${upcast.extraLevels !== 1 ? 's' : ''} above ${spell.level})`;
          }
        }

        // Check if spell allows half damage on save
        const desc = (spell.description || '').toLowerCase();
        const halfOnSave = desc.includes('half as much damage') || desc.includes('half damage') || desc.includes('save for half');
        const isHealing = spell.name.toLowerCase().includes('heal') || spell.name.toLowerCase().includes('cure') || desc.includes('regains') || desc.includes('hit points equal to');
        // Self-range spells are now handled by castSelfSpell() directly from the cast button.
        // If we somehow got here with a Self spell, just cancel and resolve via the helper.
        const isSelfRange = (spell.range || '').toLowerCase().includes('self');
        if (isSelfRange && !isHealing) {
          useMapStore.getState().cancelTargetingMode();
          castSelfSpell(spell, currentTargeting.casterTokenId, casterName);
          return;
        }

        // Build a single consolidated result message for this cast.
        const headerLines: string[] = [`✦ ${casterName} casts ${spell.name} → ${targetName}`];
        if (spell.level > 0) {
          if ((spell as any).__dmOverride) {
            headerLines.push(`   🔓 DM override (no slot consumed)`);
          } else if (castAtLevel > spell.level) {
            headerLines.push(`   Spent level ${castAtLevel} slot (upcast from level ${spell.level})`);
          } else {
            headerLines.push(`   Spent level ${spell.level} slot`);
          }
        }
        if (upcastNote) headerLines.push(upcastNote);
        delete (spell as any).__dmOverride;
        const resultParts: string[] = [];
        const dmgType = (spell.damageType || '').toLowerCase();
        const dmgWord = dmgType ? `${dmgType} ` : '';

        // Read attacker (caster) and target conditions for the rules engine
        const casterToken_local = useMapStore.getState().tokens[currentTargeting.casterTokenId];
        const casterConditions = (casterToken_local?.conditions || []) as string[];
        const targetConditions = (targetToken.conditions || []) as string[];

        // --- Phase 3A: Spell Attack vs AC ---
        if (resolvedAttackType) {
          // Build attacker + target modifiers and combine for the attack
          const attackerOwn = getOwnRollModifiers(casterConditions);
          const targetIncoming = getTargetRollModifiers(targetConditions);
          const combined = combineAttackModifiers(attackerOwn, targetIncoming);

          const atkResult = rollAttackWithModifiers(casterSpellAttack, combined);
          // Effective AC accounts for Hasted +2, Shielded +2, Mage Armor floor, etc.
          const baseAC = targetChar?.armorClass ?? 10;
          const targetScores2 = targetChar?.abilityScores
            ? (typeof targetChar.abilityScores === 'string' ? JSON.parse(targetChar.abilityScores) : targetChar.abilityScores)
            : {};
          const targetDexMod = abilityModifier((targetScores2 as any).dex || 10);
          const acResult = effectiveAC(baseAC, targetConditions, targetDexMod);
          let targetAC = acResult.value;
          // Crit on nat 20 OR forced crit (Paralyzed/Unconscious melee within 5ft)
          let isHit = atkResult.isCritical || (!atkResult.isFumble && atkResult.total >= targetAC);
          let isCrit = atkResult.isCritical || (isHit && atkResult.forceCritOnHit && resolvedAttackType === 'melee');

          // Shield reaction window — if the attack would hit, give
          // the target a chance to cast Shield. If they do, recompute
          // hit with AC+5 and (if it now misses) flip the result.
          // Early-out for NPC targets (no one to cast Shield) so we
          // don't pause every enemy attack by 1.5 s.
          let shieldNote = '';
          if (isHit && !atkResult.isCritical && targetToken.ownerUserId) {
            const shielded = await broadcastHitAndAwaitShield({
              targetTokenId: targetToken.id,
              attackerName: casterName,
              attackTotal: atkResult.total,
              currentAC: targetAC,
            });
            if (shielded) {
              targetAC += 5;
              const newHit = atkResult.total >= targetAC;
              if (!newHit) {
                isHit = false;
                isCrit = false;
                shieldNote = ' [Shield +5 AC → MISS]';
              } else {
                shieldNote = ' [Shield +5 AC → still hits]';
              }
            }
          }

          const hitIcon = isCrit ? '💥' : isHit ? '✓' : '✗';
          // Show breakdown so the user can see condition effects in the math
          const acNote = acResult.notes.length > 0 ? ` (base ${acResult.base}${acResult.notes.map(n => ' ' + n).join('')})` : '';
          const modNote = combined.notes.length > 0 ? ` [${combined.notes.join(', ')}]` : '';
          resultParts.push(`${hitIcon} Attack ${atkResult.breakdown} vs AC ${targetAC}${acNote} → ${isCrit ? 'CRIT' : isHit ? 'HIT' : 'MISS'}${modNote}${shieldNote}`);

          if (isHit && damageDice && effectiveCharId) {
            const finalDice = isCrit ? damageDice.replace(/(\d+)d/, (_: string, n: string) => `${parseInt(n) * 2}d`) : damageDice;
            const rolledDmg = rollDamageDice(finalDice);
            const freshChar = useCharacterStore.getState().allCharacters[effectiveCharId];
            const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : targetHp;
            const resisted = applyResistedDamage(rolledDmg, dmgType, freshChar, targetConditions);
            const newHp = Math.max(0, freshHp - resisted.final);
            const resistTag = resisted.note ? ` [${resisted.note}]` : '';
            const dmgChange = resisted.final !== rolledDmg ? `${rolledDmg}→${resisted.final}` : `${resisted.final}`;
            resultParts.push(`${dmgChange} ${dmgWord}dmg${resistTag} (HP ${freshHp}→${newHp})${isCrit ? ' [CRIT]' : ''}`);
            if (newHp === 0) resultParts.push('💀 DOWN');
            setTimeout(() => {
              updateTargetHp(effectiveCharId, newHp);
              // Trigger CON save for concentration + clear endsOnDamage conditions
              if (resisted.final > 0) emitDamageSideEffects(targetToken.id, resisted.final);
            }, 400);
          }
        }

        // --- Phase 3B: Saving Throw ---
        else if (resolvedSavingThrow) {
          const saveAbility = resolvedSavingThrow;
          const targetScores = targetChar?.abilityScores
            ? (typeof targetChar.abilityScores === 'string' ? JSON.parse(targetChar.abilityScores) : targetChar.abilityScores)
            : {};
          const targetSaveMod = abilityModifier(targetScores[saveAbility] || 10);

          // Apply save modifiers from target's conditions (Bless +1d4,
          // Paralyzed auto-fail STR/DEX, Hasted DEX advantage, etc.)
          const targetMods = getOwnRollModifiers(targetConditions);
          // Magic Resistance: target gets advantage on ALL saves vs spells.
          // Stacks with the existing per-condition advantage flags.
          if (hasMagicResistance(targetChar)) {
            (targetMods.saveAdvantage as any)[saveAbility] = 'advantage';
            targetMods.notes.push('Magic Resistance (adv. vs spells)');
          }
          const saveResult = rollSaveWithModifiers(saveAbility as any, targetSaveMod, targetMods);
          const saved = saveResult.autoFailed ? false : saveResult.total >= casterSpellDC;
          const saveIcon = saved ? '✓' : '✗';
          const modNote = targetMods.notes.length > 0 ? ` [${targetMods.notes.join(', ')}]` : '';
          resultParts.push(`${saveIcon} ${saveAbility.toUpperCase()} ${saveResult.breakdown} vs DC ${casterSpellDC} → ${saved ? 'SAVED' : 'FAILED'}${modNote}`);

          if (damageDice && effectiveCharId) {
            const total = rollDamageDice(damageDice);
            const dmg = saved && halfOnSave ? Math.floor(total / 2) : saved ? 0 : total;
            if (dmg > 0) {
              const freshChar = useCharacterStore.getState().allCharacters[effectiveCharId];
              const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : targetHp;
              const resisted = applyResistedDamage(dmg, dmgType, freshChar, targetConditions);
              const newHp = Math.max(0, freshHp - resisted.final);
              const resistTag = resisted.note ? ` [${resisted.note}]` : '';
              const dmgChange = resisted.final !== dmg ? `${dmg}→${resisted.final}` : `${resisted.final}`;
              resultParts.push(`${dmgChange} ${dmgWord}dmg${saved ? ' (half)' : ''}${resistTag} (HP ${freshHp}→${newHp})`);
              if (newHp === 0) resultParts.push('💀 DOWN');
              setTimeout(() => {
                updateTargetHp(effectiveCharId, newHp);
                if (resisted.final > 0) emitDamageSideEffects(targetToken.id, resisted.final);
              }, 400);
            } else if (saved && !halfOnSave) {
              resultParts.push('no damage');
            }
          }

          // Auto-apply conditions on failed save WITH duration metadata
          // so the server tracks Hold Person re-rolls, Sleep ends-on-damage,
          // Bless's 10-round timer, etc.
          if (!saved) {
            const conditions = SPELL_CONDITIONS[spell.name];
            if (conditions && conditions.length > 0) {
              resultParts.push(`now ${conditions.join(', ')}`);
              const durMeta = getSpellDurationMeta(spell.name);
              const currentRound = useCombatStore.getState().roundNumber || 0;
              const expiresAfterRound = currentRound > 0
                ? currentRound + durMeta.durationRounds - 1
                : undefined;
              const saveRetry = durMeta.saveAbility ? {
                ability: durMeta.saveAbility,
                dc: casterSpellDC,
              } : undefined;
              setTimeout(() => {
                const targetTokenData = useMapStore.getState().tokens[targetToken.id];
                if (targetTokenData) {
                  // Local-only visual feedback. We intentionally do NOT
                  // call emitTokenUpdate for conditions anymore — the
                  // server now rejects self-condition updates from
                  // non-DMs. The authoritative condition comes back via
                  // condition:apply-with-meta's broadcast.
                  const existingConditions = targetTokenData.conditions || [];
                  const newConditions = [...new Set([...existingConditions, ...conditions])] as any;
                  useMapStore.getState().updateToken(targetToken.id, { conditions: newConditions });
                  for (const condName of conditions) {
                    emitApplyConditionWithMeta({
                      targetTokenId: targetToken.id,
                      conditionName: condName,
                      source: spell.name,
                      casterTokenId: spell.isConcentration ? currentTargeting.casterTokenId : undefined,
                      expiresAfterRound,
                      saveAtEndOfTurn: saveRetry,
                      endsOnDamage: durMeta.endsOnDamage,
                    });
                  }
                }
              }, 600);
            }
          }
        }

        // --- Healing spells ---
        else if (isHealing) {
          const healDice = damageDice || '1d8';
          const heal = rollDamageDice(healDice) + (casterSpellAttack > 0 ? Math.floor(casterSpellAttack / 2) : 0);
          if (effectiveCharId) {
            const freshChar = useCharacterStore.getState().allCharacters[effectiveCharId];
            const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : targetHp;
            const newHp = Math.min(targetMaxHp, freshHp + heal);
            resultParts.push(`+${heal} HP (${freshHp}→${newHp})`);
            updateTargetHp(effectiveCharId, newHp);
          } else {
            resultParts.push(`+${heal} HP healed`);
          }
        }

        // --- Damage only (no attack, no save) ---
        else if (damageDice) {
          const dmg = rollDamageDice(damageDice);
          if (effectiveCharId) {
            const freshChar = useCharacterStore.getState().allCharacters[effectiveCharId];
            const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : targetHp;
            const resisted = applyResistedDamage(dmg, dmgType, freshChar, targetConditions);
            const newHp = Math.max(0, freshHp - resisted.final);
            const resistTag = resisted.note ? ` [${resisted.note}]` : '';
            const dmgChange = resisted.final !== dmg ? `${dmg}→${resisted.final}` : `${resisted.final}`;
            resultParts.push(`${dmgChange} ${dmgWord}dmg${resistTag} (HP ${freshHp}→${newHp})`);
            if (newHp === 0) resultParts.push('💀 DOWN');
            updateTargetHp(effectiveCharId, newHp);
            if (resisted.final > 0) emitDamageSideEffects(targetToken.id, resisted.final);
          } else {
            resultParts.push(`${dmg} ${dmgWord}dmg`);
          }
        }

        // --- No effect spell (buff, utility) ---
        else {
          // Check if it's a known buff spell. Apply the buff badge AND
          // register duration metadata so the server expires it
          // automatically (Bless after 10 rounds, Mage Armor 8 hours, etc.)
          const buffs = SPELL_BUFFS[spell.name];
          if (buffs && buffs.length > 0) {
            resultParts.push(`now ${buffs.join(', ')}`);
            const targetTokenData = useMapStore.getState().tokens[targetToken.id];
            if (targetTokenData) {
              // Local optimistic update only — the server broadcasts
              // the authoritative condition via the condition:apply-
              // with-meta handler. Never call emitTokenUpdate for
              // conditions on the caster's own token — the server
              // rejects it for non-DMs now.
              const existing = targetTokenData.conditions || [];
              const newConds = [...new Set([...existing, ...buffs])] as any;
              useMapStore.getState().updateToken(targetToken.id, { conditions: newConds });
              const durMeta = getSpellDurationMeta(spell.name);
              const currentRound = useCombatStore.getState().roundNumber || 0;
              const expiresAfterRound = currentRound > 0
                ? currentRound + durMeta.durationRounds - 1
                : undefined;
              for (const buffName of buffs) {
                emitApplyConditionWithMeta({
                  targetTokenId: targetToken.id,
                  conditionName: buffName,
                  source: spell.name,
                  casterTokenId: spell.isConcentration ? currentTargeting.casterTokenId : undefined,
                  expiresAfterRound,
                });
              }
            }
          } else {
            resultParts.push('cast successfully');
          }
        }

        emitSystemMessage([...headerLines, `   • ${targetName}: ${resultParts.join(' • ')}`].join('\n'));
      }

      if (currentTargeting.weapon || currentTargeting.action) {
        const atk = currentTargeting.weapon || currentTargeting.action;
        const atkBonus = atk.attack_bonus ?? 0;
        const dmgDice = atk.damage_dice || atk.damage || '1d6';

        // Weapon attacks and generic creature actions consume the Action
        // slot by default. Off-hand weapon attacks (two-weapon fighting)
        // override to bonusAction via __actionSlot on the atk object.
        // Multiattack is still one Action — it counts as a single Attack
        // action in 5e. We GATE the attack behind canSpendActionSlot so
        // a second action-cost attack this turn is refused outright.
        const atkSlot: ActionType = (atk as any).__actionSlot ?? 'action';
        if (!canSpendActionSlot(currentTargeting.casterTokenId, atkSlot, atk.name)) {
          useMapStore.getState().cancelTargetingMode();
          return;
        }
        {
          const inCombatA = useCombatStore.getState().active;
          const currentA = useCombatStore.getState().combatants[useCombatStore.getState().currentTurnIndex];
          const isCurrentAttacker = currentA?.tokenId === currentTargeting.casterTokenId;
          if (inCombatA && isCurrentAttacker) {
            emitUseAction(atkSlot);
          }
        }
        // Detect Thrown property — we'll drop the weapon from inventory + spawn
        // an item token at the target's location after the attack resolves.
        const wIsThrown = ((atk.properties as string[] | undefined) || []).some(p => p.toLowerCase() === 'thrown');
        const wThrownInventoryIdx = (atk as any).inventoryIndex as number | undefined;
        // Detect damage type from atk fields or damage_dice (e.g. "1d6 piercing")
        let weaponDmgType = (atk.damageType || atk.damage_type || '').toLowerCase();
        if (!weaponDmgType) {
          const m = String(dmgDice).match(/\b(slashing|piercing|bludgeoning|fire|cold|lightning|thunder|acid|poison|necrotic|radiant|force|psychic)\b/i);
          if (m) weaponDmgType = m[1].toLowerCase();
        }
        const weaponDmgWord = weaponDmgType ? `${weaponDmgType} ` : '';
        console.log('[TARGETING] Weapon/Action:', atk.name, 'atkBonus:', atkBonus, 'dmgDice:', dmgDice, 'charId:', effectiveCharId);

        // Run the attack through the roll engine so Bless / advantage /
        // disadvantage / target conditions actually apply.
        const wCasterToken = useMapStore.getState().tokens[currentTargeting.casterTokenId];
        const wCasterConds = (wCasterToken?.conditions || []) as string[];
        const wTargetConds = (targetToken.conditions || []) as string[];
        const wAttackerOwn = getOwnRollModifiers(wCasterConds);
        const wTargetIncoming = getTargetRollModifiers(wTargetConds);
        const wCombined = combineAttackModifiers(wAttackerOwn, wTargetIncoming);

        // Ranged attack disadvantage when an enemy is within 5 ft.
        // Per RAW: "You have disadvantage on a ranged attack roll if
        // you are within 5 feet of a hostile creature who can see you
        // and who isn't incapacitated."
        const wIsRangedWeapon = ((atk.properties as string[] | undefined) || [])
          .some((p) => /(range|ammunition|thrown)/i.test(p));
        const wIsActuallyRangedShot = wIsRangedWeapon && !((atk.properties as string[] | undefined) || []).includes('Melee');
        if (wIsActuallyRangedShot && wCasterToken) {
          const gridSize = useMapStore.getState().currentMap?.gridSize ?? 70;
          const allTokens = useMapStore.getState().tokens;
          let hasAdjacentEnemy = false;
          // Two-team model: PC tokens (any non-null ownerUserId) are
          // all on one side; NPC tokens (null ownerUserId) are on the
          // other. Players standing next to each other don't impose
          // ranged disadvantage.
          const casterIsPC = !!(wCasterToken as any).ownerUserId;
          for (const enemy of Object.values(allTokens)) {
            if (!enemy || (enemy as any).id === (wCasterToken as any).id) continue;
            const enemyIsPC = !!(enemy as any).ownerUserId;
            if (enemyIsPC === casterIsPC) continue;
            const ec = ((enemy as any).conditions || []) as string[];
            if (ec.includes('incapacitated') || ec.includes('unconscious')) continue;
            // Edge-to-edge distance ≤ 5 ft (1 grid cell)
            const eSize = (enemy as any).size || 1;
            const cSize = (wCasterToken as any).size || 1;
            const ecx = (enemy as any).x + (gridSize * eSize) / 2;
            const ecy = (enemy as any).y + (gridSize * eSize) / 2;
            const ccx = (wCasterToken as any).x + (gridSize * cSize) / 2;
            const ccy = (wCasterToken as any).y + (gridSize * cSize) / 2;
            const dx = Math.max(0, Math.abs(ecx - ccx) - (eSize * gridSize) / 2 - (cSize * gridSize) / 2);
            const dy = Math.max(0, Math.abs(ecy - ccy) - (eSize * gridSize) / 2 - (cSize * gridSize) / 2);
            const edgeDist = Math.max(dx, dy);
            if (edgeDist <= gridSize + 1) {
              hasAdjacentEnemy = true;
              break;
            }
          }
          if (hasAdjacentEnemy) {
            // Inject disadvantage. If we already had advantage from
            // some other source, they cancel out per 5e RAW.
            if (wCombined.attackAdvantage === 'advantage') {
              wCombined.attackAdvantage = 'normal';
            } else {
              wCombined.attackAdvantage = 'disadvantage';
            }
            wCombined.notes.push('Ranged in melee (disadv)');
          }
        }

        const wAtkResult = rollAttackWithModifiers(atkBonus, wCombined);

        // Effective AC accounts for Hasted / Shield / Mage Armor / etc.
        const wTargetScores = targetChar?.abilityScores
          ? (typeof targetChar.abilityScores === 'string' ? JSON.parse(targetChar.abilityScores) : targetChar.abilityScores)
          : {};
        const wTargetDex = abilityModifier((wTargetScores as any).dex || 10);
        const wAcResult = effectiveAC(targetChar?.armorClass ?? 10, wTargetConds, wTargetDex);
        let wTargetAC = wAcResult.value;
        let wIsHit = wAtkResult.isCritical || (!wAtkResult.isFumble && wAtkResult.total >= wTargetAC);
        const wIsMelee = (atk.properties as string[] | undefined)?.includes('Melee');
        let wIsCrit = wAtkResult.isCritical || (wIsHit && wAtkResult.forceCritOnHit && wIsMelee);

        // Shield reaction window for weapon attacks too. Skip for
        // NPC targets to avoid the 1.5 s pause when monsters fight
        // each other.
        let wShieldNote = '';
        if (wIsHit && !wAtkResult.isCritical && targetToken.ownerUserId) {
          const shielded = await broadcastHitAndAwaitShield({
            targetTokenId: targetToken.id,
            attackerName: currentTargeting.casterName,
            attackTotal: wAtkResult.total,
            currentAC: wTargetAC,
          });
          if (shielded) {
            wTargetAC += 5;
            const newHit = wAtkResult.total >= wTargetAC;
            if (!newHit) {
              wIsHit = false;
              wIsCrit = false;
              wShieldNote = ' [Shield +5 AC → MISS]';
            } else {
              wShieldNote = ' [Shield +5 AC → still hits]';
            }
          }
        }

        // Build the consolidated chat message (same shape as spell results)
        const wHeader = `⚔ ${currentTargeting.casterName} → ${targetToken.name}: ${atk.name}`;
        const wHitIcon = wIsCrit ? '💥' : wIsHit ? '✓' : '✗';
        const wAcNote = wAcResult.notes.length > 0 ? ` (base ${wAcResult.base}${wAcResult.notes.map(n => ' ' + n).join('')})` : '';
        const wModNote = wCombined.notes.length > 0 ? ` [${wCombined.notes.join(', ')}]` : '';
        const wParts: string[] = [];
        wParts.push(`${wHitIcon} Attack ${wAtkResult.breakdown} vs AC ${wTargetAC}${wAcNote} → ${wIsCrit ? 'CRIT' : wIsHit ? 'HIT' : 'MISS'}${wModNote}${wShieldNote}`);

        if (wIsHit && effectiveCharId) {
          const wFinalDice = wIsCrit ? dmgDice.replace(/(\d+)d/, (_: string, n: string) => `${parseInt(n) * 2}d`) : dmgDice;
          const wRolledDmg = rollDamageDice(wFinalDice);
          const wFreshChar = useCharacterStore.getState().allCharacters[effectiveCharId];
          const wFreshHp = wFreshChar ? (typeof wFreshChar.hitPoints === 'number' ? wFreshChar.hitPoints : parseInt(String(wFreshChar.hitPoints)) || 0) : targetHp;
          // Weapon attacks are NONMAGICAL by default — Stoneskin matters
          const wDefenses = (wFreshChar as any)?.defenses ? (typeof (wFreshChar as any).defenses === 'string' ? JSON.parse((wFreshChar as any).defenses) : (wFreshChar as any).defenses) : { resistances: [], immunities: [], vulnerabilities: [] };
          const wResisted = applyDamageWithResist(wRolledDmg, weaponDmgType, wDefenses, wTargetConds, false);
          const wNewHp = Math.max(0, wFreshHp - wResisted.amount);
          const wResistTag = wResisted.source ? ` [${wResisted.source}]` : '';
          const wDmgChange = wResisted.amount !== wRolledDmg ? `${wRolledDmg}→${wResisted.amount}` : `${wResisted.amount}`;
          wParts.push(`${wDmgChange} ${weaponDmgWord}dmg${wResistTag} (HP ${wFreshHp}→${wNewHp})${wIsCrit ? ' [CRIT]' : ''}`);
          if (wNewHp === 0) wParts.push('💀 DOWN');
          setTimeout(() => {
            updateTargetHp(effectiveCharId, wNewHp);
            if (wResisted.amount > 0) emitDamageSideEffects(targetToken.id, wResisted.amount);
          }, 300);
        }

        emitSystemMessage(`${wHeader}\n   • ${wParts.join(' • ')}`);

        // Thrown weapons drop from inventory and spawn an item token at
        // the target's location. Only fires if we have a valid inventory
        // index AND the caster has a character record.
        if (wIsThrown && wThrownInventoryIdx != null && wThrownInventoryIdx >= 0) {
          const casterCharIdForDrop = wCasterToken?.characterId;
          const mapId = useMapStore.getState().currentMap?.id;
          if (casterCharIdForDrop && mapId) {
            // Place the weapon a small offset toward the caster (in front
            // of the target) — looks like the weapon stuck in the ground
            // near the victim.
            const dropX = (targetToken as any).x;
            const dropY = (targetToken as any).y;
            fetch(`/api/characters/${casterCharIdForDrop}/loot/drop`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ itemIndex: wThrownInventoryIdx, mapId, x: dropX, y: dropY }),
            })
              .then(r => r.ok ? r.json() : null)
              .then(data => {
                if (!data?.success) return;
                // Update the caster's inventory locally. Server now
                // creates the loot token atomically and broadcasts it
                // via `map:token-added`, so no client emit is needed.
                useCharacterStore.getState().applyRemoteUpdate(casterCharIdForDrop, { inventory: data.inventory });
                emitCharacterUpdate(casterCharIdForDrop, { inventory: data.inventory }, { skipLocal: true });
                emitSystemMessage(`🗡 ${currentTargeting.casterName} dropped ${atk.name.replace(' (Thrown)', '')} at ${targetToken.name}'s feet`);
              })
              .catch(err => console.error('[THROW] failed to drop weapon:', err));
          }
        }
      }

      useMapStore.getState().cancelTargetingMode();
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { useMapStore.getState().cancelTargetingMode(); }
    };

    window.addEventListener('target-token-selected', handleTargetSelect);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('target-token-selected', handleTargetSelect);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isTargeting, targetingData]);

  // Fetch loot weapons when token changes or loot is updated
  // Must be before early returns to satisfy React hooks rules
  useEffect(() => {
    if (!selectedTokenId) { setLootWeapons([]); return; }
    const t = useMapStore.getState().tokens[selectedTokenId];
    if (!t?.characterId) { setLootWeapons([]); return; }
    const charData = useCharacterStore.getState().allCharacters[t.characterId];
    const isCreature = !t.ownerUserId || charData?.userId === 'npc';
    if (!isCreature) { setLootWeapons([]); return; }

    let cancelled = false;
    const fetchWeapons = async () => {
      try {
        const resp = await fetch(`/api/characters/${t.characterId}/loot`);
        if (!resp.ok || cancelled) return;
        const lootItems: LootEntry[] = await resp.json();
        const equipped = lootItems.filter(l => l.equipped && (l.item_slug || l.custom_item_id));
        if (equipped.length === 0) { if (!cancelled) setLootWeapons([]); return; }

        const weapons: { name: string; damage: string; damageType: string; properties: string[]; range?: string }[] = [];
        for (const item of equipped) {
          try {
            let data: any = null;

            // Fetch from compendium or custom items
            if (item.item_slug) {
              const r = await fetch(`/api/compendium/items/${item.item_slug}`);
              if (r.ok && !cancelled) data = await r.json();
            } else if (item.custom_item_id) {
              const r = await fetch(`/api/custom/items/${item.custom_item_id}`);
              if (r.ok && !cancelled) data = await r.json();
            }
            if (!data || cancelled) continue;

            const typeLower = (data.type || '').toLowerCase();
            if (!typeLower.includes('weapon')) continue;

            // Get stats — structured data first, then parse from description
            const raw = (typeof data.rawJson === 'object' && data.rawJson) || {};
            let damage = (raw.damage as string) || (data.damage as string) || '';
            let damageType = (raw.damageType as string) || (data.damage_type as string) || '';
            let properties: string[] = (raw.properties as string[]) || [];
            const range = (raw.range as string) || '';

            // Try parsing properties from JSON string (custom items store as JSON)
            if (typeof data.properties === 'string') {
              try { properties = JSON.parse(data.properties); } catch { /* ignore */ }
            } else if (Array.isArray(data.properties)) {
              properties = data.properties;
            }

            // Fallback: parse from description
            if (!damage && (data.description || data.desc)) {
              const desc = (data.description || data.desc) as string;
              const dmgMatch = desc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(slashing|piercing|bludgeoning|fire|cold|lightning|thunder|acid|poison|necrotic|radiant|force|psychic)/i);
              if (dmgMatch) {
                damage = dmgMatch[1].replace(/\s/g, '');
                damageType = dmgMatch[2].toLowerCase();
              }
              if (desc.toLowerCase().includes('finesse') && !properties.includes('Finesse')) properties.push('Finesse');
              if (desc.toLowerCase().includes('two-handed') && !properties.includes('Two-Handed')) properties.push('Two-Handed');
              if (desc.toLowerCase().includes('heavy') && !properties.includes('Heavy')) properties.push('Heavy');
              if (desc.toLowerCase().includes('thrown') && !properties.includes('Thrown')) properties.push('Thrown');
              if (desc.toLowerCase().includes('versatile') && !properties.includes('Versatile')) properties.push('Versatile');
            }

            // Last resort: infer default damage from weapon type hint
            if (!damage) {
              const t = typeLower;
              const n = item.item_name.toLowerCase();
              if (t.includes('greataxe') || n.includes('greataxe')) { damage = '1d12'; damageType = 'slashing'; }
              else if (t.includes('greatsword') || n.includes('greatsword')) { damage = '2d6'; damageType = 'slashing'; }
              else if (t.includes('longsword') || n.includes('longsword')) { damage = '1d8'; damageType = 'slashing'; }
              else if (t.includes('battleaxe') || t.includes('any axe') || n.includes('axe')) { damage = '1d8'; damageType = 'slashing'; }
              else if (t.includes('shortsword') || n.includes('shortsword')) { damage = '1d6'; damageType = 'piercing'; }
              else if (t.includes('rapier') || n.includes('rapier')) { damage = '1d8'; damageType = 'piercing'; }
              else if (t.includes('dagger') || n.includes('dagger')) { damage = '1d4'; damageType = 'piercing'; }
              else if (t.includes('mace') || n.includes('mace')) { damage = '1d6'; damageType = 'bludgeoning'; }
              else if (t.includes('warhammer') || n.includes('hammer')) { damage = '1d8'; damageType = 'bludgeoning'; }
              else if (t.includes('longbow') || n.includes('longbow')) { damage = '1d8'; damageType = 'piercing'; }
              else if (t.includes('shortbow') || n.includes('shortbow')) { damage = '1d6'; damageType = 'piercing'; }
              else if (t.includes('crossbow') || n.includes('crossbow')) { damage = '1d8'; damageType = 'piercing'; }
              else if (t.includes('spear') || n.includes('spear')) { damage = '1d6'; damageType = 'piercing'; }
              else if (t.includes('staff') || n.includes('staff')) { damage = '1d6'; damageType = 'bludgeoning'; }
              else if (t.includes('sword') || n.includes('sword')) { damage = '1d8'; damageType = 'slashing'; }
              else if (t.includes('bow') || n.includes('bow')) { damage = '1d6'; damageType = 'piercing'; }
              else if (t.includes('any')) { damage = '1d8'; damageType = 'slashing'; }
              else { damage = '1d6'; damageType = 'slashing'; } // generic weapon fallback
            }

            // Get magic weapon bonus — from DB field or parsed from description
            let magicBonus = (data.magic_bonus as number) || 0;
            if (!magicBonus) {
              const bonusMatch = ((data.description || data.desc || '') as string).match(/\+(\d)\s*bonus to attack and damage/i);
              if (bonusMatch) magicBonus = parseInt(bonusMatch[1], 10);
            }

            if (damage) {
              const finalDamage = magicBonus > 0 ? `${damage}+${magicBonus}` : damage;
              weapons.push({
                name: item.item_name,
                damage: finalDamage,
                damageType,
                properties,
                range: range || undefined,
                magicBonus,
              } as any);
            }
          } catch { /* skip */ }
        }
        if (!cancelled) setLootWeapons(weapons);
      } catch { /* ignore */ }
    };

    fetchWeapons();
    const handler = () => fetchWeapons();
    window.addEventListener('loot-updated', handler);
    return () => { cancelled = true; window.removeEventListener('loot-updated', handler); };
  }, [selectedTokenId]);

  // --- Phase 6: Creature spell state (must be before early return for hooks rules) ---
  const [creatureSpells, setCreatureSpells] = useState<{ name: string; level: number; slug: string }[]>([]);
  const [creatureSpellDC, setCreatureSpellDC] = useState(0);
  const [creatureSpellAtk, setCreatureSpellAtk] = useState(0);

  // Parse creature spellcasting trait (before early return)
  useEffect(() => {
    if (!compendiumData?.specialAbilities) { setCreatureSpells([]); setCreatureSpellDC(0); setCreatureSpellAtk(0); return; }
    const spellTrait = compendiumData.specialAbilities.find((a: any) =>
      a.name?.toLowerCase().includes('spellcasting') || a.name?.toLowerCase().includes('innate spellcasting')
    );
    if (!spellTrait?.desc) { setCreatureSpells([]); return; }

    const desc = spellTrait.desc as string;
    const dcMatch = desc.match(/spell save DC (\d+)/i);
    if (dcMatch) setCreatureSpellDC(parseInt(dcMatch[1], 10));
    const atkMatch = desc.match(/\+(\d+) to hit with spell/i);
    if (atkMatch) setCreatureSpellAtk(parseInt(atkMatch[1], 10));

    const spellNames: { name: string; level: number }[] = [];
    const lines = desc.split('\n');
    for (const line of lines) {
      const levelMatch = line.match(/(?:cantrips?|(\d+)(?:st|nd|rd|th)\s*level)/i);
      const level = levelMatch ? (levelMatch[1] ? parseInt(levelMatch[1], 10) : 0) : -1;
      if (level < 0) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const spellPart = line.slice(colonIdx + 1);
      const names = spellPart.split(/,|;/).map(s => s.replace(/\*|_/g, '').trim()).filter(Boolean);
      for (const name of names) {
        if (name.length > 2 && name.length < 40) spellNames.push({ name, level });
      }
    }
    setCreatureSpells(spellNames.map(s => ({
      ...s, slug: s.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/'/g, ''),
    })));
  }, [compendiumData]);

  // Empty-state: embedded mode shows a hint, floating popup returns
  // null so it stays hidden until a token is selected.
  const emptyHint = (msg: string) => (
    <div style={{
      padding: '24px 16px', textAlign: 'center',
      color: C.textMuted, fontSize: 12, lineHeight: 1.5,
      background: C.bg, width: '100%', height: '100%',
    }}>
      {msg}
    </div>
  );

  if (isEmbedded) {
    if (!selectedTokenId) return emptyHint('No token on the map for your character yet.\nPlace your hero on the battle map to use this panel.');
  } else {
    if (!visible || !selectedTokenId) return null;
  }

  const token = tokens[selectedTokenId];
  if (!token) {
    if (isEmbedded) return emptyHint('Your token is not on the current map.');
    return null;
  }

  const character = token.characterId ? allCharacters[token.characterId] : null;
  const isOwner = token.ownerUserId === userId;
  const canAct = isDM || isOwner;
  const isNPC = !token.ownerUserId || (character?.userId === 'npc');

  // The Combat Actions section only shows when the viewed token is
  // actually the active combatant — so non-current players can't use
  // it to burn actions out-of-turn. `currentTurnIdx` is in the
  // subscription deps so this re-evaluates on every turn advance.
  void currentTurnIdx; // referenced only to subscribe
  const isCurrentCombatant = combatActive && currentCombatantId === selectedTokenId;

  const scores = character ? parse<Record<string, number>>(character.abilityScores, {}) : {};
  const baseHp = character?.hitPoints ?? compendiumData?.hitPoints ?? 0;
  const hp = localHp !== null ? localHp : baseHp;
  const maxHp = character?.maxHitPoints ?? compendiumData?.hitPoints ?? 0;
  const storedAC = character?.armorClass ?? compendiumData?.armorClass ?? 10;
  const speed = character?.speed ?? (compendiumData?.speed?.walk) ?? 30;
  const profBonus = character?.proficiencyBonus ?? 2;
  // Parse the character's spells AND enrich them from descriptions so the
  // damage / save / attack badges show on every spell button — including
  // DDB-imported spells where the structured fields are usually null.
  const spells = character
    ? parse<any[]>(character.spells, []).map(enrichSpellFromDescription)
    : [];
  const spellSlots = character ? parse<Record<string, { max: number; used: number }>>(character.spellSlots, {}) : {};
  const inventory = character ? parse<any[]>(character.inventory, []) : [];
  const weapons = inventory.filter((i: any) => i.type === 'weapon' && i.equipped);
  const conditions = token.conditions || [];
  const portraitUrl = token.imageUrl || character?.portraitUrl || null;

  // Merged ability scores — from character or compendium
  const mergedScores = {
    str: scores.str || compendiumData?.abilityScores?.str || 10,
    dex: scores.dex || compendiumData?.abilityScores?.dex || 10,
    con: scores.con || compendiumData?.abilityScores?.con || 10,
    int: scores.int || compendiumData?.abilityScores?.int || 10,
    wis: scores.wis || compendiumData?.abilityScores?.wis || 10,
    cha: scores.cha || compendiumData?.abilityScores?.cha || 10,
  };
  const strMod = abilityModifier(mergedScores.str);
  const dexMod = abilityModifier(mergedScores.dex);
  const initiative = character?.initiative ?? dexMod;

  // Calculate effective AC from equipped gear
  const equipBonuses = calculateEquipmentBonuses(inventory, mergedScores, storedAC);
  // Use the higher of stored AC (from DDB import) or calculated AC (from equipped items)
  // This handles both DDB characters (pre-calculated) and manually equipped creatures
  const hasEquippedArmor = inventory.some((i: any) => i.equipped && (i.type === 'armor' || i.type === 'shield'));
  const ac = hasEquippedArmor ? equipBonuses.effectiveAC : storedAC;
  const acTooltip = hasEquippedArmor ? equipBonuses.acBreakdown : `Base AC: ${storedAC}`;
  const hpPct = maxHp > 0 ? hp / maxHp : 1;

  // Merge ability scores from character or compendium
  const abilityScores = Object.keys(scores).length > 0 ? scores : (compendiumData?.abilityScores || {});

  // Actions from compendium. Many third-party creatures (Tome of Beasts etc.)
  // ship with only `name` + `desc` — no structured attack_bonus / damage_dice.
  // Parse those out of the desc so the attack + damage buttons render.
  const compActions = (compendiumData?.actions || []).map((a: any) => {
    if (a.attack_bonus != null && a.damage_dice) return a;
    const desc: string = a.desc || '';
    const hitMatch = desc.match(/([+-]?\d+)\s+to\s+hit/i);
    const dmgMatch = desc.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/);
    return {
      ...a,
      attack_bonus: a.attack_bonus ?? (hitMatch ? parseInt(hitMatch[1], 10) : null),
      damage_dice: a.damage_dice ?? (dmgMatch ? dmgMatch[1].replace(/\s+/g, '') : null),
    };
  });
  const compTraits = compendiumData?.specialAbilities || [];

  // (creature spell parsing moved before early return)


  const close = () => { useMapStore.getState().selectToken(null); useMapStore.getState().cancelTargetingMode(); setVisible(false); };

  // Helper: create a character record for a token that doesn't have one
  const createCharForToken = async (t: any, comp: any, currentHp: number, mHp: number, armorClass: number, spd: number): Promise<string | null> => {
    try {
      const resp = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'npc', name: t.name,
          race: comp?.type || 'monster',
          class: `CR ${comp?.challengeRating || '0'}`,
          level: 1, hitPoints: currentHp, maxHitPoints: mHp,
          armorClass, speed: spd,
          abilityScores: comp?.abilityScores || {},
          portraitUrl: t.imageUrl,
          compendiumSlug: comp?.slug || null,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        emitTokenUpdate(t.id, { characterId: data.id } as any);
        useCharacterStore.getState().setAllCharacters({
          ...useCharacterStore.getState().allCharacters, [data.id]: { ...data, hitPoints: currentHp },
        });
        return data.id;
      }
    } catch {}
    return null;
  };

  const wrapperStyle: React.CSSProperties = isEmbedded
    ? {
        // Inline — fills its parent (the Hero sidebar tab). The whole
        // panel (header + body) scrolls together so on small viewports
        // the player can still reach every attack/spell section.
        width: '100%', height: '100%',
        background: C.bg, color: C.text,
        fontFamily: '-apple-system, sans-serif',
        display: 'flex', flexDirection: 'column',
        overflowY: 'auto',
      }
    : {
        // Floating popup — fixed to the bottom-left of the map.
        position: 'fixed', bottom: 90, left: 12, zIndex: 500,
        width: 320, maxHeight: 'calc(100vh - 160px)',
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12,
        boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
        fontFamily: '-apple-system, sans-serif', color: C.text,
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      };

  return (
    <div style={wrapperStyle}>
      {!isEmbedded && (
        <button onClick={close} style={{
          position: 'absolute', top: 6, right: 8, zIndex: 10,
          background: 'none', border: 'none', color: C.textMuted, fontSize: 18, cursor: 'pointer',
        }}>&times;</button>
      )}

      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, background: C.bgCard }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {portraitUrl ? (
            <img src={portraitUrl} alt="" style={{
              width: 48, height: 48, borderRadius: '50%', objectFit: 'cover',
              border: `2px solid ${isOwner ? C.green : C.red}`,
            }} />
          ) : (
            <div style={{
              width: 48, height: 48, borderRadius: '50%', background: token.color || '#555',
              border: `2px solid ${C.red}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, fontWeight: 700,
            }}>{token.name[0]}</div>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {/* Faction indicator dot visible to everyone */}
              {(() => {
                const fac = (token as any).faction ?? 'neutral';
                const color = fac === 'friendly' ? C.green : fac === 'hostile' ? C.red : C.gold;
                return (
                  <span
                    title={`Faction: ${fac}`}
                    style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: color, display: 'inline-block',
                      border: '1px solid rgba(0,0,0,0.35)', flexShrink: 0,
                    }}
                  />
                );
              })()}
              <div style={{ fontSize: 15, fontWeight: 700 }}>{token.name}</div>
            </div>
            {compendiumData && (
              <div style={{ fontSize: 10, color: C.textMuted }}>
                {compendiumData.size} {compendiumData.type} • CR {compendiumData.challengeRating}
              </div>
            )}
            {character && !isNPC && (
              <div style={{ fontSize: 10, color: C.textSec }}>
                {character.race} {character.class} Lv{character.level}
              </div>
            )}
            {/* DM-only faction toggle — switch sides for OA / combat */}
            {isDM && (() => {
              const fac = (token as any).faction ?? 'neutral';
              const opts: { key: 'friendly' | 'neutral' | 'hostile'; label: string; color: string }[] = [
                { key: 'friendly', label: '🟢 Friendly', color: C.green },
                { key: 'neutral', label: '🟡 Neutral', color: C.gold },
                { key: 'hostile', label: '🔴 Hostile', color: C.red },
              ];
              return (
                <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
                  {opts.map((o) => {
                    const active = fac === o.key;
                    return (
                      <button
                        key={o.key}
                        onClick={() => emitTokenUpdate(token.id, { faction: o.key } as any)}
                        style={{
                          flex: 1, padding: '2px 4px', fontSize: 9,
                          borderRadius: 3, cursor: 'pointer',
                          background: active ? `${o.color}33` : 'transparent',
                          border: `1px solid ${active ? o.color : C.border}`,
                          color: active ? o.color : C.textMuted,
                          fontWeight: active ? 700 : 500,
                        }}
                        title={`Set faction: ${o.key}`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Stats row — shows EFFECTIVE values after condition modifiers */}
        {(() => {
          const dexModForAC = abilityModifier(mergedScores.dex || 10);
          const acEff = effectiveAC(ac, conditions, dexModForAC);
          const spdEff = effectiveSpeed(speed, conditions);
          const acTip = acEff.notes.length > 0
            ? `${acTooltip}\n\nEffective AC ${acEff.value} (base ${acEff.base})\n${acEff.notes.join('\n')}`
            : acTooltip;
          const spdTip = spdEff.notes.length > 0
            ? `Effective Speed ${spdEff.value}ft (base ${spdEff.base})\n${spdEff.notes.join('\n')}`
            : `Speed ${spdEff.value}ft`;
          // Highlight modified stats in gold so they're easy to spot
          const acColor = acEff.notes.length > 0 ? C.gold : undefined;
          const spdColor = spdEff.notes.length > 0 ? C.gold : undefined;
          return (
            <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11 }}>
              <span title={acTip} style={{ color: acColor }}>AC <strong>{acEff.value}</strong>{acEff.notes.length > 0 && <span style={{ fontSize: 8, marginLeft: 2 }}>*</span>}</span>
              <span title={spdTip} style={{ color: spdColor }}>SPD <strong>{spdEff.value}ft</strong>{spdEff.notes.length > 0 && <span style={{ fontSize: 8, marginLeft: 2 }}>*</span>}</span>
              <span>INIT <strong>{fmtMod(initiative)}</strong></span>
              {compendiumData?.challengeRating && <span>CR <strong>{compendiumData.challengeRating}</strong></span>}
            </div>
          );
        })()}

        {/* HP bar + controls */}
        {maxHp > 0 && (
          <HPControls
            hp={hp} maxHp={maxHp} hpPct={hpPct}
            canEdit={canAct}
            onDamage={(amount) => {
              const oldHp = hp;
              const newHp = Math.max(0, hp - amount);
              setLocalHp(newHp);
              // Persist to server AND update the local store, otherwise the
              // panel reads stale data the next time it's opened (the panel
              // ignores localHp once it remounts).
              const charId = token.characterId || localCharId;
              if (charId) {
                emitCharacterUpdate(charId, { hitPoints: newHp });
                useCharacterStore.getState().applyRemoteUpdate(charId, { hitPoints: newHp });
                showHpUndoToast(token.name, oldHp, newHp, true, () => {
                  setLocalHp(oldHp);
                  emitCharacterUpdate(charId, { hitPoints: oldHp });
                  useCharacterStore.getState().applyRemoteUpdate(charId, { hitPoints: oldHp });
                });
              } else {
                // Create character record in background
                createCharForToken(token, compendiumData, newHp, maxHp, ac, speed).then(id => {
                  if (id) setLocalCharId(id);
                });
              }
            }}
            onHeal={(amount) => {
              const oldHp = hp;
              const newHp = Math.min(maxHp, hp + amount);
              setLocalHp(newHp);
              const charId = token.characterId || localCharId;
              if (charId) {
                emitCharacterUpdate(charId, { hitPoints: newHp });
                useCharacterStore.getState().applyRemoteUpdate(charId, { hitPoints: newHp });
                showHpUndoToast(token.name, oldHp, newHp, false, () => {
                  setLocalHp(oldHp);
                  emitCharacterUpdate(charId, { hitPoints: oldHp });
                  useCharacterStore.getState().applyRemoteUpdate(charId, { hitPoints: oldHp });
                });
              } else {
                createCharForToken(token, compendiumData, newHp, maxHp, ac, speed).then(id => {
                  if (id) setLocalCharId(id);
                });
              }
            }}
          />
        )}

        {/* Conditions — players can SEE theirs, only the DM can add or
            remove. A player can still acquire a condition by casting a
            spell on themselves (e.g. Haste target=self) because that
            flows through the cast resolver, which the DM-only restriction
            here doesn't block. */}
        {(conditions.length > 0 || isDM) && (
          <ConditionsBar
            conditions={conditions}
            canEdit={isDM}
            onToggle={(cond) => {
              const current = [...conditions] as string[];
              const updated = current.includes(cond)
                ? current.filter(c => c !== cond)
                : [...current, cond];
              emitTokenUpdate(token.id, { conditions: updated as any });
            }}
          />
        )}

        {/* Ability scores */}
        {Object.keys(abilityScores).length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, gap: 2 }}>
            {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).map(ab => {
              const score = abilityScores[ab] || 10;
              const mod = abilityModifier(score);
              return (
                <div key={ab} style={{ textAlign: 'center', flex: 1, cursor: canAct ? 'pointer' : 'default' }}
                  onClick={() => canAct && emitRoll(`1d20${fmtMod(mod)}`, `${token.name} ${ab.toUpperCase()}`)}
                  title={canAct ? `Roll ${ab.toUpperCase()} check` : undefined}>
                  <div style={{ fontSize: 7, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>{ab}</div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{fmtMod(mod)}</div>
                  <div style={{ fontSize: 8, color: C.textMuted }}>{score}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Quick action buttons — pinned to the header so they don't get
            pushed off-screen by long spell lists. Opening the full sheet
            also closes this panel so they don't overlap. */}
        {/* Quick action buttons — View Stats opens either the full
            character sheet (PC) or the compendium detail popup (NPC).
            Inventory opens the character sheet inventory tab (PC) or
            the loot editor (NPC, DM only). */}
        <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
          {character && !isNPC && (
            <>
              <Button variant="ghost" size="sm" fullWidth
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('open-character-sheet', { detail: { characterId: character.id, tab: 'actions' } }));
                  if (!isEmbedded) close();
                }}
                style={{ color: C.red, borderColor: `${C.red}44` }}
              >
                View Stats
              </Button>
              <Button variant="ghost" size="sm" fullWidth
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('open-character-sheet', { detail: { characterId: character.id, tab: 'inventory' } }));
                  if (!isEmbedded) close();
                }}
                style={{ color: C.gold, borderColor: `${C.gold}44` }}
              >
                Inventory
              </Button>
            </>
          )}
          {isNPC && (
            <>
              {compendiumData && (
                <Button variant="ghost" size="sm" fullWidth
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('open-compendium-detail', {
                      detail: { slug: compendiumData.slug || token.name.toLowerCase().replace(/\s+/g, '-'), category: 'monsters', name: token.name },
                    }));
                    if (!isEmbedded) close();
                  }}
                  style={{ color: C.red, borderColor: `${C.red}44` }}
                >
                  Full Stats
                </Button>
              )}
              {isDM && token.characterId && (
                <Button variant="ghost" size="sm" fullWidth
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('open-loot-editor', {
                      detail: { characterId: token.characterId, tokenName: token.name },
                    }));
                    if (!isEmbedded) close();
                  }}
                  style={{ color: C.gold, borderColor: `${C.gold}44` }}
                >
                  Inventory
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Scrollable content. In floating-popup mode this is the
          only scroll container; in embedded mode (Hero tab) the
          outer wrapper scrolls instead so the header scrolls along
          with the body — no nested scrolling. */}
      <div style={isEmbedded
        ? { padding: '6px 10px' }
        : { flex: 1, overflowY: 'auto', padding: '6px 10px' }
      }>
        {/* === DEAD STATE === */}
        {hp <= 0 && maxHp > 0 && isNPC && token.characterId && (
          <LootBagPanel characterId={token.characterId} creatureName={token.name} />
        )}
        {hp <= 0 && maxHp > 0 && !isNPC && (
          <div style={{
            padding: '12px 10px', textAlign: 'center', borderRadius: 6,
            background: 'rgba(197,49,49,0.1)', border: `1px solid ${C.red}33`,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.red, marginBottom: 4 }}>DEAD</div>
            <div style={{ fontSize: 10, color: C.textSec }}>This character can be resurrected</div>
          </div>
        )}

        {/* === ALIVE STATE — actions, weapons, spells, traits, loot === */}
        {(hp > 0 || maxHp === 0) && <>
        {isTargeting && targetingData && (
          <div style={{
            padding: '8px 10px', marginBottom: 6, borderRadius: 6,
            background: 'rgba(197,49,49,0.15)', border: '1px solid rgba(197,49,49,0.3)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 11, color: theme.text.primary, flex: 1 }}>
              🎯 Select target for <strong style={{ color: theme.state.danger }}>
                {targetingData.spell?.name || targetingData.weapon?.name || targetingData.action?.name}
              </strong>
            </span>
            <button onClick={() => useMapStore.getState().cancelTargetingMode()} style={{
              padding: '2px 8px', fontSize: 10, background: theme.bg.elevated, border: `1px solid ${theme.border.default}`,
              borderRadius: theme.radius.sm, color: theme.text.secondary, cursor: 'pointer', fontFamily: theme.font.body,
            }}>Cancel</button>
          </div>
        )}
        {/* (conditions moved to header) */}

        {/* Combat Actions — the seven core 5e "pick an Action" choices
            that every combatant gets, whether they're a spellcaster or
            not. Rendered only during combat for the current combatant
            so they don't clutter the panel outside of turns. Each
            button is gated by canSpendActionSlot — pressing Dash twice
            pops the denial toast. */}
        {canAct && combatActive && isCurrentCombatant && (
          <Section title="Combat Actions">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <CombatActionBtn
                action="Dash"
                color="#5ba3d5"
                onClick={() => {
                  if (!canSpendActionSlot(selectedTokenId!, 'action', 'Dash')) return;
                  emitDash();
                }}
              />
              <CombatActionBtn
                action="Dodge"
                color="#a07bc2"
                onClick={() => {
                  if (!canSpendActionSlot(selectedTokenId!, 'action', 'Dodge')) return;
                  const current = [...(token.conditions || [])] as string[];
                  if (!current.includes('dodging')) current.push('dodging');
                  useMapStore.getState().updateToken(token.id, { conditions: current as any });
                  emitUseAction('action');
                  emitSystemMessage(`🛡 ${token.name} takes the Dodge action — attacks against have disadvantage until next turn.`);
                }}
              />
              <CombatActionBtn
                action="Disengage"
                color="#4fc7ae"
                onClick={() => {
                  if (!canSpendActionSlot(selectedTokenId!, 'action', 'Disengage')) return;
                  const current = [...(token.conditions || [])] as string[];
                  if (!current.includes('disengaged')) current.push('disengaged');
                  useMapStore.getState().updateToken(token.id, { conditions: current as any });
                  emitUseAction('action');
                  emitSystemMessage(`💨 ${token.name} takes the Disengage action — no Opportunity Attacks from movement this turn.`);
                }}
              />
              <CombatActionBtn
                action="Hide"
                color="#808080"
                onClick={() => {
                  if (!canSpendActionSlot(selectedTokenId!, 'action', 'Hide')) return;
                  const dex = mergedScores.dex || 10;
                  const stealthMod = Math.floor((dex - 10) / 2) + (profBonus || 0);
                  emitRoll(`1d20+${stealthMod}`, `${token.name} Hide (Stealth)`);
                  emitUseAction('action');
                }}
              />
              <CombatActionBtn
                action="Search"
                color="#d4a843"
                onClick={() => {
                  if (!canSpendActionSlot(selectedTokenId!, 'action', 'Search')) return;
                  const wis = mergedScores.wis || 10;
                  const perMod = Math.floor((wis - 10) / 2) + (profBonus || 0);
                  emitRoll(`1d20+${perMod}`, `${token.name} Search (Perception)`);
                  emitUseAction('action');
                }}
              />
              <CombatActionBtn
                action="Help"
                color="#5cb77a"
                onClick={() => {
                  if (!canSpendActionSlot(selectedTokenId!, 'action', 'Help')) return;
                  emitUseAction('action');
                  emitSystemMessage(`🤝 ${token.name} takes the Help action — an ally of their choice has advantage on their next ability check or attack.`);
                }}
              />
              <CombatActionBtn
                action="Ready"
                color="#d18b4e"
                onClick={() => {
                  if (!canSpendActionSlot(selectedTokenId!, 'action', 'Ready')) return;
                  if (!canSpendActionSlot(selectedTokenId!, 'reaction', 'Ready (reserves Reaction)')) return;
                  emitUseAction('action');
                  emitUseAction('reaction');
                  emitSystemMessage(`⏳ ${token.name} takes the Ready action — reserving a trigger for this round.`);
                }}
              />
            </div>
          </Section>
        )}

        {/* Compendium Actions (for creatures) */}
        {compActions.length > 0 && (
          <Section title="Actions">
            {compActions.map((action: any, i: number) => (
              <div key={i} style={{ marginBottom: 4, padding: '3px 0', borderBottom: i < compActions.length - 1 ? `1px solid ${C.borderDim}` : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, flex: 1 }}>{action.name}</span>
                  {canAct && action.attack_bonus != null && (
                    <ActionBtn label={`+${action.attack_bonus}`} color={C.red}
                      onClick={() => {
                        if (!canAct) return;
                        useMapStore.getState().startTargetingMode({ action, casterTokenId: selectedTokenId!, casterName: token.name });
                      }} />
                  )}
                  {canAct && action.damage_dice && (
                    <ActionBtn label={action.damage_dice} color={C.gold}
                      onClick={() => emitRoll(action.damage_dice, `${token.name} ${action.name} Damage`)} />
                  )}
                </div>
                <div style={{ fontSize: 9, color: C.textMuted, marginTop: 1, lineHeight: 1.3 }}>
                  {action.desc?.substring(0, 80)}{action.desc?.length > 80 ? '...' : ''}
                </div>
              </div>
            ))}
          </Section>
        )}

        {/* Loot Weapons — matches Actions layout */}
        {lootWeapons.length > 0 && (
          <Section title="Equipped Loot">
            {lootWeapons.map((w, i) => {
              const props = w.properties || [];
              const isFinesse = props.some(p => p.toLowerCase().includes('finesse'));
              const isRanged = props.some(p => p.toLowerCase().includes('range') || p.toLowerCase().includes('ammunition'));
              const isThrown = props.some(p => p.toLowerCase().includes('thrown'));
              const isLight = props.some(p => p.toLowerCase() === 'light');
              const mb = (w as any).magicBonus || 0;
              const atkMod = (isFinesse ? Math.max(strMod, dexMod) : isRanged ? dexMod : strMod) + profBonus + mb;
              const dmgMod = isFinesse ? Math.max(strMod, dexMod) : isRanged ? dexMod : strMod;

              return (
                <div key={i} style={{ marginBottom: 4, padding: '3px 0', borderBottom: i < lootWeapons.length - 1 ? `1px solid ${C.borderDim}` : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, flex: 1 }}>{w.name}</span>
                    {canAct && !isRanged && (
                      <ActionBtn label={`+${atkMod}`} color={C.red} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: { name: `${w.name} (Melee)`, attack_bonus: atkMod, damage_dice: `${w.damage}+${dmgMod}`, properties: ['Melee'] },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}
                    {canAct && !isRanged && isLight && (
                      <ActionBtn label={`Off+${atkMod}`} color={C.gold} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: {
                            name: `${w.name} (Off-hand)`,
                            attack_bonus: atkMod,
                            damage_dice: String(w.damage), // no ability mod on off-hand
                            properties: ['Melee', 'Light'],
                            __actionSlot: 'bonusAction',
                          },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}
                    {canAct && isRanged && (
                      <ActionBtn label={`+${atkMod}`} color={C.red} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: { name: `${w.name} (Ranged)`, attack_bonus: atkMod, damage_dice: `${w.damage}+${dmgMod}`, properties: ['Range'], range: w.range },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}
                    {canAct && isThrown && (
                      <ActionBtn label={`Throw +${atkMod}`} color={C.gold} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: { name: `${w.name} (Thrown)`, attack_bonus: atkMod, damage_dice: `${w.damage}+${dmgMod}`, properties: ['Thrown'], range: w.range },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}
                    <ActionBtn label={w.damage} color={C.gold} onClick={() => emitRoll(`${w.damage}+${dmgMod}`, `${token.name} ${w.name} DMG`)} />
                  </div>
                  <div style={{ fontSize: 9, color: C.textMuted, marginTop: 1, lineHeight: 1.3 }}>
                    {isRanged ? 'Ranged' : 'Melee'} Weapon Attack: +{atkMod} to hit{isRanged && w.range ? `, range ${w.range} ft.` : ', reach 5 ft.'}
                    {w.damage && ` Hit: ${w.damage}+${dmgMod} ${w.damageType}`}
                  </div>
                  {props.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      <WeaponProperties properties={props} />
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
        )}

        {/* Weapons (for player characters without compendium data) */}
        {compActions.length === 0 && weapons.length > 0 && (
          <Section title="Attacks">
            {weapons.map((w: any, i: number) => {
              const props: string[] = w.properties || [];
              const isFinesse = props.some((p: string) => p.toLowerCase().includes('finesse'));
              const isRanged = props.some((p: string) => p.toLowerCase().includes('range'));
              const isThrown = props.some((p: string) => p.toLowerCase().includes('thrown'));
              // Two-Weapon Fighting requires the "Light" property on
              // both weapons. Off-hand attacks are a BONUS ACTION and
              // skip the ability modifier on damage (unless you have
              // a feature that changes this).
              const isLight = props.some((p: string) => p.toLowerCase() === 'light');
              const meleeAtkMod = (isFinesse ? Math.max(strMod, dexMod) : strMod) + profBonus;
              const rangedAtkMod = (isFinesse ? Math.max(strMod, dexMod) : dexMod) + profBonus;
              const meleeDmgMod = isFinesse ? Math.max(strMod, dexMod) : strMod;
              const rangedDmgMod = isFinesse ? Math.max(strMod, dexMod) : dexMod;
              const dmgDice = w.damage || '1d4';

              return (
                <div key={i} style={{ padding: '3px 0', borderBottom: `1px solid ${C.borderDim}` }}>
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>{w.name}</div>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {/* Melee attack */}
                    {!isRanged && canAct && (
                      <ActionBtn label={`Melee +${meleeAtkMod} (5ft)`} color={C.red} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: { ...w, name: `${w.name} (Melee)`, attack_bonus: meleeAtkMod, damage_dice: `${dmgDice}+${meleeDmgMod}`, properties: ['Melee'] },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}

                    {/* Off-hand attack (Two-Weapon Fighting) — uses
                        bonus action, no damage modifier. Shown only on
                        Light melee weapons. */}
                    {!isRanged && isLight && canAct && (
                      <ActionBtn label={`Off-hand (BA)`} color={C.gold} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: {
                            ...w,
                            name: `${w.name} (Off-hand)`,
                            attack_bonus: meleeAtkMod,
                            // No ability modifier on damage for off-hand
                            damage_dice: dmgDice,
                            properties: ['Melee', 'Light'],
                            __actionSlot: 'bonusAction',
                          },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}

                    {/* Thrown attack (for weapons with Thrown property) */}
                    {isThrown && canAct && (
                      <ActionBtn label={`Throw +${rangedAtkMod} (20ft)`} color={C.gold} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: {
                            ...w,
                            // Track the original weapon name + inventory index so the
                            // resolver can drop it from inventory and spawn an item
                            // token at the target's location after the throw lands.
                            originalName: w.name,
                            inventoryIndex: inventory.findIndex((it: any) => it.name === w.name),
                            name: `${w.name} (Thrown)`,
                            attack_bonus: rangedAtkMod,
                            damage_dice: `${dmgDice}+${rangedDmgMod}`,
                            properties: ['Thrown'],
                          },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}

                    {/* Ranged attack (for ranged weapons like bows) */}
                    {isRanged && canAct && (
                      <ActionBtn label={`Ranged +${rangedAtkMod} (80ft)`} color={C.blue} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: { ...w, name: `${w.name} (Ranged)`, attack_bonus: rangedAtkMod, damage_dice: `${dmgDice}+${rangedDmgMod}`, properties: ['Range'] },
                          casterTokenId: selectedTokenId!, casterName: token.name,
                        });
                      }} />
                    )}

                    {/* Direct damage roll (no targeting) */}
                    <ActionBtn label={`${dmgDice}`} color={C.textMuted} onClick={() => emitRoll(`${dmgDice}+${meleeDmgMod}`, `${token.name} ${w.name} DMG`)} />
                  </div>
                  {/* Weapon properties with hover tooltips */}
                  {props.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      <WeaponProperties properties={props} />
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
        )}

        {/* Traits (from compendium) */}
        {compTraits.length > 0 && (
          <Section title="Traits">
            {compTraits.slice(0, 3).map((trait: any, i: number) => (
              <div key={i} style={{ marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: C.text }}>{trait.name}. </span>
                <span style={{ fontSize: 9, color: C.textMuted }}>{trait.desc?.substring(0, 60)}{trait.desc?.length > 60 ? '...' : ''}</span>
              </div>
            ))}
          </Section>
        )}

        {/* Creature Spells (from compendium trait) */}
        {creatureSpells.length > 0 && (
          <>
            {creatureSpells.filter(s => s.level === 0).length > 0 && (
              <Section title={`Cantrips (at will)${creatureSpellDC ? ` · DC ${creatureSpellDC}` : ''}`}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  {creatureSpells.filter(s => s.level === 0).map((s, i) => (
                    <button key={i} onClick={() => {
                      if (!canAct) return;
                      useMapStore.getState().startTargetingMode({
                        spell: { name: s.name, level: 0, description: '', isConcentration: false, isRitual: false,
                          school: '', castingTime: '1 action', range: '30 feet', components: '', duration: 'Instantaneous' },
                        casterTokenId: selectedTokenId!, casterName: token.name,
                      });
                    }} onContextMenu={(e) => {
                      e.preventDefault();
                      window.dispatchEvent(new CustomEvent('open-compendium-detail', { detail: { slug: s.slug, category: 'spells', name: s.name } }));
                    }} style={{
                      padding: '2px 6px', fontSize: 9, borderRadius: 3,
                      background: C.bgHover, border: `1px solid ${C.borderDim}`,
                      color: C.textSec, cursor: canAct ? 'pointer' : 'default', fontFamily: 'inherit',
                    }}>{s.name}</button>
                  ))}
                </div>
              </Section>
            )}
            {creatureSpells.filter(s => s.level > 0).length > 0 && (
              <Section title={`Spells${creatureSpellAtk ? ` · +${creatureSpellAtk}` : ''}${creatureSpellDC ? ` · DC ${creatureSpellDC}` : ''}`}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  {creatureSpells.filter(s => s.level > 0).map((s, i) => (
                    <button key={i} onClick={() => {
                      if (!canAct) return;
                      useMapStore.getState().startTargetingMode({
                        spell: { name: s.name, level: s.level, description: '', isConcentration: false, isRitual: false,
                          school: '', castingTime: '1 action', range: '60 feet', components: '', duration: 'Instantaneous' },
                        casterTokenId: selectedTokenId!, casterName: token.name,
                      });
                    }} onContextMenu={(e) => {
                      e.preventDefault();
                      window.dispatchEvent(new CustomEvent('open-compendium-detail', { detail: { slug: s.slug, category: 'spells', name: s.name } }));
                    }} style={{
                      padding: '2px 6px', fontSize: 9, borderRadius: 3,
                      background: C.bgHover, border: `1px solid ${C.borderDim}`,
                      color: C.text, cursor: canAct ? 'pointer' : 'default', fontFamily: 'inherit',
                    }}>
                      <span style={{ fontSize: 7, color: C.textMuted, marginRight: 2 }}>L{s.level}</span>
                      {s.name}
                    </button>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}

        {/* Cantrips */}
        {spells.filter((s: any) => s.level === 0).length > 0 && (
          <Section title={`Cantrips (${spells.filter((s: any) => s.level === 0).length})`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {spells.filter((s: any) => s.level === 0).map((spell: any, i: number) => {
                const tooltip = `${spell.name} — Cantrip (at will, never expended)\n\n${spell.description || ''}`;
                return (
                  <button key={i} onClick={() => {
                    if (!canAct) return;
                    castSpellFromButton(spell, selectedTokenId!, token.name);
                  }} onContextMenu={(e) => {
                    e.preventDefault();
                    const slug = spell.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                    window.dispatchEvent(new CustomEvent('open-compendium-detail', { detail: { slug, category: 'spells', name: spell.name } }));
                  }} title={tooltip} style={{
                    padding: '2px 6px', fontSize: 9, borderRadius: 3,
                    background: C.bgHover, border: `1px solid ${C.borderDim}`,
                    color: C.textSec, cursor: canAct ? 'pointer' : 'default', fontFamily: 'inherit',
                  }}>
                    {spell.name}
                    {spell.damage && <span style={{ color: C.red, marginLeft: 2, fontSize: 7 }}>{spell.damage}</span>}
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {/* Leveled Spells */}
        {spells.filter((s: any) => s.level > 0).length > 0 && (
          <Section title={`Spells (${spells.filter((s: any) => s.level > 0).length})`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {spells.filter((s: any) => s.level > 0).slice(0, 12).map((spell: any, i: number) => {
                const slot = spellSlots[String(spell.level)] || spellSlots[spell.level as any];
                const slotsLeft = slot ? slot.max - slot.used : 0;
                const slotsMax = slot ? slot.max : 0;
                // Either the global DM "ignore slots" toggle or the per-spell
                // dmOverride flag makes this spell castable regardless of slots.
                const dmIgnoreSlots = useSessionStore.getState().dmIgnoreSpellSlots;
                const overridden = dmIgnoreSlots || spell.dmOverride;
                const isSpent = !overridden && (slot ? slotsLeft <= 0 : false);
                const canRitual = !!spell.ritual && spell.level > 0;
                // If out of slots but spell is a ritual, still allow casting
                const effectivelySpent = isSpent && !canRitual;
                const tooltip = overridden
                  ? `${spell.name} — ${spell.dmOverride ? 'DM override on this spell' : 'DM override active (all slots ignored)'}\n\n${spell.description || ''}`
                  : isSpent && canRitual
                    ? `${spell.name} — Out of slots but can be cast as a Ritual (no slot, +10 min casting time)\n\n${spell.description || ''}`
                  : isSpent
                    ? `${spell.name} — Out of level ${spell.level} slots (0/${slotsMax}). Long Rest to recharge.\n\n${spell.description || ''}`
                    : `${spell.name} — Level ${spell.level} (${slotsLeft}/${slotsMax} slots left${canRitual ? ', or cast as Ritual' : ''}, Long Rest to recharge)\n\n${spell.description || ''}`;
                return (
                  <button key={i} disabled={effectivelySpent || !canAct} onClick={() => {
                    if (!canAct || effectivelySpent) return;
                    // If out of slots, force ritual mode (skip slot consumption)
                    const spellCopy = { ...spell };
                    if (isSpent && canRitual) spellCopy.__isRitual = true;
                    castSpellFromButton(spellCopy, selectedTokenId!, token.name);
                  }} onContextMenu={(e) => {
                    e.preventDefault();
                    const slug = spell.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                    window.dispatchEvent(new CustomEvent('open-compendium-detail', { detail: { slug, category: 'spells', name: spell.name } }));
                  }} title={tooltip} style={{
                    padding: '2px 6px', fontSize: 9, borderRadius: 3,
                    background: isSpent ? 'transparent' : C.bgHover,
                    border: `1px solid ${isSpent ? C.borderDim : C.borderDim}`,
                    color: isSpent ? C.textMuted : C.text,
                    cursor: (canAct && !isSpent) ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                    opacity: isSpent ? 0.45 : 1,
                    textDecoration: isSpent ? 'line-through' : 'none',
                  }}>
                    <span style={{ fontSize: 7, color: C.textMuted, marginRight: 2 }}>L{spell.level}</span>
                    {spell.name}
                    {slot && <span style={{ fontSize: 7, color: isSpent ? C.red : C.gold, marginLeft: 3 }}>{slotsLeft}/{slotsMax}</span>}
                    {spell.damage && <span style={{ color: C.red, marginLeft: 2, fontSize: 7 }}>{spell.damage}</span>}
                  </button>
                );
              })}
              {spells.filter((s: any) => s.level > 0).length > 12 && <span style={{ fontSize: 8, color: C.textMuted }}>+{spells.filter((s: any) => s.level > 0).length - 12}</span>}
            </div>
          </Section>
        )}

        {/* Senses & Languages from compendium */}
        {compendiumData && (compendiumData.senses || compendiumData.languages) && (
          <div style={{ fontSize: 9, color: C.textMuted, marginTop: 4, lineHeight: 1.4 }}>
            {compendiumData.senses && <div><strong style={{ color: C.textSec }}>Senses:</strong> {compendiumData.senses}</div>}
            {compendiumData.languages && <div><strong style={{ color: C.textSec }}>Languages:</strong> {compendiumData.languages}</div>}
          </div>
        )}
        </>}
      </div>
    </div>
  );
}

// --- Spell metadata parsing ---

interface SpellAoeMeta {
  damageDice: string;
  savingThrow: string;
  attackType: string;
  aoeShape: 'sphere' | 'cube' | 'cone' | 'line';
  aoeRadius: number;          // in feet
  pushDistance: number;       // in feet, 0 if none
  halfOnSave: boolean;
  hasAoe: boolean;
}

/**
 * Inspect a spell's structured fields + description to figure out what shape
 * AoE it is, the damage dice, saving throw, etc. Falls back to compendium
 * lookup if structured fields are missing.
 */
async function parseSpellMeta(spell: any, casterLevel: number): Promise<SpellAoeMeta> {
  const cleanDesc = (spell.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  let damageDice = spell.damage || '';
  let savingThrow = spell.savingThrow || '';
  let attackType = spell.attackType || '';

  if (!damageDice) {
    const dmgMatch = cleanDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+\w*\s*damage/i);
    if (dmgMatch) damageDice = dmgMatch[1].replace(/\s/g, '');
  }
  if (!savingThrow) {
    const saveMatch = cleanDesc.match(/(strength|dexterity|constitution|wisdom|intelligence|charisma)\s+saving\s+throw/i);
    if (saveMatch) {
      const m: Record<string, string> = { strength: 'str', dexterity: 'dex', constitution: 'con', wisdom: 'wis', intelligence: 'int', charisma: 'cha' };
      savingThrow = m[saveMatch[1].toLowerCase()] || '';
    }
  }
  if (!attackType) {
    if (cleanDesc.match(/ranged spell attack/i)) attackType = 'ranged';
    else if (cleanDesc.match(/melee spell attack/i)) attackType = 'melee';
  }

  // Compendium fallback
  if (!damageDice || !savingThrow) {
    try {
      const slug = spell.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const resp = await fetch(`/api/compendium/spells/${slug}`);
      if (resp.ok) {
        const compSpell = await resp.json();
        const compDesc = (compSpell.description || '').replace(/<[^>]*>/g, ' ');
        if (!damageDice) {
          const m = compDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+\w*\s*damage/i);
          if (m) damageDice = m[1].replace(/\s/g, '');
        }
        if (!savingThrow) {
          const sm = compDesc.match(/(strength|dexterity|constitution|wisdom|intelligence|charisma)\s+saving\s+throw/i);
          if (sm) {
            const map: Record<string, string> = { strength: 'str', dexterity: 'dex', constitution: 'con', wisdom: 'wis', intelligence: 'int', charisma: 'cha' };
            savingThrow = map[sm[1].toLowerCase()] || '';
          }
        }
        if (!attackType) {
          if (compDesc.match(/ranged spell attack/i)) attackType = 'ranged';
          else if (compDesc.match(/melee spell attack/i)) attackType = 'melee';
        }
      }
    } catch {}
  }

  // Cantrip scaling
  if (spell.level === 0 && damageDice) {
    const tier = casterLevel >= 17 ? 4 : casterLevel >= 11 ? 3 : casterLevel >= 5 ? 2 : 1;
    if (tier > 1) {
      damageDice = damageDice.replace(/(\d+)d(\d+)/, (_: string, n: string, d: string) => `${parseInt(n) * tier}d${d}`);
    }
  }

  // AoE shape & size. Match BOTH patterns:
  //   • "20-foot-radius sphere" / "15 foot cube"  → number FIRST
  //   • "line 100 feet long" / "cone 60 feet"    → shape FIRST (Lightning Bolt!)
  let aoeRadius = spell.aoeSize || 0;
  let aoeShape: 'sphere' | 'cube' | 'cone' | 'line' = 'sphere';
  let hasAoe = false;
  if (spell.aoeType === 'cube') { aoeShape = 'cube'; hasAoe = true; }
  else if (spell.aoeType === 'cone') { aoeShape = 'cone'; hasAoe = true; }
  else if (spell.aoeType === 'line') { aoeShape = 'line'; hasAoe = true; }
  else if (spell.aoeType === 'sphere' || spell.aoeType === 'cylinder') { aoeShape = 'sphere'; hasAoe = true; }
  if (!aoeRadius) {
    let parsedShape: string | null = null;
    let parsedSize: number | null = null;
    const m1 = cleanDesc.match(/(\d+)[- ]?(?:foot|feet)[- ]?(?:long\s+|wide\s+)?(radius|sphere|cube|cone|line|cylinder|emanation)/i);
    if (m1) { parsedSize = parseInt(m1[1]); parsedShape = m1[2].toLowerCase(); }
    else {
      const m2 = cleanDesc.match(/(line|sphere|cube|cone|cylinder|radius|emanation)\s+(\d+)\s*(?:feet|foot)/i);
      if (m2) { parsedShape = m2[1].toLowerCase(); parsedSize = parseInt(m2[2]); }
    }
    if (parsedShape && parsedSize !== null) {
      aoeRadius = parsedSize;
      if (parsedShape === 'cube') aoeShape = 'cube';
      else if (parsedShape === 'cone') aoeShape = 'cone';
      else if (parsedShape === 'line') aoeShape = 'line';
      else aoeShape = 'sphere';
      hasAoe = true;
    }
  }
  if (!aoeRadius && hasAoe) aoeRadius = 15;

  // Pushback
  let pushDistance = 0;
  const pushMatch = cleanDesc.match(/pushed\s+(\d+)\s*(?:feet|ft)/i);
  if (pushMatch) pushDistance = parseInt(pushMatch[1]);

  const halfOnSave = cleanDesc.toLowerCase().includes('half as much damage')
    || cleanDesc.toLowerCase().includes('half damage')
    || cleanDesc.toLowerCase().includes('save for half');

  return {
    damageDice,
    savingThrow,
    attackType,
    aoeShape,
    aoeRadius,
    pushDistance,
    halfOnSave,
    hasAoe,
  };
}

/**
 * Filter the token map to those affected by an AoE spell at a given origin
 * and rotation. Caster is always excluded.
 */
function findTokensInAoeShape(
  allTokens: Record<string, any>,
  origin: { x: number; y: number },
  shape: 'sphere' | 'cube' | 'cone' | 'line',
  sizeFt: number,
  rotationDeg: number,
  gridSize: number,
  excludeId: string,
): any[] {
  const sizePixels = (sizeFt / 5) * gridSize;
  const halfCell = gridSize / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const dirX = Math.cos(rad);
  const dirY = Math.sin(rad);

  return Object.values(allTokens).filter((t: any) => {
    if (t.id === excludeId) return false;
    const dx = t.x - origin.x;
    const dy = t.y - origin.y;
    switch (shape) {
      case 'sphere': {
        return Math.sqrt(dx * dx + dy * dy) <= sizePixels;
      }
      case 'cube': {
        return Math.abs(dx) <= sizePixels && Math.abs(dy) <= sizePixels;
      }
      case 'cone': {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > sizePixels) return false;
        if (dist === 0) return true; // origin caster: include adjacent
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        let diff = angle - rotationDeg;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return Math.abs(diff) <= 26.5; // 53° cone
      }
      case 'line': {
        // Project onto line direction
        const proj = dx * dirX + dy * dirY;
        if (proj < 0 || proj > sizePixels) return false;
        const perpDist = Math.abs(dx * dirY - dy * dirX);
        return perpDist <= halfCell; // 5ft wide line
      }
    }
  });
}

/**
 * Resolve an area-of-effect spell. Builds a single consolidated chat message,
 * staggered HP/condition/pushback updates, and slot consumption. Used by both:
 *   • castSelfSpell — Self-range sphere/cube (Thunderwave)
 *   • castAimedSpell — Self cone/line, or non-Self placed AoE (Burning Hands, Fireball)
 */
async function resolveAreaSpell(
  spell: any,
  casterTokenId: string,
  casterName: string,
  origin: { x: number; y: number } | null,
  rotationDeg: number,
) {
  const mapState = useMapStore.getState();
  const charStore = useCharacterStore.getState();
  const casterToken = mapState.tokens[casterTokenId];
  if (!casterToken) {
    console.error('[RESOLVE AOE] Caster token not found');
    return;
  }
  const casterChar = casterToken.characterId ? charStore.allCharacters[casterToken.characterId] : null;
  const casterId = casterChar?.id || casterTokenId;
  // Recompute DC defensively if the stored value looks like a stale default
  const casterSpellDC = effectiveSpellSaveDC(casterChar);
  const casterX = (casterToken as any).x;
  const casterY = (casterToken as any).y;
  const gridSize = mapState.currentMap?.gridSize || 70;

  const meta = await parseSpellMeta(spell, casterChar?.level ?? 1);

  // --- Gate the whole cast behind the action economy slot check.
  // If the slot is already spent we refuse the cast BEFORE burning the
  // spell slot. Applies to AoE / self-cast spells too.
  {
    const precheckSlot = actionSlotForCastingTime(spell.castingTime);
    if (precheckSlot && !canSpendActionSlot(casterTokenId, precheckSlot, spell.name)) {
      return;
    }
  }

  // --- Spell slot consumption (with upcast fallback) ---
  // D&D 5e: a spell of level N can be cast using ANY slot of level N or
  // higher. The caster picks. We auto-pick the lowest available slot ≥ N
  // to avoid wasting high-level slots. If NO slot of level N or higher
  // exists at all, the cast fails — UNLESS the DM has enabled the
  // global "ignore spell slots" override OR this specific spell has its
  // per-spell dmOverride flag set, in which case we skip both the
  // consumption and the availability check.
  const isRitualCast = !!(spell as any).__isRitual;
  if (spell.level > 0 && casterChar) {
    const dmIgnoreSlots = useSessionStore.getState().dmIgnoreSpellSlots;
    if (dmIgnoreSlots || spell.dmOverride) {
      (spell as any).__dmOverride = true;
    } else if (isRitualCast) {
      // Ritual cast — no slot consumed
      (spell as any).__dmOverride = true;
      emitSystemMessage(`✦ ${casterName} casts ${spell.name} as a Ritual (no slot, +10 min casting time).`);
    } else {
      const slots = typeof casterChar.spellSlots === 'string'
        ? JSON.parse(casterChar.spellSlots) : (casterChar.spellSlots || {});
      let chosenLevel: number | null = null;
      for (let lvl = spell.level; lvl <= 9; lvl++) {
        const s = slots[lvl] || slots[String(lvl)];
        if (s && (s.max - s.used) > 0) {
          chosenLevel = lvl;
          break;
        }
      }
      if (chosenLevel === null) {
        emitSystemMessage(`✦ ${casterName} tried to cast ${spell.name} (level ${spell.level}) but has no available slots of level ${spell.level} or higher!`);
        return;
      }
      const slotKey = slots[chosenLevel] ? chosenLevel : String(chosenLevel);
      const slot = slots[slotKey];
      const updatedSlots = { ...slots, [slotKey]: { ...slot, used: slot.used + 1 } };
      emitCharacterUpdate(casterId, { spellSlots: updatedSlots });
      // Note for chat header
      if (chosenLevel > spell.level) {
        // Mark for the header below — stash on the spell object temporarily
        (spell as any).__castAtLevel = chosenLevel;
      }
    }
  }

  // Action economy consumption — burn the slot BEFORE the
  // counterspell window so a counterspelled cast still uses up the
  // attacker's Action (per RAW). Mirrors the single-target path.
  {
    const slot = actionSlotForCastingTime(spell.castingTime);
    const combatS = useCombatStore.getState();
    const currentS = combatS.combatants[combatS.currentTurnIndex];
    if (slot && combatS.active && currentS?.tokenId === casterTokenId) {
      emitUseAction(slot);
    }
  }

  // Counterspell window — broadcast and pause for AoE spells too.
  // Slot AND action are already gone; only the spell's effects are
  // canceled by a successful counterspell.
  if (spell.level > 0) {
    const castAtLevel = (spell as any).__castAtLevel ?? spell.level;
    const counterspelled = await broadcastCastAndAwaitCounterspell({
      casterTokenId,
      casterName,
      spellName: spell.name,
      spellLevel: castAtLevel,
    });
    if (counterspelled) {
      emitSystemMessage(`✦ ${casterName} casts ${spell.name} — COUNTERSPELLED, slot wasted.`);
      return;
    }
  }

  // Default origin to caster's position
  const aoeOrigin = origin ?? { x: casterX, y: casterY };
  const allTokens = mapState.tokens;
  // Caster is excluded only when AoE originates AT the caster (Self-range)
  const excludeId = (aoeOrigin.x === casterX && aoeOrigin.y === casterY) ? casterTokenId : '';
  const affectedTokens = findTokensInAoeShape(
    allTokens,
    aoeOrigin,
    meta.aoeShape,
    meta.aoeRadius || 15,
    rotationDeg,
    gridSize,
    excludeId,
  );

  // Stash for unified per-token loop below
  let damageDice = meta.damageDice;
  const resolvedSavingThrow = meta.savingThrow;
  const halfOnSave = meta.halfOnSave;
  const pushDistance = meta.pushDistance;
  const aoeShape = meta.aoeShape;
  const aoeRadius = meta.aoeRadius;

  const castAtLevel = (spell as any).__castAtLevel ?? spell.level;

  // Apply upcast damage scaling for AoE spells too. Reads the
  // description for "+Xd6 for each slot level above Yth" and bumps
  // the dice count accordingly.
  let upcastNote: string | null = null;
  if (spell.level > 0 && damageDice && castAtLevel > spell.level) {
    const upcast = applyUpcastDamage(
      damageDice,
      spell.description || '',
      spell.level,
      castAtLevel,
    );
    if (upcast.bonusDice) {
      damageDice = upcast.dice;
      upcastNote = `   Upcast: ${upcast.bonusDice} (${upcast.extraLevels} level${upcast.extraLevels !== 1 ? 's' : ''} above ${spell.level})`;
    }
  }

  // Build the cast announcement header for the consolidated message.
  const shapeLabel = aoeShape === 'cube' ? 'Cube' : aoeShape === 'cone' ? 'Cone' : aoeShape === 'line' ? 'Line' : 'Radius';
  const headerLines: string[] = [
    `✦ ${casterName} casts ${spell.name}`,
    `   ${aoeRadius}-ft ${shapeLabel} • ${affectedTokens.length} creature${affectedTokens.length !== 1 ? 's' : ''} in area`,
  ];
  const dmOverride = !!(spell as any).__dmOverride;
  if (spell.level > 0) {
    if (dmOverride) {
      headerLines.push(`   🔓 DM override (no slot consumed)`);
    } else if (castAtLevel > spell.level) {
      headerLines.push(`   Spent level ${castAtLevel} slot (upcast from level ${spell.level})`);
    } else {
      headerLines.push(`   Spent level ${spell.level} slot`);
    }
  }
  if (upcastNote) headerLines.push(upcastNote);
  // Clean up the temporary markers so a re-cast doesn't see stale data
  delete (spell as any).__castAtLevel;
  delete (spell as any).__dmOverride;

  // Trigger the spell animation. For AoE shapes the animation plays at
  // the AoE origin (sphere/cube center, or the cone/line tip) so the
  // user gets visual feedback for Lightning Bolt, Burning Hands, etc.
  // The single-target useEffect path triggers animations separately.
  const spellAnim = getSpellAnimation(spell.name);
  if (spellAnim) {
    // For directional shapes (cone/line), the "target" is the far end of
    // the shape. For sphere/cube, it's the origin itself.
    let animTarget = aoeOrigin;
    if (aoeShape === 'cone' || aoeShape === 'line') {
      const sizePixels = (aoeRadius / 5) * gridSize;
      const rad = (rotationDeg * Math.PI) / 180;
      animTarget = {
        x: aoeOrigin.x + Math.cos(rad) * sizePixels,
        y: aoeOrigin.y + Math.sin(rad) * sizePixels,
      };
    }
    useEffectStore.getState().addAnimation({
      id: `spell-${Date.now()}-${Math.random()}`,
      casterPosition: { x: casterX, y: casterY },
      targetPosition: animTarget,
      animationType: spellAnim.type,
      color: spellAnim.color,
      secondaryColor: spellAnim.secondaryColor || spellAnim.color,
      duration: spellAnim.duration,
      particleCount: spellAnim.particleCount || 20,
      startedAt: Date.now(),
    });
  }

  if (affectedTokens.length === 0) {
    const where = excludeId ? `of ${casterName}` : 'of the spell origin';
    emitSystemMessage([
      ...headerLines,
      `   ⚠ No creatures within ${aoeRadius} ft ${where}.`,
    ].join('\n'));
    return;
  }

  // Pre-fetch any character data we don't already have in the store.
  // Critical: DM-spawned creatures aren't auto-synced to player sessions, so
  // without this the player would silently skip every creature.
  const missingCharIds: string[] = [];
  for (const t of affectedTokens) {
    const cid = (t as any).characterId;
    if (cid && !charStore.allCharacters[cid]) missingCharIds.push(cid);
  }
  if (missingCharIds.length > 0) {
    await Promise.all(missingCharIds.map(async (cid) => {
      try {
        const r = await fetch(`/api/characters/${cid}`);
        if (r.ok) {
          const data = await r.json();
          useCharacterStore.getState().setAllCharacters({
            ...useCharacterStore.getState().allCharacters,
            [cid]: data,
          });
        }
      } catch { /* ignore */ }
    }));
  }

  // Re-read store after fetches
  const refreshedStore = useCharacterStore.getState();

  // Build the per-target result lines synchronously, then emit one
  // consolidated chat message at the end. We schedule the actual HP / token
  // updates with small staggered delays so the UI animates smoothly.
  const targetLines: string[] = [];

  for (let i = 0; i < affectedTokens.length; i++) {
    const aToken = affectedTokens[i] as any;
    const aCharId = aToken.characterId;
    if (!aCharId) {
      console.warn('[CAST SELF] Token has no characterId, skipping:', aToken.name);
      targetLines.push(`   • ${aToken.name}: skipped (no character link)`);
      continue;
    }
    const aChar = refreshedStore.allCharacters[aCharId];
    if (!aChar) {
      console.warn('[CAST SELF] Character not in store after fetch, skipping:', aToken.name, aCharId);
      targetLines.push(`   • ${aToken.name}: skipped (character not loaded)`);
      continue;
    }

    const aHp = typeof aChar.hitPoints === 'number' ? aChar.hitPoints : parseInt(String(aChar.hitPoints)) || 0;
    if (aHp <= 0) {
      targetLines.push(`   • ${aToken.name}: already down`);
      continue;
    }

    const delay = i * 200;
    const lineParts: string[] = [];

    // Save + damage — applies the rules engine modifiers from the
    // target's conditions (Bless +1d4, Hasted DEX advantage, Paralyzed
    // auto-fail, etc.)
    let aSaved = false;
    if (resolvedSavingThrow) {
      const aScores = aChar.abilityScores
        ? (typeof aChar.abilityScores === 'string' ? JSON.parse(aChar.abilityScores) : aChar.abilityScores)
        : {};
      const aSaveMod = abilityModifier((aScores as any)[resolvedSavingThrow] || 10);
      const aTokenConditions = (aToken.conditions || []) as string[];
      const aMods = getOwnRollModifiers(aTokenConditions);
      // Magic Resistance applies to the AoE save too
      if (hasMagicResistance(aChar)) {
        (aMods.saveAdvantage as any)[resolvedSavingThrow] = 'advantage';
        aMods.notes.push('Magic Resistance (adv. vs spells)');
      }
      const saveResult = rollSaveWithModifiers(resolvedSavingThrow as any, aSaveMod, aMods);
      aSaved = saveResult.autoFailed ? false : saveResult.total >= casterSpellDC;
      const saveLabel = resolvedSavingThrow.toUpperCase();
      const saveIcon = aSaved ? '✓' : '✗';
      const modNote = aMods.notes.length > 0 ? ` [${aMods.notes.join(', ')}]` : '';
      lineParts.push(`${saveIcon} ${saveLabel} ${saveResult.breakdown} vs DC ${casterSpellDC} → ${aSaved ? 'SAVED' : 'FAILED'}${modNote}`);
    }

    // Damage — runs through resistance/immunity/vulnerability per target
    let finalDmg = 0;
    if (damageDice) {
      const total = rollDamageDice(damageDice);
      const beforeResist = aSaved && halfOnSave ? Math.floor(total / 2) : aSaved ? 0 : total;
      if (beforeResist > 0) {
        // Read fresh HP from store right before applying
        const freshChar = useCharacterStore.getState().allCharacters[aCharId];
        const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : aHp;
        const dmgType = (spell.damageType || '').toLowerCase();
        const dmgWord = dmgType ? `${dmgType} ` : '';
        const aTokenConditions2 = (aToken.conditions || []) as string[];
        const resisted = applyResistedDamage(beforeResist, dmgType, freshChar, aTokenConditions2);
        finalDmg = resisted.final;
        const newHp = Math.max(0, freshHp - finalDmg);
        const resistTag = resisted.note ? ` [${resisted.note}]` : '';
        const dmgChange = finalDmg !== beforeResist ? `${beforeResist}→${finalDmg}` : `${finalDmg}`;
        lineParts.push(`${dmgChange} ${dmgWord}dmg${aSaved ? ' (half)' : ''}${resistTag} (HP ${freshHp}→${newHp})`);
        if (newHp === 0) lineParts.push('💀 DOWN');
        // Schedule the actual HP update + damage side effects (CON save,
        // Sleep ends-on-damage, Hideous Laughter save retry)
        setTimeout(() => {
          emitCharacterUpdate(aCharId, { hitPoints: newHp });
          useCharacterStore.getState().applyRemoteUpdate(aCharId, { hitPoints: newHp });
          if (finalDmg > 0) emitDamageSideEffects(aToken.id, finalDmg);
        }, delay + 300);
      } else if (resolvedSavingThrow && aSaved && !halfOnSave) {
        lineParts.push('no damage');
      }
    }

    // Pushback fires BEFORE the damage tick (delay vs delay+300), so dead
    // targets still move visually. For Thunderwave the rule is "pushed 10
    // feet on a failed save"; saved targets aren't pushed. The push direction
    // is FROM the AoE origin (which is the caster for Self-range spells, or
    // the explosion center for placed AoE spells).
    const shouldPush = pushDistance > 0 && (!resolvedSavingThrow || !aSaved);
    if (shouldPush) {
      let dx = aToken.x - aoeOrigin.x;
      let dy = aToken.y - aoeOrigin.y;
      const rawDist = Math.sqrt(dx * dx + dy * dy);
      if (rawDist === 0) { dx = gridSize; dy = 0; }
      const dist = rawDist || gridSize;
      const pushPixels = (pushDistance / 5) * gridSize;
      const newX = Math.round(aToken.x + (dx / dist) * pushPixels);
      const newY = Math.round(aToken.y + (dy / dist) * pushPixels);
      lineParts.push(`💨 pushed ${pushDistance} ft`);
      setTimeout(() => {
        // Update the local store immediately so the player sees the move
        // even if the server's broadcast is delayed.
        useMapStore.getState().updateToken(aToken.id, { x: newX, y: newY } as any);
        emitTokenUpdate(aToken.id, { x: newX, y: newY });
      }, delay);
    } else if (pushDistance > 0 && resolvedSavingThrow && aSaved) {
      // Make it explicit that the saved target is NOT pushed.
      lineParts.push(`resists pushback`);
    }

    // Auto-apply conditions on failed save WITH duration metadata
    if (resolvedSavingThrow && !aSaved) {
      const conditions = SPELL_CONDITIONS[spell.name];
      if (conditions && conditions.length > 0) {
        lineParts.push(`now ${conditions.join(', ')}`);
        const durMeta = getSpellDurationMeta(spell.name);
        const currentRound = useCombatStore.getState().roundNumber || 0;
        const expiresAfterRound = currentRound > 0
          ? currentRound + durMeta.durationRounds - 1
          : undefined;
        const saveRetry = durMeta.saveAbility ? {
          ability: durMeta.saveAbility,
          dc: casterSpellDC,
        } : undefined;
        setTimeout(() => {
          const targetTokenData = useMapStore.getState().tokens[aToken.id];
          if (targetTokenData) {
            // Local optimistic update — the authoritative condition
            // comes back from the server via the condition:apply-with-
            // meta broadcast. Direct emitTokenUpdate is now blocked
            // server-side when a non-DM targets their own token.
            const existingConditions = targetTokenData.conditions || [];
            const newConditions = [...new Set([...existingConditions, ...conditions])] as any;
            useMapStore.getState().updateToken(aToken.id, { conditions: newConditions });
            for (const condName of conditions) {
              emitApplyConditionWithMeta({
                targetTokenId: aToken.id,
                conditionName: condName,
                source: spell.name,
                casterTokenId: spell.isConcentration ? casterTokenId : undefined,
                expiresAfterRound,
                saveAtEndOfTurn: saveRetry,
                endsOnDamage: durMeta.endsOnDamage,
              });
            }
          }
        }, delay + 500);
      }
    }

    targetLines.push(`   • ${aToken.name}: ${lineParts.join(' • ')}`);
  }

  emitSystemMessage([...headerLines, ...targetLines].join('\n'));
}

/**
 * Cast a Self-range AoE spell whose origin is the caster (sphere/cube).
 * Direction-less, fires immediately.
 */
async function castSelfSpell(spell: any, casterTokenId: string, casterName: string) {
  await resolveAreaSpell(spell, casterTokenId, casterName, null, 0);
}

/**
 * Cast the Light / Dancing Lights cantrip. Enters a "place light"
 * targeting mode: the player clicks anywhere on the map to drop a
 * dedicated light marker token at that position. The marker emits a
 * 20 ft bright / 40 ft dim radius and cuts the fog of war around
 * itself (see FogLayer.tsx). Casting again dismisses the caster's
 * existing light markers.
 */
async function castLightSpell(
  spell: any,
  casterTokenId: string,
  casterName: string,
  actionSlot: ActionType,
) {
  const mapState = useMapStore.getState();
  const currentMap = mapState.currentMap;
  if (!currentMap) return;

  const casterToken = mapState.tokens[casterTokenId];
  if (!casterToken) return;

  // ── Dismissal path: caster already has light tokens out, toggle off.
  // Light markers are identified by name prefix "Light (" / "Dancing
  // Lights (" and the caster's name. This survives page refresh
  // because it's serialized to the DB unlike a client-side tag.
  const markerPrefix = `${spell.name} (${casterName})`;
  const existing = Object.values(mapState.tokens).filter(
    (t: any) => t.name === markerPrefix,
  ) as any[];
  if (existing.length > 0) {
    const { emitTokenRemove } = await import('../../socket/emitters');
    for (const mt of existing) {
      emitTokenRemove(mt.id);
    }
    emitSystemMessage(`✦ ${casterName} ends ${spell.name}`);
    const cbt = useCombatStore.getState();
    const cur = cbt.combatants[cbt.currentTurnIndex];
    if (cbt.active && cur?.tokenId === casterTokenId) {
      emitUseAction(actionSlot);
    }
    return;
  }

  const gridSize = currentMap.gridSize || 70;

  // Show a hint and listen for a single canvas click. We DON'T use
  // EffectLayer aim mode because Light places a point light, not an
  // AoE — the template wouldn't add anything visually useful.
  const hintEl = document.createElement('div');
  hintEl.textContent = `Cast ${spell.name} — click on the map to place a light. Esc to cancel.`;
  Object.assign(hintEl.style, {
    position: 'fixed', top: '12%', left: '50%', transform: 'translateX(-50%)',
    padding: '10px 18px', background: 'rgba(0,0,0,0.85)', color: '#fff',
    borderRadius: '8px', border: '2px solid #8cb4ff',
    zIndex: '99999', fontSize: '13px', fontWeight: '600', fontFamily: 'sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
  });
  document.body.appendChild(hintEl);

  function cleanup() {
    window.removeEventListener('canvas-click', onCanvasClick as EventListener);
    window.removeEventListener('keydown', onKey);
    if (hintEl.parentNode) hintEl.remove();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      cleanup();
      emitSystemMessage(`✦ ${casterName} cancels ${spell.name}`);
    }
  }

  async function onCanvasClick(e: Event) {
    const detail = (e as CustomEvent).detail as { mapX: number; mapY: number };
    cleanup();

    // Spawn a dedicated light marker token at the click position.
    // The marker is tiny (0.25 tile), invisible-looking (pure blue
    // circle as the fallback image), and emits magic-blue light.
    // Ownership goes to the caster so they can dismiss it even as a
    // non-DM.
    const { emitTokenAdd } = await import('../../socket/emitters');
    emitTokenAdd({
      mapId: currentMap!.id,
      characterId: null,
      // Named with the caster so the dismiss path can find it after
      // refresh without a custom tag column.
      name: markerPrefix,
      x: detail.mapX - (gridSize * 0.125),
      y: detail.mapY - (gridSize * 0.125),
      size: 0.25,
      imageUrl: null,
      color: '#8cb4ff',
      layer: 'token',
      visible: true,
      hasLight: true,
      lightRadius: gridSize * 4,    // 20 ft bright
      lightDimRadius: gridSize * 8, // 40 ft total
      lightColor: '#8cb4ff',
      conditions: [],
      ownerUserId: (casterToken as any).ownerUserId ?? null,
    });

    emitSystemMessage(
      `✦ ${casterName} casts ${spell.name} — a floating mote of magical light blooms at the chosen spot, illuminating 20 ft around it.`,
    );

    // Burn the Action slot if we're in combat
    const cbt = useCombatStore.getState();
    const cur = cbt.combatants[cbt.currentTurnIndex];
    if (cbt.active && cur?.tokenId === casterTokenId) {
      emitUseAction(actionSlot);
    }
  }

  window.addEventListener('canvas-click', onCanvasClick as EventListener);
  window.addEventListener('keydown', onKey);
}

/**
 * Map a spell name → CSS color hex for AoE template tinting.
 */
function colorForSpell(spell: any): string {
  const school = (spell.school || '').toLowerCase();
  if (school.includes('evocation')) return '#ff6b3d';
  if (school.includes('necromancy')) return '#7e3a96';
  if (school.includes('abjuration')) return '#3a86c8';
  if (school.includes('enchantment')) return '#a060c0';
  if (school.includes('conjuration')) return '#1abc9c';
  if (school.includes('transmutation')) return '#d4a843';
  if (school.includes('divination')) return '#a0a0c0';
  if (school.includes('illusion')) return '#e67e22';
  return '#c53131';
}

/**
 * Enter "aim mode" for an AoE spell. Sets up the EffectLayer template at
 * the cursor (or pinned to caster for Self cone/line) and waits for a canvas
 * click to confirm. Esc / right-click cancels.
 *
 * Used for:
 *  • Self-range cones (Burning Hands, Cone of Cold)
 *  • Self-range lines (Lightning Bolt)
 *  • Non-Self placed AoE (Fireball, Stinking Cloud, Web)
 */
async function aimAndCastSpell(spell: any, casterTokenId: string, casterName: string) {
  const casterChar = useMapStore.getState().tokens[casterTokenId]?.characterId
    ? useCharacterStore.getState().allCharacters[useMapStore.getState().tokens[casterTokenId]!.characterId!]
    : null;
  const meta = await parseSpellMeta(spell, casterChar?.level ?? 1);

  if (!meta.hasAoe) {
    // Shouldn't happen — caller should only invoke this for AoE spells
    console.warn('[AIM] Spell has no AoE, falling back to single target');
    useMapStore.getState().startTargetingMode({ spell, casterTokenId, casterName });
    return;
  }

  // Set up the effect store template
  const effectStore = useEffectStore.getState();
  effectStore.startTargeting({
    spellName: spell.name,
    aoeType: meta.aoeShape,
    aoeSize: meta.aoeRadius,
    casterTokenId,
    color: colorForSpell(spell),
  });

  // Initialize the template at the caster (or wherever the cursor will land)
  const casterToken = useMapStore.getState().tokens[casterTokenId] as any;
  if (casterToken) {
    effectStore.setTargetPosition({ x: casterToken.x, y: casterToken.y });
  }

  // Show a hint toast
  const hintEl = document.createElement('div');
  const hintText = (meta.aoeShape === 'cone' || meta.aoeShape === 'line')
    ? `Aim ${spell.name} — click a direction. Esc to cancel.`
    : `Place ${spell.name} — click on the map. Esc to cancel.`;
  hintEl.textContent = hintText;
  Object.assign(hintEl.style, {
    position: 'fixed', top: '12%', left: '50%', transform: 'translateX(-50%)',
    padding: '10px 18px', background: 'rgba(0,0,0,0.85)', color: '#fff',
    borderRadius: '8px', border: `2px solid ${colorForSpell(spell)}`,
    zIndex: '99999', fontSize: '13px', fontWeight: '600', fontFamily: 'sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
  });
  document.body.appendChild(hintEl);

  function cleanup() {
    effectStore.cancelTargeting();
    window.removeEventListener('aoe-spell-confirm', onConfirm as EventListener);
    window.removeEventListener('keydown', onKey);
    if (hintEl.parentNode) hintEl.remove();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      cleanup();
      emitSystemMessage(`✦ ${casterName} cancels ${spell.name}`);
    }
  }

  async function onConfirm(e: Event) {
    const detail = (e as CustomEvent).detail as { mapX: number; mapY: number; rotation: number };
    cleanup();

    // For Self-range cone/line, the origin stays at the caster — use rotation
    // direction. For non-Self placed AoE, the origin IS the click point.
    const isSelfRange = (spell.range || '').toLowerCase().includes('self');
    const isDirectional = meta.aoeShape === 'cone' || meta.aoeShape === 'line';
    if (isSelfRange && isDirectional) {
      const caster = useMapStore.getState().tokens[casterTokenId] as any;
      if (!caster) return;
      const angle = Math.atan2(detail.mapY - caster.y, detail.mapX - caster.x) * 180 / Math.PI;
      await resolveAreaSpell(spell, casterTokenId, casterName, { x: caster.x, y: caster.y }, angle);
    } else {
      // Non-Self placement OR Self sphere/cube redirected here (rare)
      await resolveAreaSpell(spell, casterTokenId, casterName, { x: detail.mapX, y: detail.mapY }, detail.rotation);
    }
  }

  window.addEventListener('aoe-spell-confirm', onConfirm as EventListener);
  window.addEventListener('keydown', onKey);
}

/**
 * Top-level "cast a spell" entry point used by the spell button. Picks the
 * right flow (single-target, instant Self AoE, or aim mode) based on the
 * spell's range and aoeType.
 */
async function castSpellFromButton(spell: any, casterTokenId: string, casterName: string) {
  const casterChar = useMapStore.getState().tokens[casterTokenId]?.characterId
    ? useCharacterStore.getState().allCharacters[useMapStore.getState().tokens[casterTokenId]!.characterId!]
    : null;

  // ── Special-case: Light / Dancing Lights ───────────────────────
  // Light is a "touch an object" cantrip — in the VTT we let the
  // caster click anywhere on the map to place a standalone "Light"
  // marker token at that position. The marker emits a 20 ft bright /
  // 40 ft dim radius and cuts the fog of war around it so the party
  // can see what's been illuminated. Casting it a second time
  // dismisses the caster's existing light tokens.
  if (spell.name === 'Light' || spell.name === 'Dancing Lights') {
    const lightSlot = actionSlotForCastingTime(spell.castingTime) ?? 'action';
    if (!canSpendActionSlot(casterTokenId, lightSlot, spell.name)) return;

    await castLightSpell(spell, casterTokenId, casterName, lightSlot);
    return;
  }

  const meta = await parseSpellMeta(spell, casterChar?.level ?? 1);

  const isSelfRange = (spell.range || '').toLowerCase().includes('self');
  const isDirectional = meta.aoeShape === 'cone' || meta.aoeShape === 'line';

  if (!meta.hasAoe) {
    // Single target — use the existing targeting useEffect path
    useMapStore.getState().startTargetingMode({ spell, casterTokenId, casterName });
    return;
  }

  if (isSelfRange && !isDirectional) {
    // Self sphere/cube — origin = caster, fire immediately
    await castSelfSpell(spell, casterTokenId, casterName);
    return;
  }

  // Self cone/line OR non-Self placed AoE → aim mode
  await aimAndCastSpell(spell, casterTokenId, casterName);
}

function quickBtnStyle(color: string): React.CSSProperties {
  return {
    flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 10, fontWeight: 600,
    background: `${color}15`, border: `1px solid ${color}33`, color,
    cursor: 'pointer', fontFamily: 'inherit',
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 8, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 3 }}>{title}</div>
      {children}
    </div>
  );
}

function ActionBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '2px 6px', fontSize: 9, fontWeight: 600, borderRadius: 3,
      background: `${color}22`, border: `1px solid ${color}44`, color,
      cursor: 'pointer', fontFamily: 'inherit',
    }}>{label}</button>
  );
}

/**
 * Bigger button used by the Combat Actions section for Dash / Dodge /
 * Disengage / Hide / Search / Help / Ready. Includes a tooltip so the
 * player can see the 5e rules for each action on hover.
 */
/**
 * Apply upcast damage scaling. Many spells (Fireball, Burning Hands,
 * Lightning Bolt, etc.) say "the damage increases by Xd6 for each
 * slot level above Yth". This helper:
 *   1. Looks for that exact phrase in the spell description.
 *   2. Computes how many extra dice to add (castLevel - baseLevel) ×
 *      bonus dice.
 *   3. Returns the upcast-adjusted damage dice string.
 *
 * Falls back to the original dice when no upcast clause is found
 * (Magic Missile, Cure Wounds, etc. have different wording — they're
 * handled per-spell where it matters).
 */
function applyUpcastDamage(
  baseDice: string,
  description: string,
  baseLevel: number,
  castLevel: number,
): { dice: string; bonusDice: string | null; extraLevels: number } {
  if (castLevel <= baseLevel || !baseDice || baseLevel <= 0) {
    return { dice: baseDice, bonusDice: null, extraLevels: 0 };
  }
  const cleanDesc = (description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  // Match "increases by 1d6" or "1d6 for each slot level above 3rd".
  // IMPORTANT: the optional `spell ` between "each" and "slot" is critical
  // — 2024 PHB phrasing is "each spell slot level above N" whereas the
  // original regex only allowed "each slot level above N", which silently
  // broke upcast for every spell imported from DDB's modern text.
  const m = cleanDesc.match(
    /(?:damage|healing)\s+(?:increases?|increase)\s+by\s+(\d+d\d+)\s+for\s+each\s+(?:spell\s+)?slot\s+level\s+above\s+(?:the\s+)?(\d+)/i,
  ) ?? cleanDesc.match(/(\d+d\d+)\s+for\s+each\s+(?:spell\s+)?slot\s+level\s+above\s+(?:the\s+)?(\d+)/i);
  if (!m) return { dice: baseDice, bonusDice: null, extraLevels: 0 };

  const bonus = m[1];
  const above = parseInt(m[2], 10);
  const extraLevels = castLevel - above;
  if (extraLevels <= 0) return { dice: baseDice, bonusDice: null, extraLevels: 0 };

  const bonusMatch = bonus.match(/^(\d+)d(\d+)$/);
  if (!bonusMatch) return { dice: baseDice, bonusDice: null, extraLevels: 0 };
  const bonusCount = parseInt(bonusMatch[1], 10) * extraLevels;
  const bonusSides = parseInt(bonusMatch[2], 10);

  // Add the bonus dice to the base. If the base is "8d6" and the
  // bonus is "1d6 per level above 3rd" cast at 5th, we want "10d6".
  // The base might also have a +modifier like "8d6+0" — we keep the
  // modifier in place and just bump the dice count.
  const baseMatch = baseDice.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (baseMatch && parseInt(baseMatch[2], 10) === bonusSides) {
    const newCount = parseInt(baseMatch[1], 10) + bonusCount;
    const mod = baseMatch[3] ?? '';
    return {
      dice: `${newCount}d${bonusSides}${mod}`,
      bonusDice: `+${bonusCount}d${bonusSides}`,
      extraLevels,
    };
  }

  // Different die size — append the bonus as a separate term so the
  // dice roller still handles it.
  return {
    dice: `${baseDice}+${bonusCount}d${bonusSides}`,
    bonusDice: `+${bonusCount}d${bonusSides}`,
    extraLevels,
  };
}

/**
 * Broadcast that an attack would hit so the target's owner can pop
 * a Shield prompt. Returns `true` if Shield was cast (caller should
 * recompute the hit with +5 AC) or `false` if the window elapsed.
 */
async function broadcastHitAndAwaitShield(args: {
  targetTokenId: string;
  attackerName: string;
  attackTotal: number;
  currentAC: number;
}): Promise<boolean> {
  const attackId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  emitAttackHitAttempt({ ...args, attackId });

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('shield-cast', onShield as EventListener);
      resolve(false);
    }, 1500);
    function onShield(e: Event) {
      const detail = (e as CustomEvent).detail as { attackId?: string };
      if (detail?.attackId && detail.attackId !== attackId) return;
      clearTimeout(timeout);
      window.removeEventListener('shield-cast', onShield as EventListener);
      resolve(true);
    }
    window.addEventListener('shield-cast', onShield as EventListener);
  });
}

/**
 * Broadcast a leveled spell cast attempt and wait briefly for a
 * counterspell to come back. Returns `true` if the spell was
 * counterspelled (resolver should abort) or `false` if the window
 * elapsed without interruption.
 *
 * The window is short (1.4 s) so casts feel responsive — long
 * enough that another player has time to react, short enough that
 * combat doesn't grind to a halt waiting for a counterspell that
 * never comes.
 */
async function broadcastCastAndAwaitCounterspell(args: {
  casterTokenId: string;
  casterName: string;
  spellName: string;
  spellLevel: number;
}): Promise<boolean> {
  // Cantrips and slot-zero "spells" can't be counterspelled in 5e —
  // Counterspell only targets a creature casting a spell, but per
  // the prompt window we still skip them to avoid noise.
  if (args.spellLevel <= 0) return false;

  const castId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  emitSpellCastAttempt({ ...args, castId });

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('spell-counterspelled', onCounter as EventListener);
      resolve(false);
    }, 1400);
    function onCounter(e: Event) {
      const detail = (e as CustomEvent).detail as { castId?: string };
      if (detail?.castId && detail.castId !== castId) return;
      clearTimeout(timeout);
      window.removeEventListener('spell-counterspelled', onCounter as EventListener);
      resolve(true);
    }
    window.addEventListener('spell-counterspelled', onCounter as EventListener);
  });
}

/**
 * Inline list of weapon property pills. Each property gets a rules
 * tooltip so hovering "Finesse" or "Thrown" shows the full 5e rules
 * for what the property does. Raw property strings from the imported
 * weapon data can look like "Range 80/320" — `lookupWeaponProperty`
 * strips the numeric suffix so the prefix matches.
 */
function WeaponProperties({ properties }: { properties: string[] }) {
  if (!properties || properties.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3, marginLeft: 3 }}>
      {properties.map((prop, idx) => {
        const rule = lookupWeaponProperty(prop);
        const pill = (
          <span style={{
            padding: '0px 5px', fontSize: 8, fontWeight: 600,
            background: 'rgba(212,168,67,0.08)',
            border: '1px solid rgba(212,168,67,0.25)',
            borderRadius: 3, color: '#d4a843',
            textTransform: 'capitalize' as const,
            cursor: rule ? 'help' : 'default',
            display: 'inline-block',
          }}>
            {prop}
          </span>
        );
        if (!rule) return <span key={idx}>{pill}</span>;
        return (
          <InfoTooltip
            key={idx}
            title={rule.title}
            body={rule.body}
            footer={rule.footer}
            accent={rule.accent}
          >
            {pill}
          </InfoTooltip>
        );
      })}
    </span>
  );
}

/**
 * Compact Combat Actions button used by Dash/Dodge/Disengage/etc.
 * Styled to match the rest of the panel (dark background, muted
 * border, subtle accent) with a rich hover tooltip pulled from the
 * rules-text dictionary so the user gets the full 5e rules without
 * opening a browser. Pass the action name (case-insensitive) —
 * `lookupCombatAction` finds the matching entry.
 */
function CombatActionBtn({ action, color, onClick, disabled }: {
  action: string; color: string; onClick: () => void; disabled?: boolean;
}) {
  const rule = lookupCombatAction(action);
  const btn = (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        padding: '5px 9px', fontSize: 9, fontWeight: 700, borderRadius: 3,
        // Muted "pill" that matches the rest of the ActionBtn vocabulary:
        // dark card background, faint colored border, colored text.
        background: disabled ? 'rgba(255,255,255,0.02)' : `${color}14`,
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : `${color}44`}`,
        color: disabled ? '#555' : color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit', textTransform: 'uppercase',
        letterSpacing: '0.5px', minWidth: 58,
        opacity: disabled ? 0.6 : 1,
        transition: 'all 0.12s ease',
      }}
    >
      {action}
    </button>
  );
  if (!rule) return btn;
  return (
    <InfoTooltip title={rule.title} body={rule.body} footer={rule.footer} accent={rule.accent ?? color}>
      {btn}
    </InfoTooltip>
  );
}

const CONDITION_COLORS: Record<string, string> = {
  // Standard 5e conditions
  blinded: '#4a4a4a', charmed: '#ff69b4', deafened: '#95a5a6',
  frightened: '#9b59b6', grappled: '#e67e22', incapacitated: '#7f8c8d',
  invisible: '#3498db', paralyzed: '#f1c40f', petrified: '#bdc3c7',
  poisoned: '#27ae60', prone: '#e74c3c', restrained: '#c0392b',
  stunned: '#f39c12', unconscious: '#2c3e50', exhaustion: '#8e44ad',
  // Buff badges (from SPELL_BUFFS) — use gold/blue for positive, dark red for debuff
  blessed: '#d4a843', heroic: '#d4a843', aided: '#27ae60',
  shielded: '#3498db', 'mage-armored': '#3498db', protected: '#3498db',
  sanctuary: '#ffd700', hasted: '#1abc9c', enlarged: '#e67e22',
  reduced: '#9b59b6', stoneskin: '#7f8c8d', 'death-warded': '#d4a843',
  flying: '#87ceeb', 'spider-climbing': '#8b4513', jumping: '#1abc9c',
  stealthy: '#4a4a4a', barkskin: '#6b8e23', 'temp-hp': '#95a5a6',
  'true-strike': '#d4a843', marked: '#c0392b', hexed: '#9b59b6',
  outlined: '#ffd700', baned: '#8b0000', slowed: '#7f8c8d',
  cursed: '#7e3a96', weakened: '#6b6b6b',
  // Combat action flags — set when a player takes Dodge / Disengage
  // (cleared at the start of their next turn by the server's nextTurn
  // handler, see combatEvents.ts).
  dodging: '#9b59b6', disengaged: '#1abc9c',
  // Shield spell (1st-level abjuration) — +5 AC until the start of
  // the caster's next turn. Same expiration flow as Dodge/Disengage.
  'shield-spell': '#3498db',
};

const ALL_CONDITIONS = Object.keys(CONDITION_COLORS);

function HPControls({ hp, maxHp, hpPct, canEdit, onDamage, onHeal }: {
  hp: number; maxHp: number; hpPct: number; canEdit: boolean;
  onDamage: (amount: number) => void; onHeal: (amount: number) => void;
}) {
  const [hpInput, setHpInput] = useState('');
  const [showInput, setShowInput] = useState(false);

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, marginBottom: 2 }}>
        <span style={{ color: C.green, fontWeight: 600 }}>HP</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {canEdit && (
            <>
              {[1, 5, 10].map(n => (
                <button key={`d${n}`} onClick={() => onDamage(n)} style={{
                  padding: '0 4px', fontSize: 9, background: 'rgba(197,49,49,0.15)',
                  border: `1px solid ${C.red}33`, borderRadius: 3, color: C.red,
                  cursor: 'pointer', fontFamily: 'inherit', lineHeight: '16px',
                }}>-{n}</button>
              ))}
            </>
          )}
          <span style={{ fontWeight: 700, fontSize: 12, color: hpPct > 0.5 ? C.green : hpPct > 0.25 ? C.gold : C.red, minWidth: 40, textAlign: 'center' }}>
            {hp}/{maxHp}
          </span>
          {canEdit && (
            <>
              {[1, 5, 10].map(n => (
                <button key={`h${n}`} onClick={() => onHeal(n)} style={{
                  padding: '0 4px', fontSize: 9, background: 'rgba(69,160,73,0.15)',
                  border: `1px solid ${C.green}33`, borderRadius: 3, color: C.green,
                  cursor: 'pointer', fontFamily: 'inherit', lineHeight: '16px',
                }}>+{n}</button>
              ))}
            </>
          )}
        </div>
      </div>
      <div style={{ height: 5, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 3, transition: 'width 0.3s',
          width: `${Math.max(0, Math.min(100, hpPct * 100))}%`,
          background: hpPct > 0.5 ? C.green : hpPct > 0.25 ? C.gold : C.red,
        }} />
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
          <input type="number" value={hpInput} onChange={e => setHpInput(e.target.value)}
            placeholder="Custom" onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = parseInt(hpInput);
                if (!isNaN(v) && v > 0) { onDamage(v); setHpInput(''); }
              }
            }}
            style={{
              flex: 1, padding: '2px 6px', fontSize: 10, background: '#333',
              border: `1px solid ${C.borderDim}`, borderRadius: 3, color: C.text,
              outline: 'none', width: 50,
            }} />
          <button onClick={() => { const v = parseInt(hpInput); if (!isNaN(v) && v > 0) { onDamage(v); setHpInput(''); } }}
            style={{ padding: '2px 8px', fontSize: 9, fontWeight: 600, background: 'rgba(197,49,49,0.2)', border: `1px solid ${C.red}44`, borderRadius: 3, color: C.red, cursor: 'pointer', fontFamily: 'inherit' }}>
            Dmg
          </button>
          <button onClick={() => { const v = parseInt(hpInput); if (!isNaN(v) && v > 0) { onHeal(v); setHpInput(''); } }}
            style={{ padding: '2px 8px', fontSize: 9, fontWeight: 600, background: 'rgba(69,160,73,0.2)', border: `1px solid ${C.green}44`, borderRadius: 3, color: C.green, cursor: 'pointer', fontFamily: 'inherit' }}>
            Heal
          </button>
        </div>
      )}
    </div>
  );
}

function ConditionsBar({ conditions, canEdit, onToggle }: {
  conditions: string[]; canEdit: boolean; onToggle: (cond: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  return (
    <div style={{ marginTop: 4 }}>
      {/* Active conditions — each badge is wrapped in an InfoTooltip
          so hovering shows the full 5e rules text for what the
          condition does. */}
      {conditions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 3 }}>
          {conditions.map((cond: string) => {
            const rule = lookupCondition(cond);
            const badge = (
              <span onClick={() => canEdit && onToggle(cond)} style={{
                padding: '1px 6px', fontSize: 8, fontWeight: 600,
                background: `${CONDITION_COLORS[cond] || '#888'}22`,
                border: `1px solid ${CONDITION_COLORS[cond] || '#888'}`,
                borderRadius: 8, color: CONDITION_COLORS[cond] || '#888',
                textTransform: 'capitalize', cursor: canEdit ? 'pointer' : 'help',
                display: 'inline-block',
              }}>
                {cond} {canEdit && '×'}
              </span>
            );
            if (!rule) return <span key={cond}>{badge}</span>;
            return (
              <InfoTooltip
                key={cond}
                title={rule.title}
                body={rule.body}
                footer={rule.footer}
                accent={rule.accent ?? CONDITION_COLORS[cond]}
              >
                {badge}
              </InfoTooltip>
            );
          })}
        </div>
      )}
      {/* Add condition button */}
      {canEdit && (
        <>
          <button onClick={() => setShowAll(!showAll)} style={{
            padding: '1px 8px', fontSize: 8, background: 'transparent',
            border: `1px solid ${C.borderDim}`, borderRadius: 3,
            color: C.textMuted, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {showAll ? '▲ Hide conditions' : '＋ Add condition'}
          </button>
          {showAll && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginTop: 3 }}>
              {ALL_CONDITIONS.filter(c => !conditions.includes(c)).map(cond => {
                const rule = lookupCondition(cond);
                const btn = (
                  <button onClick={() => onToggle(cond)} style={{
                    padding: '1px 5px', fontSize: 7, borderRadius: 3,
                    background: C.bgHover, border: `1px solid ${C.borderDim}`,
                    color: C.textMuted, cursor: 'pointer', fontFamily: 'inherit',
                    textTransform: 'capitalize',
                  }}>{cond}</button>
                );
                if (!rule) return <span key={cond}>{btn}</span>;
                return (
                  <InfoTooltip
                    key={cond}
                    title={rule.title}
                    body={rule.body}
                    footer={rule.footer}
                    accent={rule.accent}
                  >
                    {btn}
                  </InfoTooltip>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
