/**
 * Handler-level coverage for the server-side music state that drives
 * "late-joiner sync".
 *
 * When a player joins mid-session, `session:join` replays the room's
 * cached music state to the new socket so they hear whatever the DM is
 * already playing instead of silence. That replay reads `room.music`.
 * Booting the full `session:join` hydration path in vitest is heavy (and
 * is the area currently being changed on another branch), so rather than
 * drive the join, these tests pin the *source of truth* the replay reads:
 *
 *  • `session:music-change` caches the track / fileIndex and marks the
 *    room resuming (selecting a track implies playback); clearing the
 *    track stops it. Broadcasts `session:music-changed` room-wide.
 *  • `session:music-action` records the latest play/pause/skip so a
 *    rejoiner sees the correct indicator. Broadcasts room-wide.
 *  • Both are DM-only: a player who fires either is ignored — no state
 *    mutation and no broadcast. (Authority gate.)
 *
 * Pinning `room.music` + the DM gate locks the exact state a late joiner
 * inherits; the live end-to-end join replay remains a browser-QA row.
 *
 * Drives the real `registerSessionEvents` music handlers through a fake
 * socket as DM / player, isolating the state transition + recipient
 * routing — the only things under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the DB before importing the handler — sessionEvents opens a pg pool
// at module load. The music handlers themselves never query the DB.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerSessionEvents } from '../socket/sessionEvents.js';
import {
  createRoom, getRoom, getAllRooms, addPlayerToRoom, deleteRoom,
} from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }
type Handler = (data: unknown) => Promise<void> | void;

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

/** Register session handlers against a fake socket for `socketId`. */
function driverFor(emissions: Emission[], socketId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: socketId,
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    // Captured so an unexpected throw (safeHandler → session:error) would
    // surface as an emission instead of vanishing.
    emit: (event: string, payload: unknown) => emissions.push({ channelId: socketId, event, payload }),
  };
  registerSessionEvents(fakeIo(emissions), socket as never);
  return handlers;
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}
function payloadsFor(emissions: Emission[], event: string): unknown[] {
  return emissions.filter((e) => e.event === event).map((e) => e.payload);
}

const SESSION = 's-music-sync';

/** DM + one player. */
function seedRoom(): void {
  createRoom(SESSION, 'ROOM-MS', 'dm-user');
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock', role: 'player', characterId: null });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

describe('session:music-change — late-joiner state + broadcast', () => {
  it('a DM selecting a track caches it as resuming and broadcasts room-wide', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('session:music-change')!({ track: 'Tavern Brawl', fileIndex: 2 });

    // This is exactly what a late joiner inherits via the join replay.
    expect(getRoom(SESSION)!.music).toEqual({ track: 'Tavern Brawl', fileIndex: 2, action: 'resume' });
    expect(channelsFor(em, 'session:music-changed')).toEqual([SESSION]);
    expect(payloadsFor(em, 'session:music-changed')).toEqual([{ track: 'Tavern Brawl', fileIndex: 2 }]);
  });

  it('a DM clearing the track stops playback (action cleared)', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('session:music-change')!({ track: 'Tavern Brawl', fileIndex: 0 });
    await h.get('session:music-change')!({ track: null });

    expect(getRoom(SESSION)!.music).toEqual({ track: null, fileIndex: null, action: null });
    // The clear is the second broadcast.
    expect(payloadsFor(em, 'session:music-changed')).toEqual([
      { track: 'Tavern Brawl', fileIndex: 0 },
      { track: null, fileIndex: null },
    ]);
  });

  it('a non-DM cannot change the track (no state change, no broadcast)', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'player-sock');
    await h.get('session:music-change')!({ track: 'Sneaky Tunes', fileIndex: 1 });

    expect(getRoom(SESSION)!.music).toEqual({ track: null, fileIndex: null, action: null });
    expect(em).toHaveLength(0);
  });
});

describe('session:music-action — late-joiner state + broadcast', () => {
  it('a DM action records the latest state and broadcasts room-wide', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('session:music-action')!({ action: 'pause' });

    // A rejoiner reads this to show the correct play/pause indicator.
    expect(getRoom(SESSION)!.music.action).toBe('pause');
    expect(channelsFor(em, 'session:music-action-broadcast')).toEqual([SESSION]);
    expect(payloadsFor(em, 'session:music-action-broadcast')).toEqual([{ action: 'pause' }]);
  });

  it('a non-DM cannot drive music actions (no state change, no broadcast)', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'player-sock');
    await h.get('session:music-action')!({ action: 'pause' });

    expect(getRoom(SESSION)!.music.action).toBeNull();
    expect(em).toHaveLength(0);
  });
});
