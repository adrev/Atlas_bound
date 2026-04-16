import { abilityModifier, type AbilityName, type AbilityScores, type Character } from '@dnd-vtt/shared';

/**
 * Compute a character's saving-throw modifier for a given ability.
 *
 *   mod = floor((score - 10) / 2) + (isProficient ? profBonus : 0)
 *
 * `character.savingThrows` is the list of proficient saves (a mix of
 * "str" / "dex" / … strings). Characters without that metadata (e.g.
 * raw NPC tokens that never got a character row) fall back to an
 * untrained save — the UI treats those tokens as rolling straight d20
 * with no bonus.
 */
export function computeSaveModifier(
  ability: AbilityName,
  abilityScores: AbilityScores | undefined | null,
  savingThrowProficiencies: AbilityName[] | undefined | null,
  proficiencyBonus: number,
): number {
  if (!abilityScores) return 0;
  const score = abilityScores[ability] ?? 10;
  const mod = abilityModifier(score);
  const isProficient = Array.isArray(savingThrowProficiencies)
    && savingThrowProficiencies.includes(ability);
  return mod + (isProficient ? (proficiencyBonus || 0) : 0);
}

/**
 * Pull the needed data out of a (possibly partially-hydrated) character
 * record and hand back the save modifier for `ability`. Characters
 * might arrive with these fields as JSON strings if they haven't been
 * through the usual parse, so we handle both shapes.
 */
export function saveModifierForCharacter(
  character: Partial<Character> | null | undefined,
  ability: AbilityName,
): number {
  if (!character) return 0;
  const scores = parseMaybeJSON<AbilityScores>((character as unknown as { abilityScores?: unknown }).abilityScores);
  const saves = parseMaybeJSON<AbilityName[]>((character as unknown as { savingThrows?: unknown }).savingThrows);
  const profBonus = Number((character as unknown as { proficiencyBonus?: number }).proficiencyBonus ?? 0);
  return computeSaveModifier(ability, scores, saves, profBonus);
}

function parseMaybeJSON<T>(raw: unknown): T | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  }
  return raw as T;
}
