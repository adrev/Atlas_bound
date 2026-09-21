import type { Pool } from 'pg';
import type { Server, Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { start, locked, configured } = vi.hoisted(() => ({
  start: vi.fn(),
  locked: vi.fn(),
  configured: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({ default: { query: vi.fn() }, rawPool: {} }));
vi.mock('../services/SessionRuntime.js', () => ({
  withSessionRuntime: locked,
  sessionRuntimeConfigured: configured,
}));
vi.mock('../socket/combat/startCombatHelper.js', () => ({ startCombat: start }));
vi.mock('../utils/socketHelpers.js', () => ({
  safeHandler: (_socket: Socket, handler: (data: unknown) => Promise<void>) => handler,
}));

import { inTransaction } from '../db/transactionContext.js';
import { armReadyCheckTimer } from '../services/ReadyCheckRuntime.js';
import { registerCombatLifecycle } from '../socket/combat/lifecycleEvents.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getRoom,
  type RoomState,
} from '../utils/roomState.js';
import { restoreRoom, snapshotRoom } from '../utils/roomSnapshot.js';

const NOW = Date.parse('2026-09-21T12:00:00Z');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const room = createRoom('session', 'ROOM', 'dm');
  const emit = vi.fn();
  const io = { to: () => ({ emit }) } as unknown as Server;
  room.readyCheck = {
    id: 'check-one',
    deadline: NOW + 15_000,
    tokenIds: ['token'],
    playerIds: ['player'],
    responses: new Map([['player', false]]),
    timeout: null,
  };
  room.tokens.set('token', {
    id: 'token',
    mapId: 'map',
    characterId: null,
    ownerUserId: null,
    name: 'NPC',
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    conditions: [],
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    createdAt: '',
  });
  return { room, io, emit };
}

function transactionPool(commit: () => Promise<void> = async () => {}) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === 'COMMIT') await commit();
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getAllRooms().clear();
  configured.mockReset().mockReturnValue(true);
  locked
    .mockReset()
    .mockImplementation(async (_sessionId: string, operation: () => Promise<void>) => operation());
  start.mockReset().mockImplementation(async (_io: Server, sessionId: string) => {
    const room = getRoom(sessionId)!;
    if (room.readyCheck?.timeout) clearTimeout(room.readyCheck.timeout);
    room.readyCheck = null;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  getAllRooms().clear();
  vi.restoreAllMocks();
});

describe('ready-check durable snapshots', () => {
  it('persists identity, absolute deadline, roster and responses but never the timer', () => {
    const { room, io } = fixture();
    armReadyCheckTimer(room, io);
    const snapshot = snapshotRoom(room);
    expect(snapshot.values.readyCheck).toEqual({
      id: 'check-one',
      deadline: NOW + 15_000,
      tokenIds: ['token'],
      playerIds: ['player'],
      responses: [['player', false]],
    });
    expect(snapshot.values.readyCheck).not.toHaveProperty('timeout');
    room.readyCheck!.responses.set('player', true);
    restoreRoom(room, JSON.parse(JSON.stringify(snapshot)));
    expect(room.readyCheck!.responses.get('player')).toBe(false);
    expect(room.readyCheck!.timeout).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores legacy snapshots without inventing a check/deadline', () => {
    const { room } = fixture();
    const snapshot = snapshotRoom(room);
    delete snapshot.values.readyCheck;
    restoreRoom(room, snapshot);
    expect(room.readyCheck).toBeNull();
  });

  it.each([
    { id: '', deadline: NOW, tokenIds: [], responses: [] },
    { id: 'check', deadline: 'later', tokenIds: [], responses: [] },
    { id: 'check', deadline: NOW, tokenIds: [], responses: [['player', 'yes']] },
    { id: 'check', deadline: NOW, tokenIds: [], responses: [], timeout: 1 },
  ])('refuses malformed durable ready-check data: %j', (readyCheck) => {
    const { room } = fixture();
    const snapshot = snapshotRoom(room);
    snapshot.values.readyCheck = readyCheck;
    expect(() => restoreRoom(room, snapshot)).toThrow();
    expect(room.readyCheck!.id).toBe('check-one');
  });
});

