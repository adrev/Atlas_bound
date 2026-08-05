import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import { registerTokenEvents } from '../socket/tokenEvents.js';
import { addPlayerToRoom, createRoom, deleteRoom, getAllRooms } from '../utils/roomState.js';

type Handler = (data: unknown) => Promise<void> | void;

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION_ID = 'session-token-persistence';

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    version: 1,
    mapId: 'map-1',
    characterId: null,
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    conditions: [],
    ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function seedRoom(tokens: Token[] = []) {
  const room = createRoom(SESSION_ID, 'TOKEN', 'dm-user');
  room.playerMapId = 'map-1';
  room.currentMapId = 'map-1';
  room.mapGridSizes.set('map-1', 70);
  for (const current of tokens) room.tokens.set(current.id, current);
  addPlayerToRoom(SESSION_ID, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-socket',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION_ID, {
    userId: 'player-user',
    displayName: 'Player',
    socketId: 'player-socket',
    role: 'player',
    characterId: 'character-player',
  });
  return room;
}

function harness(actorSocketId: string) {
  const handlers: Record<string, Handler> = {};
  const emissions: Emission[] = [];
  const socket = {
    id: actorSocketId,
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    emit: (event: string, payload: unknown) =>
      emissions.push({ channelId: actorSocketId, event, payload }),
  };
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  };
  registerTokenEvents(io as never, socket as never);
  return { handlers, emissions };
}

const addPayload = {
  mapId: 'map-1',
  name: 'Arcane Marker',
  x: 140,
  y: 210,
  size: 1,
  color: '#000000',
  layer: 'token' as const,
  visible: true,
  hasLight: false,
  lightRadius: 0,
  lightDimRadius: 0,
  lightColor: '#ffffff',
  conditions: [],
};

beforeEach(() => {
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  mockQuery.mockReset();
});

describe('token lifecycle persistence ordering', () => {
  it('does not create or broadcast a ghost token when the insert fails', async () => {
    const room = seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT name FROM tokens/.test(sql)) return { rows: [] };
      if (/INSERT INTO tokens/.test(sql)) throw new Error('insert failed');
      return { rows: [] };
    });
    const { handlers, emissions } = harness('dm-socket');

    await handlers['map:token-add']!(addPayload);

    expect(room.tokens.size).toBe(0);
    expect(emissions.some((emission) => emission.event === 'map:token-added')).toBe(false);
    expect(emissions.some((emission) => emission.event === 'session:error')).toBe(true);
  });

  it('keeps room and combat caches intact when the authoritative delete fails', async () => {
    const marker = token('marker', { ownerUserId: 'player-user' });
    const room = seedRoom([marker]);
    room.actionEconomies.set('marker', {
      action: false,
      bonusAction: false,
      movementRemaining: 30,
      movementMax: 30,
      reaction: false,
    });
    mockQuery.mockRejectedValue(new Error('delete failed'));
    const { handlers, emissions } = harness('dm-socket');

    await handlers['map:token-remove']!({ tokenId: 'marker' });

    expect(room.tokens.get('marker')).toBe(marker);
    expect(room.actionEconomies.has('marker')).toBe(true);
    expect(emissions.some((emission) => emission.event === 'map:token-removed')).toBe(false);
    expect(emissions.some((emission) => emission.event === 'map:token-updated')).toBe(false);
  });

  it('prevents players from deleting their character-backed PC token', async () => {
    const pc = token('pc-token', {
      characterId: 'character-player',
      ownerUserId: 'player-user',
    });
    const room = seedRoom([pc]);
    mockQuery.mockResolvedValue({ rows: [] });
    const { handlers, emissions } = harness('player-socket');

    await handlers['map:token-remove']!({ tokenId: 'pc-token' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/DELETE FROM tokens AS t/);
    expect(String(sql)).toMatch(/t\.character_id IS NULL/);
    expect(params).toEqual(['pc-token', SESSION_ID, false, 'player-user']);
    expect(room.tokens.has('pc-token')).toBe(true);
    expect(emissions.some((emission) => emission.event === 'map:token-removed')).toBe(false);
  });

  it('deletes an owned utility marker before cleaning room state and broadcasting', async () => {
    const marker = token('marker', { ownerUserId: 'player-user' });
    const room = seedRoom([marker]);
    mockQuery.mockResolvedValue({
      rows: [{ map_id: 'map-1', owner_user_id: 'player-user' }],
    });
    const { handlers, emissions } = harness('player-socket');

    await handlers['map:token-remove']!({ tokenId: 'marker' });

    expect(room.tokens.has('marker')).toBe(false);
    const removed = emissions.filter((emission) => emission.event === 'map:token-removed');
    expect(removed.map((emission) => emission.channelId).sort()).toEqual([
      'dm-socket',
      'player-socket',
    ]);
    expect(removed[0]?.payload).toMatchObject({ tokenId: 'marker', mapId: 'map-1' });
  });
});
