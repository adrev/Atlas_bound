import { describe, it, expect } from 'vitest';

/**
 * Unit test for the client-reported dice sanity check in chatEvents.ts.
 *
 * We can't cheaply boot the full socket pipeline inside vitest, so this
 * mirrors the guard here. If the real check in `chat:roll` is changed,
 * keep this in lockstep.
 */
function validateReported(dice: Array<{ type: number; value: number }>): boolean {
  return dice.every((d) => d.type >= 2 && d.value >= 1 && d.value <= d.type);
}

describe('chat:roll reported-dice sanity check', () => {
  it('accepts an honest d20 roll', () => {
    expect(validateReported([{ type: 20, value: 15 }])).toBe(true);
  });

  it('rejects a value that exceeds the die face count', () => {
    // Client claimed a d6 landed on 20 — impossible.
    expect(validateReported([{ type: 6, value: 20 }])).toBe(false);
  });

  it('rejects a zero / negative value', () => {
    expect(validateReported([{ type: 20, value: 0 }])).toBe(false);
    expect(validateReported([{ type: 20, value: -1 }])).toBe(false);
  });

  it('rejects a nonsense die type < 2', () => {
    // A 1-sided die is a bug, not a legitimate roll.
    expect(validateReported([{ type: 1, value: 1 }])).toBe(false);
  });

  it('accepts multi-die rolls where every value fits', () => {
    expect(validateReported([
      { type: 20, value: 1 },
      { type: 20, value: 20 },
      { type: 6, value: 3 },
    ])).toBe(true);
  });

  it('rejects the whole batch if any single die is impossible', () => {
    expect(validateReported([
      { type: 20, value: 15 },
      { type: 6, value: 9 }, // oops
    ])).toBe(false);
  });
});
