import { describe, it, expect } from 'vitest';
import {
  parseCheckTarget,
  computeCheckModifier,
  resolveCheckAdvantage,
  isReliableTalent,
  jackOfAllTradesBonus,
  rollCheck,
} from '../services/chatCommands/checkRoll.js';

/** Deterministic RNG yielding the given d20 face values in order. */
function rngForD20s(...faces: number[]): () => number {
  let i = 0;
  return () => (faces[i++] - 1) / 20; // floor(((n-1)/20)*20)+1 === n
}

describe('parseCheckTarget', () => {
  it('parses canonical skills', () => {
    expect(parseCheckTarget('perception')).toEqual({
      kind: 'skill',
      skill: 'perception',
      ability: 'wis',
    });
    expect(parseCheckTarget('athletics')).toEqual({
      kind: 'skill',
      skill: 'athletics',
      ability: 'str',
    });
  });
  it('parses multi-word skills and aliases, ignoring case/spaces', () => {
    expect(parseCheckTarget('Animal Handling')).toMatchObject({
      skill: 'animalHandling',
      ability: 'wis',
    });
    expect(parseCheckTarget('sleightofhand')).toMatchObject({
      skill: 'sleightOfHand',
      ability: 'dex',
    });
    expect(parseCheckTarget('soh')).toMatchObject({ skill: 'sleightOfHand' });
    expect(parseCheckTarget('perc')).toMatchObject({ skill: 'perception' });
  });
  it('parses raw abilities', () => {
    expect(parseCheckTarget('STR')).toEqual({ kind: 'ability', ability: 'str' });
    expect(parseCheckTarget('dex')).toEqual({ kind: 'ability', ability: 'dex' });
  });
  it('returns null for nonsense', () => {
    expect(parseCheckTarget('flumph')).toBeNull();
  });
});

describe('computeCheckModifier', () => {
  const scores = { str: 16, dex: 14, con: 12, int: 10, wis: 8, cha: 18 };
  const base = { scores, profBonus: 3, className: 'Fighter' };

  it('adds proficiency for a proficient skill', () => {
    const r = computeCheckModifier({
      ...base,
      target: parseCheckTarget('athletics')!,
      skills: { athletics: 'proficient' },
    });
    expect(r.total).toBe(3 + 3); // STR +3, prof +3
    expect(r.proficient).toBe(true);
  });
  it('doubles proficiency for expertise', () => {
    const r = computeCheckModifier({
      ...base,
      target: parseCheckTarget('stealth')!,
      skills: { stealth: 'expertise' },
    });
    expect(r.total).toBe(2 + 6); // DEX +2, expertise +6
  });
  it('adds nothing for an unproficient skill', () => {
    const r = computeCheckModifier({ ...base, target: parseCheckTarget('arcana')!, skills: {} });
    expect(r.total).toBe(0); // INT +0
    expect(r.proficient).toBe(false);
  });
  it('uses the ability mod for a raw ability check', () => {
    const r = computeCheckModifier({ ...base, target: parseCheckTarget('cha')!, skills: {} });
    expect(r.total).toBe(4); // CHA 18 → +4
  });
  it('applies Bard Jack-of-All-Trades to unproficient checks only', () => {
    const bard = { scores, profBonus: 4, className: 'Bard' };
    const unprof = computeCheckModifier({
      ...bard,
      target: parseCheckTarget('arcana')!,
      skills: {},
    });
    expect(unprof.total).toBe(0 + 2); // INT +0 + floor(4/2)
    const prof = computeCheckModifier({
      ...bard,
      target: parseCheckTarget('arcana')!,
      skills: { arcana: 'proficient' },
    });
    expect(prof.total).toBe(0 + 4); // proficiency already included → no JoAT
  });
  it('adds a flat situational bonus', () => {
    const r = computeCheckModifier({
      ...base,
      target: parseCheckTarget('dex')!,
      skills: {},
      flatBonus: 2,
    });
    expect(r.total).toBe(2 + 2);
  });
});

describe('resolveCheckAdvantage', () => {
  it('honors an explicit flag', () => {
    expect(
      resolveCheckAdvantage({ explicit: 'advantage', conditions: [], exhaustion: 0 }).effective
    ).toBe('advantage');
  });
  it('imposes disadvantage for poisoned / frightened / exhaustion', () => {
    expect(
      resolveCheckAdvantage({ explicit: 'normal', conditions: ['poisoned'], exhaustion: 0 })
        .effective
    ).toBe('disadvantage');
    expect(
      resolveCheckAdvantage({ explicit: 'normal', conditions: ['frightened'], exhaustion: 0 })
        .effective
    ).toBe('disadvantage');
    expect(
      resolveCheckAdvantage({ explicit: 'normal', conditions: [], exhaustion: 1 }).effective
    ).toBe('disadvantage');
  });
  it('cancels advantage and disadvantage to normal', () => {
    expect(
      resolveCheckAdvantage({ explicit: 'advantage', conditions: ['poisoned'], exhaustion: 0 })
        .effective
    ).toBe('normal');
  });
  it('reports disadvantage sources', () => {
    expect(
      resolveCheckAdvantage({ explicit: 'normal', conditions: ['Poisoned'], exhaustion: 2 })
        .disadvantageSources
    ).toEqual(['poisoned', 'exhaustion']);
  });
});

describe('isReliableTalent / jackOfAllTradesBonus', () => {
  it('is true only for a proficient Rogue 11+', () => {
    expect(isReliableTalent('Rogue', 11, true)).toBe(true);
    expect(isReliableTalent('Rogue', 10, true)).toBe(false);
    expect(isReliableTalent('Rogue', 11, false)).toBe(false);
    expect(isReliableTalent('Fighter', 11, true)).toBe(false);
  });
  it('JoAT is half prof for a non-proficient Bard only', () => {
    expect(jackOfAllTradesBonus('Bard', 4, false)).toBe(2);
    expect(jackOfAllTradesBonus('Bard', 4, true)).toBe(0);
    expect(jackOfAllTradesBonus('Fighter', 4, false)).toBe(0);
  });
});

describe('rollCheck', () => {
  it('rolls a single d20 + modifier normally', () => {
    const r = rollCheck({
      modifier: 5,
      advantage: 'normal',
      reliableTalent: false,
      rng: rngForD20s(12),
    });
    expect(r.d20).toBe(12);
    expect(r.total).toBe(17);
  });
  it('keeps the higher of two on advantage', () => {
    const r = rollCheck({
      modifier: 0,
      advantage: 'advantage',
      reliableTalent: false,
      rng: rngForD20s(7, 18),
    });
    expect(r.d20).toBe(18);
    expect(r.d20Rolls).toEqual([7, 18]);
  });
  it('keeps the lower of two on disadvantage', () => {
    const r = rollCheck({
      modifier: 0,
      advantage: 'disadvantage',
      reliableTalent: false,
      rng: rngForD20s(7, 18),
    });
    expect(r.d20).toBe(7);
  });
  it('treats a sub-10 roll as 10 under Reliable Talent', () => {
    const r = rollCheck({
      modifier: 4,
      advantage: 'normal',
      reliableTalent: true,
      rng: rngForD20s(5),
    });
    expect(r.d20).toBe(10);
    expect(r.reliableTalentApplied).toBe(true);
    expect(r.total).toBe(14);
  });
  it('leaves a 10+ roll untouched under Reliable Talent', () => {
    const r = rollCheck({
      modifier: 0,
      advantage: 'normal',
      reliableTalent: true,
      rng: rngForD20s(13),
    });
    expect(r.d20).toBe(13);
    expect(r.reliableTalentApplied).toBe(false);
  });
});
