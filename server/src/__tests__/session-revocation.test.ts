import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import type { Server, Socket } from 'socket.io';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import sessionsRouter from '../routes/sessions.js';
import { registerSessionEvents } from '../socket/sessionEvents.js';
import { installCommittedBroadcasts, installCommittedSocket } from '../socket/committedDelivery.js';
import { inTransaction } from '../db/transactionContext.js';
import { rawPool } from '../db/connection.js';
import { addPlayerToRoom, createRoom, deleteRoom, getRoom } from '../utils/roomState.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  getIO: vi.fn(),
}));

vi.mock('../db/connection.js', async () => {
  const { transactionAwarePool } = await import('../db/transactionContext.js');
  const raw = { query: mocks.query, connect: mocks.connect } as unknown as Pool;
  return { default: transactionAwarePool(raw), rawPool: raw };
});
vi.mock('../socket/ioInstance.js', () => ({ getIO: mocks.getIO }));
vi.mock('../utils/runtimeHttp.js', () => ({ runtimeHttp: (handler: unknown) => handler }));

const SESSION = 'revocation-session';
const OWNER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
type Role = 'dm' | 'player';
type Delivery = { event: string; payload: unknown };
type Peer = {
  id: string;
  data: { userId?: string };
  rooms: Set<string>;
  received: Delivery[];
  leave: ReturnType<typeof vi.fn>;
};
let members: Map<string, Role>;
let sessionExists: boolean;
let failSQL: string | undefined;
let sqlLog: string[];
let peers: Peer[];
let io: Server;
let fetchSockets: Mock<(room: string) => Promise<Peer[]>>;
let release: ReturnType<typeof vi.fn>;

function peer(id: string, userId?: string): Peer {
  const value: Peer = {
    id,
    data: { userId },
    rooms: new Set([id, SESSION, 'other-session']),
    received: [],
    leave: vi.fn(),
  };
  value.leave.mockImplementation(async (room: string) => {
    value.rooms.delete(room);
  });
  return value;
}

function buildIO(): Server {
  const adapter = {
    broadcast(
      packet: { data: [string, unknown] },
      opts: { rooms: Set<string>; except: Set<string> }
    ) {
      for (const socket of peers) {
        if (![...opts.rooms].some((room) => socket.rooms.has(room))) continue;
        if ([...opts.except].some((room) => socket.rooms.has(room))) continue;
        socket.received.push({ event: packet.data[0], payload: packet.data[1] });
      }
    },
  };
  fetchSockets = vi.fn(async (room: string) => peers.filter((s) => s.rooms.has(room)));
  function scope(room: string, excluded: string[] = []) {
    return {
      fetchSockets: () => fetchSockets(room),
      except: (ids: string | string[]) => scope(room, excluded.concat(ids)),
      emit: (event: string, payload: unknown) => {
        adapter.broadcast(
          { data: [event, payload] },
          {
            rooms: new Set([room]),
            except: new Set(excluded),
          }
        );
      },
    };
  }
  const server = {
    in: scope,
    to: scope,
    of: () => ({ adapter }),
    // No remote peer is addressable through this instance's local socket map.
    sockets: { sockets: new Map() },
  } as unknown as Server;
  installCommittedBroadcasts(server);
  return server;
}

function app() {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => {
    const id = req.header('x-user-id');
    if (id) req.user = { id } as NonNullable<typeof req.user>;
    next();
  });
  result.use('/sessions', sessionsRouter);
  result.use(((error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: error.message });
  }) as ErrorRequestHandler);
  return result;
}

function kick(callerId = OWNER, cachedRole: Role = 'dm') {
  if (!getRoom(SESSION)) createRoom(SESSION, 'REVOKE', OWNER);
  addPlayerToRoom(SESSION, {
    userId: callerId,
    socketId: 'caller',
    role: cachedRole,
    displayName: 'Caller',
    characterId: null,
  });
  const handlers = new Map<string, (data: unknown) => Promise<void>>();
  const emit = vi.fn();
  const socket = {
    id: 'caller',
    data: { userId: callerId },
    emit,
    on: (event: string, handler: (data: unknown) => Promise<void>) => handlers.set(event, handler),
  } as unknown as Socket;
  installCommittedSocket(socket);
  registerSessionEvents(io, socket);
  return {
    run: (targetUserId = TARGET) => handlers.get('session:kick')!({ targetUserId }),
    socket,
    emit,
  };
}

