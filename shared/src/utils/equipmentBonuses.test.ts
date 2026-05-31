import { describe, expect, it } from 'vitest';
import { calculateEquipmentBonuses, type EquippedItem, type EquipmentAbilityScores } from './equipmentBonuses.js';

const scores = (overrides: Partial<EquipmentAbilityScores> = {}): EquipmentAbilityScores => ({
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
  ...overrides,
});

const item = (overrides: Partial<EquippedItem>): EquippedItem => ({
  name: 'Item',
  type: 'gear',
  equipped: true,
  ...overrides,
});

describe('calculateEquipmentBonuses', () => {
  it('supports custom light armor acType with full Dexterity modifier', () => {
    const result = calculateEquipmentBonuses([
      item({ name: 'Custom Leather', type: 'armor', ac: 11, acType: 'light' }),
    ], scores({ dex: 16 }));

    expect(result.effectiveAC).toBe(14);
    expect(result.acBreakdown).toContain('11 + 3 DEX');
  });

  it('supports custom medium armor acType with Dexterity capped at +2', () => {
    const result = calculateEquipmentBonuses([
      item({ name: 'Custom Half Plate', type: 'armor', ac: 15, acType: 'medium' }),
    ], scores({ dex: 18 }));

    expect(result.effectiveAC).toBe(17);
    expect(result.acBreakdown).toContain('15 + 2 DEX (max 2)');
  });

  it('keeps legacy dex-max-2 medium armor behavior', () => {
    const result = calculateEquipmentBonuses([
      item({ name: 'Legacy Breastplate', type: 'armor', ac: 14, acType: 'dex-max-2' }),
    ], scores({ dex: 18 }));

    expect(result.effectiveAC).toBe(16);
  });

  it('uses table defaults for named armor when structured AC is missing', () => {
    const result = calculateEquipmentBonuses([
      item({ name: 'Chain Mail', type: 'armor' }),
    ], scores({ str: 12, dex: 18 }));

    expect(result.effectiveAC).toBe(16);
    expect(result.stealthDisadvantage).toBe(true);
    expect(result.speedPenalty).toBe(-10);
  });

  it('recognizes legacy category armor even when type is generic gear', () => {
    const result = calculateEquipmentBonuses([
      item({ name: 'Scale Mail', type: 'gear', category: 'armor' }),
    ], scores({ dex: 16 }));

    expect(result.effectiveAC).toBe(16);
    expect(result.stealthDisadvantage).toBe(true);
  });

  it('does not apply heavy armor speed penalty when Strength requirement is met', () => {
    const result = calculateEquipmentBonuses([
      item({ name: 'Plate', type: 'armor' }),
    ], scores({ str: 15, dex: 18 }));

    expect(result.effectiveAC).toBe(18);
    expect(result.speedPenalty).toBe(0);
  });

  it('adds shield AC and explicit magic shield bonus', () => {
    const result = calculateEquipmentBonuses([
      item({ name: 'Leather', type: 'armor' }),
      item({ name: 'Shield +1', type: 'shield', ac: 2, magicBonus: 1 }),
    ], scores({ dex: 14 }));

    expect(result.effectiveAC).toBe(16);
    expect(result.acBreakdown).toContain('+ 3 shield');
  });

  it('does not double count imported magic armor whose structured AC already includes the bonus', () => {
    const result = calculateEquipmentBonuses([
      item({
        name: '+1 Plate Armor',
        type: 'armor',
        ac: 19,
        acType: 'heavy',
        description: 'You have a +1 bonus to AC while wearing this armor.',
      }),
    ], scores({ str: 15, dex: 18 }));

    expect(result.effectiveAC).toBe(19);
  });

  it('reads stealth disadvantage from structured properties', () => {
    const result = calculateEquipmentBonuses([
      item({
        name: 'Custom Medium Armor',
        type: 'armor',
        ac: 14,
        acType: 'medium',
        properties: ['Stealth Disadvantage'],
      }),
    ], scores({ dex: 14 }));

    expect(result.effectiveAC).toBe(16);
    expect(result.stealthDisadvantage).toBe(true);
  });
});
