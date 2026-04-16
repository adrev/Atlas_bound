import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRoom, getRoom, addPlayerToRoom, removePlayerFromRoom,
  removeSocketFromRoom, getPlayerBySocketId,
  type RoomPlayer,
} from '../utils/roomState.js';

// Pin the "multiple tabs per user must not remove presence on old-tab
// disconnect" contract. This was a silent P2 — an old tab closing
// would wipe the newer tab's presence from the room.

const SESSION = 'sess-1';
const CODE = 'MULT1';
const USER = 'user-vex';

function joinTab(socketId: string): RoomPlayer {
  const player: RoomPlayer = {
    userId: USER, displayName: 'Vex', socketId,
    role: 'player', characterId: null,
  };
  addPlayerToRoom(SESSION, player);
  return player;
}

beforeEach(() => {
  const existing = getRoom(SESSION);
  if (existing) {
    // Purge any leftover state between tests.
    for (const u of existing.players.keys()) removePlayerFromRoom(SESSION, u);
  }
  createRoom(SESSION, CODE, 'user-dm');
});

describe('addPlayerToRoom + removeSocketFromRoom (multi-tab)', () => {
  it('two tabs for the same user register both socket ids', () => {
    joinTab('sock-A');
    joinTab('sock-B');
    const room = getRoom(SESSION)!;
    expect(room.userSockets.get(USER)?.size).toBe(2);
    // Both sockets resolve to the user.
    expect(getPlayerBySocketId('sock-A')?.player.userId).toBe(USER);
    expect(getPlayerBySocketId('sock-B')?.player.userId).toBe(USER);
  });

  it('closing the older tab keeps the newer tab alive', () => {
    joinTab('sock-A');
    joinTab('sock-B'); // primary

    const result = removeSocketFromRoom(SESSION, 'sock-A');
    expect(result).toEqual({ userId: USER, userFullyLeft: false });

    const room = getRoom(SESSION)!;
    // User still present, just with one fewer socket.
    expect(room.players.has(USER)).toBe(true);
    expect(room.userSockets.get(USER)?.size).toBe(1);
    expect(room.userSockets.get(USER)?.has('sock-B')).toBe(true);
    // The "primary" socketId on the RoomPlayer should track a live socket.
    expect(room.players.get(USER)?.socketId).toBe('sock-B');
  });

  it('closing the last tab fully removes the user', () => {
    joinTab('sock-A');
    const result = removeSocketFromRoom(SESSION, 'sock-A');
    expect(result).toEqual({ userId: USER, userFullyLeft: true });
    // No user, no room (we were the only player).
    expect(getRoom(SESSION)).toBeUndefined();
  });

  it('explicit kick via removePlayerFromRoom wipes ALL sockets', () => {
    joinTab('sock-A');
    joinTab('sock-B');
    removePlayerFromRoom(SESSION, USER);
    expect(getPlayerBySocketId('sock-A')).toBeUndefined();
    expect(getPlayerBySocketId('sock-B')).toBeUndefined();
  });

  it('removeSocketFromRoom is a no-op for unknown sockets', () => {
    joinTab('sock-A');
    const result = removeSocketFromRoom(SESSION, 'sock-not-real');
    expect(result).toBeNull();
    // User still present.
    expect(getRoom(SESSION)?.players.has(USER)).toBe(true);
  });

  it('primary socketId shifts when the most-recent tab closes first', () => {
    joinTab('sock-A');
    joinTab('sock-B'); // becomes primary
    removeSocketFromRoom(SESSION, 'sock-B');
    // Primary should fall back to A (the only one left).
    expect(getRoom(SESSION)?.players.get(USER)?.socketId).toBe('sock-A');
  });
});
