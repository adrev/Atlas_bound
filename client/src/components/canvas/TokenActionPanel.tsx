import { useState, useEffect, useCallback, useRef } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitRoll, emitCharacterUpdate, emitTokenUpdate, emitSystemMessage } from '../../socket/emitters';
import { abilityModifier, calculateEquipmentBonuses, SPELL_CONDITIONS, getSpellAnimation } from '@dnd-vtt/shared';
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

const C = {
  bg: '#1a1a1a', bgCard: '#222', bgHover: '#2a2a2a',
  border: '#444', borderDim: '#333',
  text: '#eee', textSec: '#aaa', textMuted: '#777',
  red: '#c53131', green: '#45a049', gold: '#d4a843', blue: '#4a9fd5', purple: '#8b5cf6',
};

function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') try { return JSON.parse(val); } catch { return fallback; }
  return (val as T) ?? fallback;
}

function fmtMod(n: number): string { return n >= 0 ? `+${n}` : String(n); }

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

export function TokenActionPanel() {
  const selectedTokenId = useMapStore((s) => s.selectedTokenId);
  const tokens = useMapStore((s) => s.tokens);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);

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

      // Fetch compendium data for this creature
      if (token) {
        const slug = token.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        fetch(`/api/compendium/monsters/${slug}`)
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data) setCompendiumData(data); })
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
          toast.innerHTML = `<div style="font-size:14px;font-weight:700;margin-bottom:4px">Out of Range!</div><div style="font-size:12px;opacity:0.8">${targetToken.name} is ${distFeet}ft away. Max range: ${maxRange}ft.</div>`;
          Object.assign(toast.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            padding: '16px 24px', background: '#1a1a1a', color: '#eee', borderRadius: '10px',
            border: '2px solid #c53131', zIndex: '99999', textAlign: 'center',
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
      const casterSpellDC = casterChar?.spellSaveDC ?? 13;
      const casterSpellAttack = casterChar?.spellAttackBonus ?? 0;

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

        // --- Phase 4: Concentration ---
        if (spell.isConcentration && casterChar) {
          const currentConc = casterChar.concentratingOn;
          if (currentConc) {
            emitSystemMessage(`✦ ${casterName} drops concentration on ${currentConc}`);
          }
          emitCharacterUpdate(casterId, { concentratingOn: spell.name });
          useCharacterStore.getState().applyRemoteUpdate(casterId, { concentratingOn: spell.name });
        }

        // --- Phase 2: Spell Slot Consumption (with upcast fallback) ---
        // A spell of level N can be cast with any slot ≥ N. Pick the lowest
        // available so we don't waste high-level slots. Block the cast if
        // no slot at level N or higher is available.
        // The DM "ignore slots" override skips both the consumption and
        // the availability check, but tags the chat header so it's clear
        // the cast was DM-overridden.
        let castAtLevel = spell.level;
        let dmOverride = false;
        if (spell.level > 0 && casterChar) {
          const dmIgnoreSlots = useSessionStore.getState().dmIgnoreSpellSlots;
          if (dmIgnoreSlots) {
            dmOverride = true;
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
        delete (spell as any).__dmOverride;
        const resultParts: string[] = [];
        const dmgType = (spell.damageType || '').toLowerCase();
        const dmgWord = dmgType ? `${dmgType} ` : '';

        // --- Phase 3A: Spell Attack vs AC ---
        if (resolvedAttackType) {
          const attackRoll = Math.floor(Math.random() * 20) + 1;
          const totalAttack = attackRoll + casterSpellAttack;
          const targetAC = targetChar?.armorClass ?? 10;
          const isHit = attackRoll === 20 || (attackRoll !== 1 && totalAttack >= targetAC);
          const isCrit = attackRoll === 20;

          const hitIcon = isCrit ? '💥' : isHit ? '✓' : '✗';
          resultParts.push(`${hitIcon} Attack ${totalAttack} vs AC ${targetAC} → ${isCrit ? 'CRIT' : isHit ? 'HIT' : 'MISS'}`);

          if (isHit && damageDice && effectiveCharId) {
            const finalDice = isCrit ? damageDice.replace(/(\d+)d/, (_: string, n: string) => `${parseInt(n) * 2}d`) : damageDice;
            const dmg = rollDamageDice(finalDice);
            const freshChar = useCharacterStore.getState().allCharacters[effectiveCharId];
            const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : targetHp;
            const newHp = Math.max(0, freshHp - dmg);
            resultParts.push(`${dmg} ${dmgWord}dmg (HP ${freshHp}→${newHp})${isCrit ? ' [CRIT]' : ''}`);
            if (newHp === 0) resultParts.push('💀 DOWN');
            setTimeout(() => updateTargetHp(effectiveCharId, newHp), 400);
          }
        }

        // --- Phase 3B: Saving Throw ---
        else if (resolvedSavingThrow) {
          const saveAbility = resolvedSavingThrow;
          const targetScores = targetChar?.abilityScores
            ? (typeof targetChar.abilityScores === 'string' ? JSON.parse(targetChar.abilityScores) : targetChar.abilityScores)
            : {};
          const targetSaveMod = abilityModifier(targetScores[saveAbility] || 10);
          const saveRoll = Math.floor(Math.random() * 20) + 1;
          const totalSave = saveRoll + targetSaveMod;
          const saved = totalSave >= casterSpellDC;
          const saveIcon = saved ? '✓' : '✗';
          resultParts.push(`${saveIcon} ${saveAbility.toUpperCase()} ${totalSave} vs DC ${casterSpellDC} → ${saved ? 'SAVED' : 'FAILED'}`);

          if (damageDice && effectiveCharId) {
            const total = rollDamageDice(damageDice);
            const dmg = saved && halfOnSave ? Math.floor(total / 2) : saved ? 0 : total;
            if (dmg > 0) {
              const freshChar = useCharacterStore.getState().allCharacters[effectiveCharId];
              const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : targetHp;
              const newHp = Math.max(0, freshHp - dmg);
              resultParts.push(`${dmg} ${dmgWord}dmg${saved ? ' (half)' : ''} (HP ${freshHp}→${newHp})`);
              if (newHp === 0) resultParts.push('💀 DOWN');
              setTimeout(() => updateTargetHp(effectiveCharId, newHp), 400);
            } else if (saved && !halfOnSave) {
              resultParts.push('no damage');
            }
          }

          // Auto-apply conditions on failed save
          if (!saved) {
            const conditions = SPELL_CONDITIONS[spell.name];
            if (conditions && conditions.length > 0) {
              resultParts.push(`now ${conditions.join(', ')}`);
              setTimeout(() => {
                const targetTokenData = useMapStore.getState().tokens[targetToken.id];
                if (targetTokenData) {
                  const existingConditions = targetTokenData.conditions || [];
                  const newConditions = [...new Set([...existingConditions, ...conditions])] as any;
                  emitTokenUpdate(targetToken.id, { conditions: newConditions });
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
            const newHp = Math.max(0, freshHp - dmg);
            resultParts.push(`${dmg} ${dmgWord}dmg (HP ${freshHp}→${newHp})`);
            if (newHp === 0) resultParts.push('💀 DOWN');
            updateTargetHp(effectiveCharId, newHp);
          } else {
            resultParts.push(`${dmg} ${dmgWord}dmg`);
          }
        }

        // --- No effect spell (buff, utility) ---
        else {
          resultParts.push('cast successfully');
        }

        emitSystemMessage([...headerLines, `   • ${targetName}: ${resultParts.join(' • ')}`].join('\n'));
      }

      if (currentTargeting.weapon || currentTargeting.action) {
        const atk = currentTargeting.weapon || currentTargeting.action;
        const atkBonus = atk.attack_bonus ?? 0;
        const dmgDice = atk.damage_dice || atk.damage || '1d6';
        console.log('[TARGETING] Weapon/Action:', atk.name, 'atkBonus:', atkBonus, 'dmgDice:', dmgDice, 'charId:', effectiveCharId);

        emitRoll(`1d20+${atkBonus}`, `${currentTargeting.casterName} → ${targetToken.name}: ${atk.name} Attack`);
        setTimeout(() => emitRoll(dmgDice, `${atk.name} → ${targetToken.name} Damage`), 300);

        if (effectiveCharId) {
          const cid = effectiveCharId;
          setTimeout(() => {
            const match = dmgDice.match(/(\d+)d(\d+)/);
            if (match) {
              const avgDmg = Math.ceil(parseInt(match[1]) * (parseInt(match[2]) + 1) / 2);
              updateTargetHp(cid, Math.max(0, targetHp - avgDmg));
            }
          }, 600);
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

  if (!visible || !selectedTokenId) return null;

  const token = tokens[selectedTokenId];
  if (!token) return null;

  const character = token.characterId ? allCharacters[token.characterId] : null;
  const isOwner = token.ownerUserId === userId;
  const canAct = isDM || isOwner;
  const isNPC = !token.ownerUserId || (character?.userId === 'npc');

  const scores = character ? parse<Record<string, number>>(character.abilityScores, {}) : {};
  const baseHp = character?.hitPoints ?? compendiumData?.hitPoints ?? 0;
  const hp = localHp !== null ? localHp : baseHp;
  const maxHp = character?.maxHitPoints ?? compendiumData?.hitPoints ?? 0;
  const storedAC = character?.armorClass ?? compendiumData?.armorClass ?? 10;
  const speed = character?.speed ?? (compendiumData?.speed?.walk) ?? 30;
  const profBonus = character?.proficiencyBonus ?? 2;
  const spells = character ? parse<any[]>(character.spells, []) : [];
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

  // Actions from compendium
  const compActions = compendiumData?.actions || [];
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

  return (
    <div style={{
      position: 'fixed', bottom: 90, left: 12, zIndex: 500,
      width: 320, maxHeight: 'calc(100vh - 160px)',
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12,
      boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
      fontFamily: '-apple-system, sans-serif', color: C.text,
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <button onClick={close} style={{
        position: 'absolute', top: 6, right: 8, zIndex: 10,
        background: 'none', border: 'none', color: C.textMuted, fontSize: 18, cursor: 'pointer',
      }}>&times;</button>

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
            <div style={{ fontSize: 15, fontWeight: 700 }}>{token.name}</div>
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
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11 }}>
          <span title={acTooltip}>AC <strong>{ac}</strong></span>
          <span>SPD <strong>{speed}ft</strong></span>
          <span>INIT <strong>{fmtMod(initiative)}</strong></span>
          {compendiumData?.challengeRating && <span>CR <strong>{compendiumData.challengeRating}</strong></span>}
        </div>

        {/* HP bar + controls */}
        {maxHp > 0 && (
          <HPControls
            hp={hp} maxHp={maxHp} hpPct={hpPct}
            canEdit={canAct}
            onDamage={(amount) => {
              const newHp = Math.max(0, hp - amount);
              setLocalHp(newHp);
              // Persist to server AND update the local store, otherwise the
              // panel reads stale data the next time it's opened (the panel
              // ignores localHp once it remounts).
              const charId = token.characterId || localCharId;
              if (charId) {
                emitCharacterUpdate(charId, { hitPoints: newHp });
                useCharacterStore.getState().applyRemoteUpdate(charId, { hitPoints: newHp });
              } else {
                // Create character record in background
                createCharForToken(token, compendiumData, newHp, maxHp, ac, speed).then(id => {
                  if (id) setLocalCharId(id);
                });
              }
            }}
            onHeal={(amount) => {
              const newHp = Math.min(maxHp, hp + amount);
              setLocalHp(newHp);
              const charId = token.characterId || localCharId;
              if (charId) {
                emitCharacterUpdate(charId, { hitPoints: newHp });
                useCharacterStore.getState().applyRemoteUpdate(charId, { hitPoints: newHp });
              } else {
                createCharForToken(token, compendiumData, newHp, maxHp, ac, speed).then(id => {
                  if (id) setLocalCharId(id);
                });
              }
            }}
          />
        )}

        {/* Conditions */}
        {(conditions.length > 0 || canAct) && (
          <ConditionsBar
            conditions={conditions}
            canEdit={canAct}
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
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
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
            <span style={{ fontSize: 11, color: '#eee', flex: 1 }}>
              🎯 Select target for <strong style={{ color: '#c53131' }}>
                {targetingData.spell?.name || targetingData.weapon?.name || targetingData.action?.name}
              </strong>
            </span>
            <button onClick={() => useMapStore.getState().cancelTargetingMode()} style={{
              padding: '2px 8px', fontSize: 10, background: '#333', border: '1px solid #444',
              borderRadius: 3, color: '#aaa', cursor: 'pointer', fontFamily: 'inherit',
            }}>Cancel</button>
          </div>
        )}
        {/* (conditions moved to header) */}

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
                    {props.length > 0 && `. ${props.join(', ')}`}
                  </div>
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

                    {/* Thrown attack (for weapons with Thrown property) */}
                    {isThrown && canAct && (
                      <ActionBtn label={`Throw +${rangedAtkMod} (20ft)`} color={C.gold} onClick={() => {
                        useMapStore.getState().startTargetingMode({
                          weapon: { ...w, name: `${w.name} (Thrown)`, attack_bonus: rangedAtkMod, damage_dice: `${dmgDice}+${rangedDmgMod}`, properties: ['Thrown'] },
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
                // DM "ignore slots" override makes everything castable.
                const dmIgnoreSlots = useSessionStore.getState().dmIgnoreSpellSlots;
                const isSpent = !dmIgnoreSlots && (slot ? slotsLeft <= 0 : false);
                const tooltip = dmIgnoreSlots
                  ? `${spell.name} — DM override active (slots ignored)\n\n${spell.description || ''}`
                  : isSpent
                    ? `${spell.name} — Out of level ${spell.level} slots (0/${slotsMax}). Long Rest to recharge.\n\n${spell.description || ''}`
                    : `${spell.name} — Level ${spell.level} (${slotsLeft}/${slotsMax} slots left, Long Rest to recharge)\n\n${spell.description || ''}`;
                return (
                  <button key={i} disabled={isSpent || !canAct} onClick={() => {
                    if (!canAct || isSpent) return;
                    castSpellFromButton(spell, selectedTokenId!, token.name);
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

        {/* Quick action buttons — different for players vs NPCs */}
        {character && !isNPC && (
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-character-sheet', { detail: { characterId: character.id, tab: 'actions' } }))}
              style={quickBtnStyle(C.red)}
            >📋 View Stats</button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-character-sheet', { detail: { characterId: character.id, tab: 'inventory' } }))}
              style={quickBtnStyle(C.gold)}
            >🎒 Inventory</button>
          </div>
        )}

        {/* NPC buttons — wiki stats + loot editor */}
        {isNPC && token.characterId && (
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            {compendiumData && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('open-compendium-detail', {
                  detail: { slug: compendiumData.slug || token.name.toLowerCase().replace(/\s+/g, '-'), category: 'monsters', name: token.name },
                }))}
                style={quickBtnStyle(C.red)}
              >📋 Full Stats</button>
            )}
            {isDM && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('open-loot-editor', {
                  detail: { characterId: token.characterId, tokenName: token.name },
                }))}
                style={quickBtnStyle(C.gold)}
              >🎒 Inventory</button>
            )}
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

  // AoE shape & size
  let aoeRadius = spell.aoeSize || 0;
  let aoeShape: 'sphere' | 'cube' | 'cone' | 'line' = 'sphere';
  let hasAoe = false;
  if (spell.aoeType === 'cube') { aoeShape = 'cube'; hasAoe = true; }
  else if (spell.aoeType === 'cone') { aoeShape = 'cone'; hasAoe = true; }
  else if (spell.aoeType === 'line') { aoeShape = 'line'; hasAoe = true; }
  else if (spell.aoeType === 'sphere' || spell.aoeType === 'cylinder') { aoeShape = 'sphere'; hasAoe = true; }
  if (!aoeRadius) {
    const radiusMatch = cleanDesc.match(/(\d+)[- ]foot[- ](radius|cube|cone|line|emanation|sphere)/i);
    if (radiusMatch) {
      aoeRadius = parseInt(radiusMatch[1]);
      const shape = radiusMatch[2].toLowerCase();
      if (shape === 'cube') aoeShape = 'cube';
      else if (shape === 'cone') aoeShape = 'cone';
      else if (shape === 'line') aoeShape = 'line';
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
  const casterSpellDC = (casterChar as any)?.spellSaveDC ?? 13;
  const casterX = (casterToken as any).x;
  const casterY = (casterToken as any).y;
  const gridSize = mapState.currentMap?.gridSize || 70;

  const meta = await parseSpellMeta(spell, casterChar?.level ?? 1);

  // --- Spell slot consumption (with upcast fallback) ---
  // D&D 5e: a spell of level N can be cast using ANY slot of level N or
  // higher. The caster picks. We auto-pick the lowest available slot ≥ N
  // to avoid wasting high-level slots. If NO slot of level N or higher
  // exists at all, the cast fails — UNLESS the DM has enabled the
  // "ignore spell slots" override, in which case we skip both the
  // consumption and the availability check.
  if (spell.level > 0 && casterChar) {
    const dmIgnoreSlots = useSessionStore.getState().dmIgnoreSpellSlots;
    if (dmIgnoreSlots) {
      (spell as any).__dmOverride = true;
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
  const damageDice = meta.damageDice;
  const resolvedSavingThrow = meta.savingThrow;
  const halfOnSave = meta.halfOnSave;
  const pushDistance = meta.pushDistance;
  const aoeShape = meta.aoeShape;
  const aoeRadius = meta.aoeRadius;

  // Build the cast announcement header for the consolidated message.
  const shapeLabel = aoeShape === 'cube' ? 'Cube' : aoeShape === 'cone' ? 'Cone' : aoeShape === 'line' ? 'Line' : 'Radius';
  const headerLines: string[] = [
    `✦ ${casterName} casts ${spell.name}`,
    `   ${aoeRadius}-ft ${shapeLabel} • ${affectedTokens.length} creature${affectedTokens.length !== 1 ? 's' : ''} in area`,
  ];
  const castAtLevel = (spell as any).__castAtLevel ?? spell.level;
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
  // Clean up the temporary markers so a re-cast doesn't see stale data
  delete (spell as any).__castAtLevel;
  delete (spell as any).__dmOverride;

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

    // Save + damage
    let aSaved = false;
    if (resolvedSavingThrow) {
      const aScores = aChar.abilityScores
        ? (typeof aChar.abilityScores === 'string' ? JSON.parse(aChar.abilityScores) : aChar.abilityScores)
        : {};
      const aSaveMod = abilityModifier((aScores as any)[resolvedSavingThrow] || 10);
      const aSaveRoll = Math.floor(Math.random() * 20) + 1;
      const aSaveTotal = aSaveRoll + aSaveMod;
      aSaved = aSaveTotal >= casterSpellDC;
      const saveLabel = resolvedSavingThrow.toUpperCase();
      const saveIcon = aSaved ? '✓' : '✗';
      lineParts.push(`${saveIcon} ${saveLabel} ${aSaveTotal} vs DC ${casterSpellDC} → ${aSaved ? 'SAVED' : 'FAILED'}`);
    }

    // Damage
    let finalDmg = 0;
    if (damageDice) {
      const total = rollDamageDice(damageDice);
      finalDmg = aSaved && halfOnSave ? Math.floor(total / 2) : aSaved ? 0 : total;
      if (finalDmg > 0) {
        // Read fresh HP from store right before applying
        const freshChar = useCharacterStore.getState().allCharacters[aCharId];
        const freshHp = freshChar ? (typeof freshChar.hitPoints === 'number' ? freshChar.hitPoints : parseInt(String(freshChar.hitPoints)) || 0) : aHp;
        const newHp = Math.max(0, freshHp - finalDmg);
        const dmgType = (spell.damageType || '').toLowerCase();
        const dmgWord = dmgType ? `${dmgType} ` : '';
        lineParts.push(`${finalDmg} ${dmgWord}dmg${aSaved ? ' (half)' : ''} (HP ${freshHp}→${newHp})`);
        if (newHp === 0) lineParts.push('💀 DOWN');
        // Schedule the actual HP update so the UI animates as the message lands
        setTimeout(() => {
          emitCharacterUpdate(aCharId, { hitPoints: newHp });
          useCharacterStore.getState().applyRemoteUpdate(aCharId, { hitPoints: newHp });
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

    // Auto-apply conditions on failed save
    if (resolvedSavingThrow && !aSaved) {
      const conditions = SPELL_CONDITIONS[spell.name];
      if (conditions && conditions.length > 0) {
        lineParts.push(`now ${conditions.join(', ')}`);
        setTimeout(() => {
          const targetTokenData = useMapStore.getState().tokens[aToken.id];
          if (targetTokenData) {
            const existingConditions = targetTokenData.conditions || [];
            const newConditions = [...new Set([...existingConditions, ...conditions])] as any;
            emitTokenUpdate(aToken.id, { conditions: newConditions });
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

const CONDITION_COLORS: Record<string, string> = {
  blinded: '#4a4a4a', charmed: '#ff69b4', deafened: '#95a5a6',
  frightened: '#9b59b6', grappled: '#e67e22', incapacitated: '#7f8c8d',
  invisible: '#3498db', paralyzed: '#f1c40f', petrified: '#bdc3c7',
  poisoned: '#27ae60', prone: '#e74c3c', restrained: '#c0392b',
  stunned: '#f39c12', unconscious: '#2c3e50', exhaustion: '#8e44ad',
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
      {/* Active conditions */}
      {conditions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 3 }}>
          {conditions.map((cond: string) => (
            <span key={cond} onClick={() => canEdit && onToggle(cond)} style={{
              padding: '1px 6px', fontSize: 8, fontWeight: 600,
              background: `${CONDITION_COLORS[cond] || '#888'}22`,
              border: `1px solid ${CONDITION_COLORS[cond] || '#888'}`,
              borderRadius: 8, color: CONDITION_COLORS[cond] || '#888',
              textTransform: 'capitalize', cursor: canEdit ? 'pointer' : 'default',
            }}>
              {cond} {canEdit && '×'}
            </span>
          ))}
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
              {ALL_CONDITIONS.filter(c => !conditions.includes(c)).map(cond => (
                <button key={cond} onClick={() => onToggle(cond)} style={{
                  padding: '1px 5px', fontSize: 7, borderRadius: 3,
                  background: C.bgHover, border: `1px solid ${C.borderDim}`,
                  color: C.textMuted, cursor: 'pointer', fontFamily: 'inherit',
                  textTransform: 'capitalize',
                }}>{cond}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
