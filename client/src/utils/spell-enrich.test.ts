import { describe, it, expect } from 'vitest';
import { parseSpellMetaFromDesc, enrichSpellFromDescription } from './spell-enrich';
import type { Spell } from '@dnd-vtt/shared';

function base(): Spell {
  return {
    name: 'Test',
    level: 1,
    school: 'Evocation',
    castingTime: '1 action',
    range: '60 ft',
    components: 'V, S',
    duration: 'Instantaneous',
    description: '',
    isConcentration: false,
    isRitual: false,
  };
}

describe('parseSpellMetaFromDesc', () => {
  it('extracts basic damage + type', () => {
    const out = parseSpellMetaFromDesc(
      'A bright streak flashes, bursting in a fiery explosion. Each creature takes 8d6 fire damage.',
    );
    expect(out.damage).toBe('8d6');
    expect(out.damageType).toBe('fire');
  });

  it('handles damage with a modifier', () => {
    const out = parseSpellMetaFromDesc('deals 1d8 + 2 necrotic damage on a hit.');
    expect(out.damage).toBe('1d8+2');
    expect(out.damageType).toBe('necrotic');
  });

  it('ignores unknown damage types', () => {
    const out = parseSpellMetaFromDesc('takes 2d6 spooky damage');
    expect(out.damage).toBe('2d6');
    expect(out.damageType).toBeUndefined();
  });

  it('detects healing when no damage is present', () => {
    const out = parseSpellMetaFromDesc(
      'the target regains hit points equal to 2d8 + your spellcasting modifier.',
    );
    expect(out.damage).toBe('2d8');
    expect(out.damageType).toBe('healing');
  });

  it('picks up Dexterity saving throw', () => {
    const out = parseSpellMetaFromDesc(
      'Each creature in the area must make a Dexterity saving throw, taking half damage on a success.',
    );
    expect(out.savingThrow).toBe('dex');
  });

  it('detects a ranged spell attack', () => {
    const out = parseSpellMetaFromDesc('Make a ranged spell attack against the target.');
    expect(out.attackType).toBe('ranged');
  });

  it('detects a melee spell attack', () => {
    const out = parseSpellMetaFromDesc('Make a melee spell attack against a creature within reach.');
    expect(out.attackType).toBe('melee');
  });

  it('parses radius-first AoE ("20-foot-radius sphere")', () => {
    const out = parseSpellMetaFromDesc(
      'a 20-foot-radius sphere centered on a point you choose',
    );
    expect(out.aoeType).toBe('sphere');
    expect(out.aoeSize).toBe(20);
  });

  it('parses shape-first AoE ("line 100 feet long")', () => {
    const out = parseSpellMetaFromDesc(
      'A stroke of lightning forming a line 100 feet long and 5 feet wide',
    );
    expect(out.aoeType).toBe('line');
    expect(out.aoeSize).toBe(100);
  });

  it('returns empty object for empty/HTML-only input', () => {
    expect(parseSpellMetaFromDesc('')).toEqual({});
    expect(parseSpellMetaFromDesc('<div></div>')).toEqual({});
  });
});

describe('enrichSpellFromDescription', () => {
  it('fills in damage when missing and preserves existing fields', () => {
    const enriched = enrichSpellFromDescription({
      ...base(),
      name: 'Fireball',
      description: 'deals 8d6 fire damage',
    });
    expect(enriched.damage).toBe('8d6');
    expect(enriched.damageType).toBe('fire');
    expect(enriched.name).toBe('Fireball');
  });

  it("doesn't clobber fields that are already set", () => {
    const enriched = enrichSpellFromDescription({
      ...base(),
      damage: '9d8',
      damageType: 'radiant',
      description: 'deals 1d4 fire damage',
    });
    expect(enriched.damage).toBe('9d8');
    expect(enriched.damageType).toBe('radiant');
  });
});
