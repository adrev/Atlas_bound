import { describe, it, expect } from 'vitest';
import {
  getOwnRollModifiers,
  getTargetRollModifiers,
  combineAttackModifiers,
  effectiveAC,
  effectiveSpeed,
  applyDamageWithResist,
} from './roll-engine';

/**
 * Behavior guards around the shared-conditionEffects refactor. The
 * roll-engine functions used to hard-code each condition's effect in
 * long if-chains; they now delegate to shared data. These tests pin
 * the public outputs so any data-shape drift in the shared module
 * would fail loudly instead of silently changing combat math.
 */

describe('getOwnRollModifiers', () => {
  it('applies Blessed +1d4 to attack + save bonus dice', () => {
    const out = getOwnRollModifiers(['blessed']);
    expect(out.attackBonusDice).toBe('+1d4');
    expect(out.saveBonusDice).toBe('+1d4');
  });

  it('applies Baned -1d4 to attack + save bonus dice', () => {
    const out = getOwnRollModifiers(['baned']);
    expect(out.attackBonusDice).toBe('-1d4');
    expect(out.saveBonusDice).toBe('-1d4');
  });

  it('gives attack disadvantage for poisoned', () => {
    const out = getOwnRollModifiers(['poisoned']);
    expect(out.attackAdvantage).toBe('disadvantage');
  });

  it('gives all-check disadvantage for frightened', () => {
    const out = getOwnRollModifiers(['frightened']);
    expect(out.checkAdvantage.str).toBe('disadvantage');
    expect(out.checkAdvantage.wis).toBe('disadvantage');
  });

  it('auto-fails STR + DEX saves when paralyzed', () => {
    const out = getOwnRollModifiers(['paralyzed']);
    expect(out.autoFailSaves).toEqual(expect.arrayContaining(['str', 'dex']));
  });

  it('grants DEX save advantage when hasted', () => {
    const out = getOwnRollModifiers(['hasted']);
    expect(out.saveAdvantage.dex).toBe('advantage');
  });

  it('grants attack advantage when inspired', () => {
    const out = getOwnRollModifiers(['inspired']);
    expect(out.attackAdvantage).toBe('advantage');
  });

  it('gives attack + check advantage when helped', () => {
    const out = getOwnRollModifiers(['helped']);
    expect(out.attackAdvantage).toBe('advantage');
    expect(out.checkAdvantage.str).toBe('advantage');
    expect(out.checkAdvantage.cha).toBe('advantage');
  });
});

describe('getTargetRollModifiers', () => {
  it('grants advantage to attackers when target is blinded', () => {
    const out = getTargetRollModifiers(['blinded']);
    expect(out.attackAdvantage).toBe('advantage');
  });

  it('grants disadvantage to attackers when target is invisible', () => {
    const out = getTargetRollModifiers(['invisible']);
    expect(out.attackAdvantage).toBe('disadvantage');
  });

  it('prone grants advantage to melee attackers', () => {
    const out = getTargetRollModifiers(['prone'], 'melee');
    expect(out.attackAdvantage).toBe('advantage');
  });

  it('prone grants disadvantage to ranged attackers', () => {
    const out = getTargetRollModifiers(['prone'], 'ranged');
    expect(out.attackAdvantage).toBe('disadvantage');
  });

  it('sets forceCritWithin5ft for paralyzed targets', () => {
    const out = getTargetRollModifiers(['paralyzed']);
    expect(out.meleeCritWithin5ft).toBe(true);
  });

  it('dodging gives disadvantage to attackers', () => {
    const out = getTargetRollModifiers(['dodging']);
    expect(out.attackAdvantage).toBe('disadvantage');
  });
});

describe('combineAttackModifiers', () => {
  it('cancels advantage + disadvantage to normal', () => {
    const own = getOwnRollModifiers(['inspired']); // advantage
    const tgt = getTargetRollModifiers(['dodging']); // disadvantage
    const combined = combineAttackModifiers(own, tgt);
    expect(combined.attackAdvantage).toBe('normal');
  });

  it('preserves advantage when only one side has it', () => {
    const own = getOwnRollModifiers([]);
    const tgt = getTargetRollModifiers(['blinded']); // advantage to attacker
    const combined = combineAttackModifiers(own, tgt);
    expect(combined.attackAdvantage).toBe('advantage');
  });
});

