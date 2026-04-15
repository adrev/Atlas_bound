import { describe, it, expect } from 'vitest';
import {
  mergeHitDice, mergeSpellSlots, mergeFeatures, buildMergeUpdate,
} from '../services/ddbMerge.js';

describe('mergeHitDice', () => {
  it('zeroes `used` for die sizes that didn\'t exist before', () => {
    const out = mergeHitDice([], [{ dieSize: 8, total: 3, used: 0 }]);
    expect(out).toEqual([{ dieSize: 8, total: 3, used: 0 }]);
  });

  it('preserves `used` per die size across re-import', () => {
    const out = mergeHitDice(
      [{ dieSize: 8, total: 3, used: 2 }],
      [{ dieSize: 8, total: 5, used: 0 }], // levelled up, new total
    );
    expect(out).toEqual([{ dieSize: 8, total: 5, used: 2 }]);
  });

  it('clamps `used` to the new total (e.g. DDB lowered a cap)', () => {
    const out = mergeHitDice(
      [{ dieSize: 6, total: 5, used: 5 }],
      [{ dieSize: 6, total: 3, used: 0 }],
    );
    expect(out).toEqual([{ dieSize: 6, total: 3, used: 3 }]);
  });
});

describe('mergeSpellSlots', () => {
  it('preserves `used` per level while taking new `max`', () => {
    const out = mergeSpellSlots(
      { '1': { max: 3, used: 2 } },
      { '1': { max: 4, used: 0 } },
    );
    expect(out).toEqual({ '1': { max: 4, used: 2 } });
  });

  it('drops old levels that no longer exist in DDB (multiclass change)', () => {
    const out = mergeSpellSlots(
      { '1': { max: 3, used: 1 }, '2': { max: 1, used: 1 } },
      { '1': { max: 2, used: 0 } },
    );
    expect(out).toEqual({ '1': { max: 2, used: 1 } });
  });

  it('clamps `used` to new max (DDB lowered the slot count)', () => {
    const out = mergeSpellSlots(
      { '2': { max: 3, used: 3 } },
      { '2': { max: 1, used: 0 } },
    );
    expect(out).toEqual({ '2': { max: 1, used: 1 } });
  });
});

describe('mergeFeatures', () => {
  it('preserves usesRemaining when the feature carried over', () => {
    const out = mergeFeatures(
      [{ name: 'Second Wind', usesTotal: 1, usesRemaining: 0, resetOn: 'short' }],
      [{ name: 'Second Wind', usesTotal: 1, usesRemaining: 1, resetOn: 'short' }],
    );
    expect(out[0].usesRemaining).toBe(0);
  });

  it('is case-insensitive on name', () => {
    const out = mergeFeatures(
      [{ name: 'ACTION SURGE', usesTotal: 1, usesRemaining: 0 }],
      [{ name: 'Action Surge', usesTotal: 2, usesRemaining: 2 }],
    );
    expect(out[0].usesRemaining).toBe(0);
    expect(out[0].usesTotal).toBe(2); // new total
  });

  it('takes the incoming shape when feature is new to the character', () => {
    const out = mergeFeatures(
      [],
      [{ name: 'Divine Sense', usesTotal: 4, usesRemaining: 4 }],
    );
    expect(out).toEqual([{ name: 'Divine Sense', usesTotal: 4, usesRemaining: 4 }]);
  });

  it('clamps preserved usesRemaining to the new usesTotal', () => {
    const out = mergeFeatures(
      [{ name: 'Rage', usesTotal: 5, usesRemaining: 5 }],
      [{ name: 'Rage', usesTotal: 3, usesRemaining: 3 }],
    );
    expect(out[0].usesRemaining).toBe(3);
  });
});

describe('buildMergeUpdate (happy path)', () => {
  it('clamps hitPoints to the new maxHitPoints', () => {
    const existing = {
      hit_points: 40,
      hit_dice: '[]',
      spell_slots: '{}',
      features: '[]',
    };
    const incoming = {
      name: 'Vex',
      maxHitPoints: 25,
      abilityScores: {},
      savingThrows: [],
      skills: {},
      background: {},
      characteristics: {},
      personality: {},
      notes: {},
      proficiencies: {},
      senses: {},
      defenses: {},
      currency: {},
      extras: [],
      spells: [],
      features: [],
      inventory: [],
      hitDice: [],
      spellSlots: {},
    };
    const { columns, values } = buildMergeUpdate({ existing, incoming, raw: {} });
    const byCol = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
    expect(byCol.hit_points).toBe(25);
  });

  it('includes REPLACED fields and MERGED fields, omits PRESERVED fields', () => {
    const existing = { hit_points: 10, hit_dice: '[]', spell_slots: '{}', features: '[]' };
    const incoming = {
      name: 'Vex', maxHitPoints: 20,
      abilityScores: {}, savingThrows: [], skills: {},
      background: {}, characteristics: {}, personality: {},
      notes: {}, proficiencies: {}, senses: {}, defenses: {},
      currency: {}, extras: [], spells: [], features: [],
      inventory: [], hitDice: [], spellSlots: {},
    };
    const { columns } = buildMergeUpdate({ existing, incoming, raw: {} });
    // Replaced:
    expect(columns).toContain('name');
    expect(columns).toContain('max_hit_points');
    expect(columns).toContain('spells');
    // Merged:
    expect(columns).toContain('hit_dice');
    expect(columns).toContain('spell_slots');
    expect(columns).toContain('features');
    // Preserved (not in SET):
    expect(columns).not.toContain('temp_hit_points');
    expect(columns).not.toContain('death_saves');
    expect(columns).not.toContain('concentrating_on');
    expect(columns).not.toContain('conditions');
  });
});
