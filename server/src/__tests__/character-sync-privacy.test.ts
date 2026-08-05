import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerCharacterEvents } from '../socket/characterEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

type Handler = (data: unknown) => Promise<void> | void;

function seedRoom() {
  const room = createRoom('character-sync-private', 'CHARSYNC', 'dm');
  for (const player of [
    { userId: 'dm', socketId: 'dm-1', role: 'dm' as const, characterId: null },
    { userId: 'owner', socketId: 'owner-1', role: 'player' as const, characterId: 'char-1' },
    { userId: 'owner', socketId: 'owner-2', role: 'player' as const, characterId: 'char-1' },
    { userId: 'other', socketId: 'other-1', role: 'player' as const, characterId: 'char-2' },
  ]) {
    addPlayerToRoom(room.sessionId, { ...player, displayName: player.userId });
  }
  return room;
}

function registerFor(socketId: string, emissions: Emission[]) {
  const handlers = new Map<string, Handler>();
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  };
  const socket = {
    id: socketId,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: (event: string, payload: unknown) =>
      emissions.push({ channelId: socketId, event, payload }),
  };
  registerCharacterEvents(io as never, socket as never);
  return handlers;
}

beforeEach(() => {
  mockQuery.mockReset();
});

afterEach(() => {
  getAllRooms().clear();
});

describe('character:sync-request privacy', () => {
  it('sends a private sheet only to the owner tabs and DM when party sharing is off', async () => {
    seedRoom();
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ owner_user_id: 'owner', settings: '{"showPlayersToPlayers":false}' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'char-1', user_id: 'owner', name: 'Private Hero', notes_data: '{}' }],
      });
    const emissions: Emission[] = [];
    const handlers = registerFor('owner-1', emissions);

    await handlers.get('character:sync-request')!({ characterId: 'char-1' });

    expect(
      emissions
        .filter((entry) => entry.event === 'character:synced')
        .map((entry) => entry.channelId)
    ).toEqual(['dm-1', 'owner-1', 'owner-2']);
    expect(emissions.some((entry) => entry.channelId === 'other-1')).toBe(false);
    expect(emissions.some((entry) => entry.channelId === 'character-sync-private')).toBe(false);
  });

  it('refuses another player before loading the private character row', async () => {
    seedRoom();
    mockQuery.mockResolvedValueOnce({
      rows: [{ owner_user_id: 'owner', settings: '{"showPlayersToPlayers":false}' }],
    });
    const emissions: Emission[] = [];
    const handlers = registerFor('other-1', emissions);

    await handlers.get('character:sync-request')!({ characterId: 'char-1' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(emissions).toHaveLength(0);
  });
});

describe('character:updated privacy', () => {
  it('keeps private sheet-field updates on the owner and DM sockets', async () => {
    seedRoom();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'char-1', user_id: 'owner', version: 4 }] })
      .mockResolvedValueOnce({ rows: [{ version: 5 }] });
    const emissions: Emission[] = [];
    const handlers = registerFor('owner-1', emissions);

    await handlers.get('character:update')!({
      characterId: 'char-1',
      expectedVersion: 4,
      changes: { notes: { backstory: 'A private secret' } },
    });

    expect(
      emissions
        .filter((entry) => entry.event === 'character:updated')
        .map((entry) => entry.channelId)
    ).toEqual(['dm-1', 'owner-1', 'owner-2']);
    expect(emissions.some((entry) => entry.channelId === 'other-1')).toBe(false);
    expect(emissions.some((entry) => entry.channelId === 'character-sync-private')).toBe(false);
  });
});
