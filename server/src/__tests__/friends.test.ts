/**
 * Friends router smoke tests. Same pattern as feedback/tidings tests.
 * Mocks the pool, requireAuth/getAuthUserId, uuid, and the
 * roomState `getAllRooms` so presence assertions don't require
 * actual sockets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

const {
  mockQuery,
  mockGetAuthUserId,
  mockUuid,
  mockGetAllRooms,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetAuthUserId: vi.fn(),
  mockUuid: vi.fn(),
  mockGetAllRooms: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../auth/middleware.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../utils/authorization.js', () => ({
  getAuthUserId: (req: any) => mockGetAuthUserId(req),
}));
vi.mock('../utils/roomState.js', () => ({
  getAllRooms: () => mockGetAllRooms(),
}));
vi.mock('uuid', () => ({ v4: () => mockUuid() }));

import friendsRouter from '../routes/friends.js';

async function send(
  app: express.Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        { method, host: '127.0.0.1', port, path, headers: body ? { 'Content-Type': 'application/json' } : {} },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: any = {};
            try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  } finally {
    server.close();
  }
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', friendsRouter);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetAuthUserId.mockReset();
  mockUuid.mockReset();
  mockGetAllRooms.mockReset();

  mockGetAuthUserId.mockImplementation(() => 'user-alice');
  mockUuid.mockReturnValue('aaaa-bbbb-cccc-dddd');
  mockGetAllRooms.mockReturnValue(new Map());
});

// ── GET /api/friends ─────────────────────────────────────────────

describe('GET /api/friends', () => {
  it('returns each friendship with its OTHER user + offline presence by default', async () => {
    const app = makeApp();
    // Single accepted friendship row, hydrated with OTHER user fields.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'f1', user_a_id: 'user-alice', user_b_id: 'user-bob',
          requested_by: 'user-alice', status: 'accepted', blocked_by: null,
          created_at: '2026-04-27T10:00:00Z', updated_at: '2026-04-27T10:00:00Z',
          other_id: 'user-bob', other_display_name: 'Bob',
          other_email: 'bob@example.com', other_avatar_url: null,
        },
      ],
    });

    const { status, body } = await send(app, 'GET', '/api/friends');
    expect(status).toBe(200);
    expect(body.friends).toHaveLength(1);
    expect(body.friends[0]).toMatchObject({
      friendshipId: 'f1',
      userId: 'user-bob',
      displayName: 'Bob',
      status: 'accepted',
      requestedByMe: true,
      presence: { status: 'offline' },
    });
  });

  it('marks a friend as in-game when their socket is in any room', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'f1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-alice', status: 'accepted', blocked_by: null,
        created_at: '2026-04-27T10:00:00Z', updated_at: '2026-04-27T10:00:00Z',
        other_id: 'user-bob', other_display_name: 'Bob',
        other_email: 'bob@example.com', other_avatar_url: null,
      }],
    });
    // Bob is connected to session sess-X.
    mockGetAllRooms.mockReturnValue(new Map([
      ['sess-X', { userSockets: new Map([['user-bob', new Set(['sock-1'])]]) }],
    ]));
    // Session-name lookup for sess-X.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'sess-X', name: 'Mists of Thornreach', room_code: 'MQK72XL' }],
    });

    const { body } = await send(app, 'GET', '/api/friends');
    expect(body.friends[0].presence).toEqual({
      status: 'in-game',
      sessionId: 'sess-X',
      sessionName: 'Mists of Thornreach',
      roomCode: 'MQK72XL',
    });
  });
});

// ── GET /api/friends/pending ────────────────────────────────────

describe('GET /api/friends/pending', () => {
  it('separates incoming vs outgoing requests by `requested_by`', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'p1', user_a_id: 'user-alice', user_b_id: 'user-bob',
          requested_by: 'user-bob', status: 'pending', blocked_by: null,
          created_at: '2026-04-27T10:00:00Z', updated_at: '2026-04-27T10:00:00Z',
          other_id: 'user-bob', other_display_name: 'Bob',
          other_email: 'bob@example.com', other_avatar_url: null,
        },
        {
          id: 'p2', user_a_id: 'user-alice', user_b_id: 'user-carol',
          requested_by: 'user-alice', status: 'pending', blocked_by: null,
          created_at: '2026-04-27T11:00:00Z', updated_at: '2026-04-27T11:00:00Z',
          other_id: 'user-carol', other_display_name: 'Carol',
          other_email: 'carol@example.com', other_avatar_url: null,
        },
      ],
    });

    const { status, body } = await send(app, 'GET', '/api/friends/pending');
    expect(status).toBe(200);
    expect(body.incoming).toHaveLength(1);
    expect(body.incoming[0].userId).toBe('user-bob');
    expect(body.outgoing).toHaveLength(1);
    expect(body.outgoing[0].userId).toBe('user-carol');
  });
});

// ── POST /api/friends/request ───────────────────────────────────

describe('POST /api/friends/request', () => {
  it('rejects empty payloads', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'POST', '/api/friends/request', {});
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid request payload');
  });

  it('refuses friending yourself', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-alice' }] });
    const { status, body } = await send(app, 'POST', '/api/friends/request', {
      target: 'alice@example.com',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/can't befriend yourself/i);
  });

  it('returns 404 when no traveler matches', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await send(app, 'POST', '/api/friends/request', {
      target: 'ghost@nowhere',
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/no traveler/i);
  });

  it('inserts a fresh pending row with canonical (a, b) ordering', async () => {
    const app = makeApp();
    // user-alice < user-bob lexicographically, so canonical pair is (alice, bob).
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-bob' }] }); // resolve target
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no existing friendship
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT

    const { status, body } = await send(app, 'POST', '/api/friends/request', { target: 'Bob' });
    expect(status).toBe(201);
    expect(body).toEqual({ friendshipId: 'aaaa-bbbb-cccc-dddd', status: 'pending' });

    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO friendships/);
    expect(insertCall[1]).toEqual([
      'aaaa-bbbb-cccc-dddd', 'user-alice', 'user-bob', 'user-alice',
    ]);
  });

  it('auto-accepts when the OTHER side already has a pending request to me', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-bob' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'existing', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-bob', status: 'pending', blocked_by: null,
        created_at: 't', updated_at: 't',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

    const { status, body } = await send(app, 'POST', '/api/friends/request', { target: 'Bob' });
    expect(status).toBe(200);
    expect(body).toEqual({ friendshipId: 'existing', status: 'accepted', autoAccepted: true });

    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toMatch(/UPDATE friendships/);
  });

  it('returns 403 when the friendship is already blocked', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-bob' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'b1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-bob', status: 'blocked', blocked_by: 'user-bob',
        created_at: 't', updated_at: 't',
      }],
    });

    const { status, body } = await send(app, 'POST', '/api/friends/request', { target: 'Bob' });
    expect(status).toBe(403);
    // Generic message — does NOT leak who blocked.
    expect(body.error).not.toContain('blocked');
  });
});

// ── POST /api/friends/:id/accept ────────────────────────────────

describe('POST /api/friends/:id/accept', () => {
  it("rejects the sender accepting their own request", async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-alice', status: 'pending', blocked_by: null,
        created_at: 't', updated_at: 't',
      }],
    });
    const { status, body } = await send(app, 'POST', '/api/friends/p1/accept');
    expect(status).toBe(400);
    expect(body.error).toMatch(/own request/i);
  });

  it('flips the row to accepted when the recipient hits accept', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-bob', status: 'pending', blocked_by: null,
        created_at: 't', updated_at: 't',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    const { status, body } = await send(app, 'POST', '/api/friends/p1/accept');
    expect(status).toBe(200);
    expect(body).toEqual({ friendshipId: 'p1', status: 'accepted' });
  });
});

// ── POST /api/friends/:id/decline ───────────────────────────────

describe('POST /api/friends/:id/decline', () => {
  it('refuses when the caller is the sender (use cancel instead)', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-alice', status: 'pending', blocked_by: null,
        created_at: 't', updated_at: 't',
      }],
    });
    const { status, body } = await send(app, 'POST', '/api/friends/p1/decline');
    expect(status).toBe(400);
    expect(body.error).toMatch(/recipient/i);
  });

  it('deletes the row when the recipient declines', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-bob', status: 'pending', blocked_by: null,
        created_at: 't', updated_at: 't',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // DELETE
    const { status, body } = await send(app, 'POST', '/api/friends/p1/decline');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockQuery.mock.calls[1][0]).toMatch(/DELETE FROM friendships/);
  });
});

// ── DELETE /api/friends/:id (unblock + unfriend) ────────────────

describe('DELETE /api/friends/:id', () => {
  it('refuses unblock from anyone other than the blocker', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'b1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-bob', status: 'blocked', blocked_by: 'user-bob',
        created_at: 't', updated_at: 't',
      }],
    });
    const { status, body } = await send(app, 'DELETE', '/api/friends/b1');
    expect(status).toBe(403);
    expect(body.error).toBe('Not authorized');
  });

  it('lets either side unfriend an accepted friendship', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'a1', user_a_id: 'user-alice', user_b_id: 'user-bob',
        requested_by: 'user-alice', status: 'accepted', blocked_by: null,
        created_at: 't', updated_at: 't',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await send(app, 'DELETE', '/api/friends/a1');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });
});
