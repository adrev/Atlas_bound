import { describe, it, expect } from 'vitest';
import {
  roll, rollAdvantage, rollInitiative, rollDeathSave,
} from '../services/DiceService.js';

// These are smoke tests that pin the public shape of DiceService
// against regression. Actual randomness correctness lives in the
// shared rollDice / rollWithAdvantage implementations. What we care
// about here is that DiceService wraps them into the DiceRollData
// shape the socket broadcast expects.

describe('roll', () => {
  it('returns the DiceRollData contract for a simple roll', () => {
    const r = roll('1d20');
    expect(r.notation).toBe('1d20');
    expect(Array.isArray(r.dice)).toBe(true);
    expect(r.dice).toHaveLength(1);
    expect(r.dice[0].type).toBe(20);
    expect(r.dice[0].value).toBeGreaterThanOrEqual(1);
    expect(r.dice[0].value).toBeLessThanOrEqual(20);
    expect(r.total).toBe(r.dice[0].value + r.modifier);
    expect(r.advantage).toBe('normal');
  });

  it('parses modifier correctly', () => {
    const r = roll('2d6+3');
    expect(r.dice).toHaveLength(2);
    const sum = r.dice.reduce((s, d) => s + d.value, 0);
    expect(r.total).toBe(sum + 3);
    expect(r.modifier).toBe(3);
  });

  it('carries the reason through', () => {
    const r = roll('1d20', 'Perception');
    expect(r.reason).toBe('Perception');
  });
});

describe('rollAdvantage', () => {
  it('takes the higher of two d20 on advantage', () => {
    const r = rollAdvantage(5, 'advantage');
    expect(r.advantage).toBe('advantage');
    expect(r.dice).toHaveLength(2);
    const chosen = Math.max(r.dice[0].value, r.dice[1].value);
    expect(r.total).toBe(chosen + 5);
  });

  it('takes the lower of two d20 on disadvantage', () => {
    const r = rollAdvantage(2, 'disadvantage');
    expect(r.advantage).toBe('disadvantage');
    expect(r.dice).toHaveLength(2);
    const chosen = Math.min(r.dice[0].value, r.dice[1].value);
    expect(r.total).toBe(chosen + 2);
  });
});

describe('rollInitiative', () => {
  it('returns a d20 + bonus', () => {
    const r = rollInitiative(3);
    expect(r.roll).toBeGreaterThanOrEqual(1);
    expect(r.roll).toBeLessThanOrEqual(20);
    expect(r.total).toBe(r.roll + 3);
  });

  it('handles negative bonuses', () => {
    const r = rollInitiative(-2);
    expect(r.total).toBe(r.roll - 2);
  });
});

describe('rollDeathSave', () => {
  it('a natural 20 auto-succeeds with crit', () => {
    // Run many times to hit both success and failure bands — we're
    // just checking that when roll is 20 we flag crit success.
    let found20 = false;
    for (let i = 0; i < 200; i++) {
      const r = rollDeathSave();
      if (r.roll === 20) {
        expect(r.isCritSuccess).toBe(true);
        expect(r.isSuccess).toBe(true);
        expect(r.isCritFail).toBe(false);
        found20 = true;
        break;
      }
    }
    // Statistical sanity — 200 rolls should hit 20 at least once
    // with overwhelming probability (99.99%).
    expect(found20).toBe(true);
  });

  it('a natural 1 is a crit fail', () => {
    let found1 = false;
    for (let i = 0; i < 200; i++) {
      const r = rollDeathSave();
      if (r.roll === 1) {
        expect(r.isCritFail).toBe(true);
        expect(r.isSuccess).toBe(false);
        expect(r.isCritSuccess).toBe(false);
        found1 = true;
        break;
      }
    }
    expect(found1).toBe(true);
  });

  it('10+ is a success, below 10 is a failure', () => {
    for (let i = 0; i < 50; i++) {
      const r = rollDeathSave();
      if (r.roll >= 10) expect(r.isSuccess).toBe(true);
      else expect(r.isSuccess).toBe(false);
    }
  });
});