function expectRevoked(event: string) {
  for (const socket of peers.filter((s) => s.data.userId === TARGET)) {
    expect(socket.leave).toHaveBeenCalledWith(SESSION);
    expect(socket.rooms.has(SESSION)).toBe(false);
    expect(socket.rooms.has('other-session')).toBe(true);
    expect(socket.received.some((message) => message.event === event)).toBe(true);
    expect(socket.received.some((message) => message.event === 'session:player-removed')).toBe(
      false
    );
  }
  expect(peers.find((s) => s.data.userId === OTHER)!.leave).not.toHaveBeenCalled();
  io.to(SESSION).emit('private-after-revocation', { secret: true });
  for (const socket of peers.filter((s) => s.data.userId === TARGET)) {
    expect(socket.received.some((message) => message.event === 'private-after-revocation')).toBe(
      false
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteRoom(SESSION);
  members = new Map([
    [OWNER, 'dm'],
    [TARGET, 'player'],
    [OTHER, 'player'],
  ]);
  sessionExists = true;
  failSQL = undefined;
  sqlLog = [];
  let backup: { members: Map<string, Role>; exists: boolean } | undefined;
  mocks.query.mockImplementation(async (sql: string, params: string[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    sqlLog.push(normalized);
    if (failSQL && normalized.includes(failSQL)) throw new Error('injected SQL failure');
    if (normalized === 'BEGIN') backup = { members: new Map(members), exists: sessionExists };
    if (normalized === 'ROLLBACK' && backup) {
      members = backup.members;
      sessionExists = backup.exists;
    }
    if (normalized.startsWith('SELECT 1 FROM sessions')) {
      return { rows: sessionExists && params[1] === OWNER ? [{}] : [] };
    }
    if (normalized.startsWith('SELECT 1 FROM session_players')) {
      const role = members.get(params[1]);
      return { rows: role && (!normalized.includes("role = 'dm'") || role === 'dm') ? [{}] : [] };
    }
    if (normalized.startsWith('SELECT sp.role, s.dm_user_id')) {
      const role = members.get(params[1]);
      return { rows: role ? [{ role, dm_user_id: OWNER }] : [] };
    }
    if (normalized.startsWith('DELETE FROM sessions')) {
      sessionExists = false;
      members.clear();
    }
    if (normalized.startsWith('DELETE FROM session_players')) members.delete(params[1]);
    if (normalized.startsWith('UPDATE session_players SET role = $1')) {
      if (!members.has(params[2])) return { rows: [] };
      members.set(params[2], params[0] as Role);
      return { rows: [{ role: params[0] }] };
    }
    return { rows: [] };
  });
  release = vi.fn();
  mocks.connect.mockResolvedValue({ query: mocks.query, release });
  peers = [
    peer('remote-secondary-a', TARGET),
    peer('remote-secondary-b', TARGET),
    peer('bystander', OTHER),
  ];
  io = buildIO();
  mocks.getIO.mockReturnValue(io);
});

describe('adapter-wide REST revocation', () => {
  it('bans every remote secondary tab without a local room or primary socket', async () => {
    await request(app())
      .post(`/sessions/${SESSION}/bans`)
      .set('x-user-id', OWNER)
      .send({ targetUserId: TARGET, reason: 'abuse' })
      .expect(204);
    expect(fetchSockets).toHaveBeenCalledWith(SESSION);
    expect(members.has(TARGET)).toBe(false);
    expectRevoked('session:player-banned');
  });

  it('leaves all remote tabs even if membership was already deleted', async () => {
    members.delete(TARGET);
    await request(app()).delete(`/sessions/${SESSION}/leave`).set('x-user-id', TARGET).expect(200);
    expectRevoked('session:kicked');
  });

  it('ignores stale cached socket IDs and trusts authenticated adapter data', async () => {
    createRoom(SESSION, 'REVOKE', OWNER);
    addPlayerToRoom(SESSION, {
      userId: TARGET,
      socketId: 'bystander',
      role: 'player',
      displayName: 'Stale',
      characterId: null,
    });
    peers.push(peer('unauthenticated'));
    await request(app()).delete(`/sessions/${SESSION}/leave`).set('x-user-id', TARGET).expect(200);
    expectRevoked('session:kicked');
    expect(peers.at(-1)!.leave).not.toHaveBeenCalled();
    expect(getRoom(SESSION)?.players.has(TARGET)).not.toBe(true);
  });

  it('deletes a cold session and evicts every remote subscriber only after SQL succeeds', async () => {
    await request(app()).delete(`/sessions/${SESSION}`).set('x-user-id', OWNER).expect(200);
    expect(sessionExists).toBe(false);
    for (const socket of peers) {
      expect(socket.leave).toHaveBeenCalledWith(SESSION);
      expect(socket.rooms.has('other-session')).toBe(true);
      expect(socket.received).toContainEqual({
        event: 'session:deleted',
        payload: { sessionId: SESSION },
      });
    }
  });

  it.each([
    ['delete', 'DELETE FROM sessions'],
    ['leave', 'DELETE FROM session_players'],
    ['ban', 'COMMIT'],
  ])('does not notify or evict when %s persistence fails', async (action, failure) => {
    failSQL = failure;
    const api = request(app());
    const response =
      action === 'ban'
        ? api
            .post(`/sessions/${SESSION}/bans`)
            .set('x-user-id', OWNER)
            .send({ targetUserId: TARGET })
        : api
            .delete(`/sessions/${SESSION}${action === 'leave' ? '/leave' : ''}`)
            .set('x-user-id', action === 'leave' ? TARGET : OWNER);
    await response.expect(500);
    for (const socket of peers) {
      expect(socket.leave).not.toHaveBeenCalled();
      expect(socket.received).toEqual([]);
    }
    expect(members.has(TARGET)).toBe(true);
  });

  it('evicts a committed ban even if the optional ban-list read fails', async () => {
    failSQL = 'SELECT b.user_id';
    await request(app())
      .post(`/sessions/${SESSION}/bans`)
      .set('x-user-id', OWNER)
      .send({ targetUserId: TARGET })
      .expect(500);
    expectRevoked('session:player-banned');
  });

  it('fails closed before SQL mutation if adapter discovery fails', async () => {
    fetchSockets.mockRejectedValue(new Error('adapter unavailable'));
    await request(app()).delete(`/sessions/${SESSION}/leave`).set('x-user-id', TARGET).expect(500);
    expect(members.has(TARGET)).toBe(true);
    expect(sqlLog.some((sql) => sql.startsWith('DELETE'))).toBe(false);
  });

  it('uses SQL authorization before discovering sockets', async () => {
    await request(app())
      .post(`/sessions/${SESSION}/bans`)
      .set('x-user-id', OTHER)
      .send({ targetUserId: TARGET })
      .expect(403);
    await request(app()).delete(`/sessions/${SESSION}`).set('x-user-id', OTHER).expect(403);
    await request(app()).delete(`/sessions/${SESSION}/leave`).set('x-user-id', OWNER).expect(409);
    expect(fetchSockets).not.toHaveBeenCalled();
  });
});

describe('transactional socket kick and role revocation', () => {
  it('kicks remote secondary tabs that have no local presence', async () => {
    await kick().run();
    expect(members.has(TARGET)).toBe(false);
    expectRevoked('session:kicked');
  });

  it('does not trust a stale cached DM role after SQL demotion', async () => {
    const caller = kick();
    members.set(OWNER, 'player');
    await caller.run();
    expect(members.has(TARGET)).toBe(true);
    expect(fetchSockets).not.toHaveBeenCalled();
    expect(caller.emit).toHaveBeenCalledWith('session:error', expect.any(Object));
  });

  it('rejects a socket whose authenticated identity disagrees with cached presence', async () => {
    const caller = kick();
    caller.socket.data.userId = OTHER;
    await caller.run();
    expect(members.has(TARGET)).toBe(true);
    expect(fetchSockets).not.toHaveBeenCalled();
    expect(sqlLog).toEqual([]);
  });

  it.each([
    [OTHER, OWNER],
    [OWNER, OTHER],
  ])('preserves kick hierarchy from %s to %s', async (caller, target) => {
    members.set(OTHER, 'dm');
    await kick(caller).run(target);
    expect(members.has(target)).toBe(true);
    expect(fetchSockets).not.toHaveBeenCalled();
  });

  it('suppresses kick effects if the outer COMMIT fails', async () => {
    const caller = kick();
    failSQL = 'COMMIT';
    await expect(inTransaction(rawPool, () => caller.run())).rejects.toThrow(
      'injected SQL failure'
    );
    expect(members.has(TARGET)).toBe(true);
    for (const socket of peers) {
      expect(socket.leave).not.toHaveBeenCalled();
      expect(socket.received).toEqual([]);
    }
  });

  it('defers eviction and notifications until the outer session transaction commits', async () => {
    const caller = kick();
    await inTransaction(rawPool, async () => {
      await caller.run();
      for (const socket of peers) {
        expect(socket.leave).not.toHaveBeenCalled();
        expect(socket.received).toEqual([]);
      }
    });
    expect(sqlLog).toContain('COMMIT');
    expect(release).toHaveBeenCalledOnce();
    expectRevoked('session:kicked');
  });

  it('keeps transport and local presence unchanged on outer rollback', async () => {
    const caller = kick();
    addPlayerToRoom(SESSION, {
      userId: TARGET,
      socketId: 'remote-secondary-a',
      role: 'player',
      displayName: 'Target',
      characterId: null,
    });
    await expect(
      inTransaction(rawPool, async () => {
        await caller.run();
        throw new Error('checkpoint failed');
      })
    ).rejects.toThrow('checkpoint failed');
    expect(members.has(TARGET)).toBe(true);
    expect(getRoom(SESSION)?.players.has(TARGET)).toBe(true);
    for (const socket of peers) {
      expect(socket.leave).not.toHaveBeenCalled();
      expect(socket.received).toEqual([]);
    }
  });

  it('SQL demotion reaches all remote tabs and denies a cached-DM kick', async () => {
    members.set(TARGET, 'dm');
    const caller = kick(TARGET);
    await request(app())
      .post(`/sessions/${SESSION}/demote`)
      .set('x-user-id', OWNER)
      .send({ targetUserId: TARGET })
      .expect(204);
    for (const socket of peers.filter((s) => s.data.userId === TARGET)) {
      expect(socket.received).toContainEqual({
        event: 'session:role-changed',
        payload: { userId: TARGET, role: 'player' },
      });
    }
    getRoom(SESSION)!.players.get(TARGET)!.role = 'dm';
    await caller.run(OTHER);
    expect(members.has(OTHER)).toBe(true);
    expect(fetchSockets).not.toHaveBeenCalled();
  });

  it('promotion reaches every remote tab without evicting legitimate membership', async () => {
    await request(app())
      .post(`/sessions/${SESSION}/promote`)
      .set('x-user-id', OWNER)
      .send({ targetUserId: TARGET })
      .expect(204);
    expect(members.get(TARGET)).toBe('dm');
    for (const socket of peers.filter((s) => s.data.userId === TARGET)) {
      expect(socket.leave).not.toHaveBeenCalled();
      expect(socket.received).toContainEqual({
        event: 'session:role-changed',
        payload: { userId: TARGET, role: 'dm' },
      });
    }
  });
});