describe('effectiveAC (shared delegation)', () => {
  it('applies +2 Hasted AC bonus', () => {
    const out = effectiveAC(15, ['hasted'], 2);
    expect(out.value).toBe(17);
    expect(out.base).toBe(15);
  });

  it('applies -2 Slowed AC penalty', () => {
    const out = effectiveAC(15, ['slowed'], 2);
    expect(out.value).toBe(13);
  });

  it('Mage Armor floors base AC to 13 + DEX when higher', () => {
    const out = effectiveAC(10, ['mage-armored'], 3);
    // 13 + 3 = 16 > 10 → lifted
    expect(out.value).toBe(16);
  });

  it('Mage Armor does not lower AC when the base is already higher', () => {
    const out = effectiveAC(18, ['mage-armored'], 2);
    // 13+2=15, less than 18 → stays at 18
    expect(out.value).toBe(18);
  });

  it('stacks cover on top of armor', () => {
    const out = effectiveAC(15, ['half-cover'], 2);
    expect(out.value).toBe(17);
  });

  it('stacks three-quarters cover + Hasted', () => {
    const out = effectiveAC(15, ['three-quarters-cover', 'hasted'], 2);
    expect(out.value).toBe(22); // 15 + 5 + 2
  });
});

describe('effectiveSpeed (shared delegation)', () => {
  it('returns 0 when grappled', () => {
    const out = effectiveSpeed(30, ['grappled']);
    expect(out.value).toBe(0);
  });

  it('returns 0 when restrained', () => {
    const out = effectiveSpeed(30, ['restrained']);
    expect(out.value).toBe(0);
  });

  it('doubles speed when hasted', () => {
    const out = effectiveSpeed(30, ['hasted']);
    expect(out.value).toBe(60);
  });

  it('halves speed when slowed', () => {
    const out = effectiveSpeed(30, ['slowed']);
    expect(out.value).toBe(15);
  });

  it('halves speed when prone', () => {
    const out = effectiveSpeed(30, ['prone']);
    expect(out.value).toBe(15);
  });

  it('speed 0 wins over halve conditions', () => {
    const out = effectiveSpeed(30, ['prone', 'paralyzed']);
    expect(out.value).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Silvered / adamantine / cold-iron weapon material bypass
// ═══════════════════════════════════════════════════════════════════

describe('applyDamageWithResist — weapon material exemptions', () => {
  const werewolfDefenses = {
    resistances: [
      "bludgeoning, piercing, and slashing from nonmagical attacks that aren't silvered",
    ],
    immunities: [],
    vulnerabilities: [],
  };

  it('werewolf halves damage from a nonmagical non-silvered longsword', () => {
    const result = applyDamageWithResist(
      20, 'slashing', werewolfDefenses, [], false, null,
    );
    expect(result.amount).toBe(10);
    expect(result.multiplier).toBe(0.5);
  });

  it('silvered longsword bypasses the werewolf resistance', () => {
    const result = applyDamageWithResist(
      20, 'slashing', werewolfDefenses, [], false, 'silvered',
    );
    expect(result.amount).toBe(20);
    expect(result.multiplier).toBe(1);
  });

  it('magical longsword bypasses the werewolf resistance (isMagical branch)', () => {
    const result = applyDamageWithResist(
      20, 'slashing', werewolfDefenses, [], true, null,
    );
    expect(result.amount).toBe(20);
    expect(result.multiplier).toBe(1);
  });

  const stoneGolemDefenses = {
    resistances: [],
    immunities: [
      "bludgeoning, piercing, and slashing from nonmagical attacks that aren't adamantine",
    ],
    vulnerabilities: [],
  };

  it('stone golem immune to a nonmagical non-adamantine attack', () => {
    const result = applyDamageWithResist(
      30, 'bludgeoning', stoneGolemDefenses, [], false, null,
    );
    expect(result.amount).toBe(0);
    expect(result.multiplier).toBe(0);
  });

  it('adamantine weapon lands full damage vs a stone golem', () => {
    const result = applyDamageWithResist(
      30, 'bludgeoning', stoneGolemDefenses, [], false, 'adamantine',
    );
    expect(result.amount).toBe(30);
    expect(result.multiplier).toBe(1);
  });

  const fiendDefenses = {
    resistances: [
      "bludgeoning, piercing, and slashing from nonmagical attacks that aren't cold iron",
    ],
    immunities: [],
    vulnerabilities: [],
  };

  it('cold-iron weapon bypasses a fey-style resistance (aren\'t cold iron)', () => {
    const result = applyDamageWithResist(
      16, 'slashing', fiendDefenses, [], false, 'cold-iron',
    );
    expect(result.amount).toBe(16);
  });

  it('silvered weapon does NOT bypass a cold-iron-only resistance', () => {
    const result = applyDamageWithResist(
      16, 'slashing', fiendDefenses, [], false, 'silvered',
    );
    expect(result.amount).toBe(8);
    expect(result.multiplier).toBe(0.5);
  });
});

