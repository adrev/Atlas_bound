import type { Character } from '@dnd-vtt/shared';
import { emitCharacterUpdate, emitSystemMessage } from '../socket/emitters';
import { useCharacterStore } from '../stores/useCharacterStore';
import { showToast } from '../components/ui';
import { EMOJI } from '../styles/emoji';

/**
 * Shared rest logic extracted from CharacterSheetFull so the
 * QuickActions bottom bar can trigger a Long Rest without requiring
 * the full sheet modal to be open.
 *
 * Mirrors the inline handler in CharacterSheetFull.tsx's HeaderBar.
 * Any changes there should be kept in sync here (or vice versa).
 */

function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T; } catch { return fallback; }
  }
  return (val ?? fallback) as T;
}

/**
 * Perform a full Long Rest on the given character:
 *   1. Restore HP to max
 *   2. Clear temp HP
 *   3. Restore all spell slots
 *   4. Restore all feature uses
 *   5. Recover half (rounded up) of spent Hit Dice
 *   6. Clear death saves
 *   7. Drop concentration
 *
 * Emits the character update to the server, applies locally, shows a
 * toast, and posts a system chat message announcing the rest.
 */
export function performLongRest(character: Character): void {
  const changes: string[] = [];
  const updates: Record<string, unknown> = {};

  // 1) Restore HP to max
  if (character.hitPoints < character.maxHitPoints) {
    updates.hitPoints = character.maxHitPoints;
    changes.push(`HP restored (${character.hitPoints} → ${character.maxHitPoints})`);
  }
  // 2) Clear temp HP
  if ((character.tempHitPoints ?? 0) > 0) {
    updates.tempHitPoints = 0;
    changes.push('Temporary HP cleared');
  }
  // 3) Restore all spell slots
  const slots = parse<Record<string, { max: number; used: number }>>(
    (character as unknown as { spellSlots: unknown }).spellSlots,
    {},
  );
  const updatedSlots: Record<string, { max: number; used: number }> = {};
  const restoredLevels: string[] = [];
  for (const [lvl, slot] of Object.entries(slots)) {
    if (slot.used > 0) restoredLevels.push(lvl);
    updatedSlots[lvl] = { max: slot.max, used: 0 };
  }
  if (restoredLevels.length > 0) {
    updates.spellSlots = updatedSlots;
    changes.push(
      `Spell slots restored (level${restoredLevels.length !== 1 ? 's' : ''} ${restoredLevels.join(', ')})`,
    );
  }
  // 4) Restore all feature uses
  const features = parse<
    Array<{ name: string; usesTotal?: number; usesRemaining?: number; resetOn?: string | null }>
  >((character as unknown as { features: unknown }).features, []);
  let restoredFeatures = 0;
  const updatedFeatures = features.map((f) => {
    if (f.usesTotal && (f.usesRemaining ?? f.usesTotal) < f.usesTotal) {
      restoredFeatures++;
      return { ...f, usesRemaining: f.usesTotal };
    }
    return f;
  });
  if (restoredFeatures > 0) {
    updates.features = updatedFeatures;
    changes.push(`${restoredFeatures} feature${restoredFeatures !== 1 ? 's' : ''} restored`);
  }
  // 5) Restore half (rounded up) of spent Hit Dice
  const hitDicePools = parse<Array<{ dieSize: number; total: number; used: number }>>(
    (character as unknown as { hitDice: unknown }).hitDice,
    [],
  );
  if (hitDicePools.length > 0) {
    let restoredHd = 0;
    const updatedPools = hitDicePools.map((p) => {
      if (p.used <= 0) return p;
      const recovery = Math.max(1, Math.ceil(p.total / 2));
      const newUsed = Math.max(0, p.used - recovery);
      restoredHd += p.used - newUsed;
      return { ...p, used: newUsed };
    });
    if (restoredHd > 0) {
      updates.hitDice = updatedPools;
      changes.push(`Recovered ${restoredHd} Hit Dice`);
    }
  }
  // 6) Death saves cleared
  updates.deathSaves = { successes: 0, failures: 0 };
  // 7) Drop concentration
  const concentratingOn = (character as unknown as { concentratingOn?: string | null })
    .concentratingOn;
  if (concentratingOn) {
    updates.concentratingOn = null;
    changes.push(`Concentration on ${concentratingOn} dropped`);
  }

  if (changes.length === 0) changes.push('Already fully rested');

  emitCharacterUpdate(character.id, updates);
  useCharacterStore.getState().applyRemoteUpdate(character.id, updates);
  showToast({
    emoji: EMOJI.rest.long,
    message: `Long Rest — ${changes.join(' • ')}`,
    variant: 'success',
    duration: 5000,
  });
  emitSystemMessage(`${EMOJI.rest.long} ${character.name} takes a Long Rest\n   ${changes.join(' • ')}`);
}

