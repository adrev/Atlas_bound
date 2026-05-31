import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '@dnd-vtt/shared';

const emitRest = vi.fn();

vi.mock('../socket/emitters', () => ({
  emitCharacterRest: (...args: unknown[]) => emitRest(...args),
}));

import { performLongRest, performShortRest } from './rest';

function baseChar(overrides: Partial<Character> = {}): Character {
  return {
    id: 'c1',
    name: 'Tester',
    hitPoints: 10,
    maxHitPoints: 20,
    class: 'Fighter',
    ...overrides,
  } as Character;
}

beforeEach(() => {
  emitRest.mockClear();
});

describe('rest request helpers', () => {
  it('requests a server-owned long rest', () => {
    performLongRest(baseChar({ id: 'char-long' }));

    expect(emitRest).toHaveBeenCalledWith('char-long', 'long');
  });

  it('requests a server-owned short rest', () => {
    performShortRest(baseChar({ id: 'char-short' }));

    expect(emitRest).toHaveBeenCalledWith('char-short', 'short');
  });
});
