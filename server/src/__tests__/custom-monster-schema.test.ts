import { describe, it, expect } from 'vitest';
import { createCustomMonsterSchema } from '../utils/validation.js';

// CreateMonsterForm sends structured objects/arrays for the fields
// the server used to expect as strings. These tests lock in that the
// schema now accepts BOTH the new object shape (primary path) and the
// old string shape (legacy / import) so neither pipeline regresses.

const minimal = {
  sessionId: 's1',
  name: 'Goblin King',
};

describe('createCustomMonsterSchema — object payloads from CreateMonsterForm', () => {
  it('accepts the exact shape the form sends today', () => {
    const r = createCustomMonsterSchema.safeParse({
      ...minimal,
      size: 'Medium',
      type: 'Humanoid',
      alignment: 'lawful evil',
      armorClass: 17,
      hitPoints: 82,
      hitDice: '11d8 + 33',
      speed: { walk: 30, climb: 30 },
      abilityScores: { str: 18, dex: 14, con: 16, int: 10, wis: 12, cha: 14 },
      challengeRating: '5',
      crNumeric: 5,
      actions: [
        { name: 'Multiattack', desc: 'Three attacks.' },
        { name: 'Longsword', desc: '+7 to hit, 1d8+4 slashing', attackBonus: 7, damageDice: '1d8+4', damageType: 'slashing' },
      ],
      specialAbilities: [{ name: 'Keen Hearing', desc: 'Advantage on Perception.' }],
      legendaryActions: [],
      description: 'A cruel goblin noble.',
    });
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it('still accepts the legacy string shape for speed / abilityScores / actions', () => {
    const r = createCustomMonsterSchema.safeParse({
      ...minimal,
      speed: '30 ft., fly 60 ft.',
      abilityScores: 'STR 18 DEX 14 CON 16',
      actions: 'Bite: +5 to hit',
      specialAbilities: 'Keen Hearing.',
      legendaryActions: 'None.',
    });
    expect(r.success).toBe(true);
  });
});

describe('createCustomMonsterSchema — rejects bad shapes', () => {
  it('rejects when sessionId is missing', () => {
    const r = createCustomMonsterSchema.safeParse({ name: 'anon' });
    expect(r.success).toBe(false);
  });

  it('rejects name longer than 200 chars', () => {
    const r = createCustomMonsterSchema.safeParse({ ...minimal, name: 'x'.repeat(201) });
    expect(r.success).toBe(false);
  });

  it('rejects a caster-size actions array (>40 entries)', () => {
    const huge = Array.from({ length: 41 }, (_, i) => ({ name: `A${i}`, desc: 'x' }));
    const r = createCustomMonsterSchema.safeParse({ ...minimal, actions: huge });
    expect(r.success).toBe(false);
  });

  it('rejects an ability score above 30 (over the epic cap)', () => {
    const r = createCustomMonsterSchema.safeParse({
      ...minimal,
      abilityScores: { str: 45 },
    });
    expect(r.success).toBe(false);
  });

  it('rejects action entries with no name', () => {
    const r = createCustomMonsterSchema.safeParse({
      ...minimal,
      actions: [{ name: '', desc: 'no name' }],
    });
    expect(r.success).toBe(false);
  });
});
