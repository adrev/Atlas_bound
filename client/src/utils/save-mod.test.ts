import { describe, it, expect } from 'vitest';
import { computeSaveModifier, saveModifierForCharacter } from './save-mod';
import type { AbilityScores } from '@dnd-vtt/shared';

const abilities: AbilityScores = {
  str: 14,  // +2
  dex: 18,  // +4
  con: 13,  // +1
  int: 10,  // +0
  wis: 8,   // -1
  cha: 16,  // +3
};

describe('computeSaveModifier', () => {
  it('returns just the ability modifier when NOT proficient', () => {
    expect(computeSaveModifier('str', abilities, [], 3)).toBe(2);
    expect(computeSaveModifier('dex', abilities, [], 3)).toBe(4);
    expect(computeSaveModifier('wis', abilities, [], 3)).toBe(-1);
  });

  it('adds proficiency bonus when proficient', () => {
    expect(computeSaveModifier('dex', abilities, ['dex'], 3)).toBe(7);
    expect(computeSaveModifier('wis', abilities, ['wis'], 4)).toBe(3);
  });

  it('ignores proficiency when flagged for a different ability', () => {
    expect(computeSaveModifier('int', abilities, ['wis', 'cha'], 3)).toBe(0);
  });

  it('handles a null / missing character gracefully', () => {
    expect(computeSaveModifier('str', null, null, 3)).toBe(0);
    expect(computeSaveModifier('str', undefined, undefined, 3)).toBe(0);
  });
});

describe('saveModifierForCharacter', () => {
  it('reads parsed object shape', () => {
    const char = {
      abilityScores: abilities,
      savingThrows: ['dex', 'int'],
      proficiencyBonus: 3,
    };
    expect(saveModifierForCharacter(char as never, 'dex')).toBe(7);
    expect(saveModifierForCharacter(char as never, 'int')).toBe(3);
    expect(saveModifierForCharacter(char as never, 'wis')).toBe(-1);
  });

  it('reads stringified JSON (DB row pass-through shape)', () => {
    const char = {
      abilityScores: JSON.stringify(abilities),
      savingThrows: JSON.stringify(['con']),
      proficiencyBonus: 2,
    };
    expect(saveModifierForCharacter(char as never, 'con')).toBe(3);
    expect(saveModifierForCharacter(char as never, 'str')).toBe(2);
  });

  it('returns 0 for a null character', () => {
    expect(saveModifierForCharacter(null, 'str')).toBe(0);
  });

  it('returns 0 for unparseable JSON', () => {
    const char = {
      abilityScores: '{not-json',
      savingThrows: '[ok but abilities broken',
      proficiencyBonus: 3,
    };
    expect(saveModifierForCharacter(char as never, 'str')).toBe(0);
  });
});
