import { describe, it, expect } from 'vitest';
import { parseDiceNotation } from '@dnd-vtt/shared';
import { validateReportedRoll } from '../utils/rollValidator.js';

/**
 * P1 regression: the earlier sanity-check accepted any `total` and
 * derived the modifier from `total - sum(dice)`, letting a client
 * report d20=1 / total=10000 and having it persisted as authoritative.
 * The validator now parses the notation and demands that the reported
 * dice bag and final total agree with what the notation says.
 */
describe('validateReportedRoll', () => {
  it('accepts an honest d20 roll with no modifier', () => {
    const parsed = parseDiceNotation('1d20');
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 20, value: 15 }],
        total: 15,
      })
    ).toBe(true);
  });

  it('accepts 2d6+3 rolled as [4,5]+3 = 12', () => {
    const parsed = parseDiceNotation('2d6+3');
    expect(
      validateReportedRoll(parsed, {
        dice: [
          { type: 6, value: 4 },
          { type: 6, value: 5 },
        ],
        total: 12,
      })
    ).toBe(true);
  });

  it('rejects an impossible total — client tried to fake total=9999 with an honest d20=1', () => {
    const parsed = parseDiceNotation('1d20');
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 20, value: 1 }],
        total: 9999,
      })
    ).toBe(false);
  });

  it('rejects a dice bag that does not match the notation (2d6 notation, only 1d6 reported)', () => {
    const parsed = parseDiceNotation('2d6');
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 6, value: 5 }],
        total: 5,
      })
    ).toBe(false);
  });

  it('rejects dice of the wrong sides (2d6 notation, client reported 2d8)', () => {
    const parsed = parseDiceNotation('2d6');
    expect(
      validateReportedRoll(parsed, {
        dice: [
          { type: 8, value: 4 },
          { type: 8, value: 4 },
        ],
        total: 8,
      })
    ).toBe(false);
  });

  it('rejects a die value exceeding its face count', () => {
    const parsed = parseDiceNotation('1d6');
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 6, value: 20 }],
        total: 20,
      })
    ).toBe(false);
  });

  it('rejects zero / negative die values', () => {
    const parsed = parseDiceNotation('1d20');
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 20, value: 0 }],
        total: 0,
      })
    ).toBe(false);
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 20, value: -5 }],
        total: -5,
      })
    ).toBe(false);
  });

  it('rejects when parser returned null (unparseable notation)', () => {
    expect(
      validateReportedRoll(null, {
        dice: [{ type: 20, value: 15 }],
        total: 15,
      })
    ).toBe(false);
  });

  it('handles negative modifier — 1d20-2 rolled as 12 → total 10', () => {
    const parsed = parseDiceNotation('1d20-2');
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 20, value: 12 }],
        total: 10,
      })
    ).toBe(true);
  });

  it('handles mixed dice — 1d20+2d4 = 14 + (3+2) = 19', () => {
    const parsed = parseDiceNotation('1d20+2d4');
    expect(
      validateReportedRoll(parsed, {
        dice: [
          { type: 20, value: 14 },
          { type: 4, value: 3 },
          { type: 4, value: 2 },
        ],
        total: 19,
      })
    ).toBe(true);
  });

  it('rejects correct dice but a wrong total', () => {
    const parsed = parseDiceNotation('1d20+5');
    expect(
      validateReportedRoll(parsed, {
        dice: [{ type: 20, value: 10 }],
        total: 100, // should be 15
      })
    ).toBe(false);
  });
});

/**
 * ADV/DIS regression: the tray rolls 2d20 with an advantage flag and the
 * total must be built from the KEPT die — the pre-fix client summed both
 * d20s and the validator (sum semantics) happily accepted totals of 2–40.
 */
describe('validateReportedRoll — advantage/disadvantage', () => {
  const twoD20 = (a: number, b: number, total: number) => ({
    dice: [
      { type: 20, value: a },
      { type: 20, value: b },
    ],
    total,
  });

  it('accepts an advantage roll totalled from the higher die', () => {
    const parsed = parseDiceNotation('2d20');
    expect(validateReportedRoll(parsed, twoD20(14, 8, 14), 'advantage')).toBe(true);
  });

  it('REJECTS the old summed total under advantage (the 22-from-[14,8] bug)', () => {
    const parsed = parseDiceNotation('2d20');
    expect(validateReportedRoll(parsed, twoD20(14, 8, 22), 'advantage')).toBe(false);
  });

  it('accepts a disadvantage roll totalled from the lower die', () => {
    const parsed = parseDiceNotation('2d20');
    expect(validateReportedRoll(parsed, twoD20(14, 8, 8), 'disadvantage')).toBe(true);
  });

  it('rejects a disadvantage total that kept the higher die', () => {
    const parsed = parseDiceNotation('2d20');
    expect(validateReportedRoll(parsed, twoD20(14, 8, 14), 'disadvantage')).toBe(false);
  });

  it('carries the notation modifier into the kept total (2d20+3)', () => {
    const parsed = parseDiceNotation('2d20+3');
    expect(validateReportedRoll(parsed, twoD20(11, 17, 20), 'advantage')).toBe(true);
    expect(validateReportedRoll(parsed, twoD20(11, 17, 17), 'advantage')).toBe(false);
  });

  it('rejects an advantage report with the wrong dice shape', () => {
    const oneD20 = parseDiceNotation('1d20');
    expect(
      validateReportedRoll(
        oneD20,
        {
          dice: [{ type: 20, value: 14 }],
          total: 14,
        },
        'advantage'
      )
    ).toBe(false);
    const parsed = parseDiceNotation('2d20');
    expect(
      validateReportedRoll(
        parsed,
        {
          dice: [
            { type: 20, value: 14 },
            { type: 6, value: 3 },
          ],
          total: 14,
        },
        'advantage'
      )
    ).toBe(false);
  });

  it('treats equal dice as either kept die', () => {
    const parsed = parseDiceNotation('2d20');
    expect(validateReportedRoll(parsed, twoD20(12, 12, 12), 'advantage')).toBe(true);
    expect(validateReportedRoll(parsed, twoD20(12, 12, 12), 'disadvantage')).toBe(true);
  });

  it('leaves non-advantage validation unchanged (2d20 sum still fine without the flag)', () => {
    const parsed = parseDiceNotation('2d20');
    expect(validateReportedRoll(parsed, twoD20(14, 8, 22))).toBe(true);
  });
});
