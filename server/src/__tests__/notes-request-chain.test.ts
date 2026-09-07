import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';

const { mockQuery, readSessionCookie, validateSession } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  readSessionCookie: vi.fn(),
  validateSession: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../auth/lucia.js', () => ({ lucia: { readSessionCookie, validateSession } }));

import notesRouter from '../routes/notes.js';
import { requireAuth } from '../auth/middleware.js';

const members = new Map<string, string>();
const note = { session_id: 'campaign', created_by: 'author', is_shared: 1 };

function app() {
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth, notesRouter);
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  members.clear();
  members.set('author', 'player');
  members.set('dm', 'dm');
  members.set('other', 'player');
  readSessionCookie.mockImplementation(
    (cookie: string) => /auth_session=([^;]+)/.exec(cookie)?.[1] ?? null
  );
  validateSession.mockImplementation(async (id: string) =>
    id === 'expired'
      ? { session: null, user: null }
      : { session: { id, userId: id, fresh: false }, user: { id } }
  );
  mockQuery.mockImplementation(async (sql: string, params: string[]) => {
    if (sql.startsWith('SELECT session_id, created_by')) {
      return { rows: params[0] === 'note' ? [note] : [] };
    }
    if (sql.startsWith('SELECT 1 FROM session_players')) {
      const role = params[0] === 'campaign' ? members.get(params[1]) : undefined;
      return { rows: role && (!sql.includes("role = 'dm'") || role === 'dm') ? [{ ok: 1 }] : [] };
    }
    if (/^(UPDATE|DELETE FROM) session_notes/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
});

function mutate(method: 'put' | 'delete', user: string | null, id = 'note') {
  const req = supertest(app())[method](`/api/notes/${id}`);
  if (user) req.set('Cookie', `auth_session=${user}`);
  return method === 'put' ? req.send({ content: 'Updated content', isShared: true }) : req;
}

function mutations() {
  return mockQuery.mock.calls.filter(([sql]) => /^(UPDATE|DELETE FROM) session_notes/.test(sql));
}

describe.each(['put', 'delete'] as const)('note %s request chain', (method) => {
  it.each([null, 'expired'])('rejects unauthenticated or expired sessions (%s)', async (user) => {
    expect((await mutate(method, user)).status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a removed author even when the DM previously shared the note', async () => {
    members.delete('author');
    const read = await supertest(app())
      .get('/api/sessions/campaign/notes')
      .set('Cookie', 'auth_session=author');
    expect(read.status).toBe(403);
    expect((await mutate(method, 'author')).status).toBe(403);
    expect(mutations()).toHaveLength(0);
  });

  it('rejects an unrelated current member', async () => {
    expect((await mutate(method, 'other')).status).toBe(403);
    expect(mutations()).toHaveLength(0);
  });

  it.each(['author', 'dm'])('allows a current authorized member (%s)', async (user) => {
    expect((await mutate(method, user)).status).toBe(200);
    expect(mutations()).toHaveLength(1);
    if (method === 'put') {
      expect(mutations()[0][0].includes('is_shared =')).toBe(user === 'dm');
    }
  });

  it('preserves missing-note 404 responses', async () => {
    expect((await mutate(method, 'author', 'missing')).status).toBe(404);
    expect(mutations()).toHaveLength(0);
  });
});
