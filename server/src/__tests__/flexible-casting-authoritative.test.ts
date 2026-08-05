import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
  type RoomState,
} from '../utils/roomState.js';
import '../services/chatCommands/sorcererHandler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 's-flexible-authoritative';

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function token(): Token {
  return {
    id: 'sorc-token',
    mapId: 'map-1',
    characterId: 'char-sorc',
    name: 'Ember',
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#ffffff',
    conditions: [],
    ownerUserId: 'owner-user',
    createdAt: new Date().toISOString(),
  };
}

function seedRoom(remainingSp = 2): RoomState {
  const room = createRoom(SESSION, 'ROOM-FLEX', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('sorc-token', token());
  room.pointPools.set(
    'char-sorc',
    new Map([['sp', { max: 5, remaining: remainingSp }]])
  );
  addPlayerToRoom(SESSION, {
    userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user', displayName: 'Ember', socketId: 'owner-sock', role: 'player', characterId: 'char-sorc',
  });
  addPlayerToRoom(SESSION, {
    userId: 'other-user', displayName: 'Rook', socketId: 'other-sock', role: 'player', characterId: null,
  });
  return room;
}

function mockCharacter(
  slots: Record<string, { max: number; used: number }>,
  version: unknown,
  updateResult: Array<Record<string, unknown>> | Error = [{ version: 8 }]
): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT class')) {
      return { rows: [{ class: 'Sorcerer', level: 5, name: 'Ember' }] };
    }
    if (sql.startsWith('SELECT spell_slots')) {
      return { rows: [{ spell_slots: slots, version }] };
    }
    if (sql.startsWith('UPDATE characters')) {
      if (updateResult instanceof Error) throw updateResult;
      return { rows: updateResult };
    }
    return { rows: [] };
  });
}

function updateCalls(): Array<[string, unknown[]]> {
  return mockQuery.mock.calls
    .filter(([sql]) => String(sql).startsWith('UPDATE characters'))
    .map((call) => [String(call[0]), call[1] as unknown[]]);
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((emission) => emission.event === event)
    .map((emission) => emission.channelId)
    .sort();
}

function characterChanges(emissions: Emission[]): Record<string, unknown> | undefined {
  return (emissions.find((emission) => emission.event === 'character:updated')?.payload as
    | { changes?: Record<string, unknown> }
    | undefined)?.changes;
}

function spRemaining(room: RoomState): number {
  return room.pointPools.get('char-sorc')!.get('sp')!.remaining;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Flexible Casting authoritative resource changes', () => {
  it('commits slot-to-SP before mutating SP and forwards the returned version', async () => {
    const room = seedRoom(2);
    mockCharacter({ 1: { max: 3, used: 0 } }, 7, [{ version: 8 }]);
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!flexible slot2sp 1'
    );

    expect(updateCalls()).toEqual([[
      'UPDATE characters SET spell_slots = $1 WHERE id = $2 AND version = $3 RETURNING version',
      [JSON.stringify({ 1: { max: 3, used: 1 } }), 'char-sorc', 7],
    ]]);
    expect(spRemaining(room)).toBe(3);
    expect(characterChanges(emissions)).toEqual({
      spellSlots: { 1: { max: 3, used: 1 } },
      version: 8,
    });
    expect(channelsFor(emissions, 'character:updated')).toEqual(['dm-sock', 'owner-sock']);
  });

  it('commits SP-to-slot before charging SP', async () => {
    const room = seedRoom(5);
    mockCharacter({ 1: { max: 3, used: 2 } }, 10, [{ version: 11 }]);
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!flexible sp2slot 1'
    );

    expect(spRemaining(room)).toBe(3);
    expect(characterChanges(emissions)).toEqual({
      spellSlots: { 1: { max: 3, used: 1 } },
      version: 11,
    });
  });

  it('keeps both resources unchanged and suppresses success when the write throws', async () => {
    const room = seedRoom(2);
    mockCharacter({ 1: { max: 3, used: 0 } }, 7, new Error('db unavailable'));
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!flexible slot2sp 1'
    );

    expect(spRemaining(room)).toBe(2);
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(emissions.some((emission) => emission.channelId === SESSION)).toBe(false);
    expect(
      emissions.some((emission) =>
        String((emission.payload as { content?: string }).content).includes('could not save')
      )
    ).toBe(true);
  });

  it('keeps both resources unchanged on an optimistic version conflict', async () => {
    const room = seedRoom(5);
    mockCharacter({ 1: { max: 3, used: 2 } }, 7, []);
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!flexible sp2slot 1'
    );

    expect(spRemaining(room)).toBe(5);
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(emissions.some((emission) => emission.channelId === SESSION)).toBe(false);
  });

  it('does not burn a slot when Sorcery Points are already full', async () => {
    const room = seedRoom(5);
    mockCharacter({ 1: { max: 3, used: 0 } }, 7);
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!flexible slot2sp 1'
    );

    expect(spRemaining(room)).toBe(5);
    expect(updateCalls()).toEqual([]);
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
  });

  it('rejects partial level strings before reading or writing the character', async () => {
    seedRoom();
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!flexible slot2sp 1junk'
    );

    expect(mockQuery).not.toHaveBeenCalled();
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
  });
});

describe('Sorcery Point input validation', () => {
  it('rejects negative !sp use amounts instead of increasing the pool', async () => {
    const room = seedRoom(2);
    mockCharacter({}, 7);
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!sp use -5'
    );

    expect(spRemaining(room)).toBe(2);
    expect(emissions.some((emission) => emission.channelId === SESSION)).toBe(false);
  });

  it('rejects partial !sp use amounts instead of silently truncating them', async () => {
    const room = seedRoom(2);
    mockCharacter({}, 7);
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions), getPlayerBySocketId('owner-sock')!, '!sp use 1junk'
    );

    expect(spRemaining(room)).toBe(2);
    expect(emissions.some((emission) => emission.channelId === SESSION)).toBe(false);
  });
});
