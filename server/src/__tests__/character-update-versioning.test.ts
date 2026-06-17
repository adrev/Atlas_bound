import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerCharacterEvents } from '../socket/characterEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function fakeIo(): { io: Server; emissions: Emission[] } {
  const emissions: Emission[] = [];
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as unknown as Server;
  return { io, emissions };
}

function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const socket = {
    id: 'sock-player',
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(event, handler);
      return socket;
    },
  } as unknown as Socket;
  return { socket, handlers };
}

function seedRoom(): void {
  const room = createRoom('session-character-version', 'CHARVER', 'dm-user');
  addPlayerToRoom(room.sessionId, {
    userId: 'player-1',
    displayName: 'Player',
    socketId: 'sock-player',
    role: 'player',
    characterId: 'char-1',
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('character:update version conflict handling', () => {
  it('rejects stale character writes and returns the latest character to the sender', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, user_id, version FROM characters')) {
        return { rows: [{ id: 'char-1', user_id: 'player-1', version: 3 }] };
      }
      if (sql.trim().startsWith('UPDATE characters SET')) return { rows: [] };
      if (sql.includes('SELECT * FROM characters WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'char-1',
              user_id: 'player-1',
              version: 4,
              name: 'Rook',
              hit_points: 10,
              max_hit_points: 20,
              temp_hit_points: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:update')?.({
      characterId: 'char-1',
      changes: { hitPoints: 15 },
      expectedVersion: 3,
    });

    expect(emissions.some((e) => e.event === 'character:updated')).toBe(false);
    expect(emissions.map((e) => e.event)).toEqual(['character:update-conflict']);
    const conflict = emissions[0].payload as {
      character?: { id?: string; version?: number; hitPoints?: number };
    };
    expect(conflict.character?.id).toBe('char-1');
    expect(conflict.character?.version).toBe(4);
    expect(conflict.character?.hitPoints).toBe(10);
  });
});
