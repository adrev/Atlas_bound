import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Character } from '@dnd-vtt/shared';

// Mock all the side-effect dependencies so the tests exercise just
// the update-building logic in performLongRest / performShortRest.
const emitUpdate = vi.fn();
const emitSystem = vi.fn();
const applyRemote = vi.fn();
const toast = vi.fn();

vi.mock('../socket/emitters', () => ({
  emitCharacterUpdate: (...args: unknown[]) => emitUpdate(...args),
  emitSystemMessage: (...args: unknown[]) => emitSystem(...args),
}));
vi.mock('../stores/useCharacterStore', () => ({
  useCharacterStore: {
    getState: () => ({ applyRemoteUpdate: (...a: unknown[]) => applyRemote(...a) }),
  },
}));
vi.mock('../components/ui', () => ({
  showToast: (...args: unknown[]) => toast(...args),
}));
vi.mock('../styles/emoji', () => ({
  EMOJI: { rest: { long: '💤', short: '💤' } },
}));

import { performLongRest, performShortRest } from './rest';

// DB rows arrive with features/hitDice/spellSlots as JSON strings; the
// rest helpers parse them defensively. We simulate that by writing
// strings here and reaching past the Character type with `as unknown`.
type RawCharacter = Omit<Character, 'features' | 'hitDice' | 'spellSlots' | 'tempHitPoints' | 'concentratingOn'> & {
  hitDice?: unknown;
  features?: unknown;
  spellSlots?: unknown;
  tempHitPoints?: number;
  concentratingOn?: string | null;
};

function baseChar(overrides: Partial<RawCharacter> = {}): Character {
  return {
    id: 'c1',
    name: 'Tester',
    hitPoints: 10,
    maxHitPoints: 20,
    tempHitPoints: 0,
    class: 'Fighter',
    features: JSON.stringify([]),
    spellSlots: JSON.stringify({}),
    hitDice: JSON.stringify([]),
    ...overrides,
  } as unknown as Character;
}

beforeEach(() => {
  emitUpdate.mockClear();
  emitSystem.mockClear();
  applyRemote.mockClear();
  toast.mockClear();
});

// -------------------------------------------------------------------------
// performLongRest
// -------------------------------------------------------------------------

describe('performLongRest', () => {
  it('restores HP to max when damaged', () => {
    performLongRest(baseChar({ hitPoints: 4, maxHitPoints: 30 }));
    const [, updates] = emitUpdate.mock.calls[0];
    expect(updates).toMatchObject({ hitPoints: 30 });
    expect(emitSystem).toHaveBeenCalledTimes(1);
    const msg = emitSystem.mock.calls[0][0] as string;
    expect(msg).toContain('takes a Long Rest');
    expect(msg).toContain('HP restored');
  });

  it('clears temp HP if any', () => {
    performLongRest(baseChar({ tempHitPoints: 7, hitPoints: 20, maxHitPoints: 20 }));
    const [, updates] = emitUpdate.mock.calls[0];
    expect(updates.tempHitPoints).toBe(0);
  });

  it('restores all spell slots by zeroing `used`', () => {
    performLongRest(baseChar({
      hitPoints: 20, maxHitPoints: 20,
      spellSlots: JSON.stringify({ '1': { max: 4, used: 3 }, '2': { max: 2, used: 1 } }),
    }));
    const [, updates] = emitUpdate.mock.calls[0];
    expect(updates.spellSlots).toEqual({
      '1': { max: 4, used: 0 },
      '2': { max: 2, used: 0 },
    });
  });

  it('recovers half (rounded up) of spent Hit Dice', () => {
    performLongRest(baseChar({
      hitPoints: 20, maxHitPoints: 20,
      hitDice: JSON.stringify([{ dieSize: 10, total: 5, used: 5 }]),
    }));
    const [, updates] = emitUpdate.mock.calls[0];
    // 5 total → recover ceil(5/2)=3 → new used = 5-3 = 2
    expect(updates.hitDice).toEqual([{ dieSize: 10, total: 5, used: 2 }]);
  });

  it('always clears death saves', () => {
    performLongRest(baseChar({ hitPoints: 20, maxHitPoints: 20 }));
    const [, updates] = emitUpdate.mock.calls[0];
    expect(updates.deathSaves).toEqual({ successes: 0, failures: 0 });
  });

  it('drops concentration with a message', () => {
    performLongRest(baseChar({
      hitPoints: 20, maxHitPoints: 20,
      concentratingOn: 'Bless',
    }));
    const [, updates] = emitUpdate.mock.calls[0];
    expect(updates.concentratingOn).toBe(null);
    expect(emitSystem.mock.calls[0][0]).toContain('Concentration on Bless dropped');
  });

  it('posts "Already fully rested" when nothing changed', () => {
    performLongRest(baseChar({ hitPoints: 20, maxHitPoints: 20 }));
    // Still emits because death saves are unconditionally reset, but
    // the chat line should note already-rested.
    const msg = emitSystem.mock.calls[0][0] as string;
    expect(msg).toContain('Already fully rested');
  });
});

// -------------------------------------------------------------------------
// performShortRest
// -------------------------------------------------------------------------

describe('performShortRest', () => {
  it('restores only short-rest features (not long-rest ones)', () => {
    performShortRest(baseChar({
      features: JSON.stringify([
        { name: 'Second Wind',     usesTotal: 1, usesRemaining: 0, resetOn: 'short' },
        { name: 'Action Surge',    usesTotal: 1, usesRemaining: 0, resetOn: 'short' },
        { name: 'Divine Smite',    usesTotal: 4, usesRemaining: 0, resetOn: 'long' },
      ]),
    }));
    const [, updates] = emitUpdate.mock.calls[0];
    const features = updates.features as Array<{ name: string; usesRemaining: number }>;
    const byName = Object.fromEntries(features.map((f) => [f.name, f.usesRemaining]));
    expect(byName['Second Wind']).toBe(1);
    expect(byName['Action Surge']).toBe(1);
    expect(byName['Divine Smite']).toBe(0); // long-rest stays depleted
  });

  it('restores Warlock spell slots on a short rest', () => {
    performShortRest(baseChar({
      class: 'Warlock',
      spellSlots: JSON.stringify({ '3': { max: 2, used: 2 } }),
    }));
    const [, updates] = emitUpdate.mock.calls[0];
    expect(updates.spellSlots).toEqual({ '3': { max: 2, used: 0 } });
  });

  it('does NOT restore spell slots for non-Warlocks', () => {
    performShortRest(baseChar({
      class: 'Wizard',
      spellSlots: JSON.stringify({ '1': { max: 4, used: 3 } }),
    }));
    // When nothing to update, emitCharacterUpdate may still be called
    // — but spellSlots should not be in the updates.
    if (emitUpdate.mock.calls.length > 0) {
      const [, updates] = emitUpdate.mock.calls[0];
      expect(updates.spellSlots).toBeUndefined();
    }
  });

  it('short rest chat message matches the sheet-dialog contract', () => {
    // This is the contract that guarantees both the QuickActions
    // Short Rest and the sheet's Finish Short Rest button produce
    // the identical chat line. If this ever changes, the other path
    // MUST change with it.
    performShortRest(baseChar({ name: 'Vex' }));
    const msg = emitSystem.mock.calls[0][0] as string;
    expect(msg.startsWith('💤 Vex finishes a Short Rest')).toBe(true);
  });
});
