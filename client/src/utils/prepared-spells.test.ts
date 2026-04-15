import { describe, it, expect } from 'vitest';
import {
  isPrepareClass, maxPreparedSpells, countPreparedSpells, isSpellReady,
} from './prepared-spells';
import type { Spell, AbilityScores } from '@dnd-vtt/shared';

const abilities: AbilityScores = { str: 10, dex: 10, con: 10, int: 16, wis: 14, cha: 10 };
const makeSpell = (level: number, prepared?: boolean, name = 'Spell'): Spell => ({
  name, level, school: 'Evocation',
  castingTime: '1 action', range: '30 ft', components: 'V',
  duration: 'Instantaneous', description: '',
  isConcentration: false, isRitual: false,
  prepared,
});

describe('isPrepareClass', () => {
  it('recognises single-class casters', () => {
    expect(isPrepareClass('Cleric')).toBe(true);
    expect(isPrepareClass('Wizard')).toBe(true);
    expect(isPrepareClass('Druid')).toBe(true);
    expect(isPrepareClass('Paladin')).toBe(true);
    expect(isPrepareClass('Artificer')).toBe(true);
    expect(isPrepareClass('Sorcerer')).toBe(false);
    expect(isPrepareClass('Warlock')).toBe(false);
    expect(isPrepareClass('Ranger')).toBe(false);
  });

  it('matches a prepare-class inside a multiclass string', () => {
    expect(isPrepareClass('Cleric 3 / Rogue 2')).toBe(true);
    expect(isPrepareClass('Rogue 3 / Wizard 2')).toBe(true);
  });

  it('handles empty / null / undefined', () => {
    expect(isPrepareClass(null)).toBe(false);
    expect(isPrepareClass(undefined)).toBe(false);
    expect(isPrepareClass('')).toBe(false);
  });
});

describe('maxPreparedSpells', () => {
  it('returns Infinity for non-prepare classes (flag is informational)', () => {
    expect(maxPreparedSpells('Sorcerer', 10, 'cha', abilities)).toBe(Infinity);
    expect(maxPreparedSpells('Warlock', 20, 'cha', abilities)).toBe(Infinity);
  });

  it('wizard level 5 INT 16 → 5 + 3 = 8', () => {
    expect(maxPreparedSpells('Wizard', 5, 'int', abilities)).toBe(8);
  });

  it('cleric level 1 WIS 14 → max(1, 1 + 2) = 3', () => {
    expect(maxPreparedSpells('Cleric', 1, 'wis', abilities)).toBe(3);
  });

  it('paladin uses HALF level rounded down, min 1', () => {
    // level 5, cha 10 (mod 0) → floor(5/2) + 0 = 2
    expect(maxPreparedSpells('Paladin', 5, 'cha', abilities)).toBe(2);
    // level 1 with dump-stat cha would be floor(1/2)+mod = 0+0=0 → min 1
    expect(maxPreparedSpells('Paladin', 1, 'cha', abilities)).toBe(1);
  });

  it('clamps to a minimum of 1 even with negative modifiers', () => {
    const dumped: AbilityScores = { ...abilities, int: 1 };
    expect(maxPreparedSpells('Wizard', 1, 'int', dumped)).toBe(1);
  });
});

describe('countPreparedSpells', () => {
  it('counts only level >= 1 spells with prepared === true', () => {
    const spells: Spell[] = [
      makeSpell(0, true),   // cantrip — excluded
      makeSpell(1, true),
      makeSpell(1, false),
      makeSpell(2),         // prepared not set (undefined)
      makeSpell(3, true),
    ];
    expect(countPreparedSpells(spells)).toBe(2);
  });

  it('empty list counts as zero', () => {
    expect(countPreparedSpells([])).toBe(0);
  });
});

describe('isSpellReady', () => {
  it('cantrips are always ready regardless of class or flag', () => {
    const cantrip = makeSpell(0, false);
    expect(isSpellReady(cantrip, 'Wizard')).toBe(true);
    expect(isSpellReady(cantrip, 'Sorcerer')).toBe(true);
  });

  it('non-prepare classes ignore the flag', () => {
    const spell = makeSpell(3, false);
    expect(isSpellReady(spell, 'Sorcerer')).toBe(true);
    expect(isSpellReady(spell, 'Warlock')).toBe(true);
  });

  it('prepare-class leveled spells require the flag', () => {
    expect(isSpellReady(makeSpell(2, true), 'Wizard')).toBe(true);
    expect(isSpellReady(makeSpell(2, false), 'Wizard')).toBe(false);
    expect(isSpellReady(makeSpell(2), 'Wizard')).toBe(false);
  });
});
