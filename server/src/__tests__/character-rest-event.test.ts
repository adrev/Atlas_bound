import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';

const { mockQuery, mockClientQuery, mockConnect, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockRelease: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({
  default: {
    query: mockQuery,
    connect: mockConnect,
  },
}));

import { registerCharacterEvents } from '../socket/characterEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomPlayer } from '../utils/roomState.js';

interface Emission {
  event: string;
  payload: unknown;
  channelId: string;
}

function fakeIo(): { io: Server; emissions: Emission[] } {
  const emissions: Emission[] = [];
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ event, payload, channelId }),
    }),
  } as unknown as Server;
  return { io, emissions };
}

function fakeSocket(socketId = 'sock-player') {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const emissions: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    id: socketId,
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(event, handler);
      return socket;
    },
    emit: (event: string, payload: unknown) => {
      emissions.push({ event, payload });
      return true;
    },
  } as unknown as Socket;
  return { socket, handlers, emissions };
}

function seedPlayerRoom(): RoomPlayer {
  const room = createRoom('session-rest-event', 'RESTEVT', 'dm-user');
  const player: RoomPlayer = {
    userId: 'player-1',
    displayName: 'Player',
    socketId: 'sock-player',
    role: 'player',
    characterId: 'char-1',
  };
  room.players.set(player.userId, player);
  addPlayerToRoom(room.sessionId, player);
  return player;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockConnect.mockReset();
  mockRelease.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('character:rest socket event', () => {
  it('applies a server-owned rest for the owning player character', async () => {
    seedPlayerRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            class: 'Fighter',
            hit_points: 4,
            max_hit_points: 20,
            temp_hit_points: 0,
            spell_slots: {},
            features: [],
            hit_dice: [],
            death_saves: { successes: 0, failures: 0 },
            concentrating_on: null,
            exhaustion_level: 0,
          }],
        };
      }
      if (sql.includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers, emissions: socketEmissions } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:rest')?.({ characterId: 'char-1', kind: 'long' });

    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('BEGIN');
    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('COMMIT');
    expect(mockClientQuery.mock.calls.map((call) => call[0])).not.toContain('ROLLBACK');
    const characterUpdate = emissions.find((e) => e.event === 'character:updated')?.payload as {
      characterId?: string;
      changes?: Record<string, unknown>;
    };
    expect(characterUpdate.characterId).toBe('char-1');
    expect(characterUpdate.changes?.hitPoints).toBe(20);
    const rested = socketEmissions.find((e) => e.event === 'character:rested')?.payload as {
      changes?: string[];
    };
    expect(rested.changes?.join(' ')).toContain('HP restored');
  });

  it('rejects rest requests for characters outside the current session', async () => {
    seedPlayerRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            hit_points: 4,
            max_hit_points: 20,
          }],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers, emissions: socketEmissions } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:rest')?.({ characterId: 'char-1', kind: 'long' });

    expect(mockConnect).not.toHaveBeenCalled();
    expect(emissions.some((e) => e.event === 'character:updated')).toBe(false);
    expect(socketEmissions.some((e) => e.event === 'character:rested')).toBe(false);
  });

  it('keeps already-rested feedback local instead of broadcasting to the room', async () => {
    seedPlayerRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            class: 'Fighter',
            hit_points: 20,
            max_hit_points: 20,
            temp_hit_points: 0,
            spell_slots: {},
            features: [],
            hit_dice: [],
            death_saves: { successes: 0, failures: 0 },
            concentrating_on: null,
            exhaustion_level: 0,
          }],
        };
      }
      if (sql.includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers, emissions: socketEmissions } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:rest')?.({ characterId: 'char-1', kind: 'long' });

    expect(emissions.some((e) => e.event === 'character:updated')).toBe(false);
    expect(emissions.some((e) => e.event === 'chat:new-message')).toBe(false);
    const rested = socketEmissions.find((e) => e.event === 'character:rested')?.payload as {
      changes?: string[];
    };
    expect(rested.changes).toEqual(['Already fully rested']);
  });
});
