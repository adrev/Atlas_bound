import type { AbilityName } from '@dnd-vtt/shared';

/**
 * Per-spell duration + save-retry metadata used when registering
 * conditions/buffs with the server's duration tracker.
 *
 * Each entry encodes:
 *   • durationRounds  — how many combat rounds the effect lasts
 *                       (5e: 1 minute = 10 rounds; 1 hour = 600 rounds;
 *                       "until your next turn" = 1 round)
 *   • saveAbility     — if the spell allows a save at end of each turn,
 *                       which ability is rolled
 *   • saveOnDamage    — Hideous Laughter etc. allow another save with
 *                       advantage when the target takes damage
 *   • endsOnDamage    — Sleep ends entirely when the target takes damage
 *
 * Spells not in this map use a sensible default (10 rounds, no retry).
 */
export interface SpellDurationMeta {
  durationRounds: number;
  saveAbility?: AbilityName;
  saveOnDamage?: boolean;
  endsOnDamage?: boolean;
}

export const SPELL_DURATIONS: Record<string, SpellDurationMeta> = {
  // 1-minute concentration buffs / debuffs (10 rounds)
  'Bless': { durationRounds: 10 },
  'Bane': { durationRounds: 10 },
  'Heroism': { durationRounds: 10 },
  'Faerie Fire': { durationRounds: 10 },
  // 1-hour concentration-anchored debuffs. 5e says 1 minute = 10
  // rounds, so 1 hour = 60 * 10 = 600 rounds, NOT 6000.
  'Hex': { durationRounds: 600 },
  "Hunter's Mark": { durationRounds: 600 },

  // 1-minute control spells with end-of-turn save retry
  'Hold Person': { durationRounds: 10, saveAbility: 'wis' },
  'Hold Monster': { durationRounds: 10, saveAbility: 'wis' },
  'Tasha\'s Hideous Laughter': { durationRounds: 10, saveAbility: 'wis', saveOnDamage: true },
  'Hideous Laughter': { durationRounds: 10, saveAbility: 'wis', saveOnDamage: true },
  'Fear': { durationRounds: 10, saveAbility: 'wis' },
  'Hypnotic Pattern': { durationRounds: 10, saveAbility: 'wis', saveOnDamage: true },
  // 8-hour concentration spells. 8 * 60 * 10 = 4800 rounds.
  'Suggestion': { durationRounds: 4800 },
  'Charm Person': { durationRounds: 600 },        // 1 hour
  'Charm Monster': { durationRounds: 600 },       // 1 hour (concentration)
  'Dominate Person': { durationRounds: 10, saveAbility: 'wis' },
  'Dominate Monster': { durationRounds: 10, saveAbility: 'wis' },
  'Polymorph': { durationRounds: 10, saveAbility: 'wis' },
  'Banishment': { durationRounds: 10, saveAbility: 'cha' },

  // Sleep — ends on damage, no save retry
  'Sleep': { durationRounds: 10, endsOnDamage: true },

  // Stoneskin / barkskin / haste / slow — 1 hour ish
  'Stoneskin': { durationRounds: 10 },           // concentration
  'Barkskin': { durationRounds: 10 },
  'Haste': { durationRounds: 10 },               // concentration
  'Slow': { durationRounds: 10 },                // concentration

  // Mage Armor — 8 hours, basically always-on
  'Mage Armor': { durationRounds: 4800 },

  // Shield of Faith — 10 minutes (concentration)
  'Shield of Faith': { durationRounds: 100 },

  // Sanctuary — 1 minute
  'Sanctuary': { durationRounds: 10 },

  // Faerie Fire is up there
  // Web — 1 hour, save each turn
  'Web': { durationRounds: 600, saveAbility: 'str' },
  'Entangle': { durationRounds: 10, saveAbility: 'str' },

  // Blindness/Deafness — 1 minute
  'Blindness/Deafness': { durationRounds: 10, saveAbility: 'con' },
  'Blindness': { durationRounds: 10, saveAbility: 'con' },

  // Color Spray — until end of caster's next turn (1 round-ish)
  'Color Spray': { durationRounds: 1 },

  // Command — affects the target's NEXT turn only. 1 round max.
  'Command': { durationRounds: 1 },

  // Power Word Stun — until the target succeeds on a save; default
  // 10 rounds is generous but reasonable.
  'Power Word Stun': { durationRounds: 10, saveAbility: 'con' },

  // Eyebite — 1 minute, WIS save each round.
  'Eyebite': { durationRounds: 10, saveAbility: 'wis' },
};

/**
 * Look up duration meta for a spell. Returns a default of 10 rounds with
 * no retry if the spell isn't in the map — most short concentration
 * spells default this way and the DM can manually clear if needed.
 */
export function getSpellDurationMeta(spellName: string): SpellDurationMeta {
  return SPELL_DURATIONS[spellName] ?? { durationRounds: 10 };
}
