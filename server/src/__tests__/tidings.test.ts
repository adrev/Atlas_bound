/**
 * Tidings router smoke tests. Same harness shape as feedback.test.ts:
 * stub the pool + auth middleware + uuid, then drive the router via
 * a tiny supertest-style helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

const {
  mockQuery,
  mockGetAuthUserId,
  mockRequireAdmin,
  mockUuid,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetAuthUserId: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockUuid: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../auth/middleware.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../auth/admin.js', () => ({
  requireAdmin: (req: any, res: any, next: any) => mockRequireAdmin(req, res, next),
}));
vi.mock('../utils/authorization.js', () => ({
  getAuthUserId: (req: any) => mockGetAuthUserId(req),
}));
vi.mock('../utils/releasesWebhook.js', () => ({
  // Spy on the webhook so the announcement-trigger tests can assert it
  // was called without actually hitting Discord. The real function is
  // covered by releasesWebhook.test.ts.
  sendReleaseWebhook: vi.fn(async () => ({ ok: false, threadUrl: null })),
}));
vi.mock('uuid', () => ({ v4: () => mockUuid() }));

import tidingsRouter from '../routes/tidings.js';

async function send(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  app.use('/api', tidingsRouter);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetAuthUserId.mockReset();
  mockRequireAdmin.mockReset();
  mockUuid.mockReset();

  mockGetAuthUserId.mockImplementation(() => 'user-1');
  mockRequireAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
  mockUuid.mockReturnValue('11111111-2222-3333-4444-555555555555');
});

describe('GET /api/tidings (public read)', () => {
  it('filters by audience based on the caller\u2019s session_players roles', async () => {
    const app = makeApp();
    // Step 1: role lookup → caller is a DM (not a player)
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'dm' }] });
    // Step 2: tidings list filtered by audience array
    mockQuery.mockResolvedValueOnce({
      rows: [
        sampleRow({ id: 't1', published_at: '2026-04-26T10:00:00Z' }),
        sampleRow({ id: 't2', published_at: '2026-04-25T10:00:00Z' }),
      ],
    });
    // Step 3: lastReadTidingsAt lookup → never read before
    mockQuery.mockResolvedValueOnce({ rows: [{ last_read_tidings_at: null }] });

    const { status, body } = await send(app, 'GET', '/api/tidings');

    expect(status).toBe(200);
    expect(body.tidings).toHaveLength(2);
    expect(body.unreadCount).toBe(2);

    // The audience filter should include 'all' + 'dm' but NOT 'player'.
    const tidingsCall = mockQuery.mock.calls[1];
    expect(tidingsCall[1][0]).toEqual(['all', 'dm']);
  });

  it('counts only tidings published AFTER the caller\u2019s lastReadAt as unread', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no roles → all-only audience
    mockQuery.mockResolvedValueOnce({
      rows: [
        sampleRow({ id: 'fresh', published_at: '2026-04-27T10:00:00Z' }),
        sampleRow({ id: 'stale', published_at: '2026-04-20T10:00:00Z' }),
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ last_read_tidings_at: '2026-04-25T00:00:00Z' }] });

    const { body } = await send(app, 'GET', '/api/tidings');
    expect(body.tidings).toHaveLength(2);
    expect(body.unreadCount).toBe(1); // only "fresh" was published after the read mark
    expect(body.lastReadAt).toBe('2026-04-25T00:00:00Z');
  });

  it('shapes rows with camelCase fields and pinned-as-boolean', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [sampleRow({ id: 't1', pinned: 1, expanded_body: 'long…', author_display_name: 'Alice' })],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ last_read_tidings_at: null }] });

    const { body } = await send(app, 'GET', '/api/tidings');
    const t = body.tidings[0];
    expect(t.pinned).toBe(true);
    expect(t.expandedBody).toBe('long…');
    expect(t.authorDisplayName).toBe('Alice');
    expect(t).not.toHaveProperty('expanded_body');
  });
});

describe('POST /api/tidings/mark-read', () => {
  it('issues a single UPDATE on the caller\u2019s row and returns ok', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { status, body } = await send(app, 'POST', '/api/tidings/mark-read');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE auth_users SET last_read_tidings_at/);
    expect(params).toEqual(['user-1']);
  });
});

describe('POST /api/admin/tidings (admin create)', () => {
  it('rejects payloads missing a title', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'POST', '/api/admin/tidings', {
      kind: 'patch',
      body: 'something happened',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid tiding payload');
  });

  it('inserts and echoes the new row back, persisting linked feedback ids', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [sampleRow({
        id: '11111111-2222-3333-4444-555555555555',
        kind: 'patch',
        title: 'Patch 0.7.3',
        linked_feedback_ids: ['ffffffff-1111-1111-1111-111111111111'],
      })],
    }); // SELECT after insert

    const { status, body } = await send(app, 'POST', '/api/admin/tidings', {
      kind: 'patch',
      title: 'Patch 0.7.3',
      body: 'New top-down map renderer.',
      versionTag: '0.7.3',
      pinned: true,
      linkedFeedbackIds: ['ffffffff-1111-1111-1111-111111111111'],
    });

    expect(status).toBe(201);
    expect(body.tiding.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(body.tiding.title).toBe('Patch 0.7.3');
    expect(body.tiding.kind).toBe('patch');
    expect(body.tiding.linkedFeedbackIds).toEqual(['ffffffff-1111-1111-1111-111111111111']);

    // INSERT call should bind the array to the linked_feedback_ids column.
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO tidings/);
    // Position of linked_feedback_ids in the param list — see the route.
    expect(params).toContain('11111111-2222-3333-4444-555555555555'); // id
    expect(params.some((p: any) => Array.isArray(p) && p.includes('ffffffff-1111-1111-1111-111111111111'))).toBe(true);
  });

  it('rejects malformed linkedFeedbackIds (non-uuid strings)', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'POST', '/api/admin/tidings', {
      kind: 'patch', title: 'X', body: 'Y',
      linkedFeedbackIds: ['not-a-uuid'],
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid tiding payload');
  });

  it('refuses non-admins via the requireAdmin middleware', async () => {
    const app = makeApp();
    mockRequireAdmin.mockImplementationOnce((_req: any, res: any) => {
      res.status(403).json({ error: 'Admin privileges required' });
    });
    const { status, body } = await send(app, 'POST', '/api/admin/tidings', {
      title: 'x', body: 'y',
    });
    expect(status).toBe(403);
    expect(body.error).toBe('Admin privileges required');
  });
});

describe('PATCH /api/admin/tidings/:id', () => {
  it('only sets columns that the caller actually sent', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow({ id: 'tx', pinned: 1 })] }); // SELECT after

    const { status, body } = await send(app, 'PATCH', '/api/admin/tidings/tx', {
      pinned: true,
    });

    expect(status).toBe(200);
    expect(body.tiding.id).toBe('tx');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE tidings SET pinned = \$1, updated_at = NOW\(\)::text WHERE id = \$2/);
    expect(params).toEqual([1, 'tx']);
  });

  it('short-circuits with ok when no fields are sent', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'PATCH', '/api/admin/tidings/tx', {});
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when the row vanished mid-flight', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE (no error if 0 affected)
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT after returns nothing

    const { status, body } = await send(app, 'PATCH', '/api/admin/tidings/gone', {
      title: 'Updated',
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Tiding not found');
  });
});

describe('DELETE /api/admin/tidings/:id', () => {
  it('hard-deletes and returns ok', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { status, body } = await send(app, 'DELETE', '/api/admin/tidings/tx');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockQuery).toHaveBeenCalledWith('DELETE FROM tidings WHERE id = $1', ['tx']);
  });
});

// ── Helpers ─────────────────────────────────────────────────────

function sampleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'row-id',
    kind: 'announcement',
    title: 'Sample',
    body: 'Sample body',
    expanded_body: null,
    audience: 'all',
    version_tag: null,
    published_at: '2026-04-27T00:00:00Z',
    expires_at: null,
    pinned: 0,
    linked_feedback_ids: null,
    discord_announced_at: null,
    discord_thread_url: null,
    created_by: 'user-1',
    author_display_name: null,
    created_at: '2026-04-27T00:00:00Z',
    updated_at: '2026-04-27T00:00:00Z',
    ...overrides,
  };
}
