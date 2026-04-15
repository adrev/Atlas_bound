import type { AbilityScores, Spell } from '@dnd-vtt/shared';
import { abilityModifier } from '@dnd-vtt/shared';

/**
 * Per-5e rules: certain classes PREPARE a subset of their spell list
 * after each long rest (cleric, druid, wizard, paladin, artificer),
 * while others know a fixed list and cast freely from it (sorcerer,
 * bard, warlock, ranger).
 *
 * We only show the "Prepared" toggle in the UI for prepare-classes.
 * Everyone else's spells are always available and the flag is ignored.
 *
 * Multi-class characters ("Cleric 3 / Rogue 2") match on the first
 * recognised class name in the string.
 */
const PREPARE_CLASSES = ['cleric', 'druid', 'wizard', 'paladin', 'artificer'];

export function isPrepareClass(className: string | undefined | null): boolean {
  if (!className) return false;
  const lower = className.toLowerCase();
  return PREPARE_CLASSES.some((c) => lower.includes(c));
}

/**
 * Maximum number of spells this character can prepare at once.
 *
 * Standard 5e formula: (spellcasting ability modifier + effective
 * prepare-level). The effective prepare-level is the character level
 * for cleric/druid/wizard/artificer and HALF the level (rounded down,
 * min 1) for paladin. Minimum of 1 across the board so low-level
 * characters always have at least one prepared slot.
 *
 * This is an approximation — a full multiclass calculator would need
 * per-class levels, not just the top-line class string. For our VTT
 * use case the approximation is fine; the number is a guideline, not
 * a hard cap (we show it in the header and flag over/under but don't
 * block the user from preparing more).
 */
export function maxPreparedSpells(
  className: string | undefined | null,
  level: number,
  spellcastingAbility: string,
  abilityScores: AbilityScores,
): number {
  if (!isPrepareClass(className)) return Infinity;
  const mod = abilityModifier(abilityScores[(spellcastingAbility || 'int') as keyof AbilityScores] ?? 10);
  const lowered = (className ?? '').toLowerCase();
  const isPaladin = lowered.includes('paladin');
  const effectiveLevel = isPaladin ? Math.max(1, Math.floor(level / 2)) : level;
  return Math.max(1, mod + effectiveLevel);
}

/**
 * A spell counts against the "prepared" budget when:
 *   - the character is a prepare-class, AND
 *   - the spell is at level >= 1 (cantrips are always prepared), AND
 *   - the `prepared` flag is true
 *
 * Rituals-only spells also count — 5e treats them as prepared for the
 * day even if they're not marked ritually, so we don't special-case
 * isRitual here.
 */
export function countPreparedSpells(spells: Spell[]): number {
  return spells.filter((s) => s.level > 0 && s.prepared).length;
}

/**
 * Whether a given spell is currently usable. For prepare-classes,
 * leveled spells need the `prepared` flag set. Cantrips and ritual
 * casts are always available. For non-prepare classes the flag is
 * ignored and every known spell is usable.
 */
export function isSpellReady(spell: Spell, className: string | undefined | null): boolean {
  if (spell.level === 0) return true; // cantrips
  if (!isPrepareClass(className)) return true;
  return !!spell.prepared;
}
