import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerCharacterEvents } from '../socket/characterEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';
import type { Token } from '@dnd-vtt/shared';

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

function npcToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 'npc-token',
    mapId: 'map-1',
    characterId: 'npc-char',
    name: 'Goblin',
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
    ownerUserId: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  } as Token;
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

  it('keeps NPC sheet updates DM-only when creature sharing is disabled', async () => {
    const room = seedRoom();
    room.showCreatureStatsToPlayers = false;
    room.tokens.set('npc-token', npcToken({ name: 'Secret Goblin' }));
    room.playerMapId = 'map-1';
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'npc-char', user_id: 'npc', version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [{ version: 3 }] });
    const emissions: Emission[] = [];
    const handlers = registerFor('dm-1', emissions);

    await handlers.get('character:update')!({
      characterId: 'npc-char',
      expectedVersion: 2,
      changes: { notes: { tactics: 'Ambush from the east' } },
    });

    expect(
      emissions
        .filter((entry) => entry.event === 'character:updated')
        .map((entry) => entry.channelId)
    ).toEqual(['dm-1']);
  });

  it('shares a visible NPC sheet only when creature sharing is enabled', async () => {
    const room = seedRoom();
    room.showCreatureStatsToPlayers = true;
    room.playerMapId = 'map-1';
    room.tokens.set('npc-token', npcToken({ name: 'Known Goblin' }));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'npc-char', user_id: 'npc', version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [{ version: 3 }] });
    const emissions: Emission[] = [];
    const handlers = registerFor('dm-1', emissions);

    await handlers.get('character:update')!({
      characterId: 'npc-char',
      expectedVersion: 2,
      changes: { hitPoints: 4 },
    });

    expect(
      emissions
        .filter((entry) => entry.event === 'character:updated')
        .map((entry) => entry.channelId)
        .sort()
    ).toEqual(['dm-1', 'other-1', 'owner-1', 'owner-2']);
  });

  it('rejects a player HP update for an NPC hidden from the player ribbon', async () => {
    const room = seedRoom();
    room.playerMapId = 'map-1';
    room.tokens.set('npc-token', npcToken({ visible: false }));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'npc-char', user_id: 'npc', version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    const emissions: Emission[] = [];
    const handlers = registerFor('owner-1', emissions);

    await handlers.get('character:update')!({
      characterId: 'npc-char',
      expectedVersion: 2,
      changes: { hitPoints: 0 },
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(emissions).toHaveLength(0);
  });

  it('allows a player HP update for a visible NPC on the current ribbon', async () => {
    const room = seedRoom();
    room.playerMapId = 'map-1';
    room.showCreatureStatsToPlayers = false;
    room.tokens.set('npc-token', npcToken());
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'npc-char', user_id: 'npc', version: 2 }] })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [{ version: 3 }] });
    const emissions: Emission[] = [];
    const handlers = registerFor('owner-1', emissions);

    await handlers.get('character:update')!({
      characterId: 'npc-char',
      expectedVersion: 2,
      changes: { hitPoints: 4 },
    });

    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(
      emissions
        .filter((entry) => entry.event === 'character:updated')
        .map((entry) => entry.channelId)
    ).toEqual(['dm-1']);
  });
});
