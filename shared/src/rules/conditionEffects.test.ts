import { describe, it, expect } from 'vitest';
import {
  CONDITION_EFFECTS,
  PSEUDO_CONDITION_EFFECTS,
  effectForCondition,
  colorForCondition,
  speedMultiplierFor,
  blocksActions,
  blocksReactions,
  computeAttackModifiers,
  computeSaveModifiers,
  computeEffectiveAC,
  computeEffectiveSpeed,
} from './conditionEffects.js';

/**
 * Covers the shared source-of-truth rules data. The client's
 * roll-engine tests exercise these indirectly through wrappers, but
 * server-side callers and future macro tools will hit the shared
 * helpers directly — pin their contract here too.
 */

describe('effectForCondition lookup', () => {
  it('finds canonical 5e conditions', () => {
    expect(effectForCondition('poisoned')?.name).toBe('poisoned');
    expect(effectForCondition('unconscious')?.name).toBe('unconscious');
  });

  it('finds pseudo-conditions', () => {
    expect(effectForCondition('hasted')?.name).toBe('hasted');
    expect(effectForCondition('blessed')?.name).toBe('blessed');
    expect(effectForCondition('half-cover')?.name).toBe('half-cover');
  });

  it('is case-insensitive', () => {
    expect(effectForCondition('HASTED')?.name).toBe('hasted');
    expect(effectForCondition('Blessed')?.name).toBe('blessed');
  });

  it('returns undefined for unknown names', () => {
    expect(effectForCondition('bogus-condition')).toBeUndefined();
  });
});

describe('blocksActions / blocksReactions honor pseudo-conditions', () => {
  it('returns true for any incapacitating 5e condition', () => {
    expect(blocksActions(['stunned'])).toBe(true);
    expect(blocksReactions(['paralyzed'])).toBe(true);
  });

  it('returns false for basic pseudo-conditions that do not block', () => {
    expect(blocksActions(['blessed', 'inspired'])).toBe(false);
    expect(blocksReactions(['hasted', 'dodging'])).toBe(false);
  });
});

describe('speedMultiplierFor', () => {
  it('grappled/restrained/paralyzed drop speed to 0', () => {
    expect(speedMultiplierFor(['grappled'])).toBe(0);
    expect(speedMultiplierFor(['restrained'])).toBe(0);
    expect(speedMultiplierFor(['paralyzed'])).toBe(0);
  });

  it('prone halves speed', () => {
    expect(speedMultiplierFor(['prone'])).toBe(0.5);
  });

  it('minimum wins across multiple conditions', () => {
    // prone (0.5) AND paralyzed (0) → 0
    expect(speedMultiplierFor(['prone', 'paralyzed'])).toBe(0);
  });

  it('exhaustion L2 halves, L5 zeros', () => {
    expect(speedMultiplierFor([], 2)).toBe(0.5);
    expect(speedMultiplierFor([], 5)).toBe(0);
  });

  it('exhaustion does not overwrite a stricter condition multiplier', () => {
    expect(speedMultiplierFor(['paralyzed'], 2)).toBe(0);
  });
});

describe('computeAttackModifiers', () => {
  it('no modifiers → normal', () => {
    expect(computeAttackModifiers([], [], 'melee').effectiveAdvantage).toBe('normal');
  });

  it('attacker poisoned → disadvantage', () => {
    expect(computeAttackModifiers(['poisoned'], [], 'melee').effectiveAdvantage).toBe('disadvantage');
  });

  it('attacker invisible → advantage', () => {
    expect(computeAttackModifiers(['invisible'], [], 'melee').effectiveAdvantage).toBe('advantage');
  });

  it('target blinded → advantage to attacker', () => {
    expect(computeAttackModifiers([], ['blinded'], 'melee').effectiveAdvantage).toBe('advantage');
  });

  it('target prone + melee range → advantage', () => {
    expect(computeAttackModifiers([], ['prone'], 'melee').effectiveAdvantage).toBe('advantage');
  });

  it('target prone + ranged → disadvantage', () => {
    expect(computeAttackModifiers([], ['prone'], 'ranged').effectiveAdvantage).toBe('disadvantage');
  });

  it('attacker inspired (pseudo-condition) → advantage', () => {
    expect(computeAttackModifiers(['inspired'], [], 'melee').effectiveAdvantage).toBe('advantage');
  });

  it('paralyzed target at melee5 → auto-crit', () => {
    expect(computeAttackModifiers([], ['paralyzed'], 'melee5').autoCrit).toBe(true);
  });

  it('paralyzed target at ranged → no auto-crit', () => {
    expect(computeAttackModifiers([], ['paralyzed'], 'ranged').autoCrit).toBe(false);
  });

  it('advantage + disadvantage cancel to normal', () => {
    // poisoned attacker vs blinded target: disadv + adv = normal
    const r = computeAttackModifiers(['poisoned'], ['blinded'], 'melee');
    expect(r.effectiveAdvantage).toBe('normal');
  });
});

