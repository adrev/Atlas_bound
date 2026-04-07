import type { Character, AbilityName } from '@dnd-vtt/shared';
import { abilityModifier, proficiencyBonusForLevel } from '@dnd-vtt/shared';

/**
 * Class name → primary spellcasting ability. Used to compute the
 * spell save DC and spell attack bonus on the fly when the stored
 * fields look like stale defaults (0 or 10) — typically because the
 * character was imported before those columns were added to the DB
 * and the local store hasn't picked up the backfilled values yet.
 *
 * Half-casters (Paladin, Ranger) and unusual cases use the same map.
 */
const CLASS_PRIMARY_ABILITY: Record<string, AbilityName> = {
  bard: 'cha',
  cleric: 'wis',
  druid: 'wis',
  paladin: 'cha',
  ranger: 'wis',
  sorcerer: 'cha',
  warlock: 'cha',
  wizard: 'int',
  artificer: 'int',
};

/**
 * Compute the canonical spell save DC for a character: 8 + prof bonus +
 * spellcasting ability modifier. Picks the spellcasting ability from
 * the character.spellcastingAbility field if set, otherwise infers
 * from the class name.
 */
export function computeSpellSaveDC(character: Character | null | undefined): number {
  if (!character) return 10;

  const explicit = (character as any).spellcastingAbility as string | undefined;
  let ability: AbilityName | null = null;

  if (explicit && ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(explicit)) {
    ability = explicit as AbilityName;
  } else {
    // Infer from class string
    const cls = (character.class || '').toLowerCase();
    for (const [key, val] of Object.entries(CLASS_PRIMARY_ABILITY)) {
      if (cls.includes(key)) { ability = val; break; }
    }
  }
  if (!ability) return 10;

  let scores: Record<string, number> = {};
  if (typeof character.abilityScores === 'string') {
    try { scores = JSON.parse(character.abilityScores); } catch { /* ignore */ }
  } else {
    scores = (character.abilityScores as unknown as Record<string, number>) || {};
  }

  const score = scores[ability] ?? 10;
  const mod = abilityModifier(score);
  const profBonus = character.proficiencyBonus ?? proficiencyBonusForLevel(character.level || 1);

  return 8 + profBonus + mod;
}

/**
 * Same idea for spell attack bonus: prof + spellcasting mod.
 */
export function computeSpellAttackBonus(character: Character | null | undefined): number {
  if (!character) return 0;

  const explicit = (character as any).spellcastingAbility as string | undefined;
  let ability: AbilityName | null = null;

  if (explicit && ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(explicit)) {
    ability = explicit as AbilityName;
  } else {
    const cls = (character.class || '').toLowerCase();
    for (const [key, val] of Object.entries(CLASS_PRIMARY_ABILITY)) {
      if (cls.includes(key)) { ability = val; break; }
    }
  }
  if (!ability) return 0;

  let scores: Record<string, number> = {};
  if (typeof character.abilityScores === 'string') {
    try { scores = JSON.parse(character.abilityScores); } catch { /* ignore */ }
  } else {
    scores = (character.abilityScores as unknown as Record<string, number>) || {};
  }

  const score = scores[ability] ?? 10;
  const mod = abilityModifier(score);
  const profBonus = character.proficiencyBonus ?? proficiencyBonusForLevel(character.level || 1);

  return profBonus + mod;
}

/**
 * Returns the character's effective spell save DC. Trusts the stored
 * value when it looks plausible; otherwise recomputes from class &
 * ability score. Defends against the "stored DC is the placeholder
 * default" failure mode where the database column was populated late
 * and the in-memory copy is stale.
 */
export function effectiveSpellSaveDC(character: Character | null | undefined): number {
  if (!character) return 10;
  const stored = (character as any).spellSaveDC as number | undefined;
  // If stored is null/undefined or looks like a default placeholder, recompute
  if (stored == null || stored <= 10) {
    const computed = computeSpellSaveDC(character);
    return Math.max(stored ?? 0, computed);
  }
  return stored;
}

/**
 * Same defensive treatment for spell attack bonus.
 */
export function effectiveSpellAttackBonus(character: Character | null | undefined): number {
  if (!character) return 0;
  const stored = (character as any).spellAttackBonus as number | undefined;
  if (stored == null || stored === 0) {
    return computeSpellAttackBonus(character);
  }
  return stored;
}
