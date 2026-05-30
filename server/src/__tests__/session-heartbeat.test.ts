import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRoom, getRoom, addPlayerToRoom, removePlayerFromRoom,
  removeSocketFromRoom, refreshSocketPresence,
  type RoomPlayer,
} from '../utils/roomState.js';

// Pins the `session:heartbeat` server contract: the lightweight keep-alive
// must re-assert an already-joined socket's membership WITHOUT mutating
// presence (no churn), and must report `ok: false` for a socket the room
// no longer knows so the client can fall back to a full `session:join`.

const SESSION = 'sess-hb';
const CODE = 'HBEAT';
const USER = 'user-keyleth';

function joinTab(socketId: string, role: 'dm' | 'player' = 'player'): RoomPlayer {
  const player: RoomPlayer = {
    userId: USER, displayName: 'Keyleth', socketId, role, characterId: null,
  };
  addPlayerToRoom(SESSION, player);
  return player;
}

beforeEach(() => {
  const existing = getRoom(SESSION);
  if (existing) {
    for (const u of existing.players.keys()) removePlayerFromRoom(SESSION, u);
  }
  createRoom(SESSION, CODE, 'user-dm');
});

describe('refreshSocketPresence (session:heartbeat)', () => {
  it('returns ok with the session id and event cursor for a joined socket', () => {
    joinTab('sock-A');
    const room = getRoom(SESSION)!;
    room.nextEventId = 42;

    const status = refreshSocketPresence('sock-A');
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.sessionId).toBe(SESSION);
      expect(status.userId).toBe(USER);
      expect(status.nextEventId).toBe(42);
    }
  });

  it('does not change presence or socket counts (idempotent, no churn)', () => {
    joinTab('sock-A');
    joinTab('sock-B');
    const room = getRoom(SESSION)!;
    const before = room.userSockets.get(USER)?.size;

    // Hammer it like the 5s keep-alive would.
    refreshSocketPresence('sock-A');
    refreshSocketPresence('sock-A');
    refreshSocketPresence('sock-B');

    expect(room.userSockets.get(USER)?.size).toBe(before);
    expect(room.players.has(USER)).toBe(true);
    // No phantom extra players or sockets introduced.
    expect(room.players.size).toBe(1);
  });

  it('reports rejoinRequired (ok:false) for a socket the room never knew', () => {
    joinTab('sock-A');
    const status = refreshSocketPresence('sock-ghost');
    expect(status.ok).toBe(false);
  });

  it('reports ok:false once the socket has been removed (server restart / GC analogue)', () => {
    joinTab('sock-A');
    joinTab('sock-B');
    // Drop sock-A; it should no longer resolve, but sock-B still does.
    removeSocketFromRoom(SESSION, 'sock-A');

    expect(refreshSocketPresence('sock-A').ok).toBe(false);
    expect(refreshSocketPresence('sock-B').ok).toBe(true);
  });

  it('re-adds a socket missing from userSockets but still in the index (partial-cleanup guard)', () => {
    joinTab('sock-A');
    joinTab('sock-B');
    const room = getRoom(SESSION)!;
    // Simulate a partial-cleanup race: socket pruned from the live set
    // but the player (and primary socket index) still resolves.
    room.userSockets.get(USER)!.delete('sock-B');

    const status = refreshSocketPresence('sock-B');
    expect(status.ok).toBe(true);
    expect(room.userSockets.get(USER)?.has('sock-B')).toBe(true);
  });
});