/**
 * Perform a "quick" Short Rest. Restores:
 *   1. All short-rest feature uses (resetOn === 'short')
 *   2. All Warlock spell slots (class match, not slot level)
 *   3. Concentration is NOT dropped (a short rest doesn't require it)
 *
 * Hit Dice spending is intentionally NOT done here — that's a manual,
 * dice-by-dice decision the player makes in the Short Rest dialog
 * inside the character sheet. For the quick-action path (Bottom Bar)
 * and the "Finish Short Rest" button inside the dialog, this function
 * produces the identical chat message so there's no inconsistency.
 */
export function performShortRest(character: Character): void {
  const changes: string[] = [];
  const updates: Record<string, unknown> = {};

  // 1) Restore short-rest feature uses.
  const features = parse<
    Array<{ name: string; usesTotal?: number; usesRemaining?: number; resetOn?: string | null }>
  >((character as unknown as { features: unknown }).features, []);
  let restoredFeatures = 0;
  const updatedFeatures = features.map((f) => {
    if (f.resetOn === 'short' && f.usesTotal && (f.usesRemaining ?? f.usesTotal) < f.usesTotal) {
      restoredFeatures++;
      return { ...f, usesRemaining: f.usesTotal };
    }
    return f;
  });
  if (restoredFeatures > 0) {
    updates.features = updatedFeatures;
    changes.push(`${restoredFeatures} short-rest feature${restoredFeatures !== 1 ? 's' : ''} restored`);
  }

  // 2) Warlocks recover their spell slots on a short rest (unique 5e rule).
  const isWarlock = (character.class || '').toLowerCase().includes('warlock');
  if (isWarlock) {
    const slots = parse<Record<string, { max: number; used: number }>>(
      (character as unknown as { spellSlots: unknown }).spellSlots,
      {},
    );
    const updatedSlots: Record<string, { max: number; used: number }> = {};
    let restoredSlots = 0;
    for (const [lvl, slot] of Object.entries(slots)) {
      if (slot.used > 0) restoredSlots++;
      updatedSlots[lvl] = { max: slot.max, used: 0 };
    }
    if (restoredSlots > 0) {
      updates.spellSlots = updatedSlots;
      changes.push('Warlock spell slots restored');
    }
  }

  if (Object.keys(updates).length > 0) {
    emitCharacterUpdate(character.id, updates);
    useCharacterStore.getState().applyRemoteUpdate(character.id, updates);
  }

  const summary = changes.length > 0
    ? `${EMOJI.rest.short} ${character.name} finishes a Short Rest\n   ${changes.join(' • ')}`
    : `${EMOJI.rest.short} ${character.name} finishes a Short Rest`;
  showToast({
    emoji: EMOJI.rest.short,
    message: changes.length > 0
      ? `Short Rest — ${changes.join(' • ')}`
      : 'Short Rest — already refreshed',
    variant: 'success',
    duration: 4000,
  });
  emitSystemMessage(summary);
}
