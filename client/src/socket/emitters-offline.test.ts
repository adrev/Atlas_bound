/**
 * Offline / lobby persistence for character mutations.
 *
 * The lobby renders the full hero sheet but never connects the socket
 * (`autoConnect: false`), and socket.io silently BUFFERS emits on a
 * disconnected socket — so sheet edits (spell prep, inventory, slot
 * pips) looked saved and then vanished. These tests pin the fallback:
 *
 *   • emitCharacterUpdate  → REST PUT /api/characters/:id when offline
 *   • emitSpellSlotAdjust  → pure counter math computed client-side,
 *                            applied locally, persisted via REST
 *   • emitSpendHitDie / emitCharacterRest → server-rolled actions are
 *                            refused offline with a toast (never faked)
 *   • REST failure         → danger toast instead of silent loss
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Character } from '@dnd-vtt/shared';

const { mockSocket, mockShowToast, mockTriggerSnapshot } = vi.hoisted(() => ({
  mockSocket: { connected: false, emit: vi.fn() },
  mockShowToast: vi.fn(),
  mockTriggerSnapshot: vi.fn(),
}));

vi.mock('./client', () => ({ getSocket: () => mockSocket }));
vi.mock('./stateSnapshot', () => ({ triggerSnapshot: mockTriggerSnapshot }));
vi.mock('../components/ui/Toast', () => ({ showToast: mockShowToast }));

import {
  emitCharacterUpdate,
  emitSpellSlotAdjust,
  emitSpendHitDie,
  emitCharacterRest,
} from './emitters';
import { useCharacterStore } from '../stores/useCharacterStore';

function fixtureCharacter(): Character {
  return {
    id: 'c1',
    userId: 'u1',
    name: 'Liraya',
    race: 'Tiefling',
    class: 'Bard',
    level: 3,
    hitPoints: 21,
    maxHitPoints: 21,
    armorClass: 14,
    speed: 30,
    proficiencyBonus: 2,
    abilityScores: { str: 8, dex: 14, con: 12, int: 10, wis: 10, cha: 16 },
    savingThrows: [],
    skills: {},
    spellSlots: { 1: { max: 4, used: 1 }, 2: { max: 2, used: 2 } },
    spells: [],
    features: [],
    inventory: [],
    conditions: [],
  } as unknown as Character;
}

/** Flush queued microtasks (the REST fallback is fire-and-forget). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  mockSocket.connected = false;
  mockSocket.emit.mockReset();
  mockShowToast.mockReset();
  mockTriggerSnapshot.mockReset();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  useCharacterStore.setState({ allCharacters: { c1: fixtureCharacter() } });
});

describe('emitCharacterUpdate offline', () => {
  it('persists via REST PUT instead of buffering into the dead socket', async () => {
    emitCharacterUpdate('c1', { spells: [{ name: 'Vicious Mockery', prepared: true }] });
    await flush();
    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/characters/c1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body).spells[0].name).toBe('Vicious Mockery');
  });

  it('still applies the change to the local store (optimistic UI unchanged)', () => {
    emitCharacterUpdate('c1', { hitPoints: 15 });
    expect(useCharacterStore.getState().allCharacters['c1'].hitPoints).toBe(15);
  });

  it('uses the socket (no REST) when connected', async () => {
    mockSocket.connected = true;
    emitCharacterUpdate('c1', { hitPoints: 15 });
    await flush();
    expect(mockSocket.emit).toHaveBeenCalledWith('character:update', {
      characterId: 'c1',
      changes: { hitPoints: 15 },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('surfaces a toast when the REST save fails', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500 });
    emitCharacterUpdate('c1', { hitPoints: 15 });
    await flush();
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast.mock.calls[0][0].variant).toBe('danger');
  });
});

describe('emitSpellSlotAdjust offline', () => {
  it('computes the new slot state locally and PUTs it', async () => {
    emitSpellSlotAdjust('c1', 1, 1);
    await flush();
    const stored = useCharacterStore.getState().allCharacters['c1'].spellSlots[1];
    expect(stored).toEqual({ max: 4, used: 2 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).spellSlots['1']).toEqual({ max: 4, used: 2 });
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('clamps at max and skips the no-op PUT', async () => {
    emitSpellSlotAdjust('c1', 2, 1); // already 2/2 used
    await flush();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useCharacterStore.getState().allCharacters['c1'].spellSlots[2]).toEqual({
      max: 2,
      used: 2,
    });
  });

  it('clamps at zero on refund', async () => {
    emitSpellSlotAdjust('c1', 1, -1);
    emitSpellSlotAdjust('c1', 1, -1); // would go below 0 — clamped, no second PUT
    await flush();
    expect(useCharacterStore.getState().allCharacters['c1'].spellSlots[1]).toEqual({
      max: 4,
      used: 0,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('emits over the socket when connected', () => {
    mockSocket.connected = true;
    emitSpellSlotAdjust('c1', 1, 1);
    expect(mockSocket.emit).toHaveBeenCalledWith('character:spell-slot-adjust', {
      characterId: 'c1',
      level: 1,
      delta: 1,
    });
  });
});

describe('server-rolled actions offline', () => {
  it('refuses to spend a Hit Die offline (server rolls the heal) with a toast', async () => {
    emitSpendHitDie('c1', 8);
    await flush();
    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  it('refuses a rest offline with a toast', async () => {
    emitCharacterRest('c1', 'long');
    await flush();
    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
});
