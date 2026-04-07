/**
 * Maps NO-SAVE buff spells to the badges they apply to willing targets.
 * These spells don't have a saving throw — the target chooses to accept
 * the spell. Used for visual feedback only; the mechanical bonuses
 * (e.g. Bless's +1d4 to attack rolls) are NOT enforced yet.
 *
 * The badge string is what shows on the token. Common buffs use custom
 * names that fall outside the 15 standard 5e conditions.
 */
export const SPELL_BUFFS: Record<string, string[]> = {
  // Beneficial buffs (target's choice)
  'Bless': ['blessed'],
  'Heroism': ['heroic'],
  'Aid': ['aided'],
  'Shield of Faith': ['shielded'],
  'Mage Armor': ['mage-armored'],
  'Protection from Evil and Good': ['protected'],
  'Protection from Energy': ['protected'],
  'Sanctuary': ['sanctuary'],
  'Haste': ['hasted'],
  'Enlarge/Reduce': ['enlarged'],
  'Enlarge': ['enlarged'],
  'Reduce': ['reduced'],
  'Greater Invisibility': ['invisible'],
  'Invisibility': ['invisible'],
  'Stoneskin': ['stoneskin'],
  'Death Ward': ['death-warded'],
  'Fly': ['flying'],
  'Spider Climb': ['spider-climbing'],
  'Jump': ['jumping'],
  'Longstrider': ['hasted'],
  'Pass without Trace': ['stealthy'],
  'Barkskin': ['barkskin'],
  'False Life': ['temp-hp'],
  'True Strike': ['true-strike'],
  'Hunter\'s Mark': ['marked'],
  'Hex': ['hexed'],
  'Faerie Fire': ['outlined'],

  // Debuffs that don't follow the standard "save or be conditioned" model
  'Bane': ['baned'],
  'Slow': ['slowed'],
};

/**
 * Maps spell names to conditions they apply on a failed save.
 * Used for auto-applying conditions when spell targeting resolves.
 */
export const SPELL_CONDITIONS: Record<string, string[]> = {
  // Enchantment
  'Hold Person': ['paralyzed'],
  'Hold Monster': ['paralyzed'],
  'Command': ['prone'],
  'Hideous Laughter': ['prone', 'incapacitated'],
  "Tasha's Hideous Laughter": ['prone', 'incapacitated'],
  'Sleep': ['unconscious'],
  'Charm Person': ['charmed'],
  'Charm Monster': ['charmed'],
  'Suggestion': ['charmed'],
  'Hypnotic Pattern': ['charmed', 'incapacitated'],
  'Crown of Madness': ['charmed'],
  'Dominate Person': ['charmed'],
  'Dominate Monster': ['charmed'],
  'Power Word Stun': ['stunned'],
  'Eyebite': ['frightened'],

  // Evocation
  'Blindness/Deafness': ['blinded'],
  'Blindness': ['blinded'],

  // Necromancy
  'Ray of Enfeeblement': ['weakened'],
  'Contagion': ['poisoned'],
  'Bestow Curse': ['cursed'],

  // Transmutation
  'Flesh to Stone': ['restrained', 'petrified'],
  'Polymorph': ['incapacitated'],
  'Slow': ['slowed'],

  // Abjuration
  'Banishment': ['incapacitated'],

  // Conjuration
  'Entangle': ['restrained'],
  'Web': ['restrained'],
  'Grease': ['prone'],

  // Other
  'Faerie Fire': ['outlined'],
  'Fear': ['frightened'],
  'Phantasmal Force': ['frightened'],
  'Color Spray': ['blinded'],
  'Stunning Strike': ['stunned'],
  'Otto\'s Irresistible Dance': ['incapacitated'],
  'Irresistible Dance': ['incapacitated'],
};