describe('computeSaveModifiers', () => {
  it('paralyzed auto-fails STR + DEX', () => {
    expect(computeSaveModifiers(['paralyzed'], 'str').autoFail).toBe(true);
    expect(computeSaveModifiers(['paralyzed'], 'dex').autoFail).toBe(true);
    expect(computeSaveModifiers(['paralyzed'], 'con').autoFail).toBe(false);
  });

  it('restrained → disadvantage on DEX saves', () => {
    expect(computeSaveModifiers(['restrained'], 'dex').effectiveAdvantage).toBe('disadvantage');
  });

  it('hasted (pseudo) → advantage on DEX saves', () => {
    expect(computeSaveModifiers(['hasted'], 'dex').effectiveAdvantage).toBe('advantage');
  });

  it('exhaustion L3 → disadvantage on all saves', () => {
    expect(computeSaveModifiers([], 'wis', 3).effectiveAdvantage).toBe('disadvantage');
  });
});

describe('computeEffectiveAC', () => {
  it('returns base AC with no conditions', () => {
    expect(computeEffectiveAC(15, [], 2).value).toBe(15);
  });

  it('adds Hasted +2', () => {
    expect(computeEffectiveAC(15, ['hasted'], 2).value).toBe(17);
  });

  it('Mage Armor floors to 13+DEX when base is lower', () => {
    expect(computeEffectiveAC(10, ['mage-armored'], 3).value).toBe(16);
  });

  it('Mage Armor does not lower a higher base AC', () => {
    expect(computeEffectiveAC(18, ['mage-armored'], 2).value).toBe(18);
  });

  it('Barkskin lifts low AC to 16', () => {
    expect(computeEffectiveAC(12, ['barkskin'], 1).value).toBe(16);
  });

  it('cover stacks on floor', () => {
    // 10 base, barkskin floor = 16, half cover +2 = 18
    expect(computeEffectiveAC(10, ['barkskin', 'half-cover'], 1).value).toBe(18);
  });

  it('Shield spell +5', () => {
    expect(computeEffectiveAC(15, ['shield-spell'], 2).value).toBe(20);
  });
});

describe('computeEffectiveSpeed', () => {
  it('returns baseline with no conditions', () => {
    expect(computeEffectiveSpeed(30, []).value).toBe(30);
  });

  it('grappled = 0', () => {
    expect(computeEffectiveSpeed(30, ['grappled']).value).toBe(0);
  });

  it('hasted doubles', () => {
    expect(computeEffectiveSpeed(30, ['hasted']).value).toBe(60);
  });

  it('slowed halves', () => {
    expect(computeEffectiveSpeed(30, ['slowed']).value).toBe(15);
  });

  it('prone halves (crawl / stand)', () => {
    expect(computeEffectiveSpeed(30, ['prone']).value).toBe(15);
  });

  it('exhaustion L5 zeros speed', () => {
    expect(computeEffectiveSpeed(30, [], 5).value).toBe(0);
  });

  it('speed-0 condition beats half-speed condition', () => {
    expect(computeEffectiveSpeed(30, ['prone', 'paralyzed']).value).toBe(0);
  });
});

describe('colorForCondition', () => {
  it('returns the entry\'s color for known standard conditions', () => {
    expect(colorForCondition('paralyzed')).toBe('#f1c40f');
    expect(colorForCondition('unconscious')).toBe('#2c3e50');
  });

  it('returns the entry\'s color for known pseudo-conditions', () => {
    expect(colorForCondition('blessed')).toBe('#f1c40f');
    expect(colorForCondition('hexed')).toBe('#8e44ad');
    expect(colorForCondition('bear-raging')).toBe('#6e2c00');
  });

  it('is case-insensitive', () => {
    expect(colorForCondition('PARALYZED')).toBe('#f1c40f');
    expect(colorForCondition('Hexblade-Cursed')).toBe('#6c3483');
  });

  it('returns the fallback for unknown names', () => {
    expect(colorForCondition('bogus')).toBe('#888');
    expect(colorForCondition('bogus', '#ff0000')).toBe('#ff0000');
  });

  it('every standard condition has a color defined', () => {
    for (const [key, eff] of Object.entries(CONDITION_EFFECTS)) {
      expect(eff.color, `${key} missing color`).toBeDefined();
    }
  });

  it('every pseudo-condition has a color defined', () => {
    for (const [key, eff] of Object.entries(PSEUDO_CONDITION_EFFECTS)) {
      expect(eff.color, `${key} missing color`).toBeDefined();
    }
  });
});

describe('data integrity', () => {
  it('every 5e condition in CONDITION_EFFECTS has name matching its key', () => {
    for (const [key, eff] of Object.entries(CONDITION_EFFECTS)) {
      expect(eff.name).toBe(key);
    }
  });

  it('every pseudo-condition in PSEUDO_CONDITION_EFFECTS has name matching its key', () => {
    for (const [key, eff] of Object.entries(PSEUDO_CONDITION_EFFECTS)) {
      expect(eff.name).toBe(key);
    }
  });

  it('no key collisions between CONDITION_EFFECTS and PSEUDO_CONDITION_EFFECTS', () => {
    const canonical = new Set(Object.keys(CONDITION_EFFECTS));
    for (const key of Object.keys(PSEUDO_CONDITION_EFFECTS)) {
      expect(canonical.has(key)).toBe(false);
    }
  });
});
