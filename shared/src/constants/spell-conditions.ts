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
