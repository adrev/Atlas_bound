/**
 * Feedback router smoke tests.
 *
 * We exercise the router via Express's request pipeline using a tiny
 * supertest-style helper instead of the real `supertest` dep — keeps
 * test deps unchanged. The pool, requireAuth, requireAdmin
 * middleware, and uuid are stubbed so tests run without a DB or env.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

// ── Hoisted mocks ───────────────────────────────────────────────
// `vi.hoisted` is required because `vi.mock` is hoisted above the
// imports below — referencing the mocks inside the factory needs them
// declared in the same hoisted block.
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
vi.mock('uuid', () => ({ v4: () => mockUuid() }));

import feedbackRouter from '../routes/feedback.js';

// ── Tiny helper: send a request to an Express router and capture JSON.
async function send(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          method,
          host: '127.0.0.1',
          port,
          path,
          headers: body ? { 'Content-Type': 'application/json' } : {},
        },
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
  app.use('/api', feedbackRouter);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetAuthUserId.mockReset();
  mockRequireAdmin.mockReset();
  mockUuid.mockReset();

  // Default behaviour: caller is signed-in as user-1 and is an admin.
  mockGetAuthUserId.mockImplementation(() => 'user-1');
  mockRequireAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
  mockUuid.mockReturnValue('00000000-0000-0000-0000-000000000000');
});

describe('POST /api/feedback', () => {
  it('rejects payloads with missing or short content', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'POST', '/api/feedback', {
      category: 'bug',
      content: 'too', // only 3 chars; schema requires 5
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid feedback payload');
  });

  it('inserts a feedback row when the payload is valid', async () => {
    const app = makeApp();
    // Rate-limit count query: 0 recent submissions
    mockQuery.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    // Insert query: no row needed in response
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { status, body } = await send(app, 'POST', '/api/feedback', {
      category: 'feature',
      content: 'The wiki search would be much faster with prefix matching.',
      anonymous: false,
    });

    expect(status).toBe(201);
    expect(body).toEqual({ id: '00000000-0000-0000-0000-000000000000' });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const insertCall = mockQuery.mock.calls[1];
    // Insert SQL targets the feedback table and binds 10 positional params.
    expect(insertCall[0]).toMatch(/INSERT INTO feedback/);
    expect(insertCall[1]).toHaveLength(10);
    expect(insertCall[1][0]).toBe('00000000-0000-0000-0000-000000000000'); // id
    expect(insertCall[1][1]).toBe('user-1');                               // user_id
    expect(insertCall[1][3]).toBe('feature');                              // category
    expect(insertCall[1][9]).toBe(0);                                      // anonymous flag
  });

  it('returns 429 once the daily submission cap is reached', async () => {
    const app = makeApp();
    // Already at the cap — 5 prior rows in the last 24 h.
    mockQuery.mockResolvedValueOnce({ rows: [{ n: 5 }] });

    const { status, body } = await send(app, 'POST', '/api/feedback', {
      category: 'other',
      content: 'Cap test — should be rejected as rate-limited.',
    });

    expect(status).toBe(429);
    expect(body.limit).toBe(5);
    // Insert was never attempted because the cap query short-circuited.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/admin/feedback', () => {
  it('returns rows with anonymous fields nulled out', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'f1',
          user_id: 'u1',
          session_id: null,
          category: 'bug',
          content: 'Crash on load',
          page_url: '/session/AB12',
          browser: 'Chrome',
          app_version: '1.0.0',
          screenshot_url: null,
          anonymous: 1,
          status: 'open',
          admin_notes: null,
          created_at: '2026-04-23T10:00:00Z',
          updated_at: '2026-04-23T10:00:00Z',
          user_display_name: 'Alice',
          user_email: 'alice@example.com',
        },
      ],
    });

    const { status, body } = await send(app, 'GET', '/api/admin/feedback?status=open');
    expect(status).toBe(200);
    expect(body.feedback).toHaveLength(1);
    const row = body.feedback[0];
    // Anonymous flag scrubs identity fields; preserves content + status.
    expect(row.anonymous).toBe(true);
    expect(row.userId).toBeNull();
    expect(row.userEmail).toBeNull();
    expect(row.userDisplayName).toBe('(anonymous)');
    expect(row.content).toBe('Crash on load');
    expect(row.status).toBe('open');
  });

  it('rejects non-admins via requireAdmin middleware', async () => {
    const app = makeApp();
    // Override middleware to deny.
    mockRequireAdmin.mockImplementationOnce((_req: any, res: any) => {
      res.status(403).json({ error: 'Admin privileges required' });
    });

    const { status, body } = await send(app, 'GET', '/api/admin/feedback');
    expect(status).toBe(403);
    expect(body.error).toBe('Admin privileges required');
  });
});

describe('PATCH /api/admin/feedback/:id', () => {
  it('updates status + adminNotes and returns ok', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { status, body } = await send(app, 'PATCH', '/api/admin/feedback/abc', {
      status: 'planned',
      adminNotes: 'Scheduled for next sprint',
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE feedback SET/);
    expect(params).toContain('planned');
    expect(params).toContain('Scheduled for next sprint');
    expect(params[params.length - 1]).toBe('abc'); // id is last positional param
  });

  it('short-circuits with ok=true when no fields are provided', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'PATCH', '/api/admin/feedback/abc', {});
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    // No DB write attempted.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid status value with 400', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'PATCH', '/api/admin/feedback/abc', {
      status: 'totally-fake',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid update payload');
  });
});
