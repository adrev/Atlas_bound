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

  it('spends a hit die on the server and broadcasts the authoritative HP update', async () => {
    seedPlayerRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            class: 'Fighter',
            hit_points: 5,
            max_hit_points: 20,
            ability_scores: { con: 14 },
            hit_dice: [{ dieSize: 10, total: 2, used: 0 }],
          }],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers, emissions: socketEmissions } = fakeSocket();
    registerCharacterEvents(io, socket);
    const originalRandom = Math.random;
    Math.random = () => 0.4; // d10 roll = 5
    try {
      await handlers.get('character:spend-hit-die')?.({ characterId: 'char-1', dieSize: 10 });
    } finally {
      Math.random = originalRandom;
    }

    const sqlLog = mockClientQuery.mock.calls.map((call) => call[0]);
    expect(sqlLog).toContain('BEGIN');
    expect(sqlLog).toContain('COMMIT');
    expect(sqlLog).not.toContain('ROLLBACK');
    expect(sqlLog.some((sql) => String(sql).includes('FOR UPDATE'))).toBe(true);
    const characterUpdate = emissions.find((e) => e.event === 'character:updated')?.payload as {
      characterId?: string;
      changes?: Record<string, unknown>;
    };
    expect(characterUpdate.characterId).toBe('char-1');
    expect(characterUpdate.changes?.hitPoints).toBe(12);
    expect(characterUpdate.changes?.hitDice).toEqual([{ dieSize: 10, total: 2, used: 1 }]);
    const spent = socketEmissions.find((e) => e.event === 'character:hit-die-spent')?.payload as {
      roll?: number;
      conMod?: number;
      heal?: number;
      newHp?: number;
    };
    expect(spent.roll).toBe(5);
    expect(spent.conMod).toBe(2);
    expect(spent.heal).toBe(7);
    expect(spent.newHp).toBe(12);
    const chat = emissions.find((e) => e.event === 'chat:new-message')?.payload as {
      type?: string;
      sessionId?: string;
      content?: string;
    };
    expect(chat.type).toBe('system');
    expect(chat.sessionId).toBe('session-rest-event');
    expect(chat.content).toContain('Rook spends 1d10 Hit Die');
  });

  it('adjusts spell slots on the server with a locked character row', async () => {
    seedPlayerRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            spell_slots: { '1': { max: 2, used: 0 } },
          }],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers, emissions: socketEmissions } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:spell-slot-adjust')?.({ characterId: 'char-1', level: 1, delta: 1 });

    const sqlLog = mockClientQuery.mock.calls.map((call) => call[0]);
    expect(sqlLog).toContain('BEGIN');
    expect(sqlLog).toContain('COMMIT');
    expect(sqlLog).not.toContain('ROLLBACK');
    expect(sqlLog.some((sql) => String(sql).includes('FOR UPDATE'))).toBe(true);
    const characterUpdate = emissions.find((e) => e.event === 'character:updated')?.payload as {
      characterId?: string;
      changes?: Record<string, unknown>;
    };
    expect(characterUpdate.characterId).toBe('char-1');
    expect(characterUpdate.changes?.spellSlots).toEqual({ '1': { max: 2, used: 1 } });
    const adjusted = socketEmissions.find((e) => e.event === 'character:spell-slot-adjusted')?.payload as {
      level?: number;
      oldUsed?: number;
      newUsed?: number;
      changes?: string[];
    };
    expect(adjusted.level).toBe(1);
    expect(adjusted.oldUsed).toBe(0);
    expect(adjusted.newUsed).toBe(1);
    expect(adjusted.changes?.join(' ')).toContain('spent');
  });

  it('does not broadcast a spell slot update when the slot is already spent', async () => {
    seedPlayerRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            spell_slots: { '1': { max: 1, used: 1 } },
          }],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers, emissions: socketEmissions } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:spell-slot-adjust')?.({ characterId: 'char-1', level: 1, delta: 1 });

    expect(emissions.some((e) => e.event === 'character:updated')).toBe(false);
    const sqlLog = mockClientQuery.mock.calls.map((call) => call[0]);
    expect(sqlLog.some((sql) => String(sql).startsWith('UPDATE characters'))).toBe(false);
    const adjusted = socketEmissions.find((e) => e.event === 'character:spell-slot-adjusted')?.payload as {
      updates?: Record<string, unknown>;
      changes?: string[];
    };
    expect(adjusted.updates).toEqual({});
    expect(adjusted.changes?.join(' ')).toContain('No level 1 spell slots remaining');
  });
});