describe('after-commit ready-check timers', () => {
  it('waits for a slow COMMIT even when the saved deadline has already passed', async () => {
    const { room, io, emit } = fixture();
    const committing = deferred();
    const release = deferred();
    const { pool } = transactionPool(async () => {
      committing.resolve();
      await release.promise;
    });
    const transaction = inTransaction(pool, async () => {
      armReadyCheckTimer(room, io);
    });
    await committing.promise;
    expect(room.readyCheck!.timeout).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(start).not.toHaveBeenCalled();
    release.resolve();
    await transaction;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(locked).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(io, 'session', ['token']);
    expect(emit).toHaveBeenCalledWith('combat:ready-check-complete', {});
  });

  it('arms nothing after rollback or COMMIT failure', async () => {
    const { room, io } = fixture();
    const failed = transactionPool(async () => {
      throw new Error('commit failed');
    });
    await expect(
      inTransaction(failed.pool, async () => {
        armReadyCheckTimer(room, io);
      })
    ).rejects.toThrow('commit failed');
    const valid = transactionPool();
    await expect(
      inTransaction(valid.pool, async () => {
        armReadyCheckTimer(room, io);
        throw new Error('handler failed');
      })
    ).rejects.toThrow('handler failed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(room.readyCheck!.timeout).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('rearms a cold room for the remaining time, not another fifteen seconds', async () => {
    const { room, io } = fixture();
    armReadyCheckTimer(room, io);
    const saved = snapshotRoom(room);
    await vi.advanceTimersByTimeAsync(11_000);
    deleteRoom(room.sessionId);
    const cold = createRoom('session', 'ROOM', 'dm');
    cold.tokens = room.tokens;
    restoreRoom(cold, saved);
    armReadyCheckTimer(cold, io);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(cold.readyCheck).toBeNull();
  });

  it('checks the durable identity again after acquiring the session lock', async () => {
    const { room, io } = fixture();
    const cancelled = snapshotRoom(room);
    cancelled.values.readyCheck = null;
    locked.mockImplementation(async (_sessionId: string, operation: () => Promise<void>) => {
      restoreRoom(room, cancelled);
      await operation();
    });
    armReadyCheckTimer(room, io);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(locked).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'replaced', 'deadline changed'] as const)(
    'a queued timer cannot start a %s check',
    async (change) => {
      const { room, io } = fixture();
      const release = deferred();
      locked.mockImplementation(async (_sessionId: string, operation: () => Promise<void>) => {
        await release.promise;
        await operation();
      });
      armReadyCheckTimer(room, io);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(locked).toHaveBeenCalledTimes(1);
      if (change === 'cancelled') room.readyCheck = null;
      else if (change === 'replaced') room.readyCheck!.id = 'replacement';
      else room.readyCheck!.deadline = NOW + 30_000;
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(start).not.toHaveBeenCalled();
    }
  );

  it('an evicted room timer cannot act on a replacement room with the same check ID', async () => {
    const { room, io } = fixture();
    armReadyCheckTimer(room, io);
    const saved = snapshotRoom(room);
    getAllRooms().delete(room.sessionId); // Simulate loss without clean cancellation.
    const replacement = createRoom('session', 'ROOM', 'dm');
    replacement.tokens = room.tokens;
    restoreRoom(replacement, saved);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(start).not.toHaveBeenCalled();
    armReadyCheckTimer(replacement, io);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a timer can open a fresh transaction without inheriting its scheduling transaction', async () => {
    const { room, io } = fixture();
    const { pool, client } = transactionPool();
    locked.mockImplementation((_sessionId: string, operation: () => Promise<void>) =>
      inTransaction(pool, operation)
    );
    await inTransaction(pool, async () => {
      armReadyCheckTimer(room, io);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(2);
    expect(client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('repeated arming maintains only one timer and no duplicate combat start', async () => {
    const { room, io } = fixture();
    const { pool } = transactionPool();
    await inTransaction(pool, async () => {
      armReadyCheckTimer(room, io);
      armReadyCheckTimer(room, io);
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('clears an obsolete check rather than restarting already-active combat', async () => {
    const { room, io } = fixture();
    armReadyCheckTimer(room, io);
    locked.mockImplementation(async (_sessionId: string, operation: () => Promise<void>) => {
      room.combatState = { active: true } as RoomState['combatState'];
      await operation();
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(start).not.toHaveBeenCalled();
    expect(room.readyCheck).toBeNull();
  });

  it('does not emit completion when combat start fails', async () => {
    const { room, io, emit } = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    start.mockRejectedValue(new Error('cannot save combat'));
    armReadyCheckTimer(room, io);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(emit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('refuses to start if the durable selection no longer resolves to existing tokens', async () => {
    const { room, io, emit } = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    armReadyCheckTimer(room, io);
    room.tokens.clear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(start).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('backs off a repeatedly failing overdue timer without altering its saved deadline', async () => {
    const { room, io } = fixture();
    room.readyCheck!.deadline = NOW;
    const committed = snapshotRoom(room);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    start.mockRejectedValue(new Error('persistent combat write failure'));
    locked.mockImplementation(async (_sessionId: string, operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        // The parent's rollback path restores committed state before rearming.
        restoreRoom(room, committed);
        armReadyCheckTimer(room, io, 5_000);
        throw error;
      }
    });
    armReadyCheckTimer(room, io);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(room.readyCheck!.deadline).toBe(NOW);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(start).toHaveBeenCalledTimes(2);
    expect(snapshotRoom(room)).toEqual(committed);
  });

  it('does not arm legacy fixtures without durable identity/deadline', () => {
    const { room, io } = fixture();
    delete room.readyCheck!.id;
    armReadyCheckTimer(room, io);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ready-check lifecycle handlers', () => {
  function handlersFor(socketId: string, io: Server) {
    const handlers = new Map<string, (data: unknown) => Promise<void>>();
    const socket = {
      id: socketId,
      on: (event: string, handler: (data: unknown) => Promise<void>) =>
        handlers.set(event, handler),
    } as unknown as Socket;
    registerCombatLifecycle(io, socket);
    return handlers;
  }

  it('creates a durable check, saves responses through hydration, and completes all-ready once', async () => {
    const { room, io } = fixture();
    room.readyCheck = null;
    addPlayerToRoom('session', {
      userId: 'dm',
      socketId: 'dm-socket',
      displayName: 'DM',
      role: 'dm',
      characterId: null,
    });
    addPlayerToRoom('session', {
      userId: 'player',
      socketId: 'p-socket',
      displayName: 'Player',
      role: 'player',
      characterId: null,
    });
    const dm = handlersFor('dm-socket', io);
    const player = handlersFor('p-socket', io);
    const { pool } = transactionPool();
    await inTransaction(pool, async () => {
      await dm.get('combat:ready-check')!({ tokenIds: ['token'] });
      expect(room.readyCheck!.id).toBeTruthy();
      expect(room.readyCheck!.deadline).toBe(NOW + 15_000);
      expect(room.readyCheck!.playerIds).toEqual(['player']);
      expect(room.readyCheck!.timeout).toBeNull();
    });
    await player.get('combat:ready-response')!({ ready: false });
    const saved = snapshotRoom(room);
    restoreRoom(room, saved);
    expect(room.readyCheck!.responses.get('player')).toBe(false);
    armReadyCheckTimer(room, io);
    await player.get('combat:ready-response')!({ ready: true });
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(room.readyCheck).toBeNull();
  });

  it('a disconnected original participant remains required until the saved deadline', async () => {
    const { room, io } = fixture();
    addPlayerToRoom('session', {
      userId: 'dm',
      socketId: 'dm-socket',
      displayName: 'DM',
      role: 'dm',
      characterId: null,
    });
    const dm = handlersFor('dm-socket', io);
    await dm.get('combat:ready-response')!({ ready: true });
    expect(start).not.toHaveBeenCalled();
    expect(room.readyCheck!.playerIds).toEqual(['player']);
  });

  it('propagates all-ready start failures to the parent transaction without completion', async () => {
    const { room, io, emit } = fixture();
    addPlayerToRoom('session', {
      userId: 'player',
      socketId: 'p-socket',
      displayName: 'Player',
      role: 'player',
      characterId: null,
    });
    const player = handlersFor('p-socket', io);
    start.mockRejectedValue(new Error('cannot start'));
    await expect(player.get('combat:ready-response')!({ ready: true })).rejects.toThrow(
      'cannot start'
    );
    expect(emit).not.toHaveBeenCalledWith('combat:ready-check-complete', {});
    expect(room.readyCheck).not.toBeNull();
  });
});
