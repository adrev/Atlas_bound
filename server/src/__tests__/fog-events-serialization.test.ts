/**
 * Fog edit serialization (audit #11).
 *
 * Each fog reveal/hide is a read-modify-write of the whole maps.fog_state
 * array. Two strokes that interleaved (second SELECT before first UPDATE)
 * used to clobber each other — the second append dropped the first
 * stroke, silently destroying the DM's reveal work.
 *
 * This drives the real socket handlers with a mocked pool whose SELECT is
 * artificially slow, fires two strokes back-to-back, and asserts both
 * survive in the persisted array (they queue instead of racing).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FogPolygon } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerFogEvents } from '../socket/fogEvents.js';
import { createRoom, getAllRooms, addPlayerToRoom, deleteRoom } from '../utils/roomState.js';

type Handler = (data: unknown) => Promise<void> | void;

const SESSION = 's-fog-serial';
const MAP_ID = 'map-fog';

function driver(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: 'dm-sock',
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    emit: () => undefined,
    to: () => ({ emit: () => undefined }),
  };
  const io = { to: () => ({ emit: () => undefined }) };
  registerFogEvents(io as never, socket as never);
  return handlers;
}

function seedRoom() {
  const room = createRoom(SESSION, 'ROOM-FS', 'dm-user');
  room.currentMapId = MAP_ID;
  room.playerMapId = MAP_ID;
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  return room;
}

beforeEach(() => {
  mockQuery.mockReset();
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('fog edit serialization', () => {
  it('two concurrent strokes both survive (no read-modify-write clobber)', async () => {
    seedRoom();
    const h = driver();

    // Server-side source of truth the mock reads/writes, mimicking the DB.
    let persisted: FogPolygon[] = [];

    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT fog_state')) {
        // Slow SELECT: if the two handlers ran concurrently they would
        // both read the same empty array here. The lock must prevent that.
        await new Promise((r) => setTimeout(r, 15));
        return { rows: [{ fog_state: JSON.stringify(persisted) }] };
      }
      if (sql.startsWith('UPDATE maps SET fog_state')) {
        persisted = JSON.parse(params[0] as string);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const a: number[] = [0, 0, 10, 0, 10, 10];
    const b: number[] = [20, 20, 30, 20, 30, 30];

    // Fire both without awaiting the first — the exact race condition.
    await Promise.all([
      h.get('map:fog-reveal')!({ points: a }),
      h.get('map:fog-hide')!({ points: b }),
    ]);

    expect(persisted).toHaveLength(2);
    const modes = persisted.map((r) => r.mode).sort();
    expect(modes).toEqual(['hide', 'reveal']);
    expect(persisted.find((r) => r.mode === 'reveal')!.points).toEqual(a);
    expect(persisted.find((r) => r.mode === 'hide')!.points).toEqual(b);
  });

  it('a failing stroke does not wedge later strokes for the same map', async () => {
    seedRoom();
    const h = driver();
    let persisted: FogPolygon[] = [];
    let calls = 0;

    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT fog_state')) {
        calls++;
        if (calls === 1) throw new Error('transient DB blip');
        return { rows: [{ fog_state: JSON.stringify(persisted) }] };
      }
      if (sql.startsWith('UPDATE maps SET fog_state')) {
        persisted = JSON.parse(params[0] as string);
        return { rows: [] };
      }
      return { rows: [] };
    });

    // First stroke throws inside the lock; second must still run.
    await Promise.allSettled([
      h.get('map:fog-reveal')!({ points: [0, 0, 10, 0, 10, 10] }),
      h.get('map:fog-reveal')!({ points: [1, 1, 11, 1, 11, 11] }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0].points).toEqual([1, 1, 11, 1, 11, 11]);
  });
});
