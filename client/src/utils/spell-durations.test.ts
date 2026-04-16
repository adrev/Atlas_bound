import { describe, it, expect } from 'vitest';
import { getSpellDurationMeta, SPELL_DURATIONS } from './spell-durations';

describe('getSpellDurationMeta', () => {
  it('returns the canonical meta for a known spell', () => {
    const bless = getSpellDurationMeta('Bless');
    expect(bless.durationRounds).toBe(10);
    expect(bless.saveAbility).toBeUndefined();
  });

  it('returns the 1-hour (600-round) duration for Hex', () => {
    const hex = getSpellDurationMeta('Hex');
    expect(hex.durationRounds).toBe(600);
  });

  it('falls back to the default 10-round meta for unknown spells', () => {
    const unknown = getSpellDurationMeta('Made-Up Spell Name');
    expect(unknown.durationRounds).toBe(10);
    expect(unknown.saveAbility).toBeUndefined();
  });

  it('flags saveOnDamage for Hideous Laughter', () => {
    const meta = getSpellDurationMeta("Tasha's Hideous Laughter");
    expect(meta.saveOnDamage).toBe(true);
    expect(meta.saveAbility).toBe('wis');
  });
});

describe('SPELL_DURATIONS data sanity', () => {
  it('every durationRounds is a positive integer', () => {
    for (const [name, meta] of Object.entries(SPELL_DURATIONS)) {
      expect(Number.isInteger(meta.durationRounds), `${name}`).toBe(true);
      expect(meta.durationRounds, `${name}`).toBeGreaterThan(0);
    }
  });

  it('saveAbility when present is one of the six abilities', () => {
    const allowed = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha']);
    for (const [name, meta] of Object.entries(SPELL_DURATIONS)) {
      if (meta.saveAbility !== undefined) {
        expect(allowed.has(meta.saveAbility), `${name} → ${meta.saveAbility}`).toBe(true);
      }
    }
  });
});
