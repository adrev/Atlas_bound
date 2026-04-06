export type AnimationType = 'projectile' | 'aoe' | 'buff' | 'melee';

export interface SpellAnimationConfig {
  type: AnimationType;
  color: string;
  secondaryColor?: string;
  duration: number;
  particleCount?: number;
}

export const SPELL_ANIMATIONS: Record<string, SpellAnimationConfig> = {
  // Cantrips
  'Fire Bolt': { type: 'projectile', color: '#ff4500', secondaryColor: '#ffa500', duration: 600, particleCount: 20 },
  'Eldritch Blast': { type: 'projectile', color: '#9b30ff', secondaryColor: '#da70d6', duration: 500, particleCount: 15 },
  'Ray of Frost': { type: 'projectile', color: '#87ceeb', secondaryColor: '#ffffff', duration: 600, particleCount: 25 },
  'Sacred Flame': { type: 'aoe', color: '#ffd700', secondaryColor: '#ffffff', duration: 800, particleCount: 30 },
  'Shocking Grasp': { type: 'melee', color: '#00bfff', secondaryColor: '#ffffff', duration: 400, particleCount: 15 },
  'Chill Touch': { type: 'projectile', color: '#2f4f4f', secondaryColor: '#00ced1', duration: 600, particleCount: 20 },
  'Acid Splash': { type: 'projectile', color: '#32cd32', secondaryColor: '#adff2f', duration: 500, particleCount: 20 },
  'Poison Spray': { type: 'aoe', color: '#228b22', secondaryColor: '#7cfc00', duration: 600, particleCount: 25 },
  'Toll the Dead': { type: 'aoe', color: '#4a0e4e', secondaryColor: '#8b008b', duration: 700, particleCount: 20 },

  // Level 1
  'Magic Missile': { type: 'projectile', color: '#da70d6', secondaryColor: '#ffffff', duration: 400, particleCount: 10 },
  'Burning Hands': { type: 'aoe', color: '#ff4500', secondaryColor: '#ffa500', duration: 700, particleCount: 40 },
  'Thunderwave': { type: 'aoe', color: '#4169e1', secondaryColor: '#87ceeb', duration: 600, particleCount: 35 },
  'Cure Wounds': { type: 'buff', color: '#ffd700', secondaryColor: '#ffffff', duration: 800, particleCount: 20 },
  'Healing Word': { type: 'buff', color: '#ffd700', secondaryColor: '#90ee90', duration: 600, particleCount: 15 },
  'Shield': { type: 'buff', color: '#4169e1', secondaryColor: '#87ceeb', duration: 500, particleCount: 20 },
  'Guiding Bolt': { type: 'projectile', color: '#ffd700', secondaryColor: '#ffffff', duration: 500, particleCount: 25 },
  'Chromatic Orb': { type: 'projectile', color: '#ff69b4', secondaryColor: '#00bfff', duration: 600, particleCount: 25 },
  'Witch Bolt': { type: 'projectile', color: '#00bfff', secondaryColor: '#9b30ff', duration: 700, particleCount: 30 },

  // Level 2
  'Scorching Ray': { type: 'projectile', color: '#ff4500', secondaryColor: '#ff6347', duration: 500, particleCount: 15 },
  'Shatter': { type: 'aoe', color: '#b0c4de', secondaryColor: '#ffffff', duration: 600, particleCount: 40 },
  'Misty Step': { type: 'buff', color: '#b0c4de', secondaryColor: '#e6e6fa', duration: 400, particleCount: 30 },
  'Hold Person': { type: 'buff', color: '#daa520', secondaryColor: '#ffffff', duration: 700, particleCount: 20 },

  // Level 3
  'Fireball': { type: 'aoe', color: '#ff4500', secondaryColor: '#ffa500', duration: 1000, particleCount: 60 },
  'Lightning Bolt': { type: 'projectile', color: '#ffffff', secondaryColor: '#00bfff', duration: 400, particleCount: 40 },
  'Counterspell': { type: 'buff', color: '#9b30ff', secondaryColor: '#4b0082', duration: 500, particleCount: 25 },
  'Spirit Guardians': { type: 'aoe', color: '#ffd700', secondaryColor: '#ffffff', duration: 1000, particleCount: 50 },
  'Revivify': { type: 'buff', color: '#ffd700', secondaryColor: '#ffffff', duration: 1200, particleCount: 40 },

  // Level 4+
  'Ice Storm': { type: 'aoe', color: '#87ceeb', secondaryColor: '#ffffff', duration: 1000, particleCount: 50 },
  'Dimension Door': { type: 'buff', color: '#9b30ff', secondaryColor: '#000000', duration: 600, particleCount: 30 },
  'Banishment': { type: 'buff', color: '#ffd700', secondaryColor: '#ffffff', duration: 800, particleCount: 35 },
  'Cone of Cold': { type: 'aoe', color: '#add8e6', secondaryColor: '#ffffff', duration: 800, particleCount: 50 },
  'Chain Lightning': { type: 'projectile', color: '#ffffff', secondaryColor: '#00bfff', duration: 500, particleCount: 45 },
  'Disintegrate': { type: 'projectile', color: '#32cd32', secondaryColor: '#00ff00', duration: 800, particleCount: 40 },
  'Meteor Swarm': { type: 'aoe', color: '#ff4500', secondaryColor: '#ff0000', duration: 1500, particleCount: 80 },
  'Power Word Kill': { type: 'melee', color: '#000000', secondaryColor: '#8b0000', duration: 500, particleCount: 10 },
};

export function getSpellAnimation(spellName: string): SpellAnimationConfig {
  return SPELL_ANIMATIONS[spellName] ?? {
    type: 'projectile',
    color: '#9b30ff',
    duration: 500,
    particleCount: 15,
  };
}
