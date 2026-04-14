import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';

// Mock the database connection module before importing anything that uses it.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import {
  getAuthUserId,
  assertSessionMember,
  assertSessionDM,
} from '../utils/authorization.js';
import { requireAdmin } from '../auth/admin.js';

beforeEach(() => {
  mockQuery.mockReset();
});

/**
 * Helper: build a minimal Express app that injects a pretend req.user
 * (or none) so we can exercise the real authorization helpers exactly
 * the way the production routes do — without pulling in Lucia / cookies.
 */
function buildApp(authedUser: { id: string; email?: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: unknown }).user = authedUser;
    next();
  });
  return app;
}

/**
 * Mirrors the policy in GET /api/sessions/:id/maps (see routes/maps.ts).
 * Returns only the active player-facing map for players; returns all maps
 * for the DM. Verifies the authz layering (session-membership + role).
 */
function mountSessionMapsGet(app: express.Express) {
  app.get(
    '/api/sessions/:sessionId/maps',
    async (req: Request, res: Response) => {
      try {
        const userId = getAuthUserId(req);
        const sessionId = String(req.params.sessionId);
        await assertSessionMember(sessionId, userId);

        const pool = (await import('../db/connection.js')).default;
        const { rows: roleRows } = await pool.query('role-lookup', [
          sessionId,
          userId,
        ]);
        const isDM = roleRows[0]?.role === 'dm';

        if (isDM) {
          const { rows } = await pool.query('dm-maps-sql', [sessionId]);
          res.json(rows);
          return;
        }
        const { rows: playerRows } = await pool.query('player-map-sql', [
          sessionId,
        ]);
        res.json(playerRows);
      } catch (err) {
        const e = err as Error & { status?: number };
        res.status(e.status ?? 500).json({ error: e.message });
      }
    },
  );
}

/**
 * Mirrors a DM-only endpoint: uses assertSessionDM after auth.
 */
function mountDmOnlyEndpoint(app: express.Express) {
  app.post(
    '/api/sessions/:sessionId/dm-action',
    async (req: Request, res: Response) => {
      try {
        const userId = getAuthUserId(req);
        const sessionId = String(req.params.sessionId);
        await assertSessionDM(sessionId, userId);
        res.json({ ok: true });
      } catch (err) {
        const e = err as Error & { status?: number };
        res.status(e.status ?? 500).json({ error: e.message });
      }
    },
  );
}

function mountAdminEndpoint(app: express.Express) {
  app.post('/api/compendium/sync', requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated requests to protected endpoints → 401
// ---------------------------------------------------------------------------
describe('Integration: unauthenticated requests to protected endpoints', () => {
  it('GET /api/sessions/:id/maps returns 401 when req.user is missing', async () => {
    const app = buildApp(null);
    mountSessionMapsGet(app);
    const res = await supertest(app).get('/api/sessions/sess-1/maps');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
    // Should NEVER hit the DB because auth short-circuits.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('POST /api/sessions/:id/dm-action returns 401 when unauthenticated', async () => {
    const app = buildApp(null);
    mountDmOnlyEndpoint(app);
    const res = await supertest(app).post('/api/sessions/sess-1/dm-action');
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Non-DM trying to access DM-only endpoints → 403
// ---------------------------------------------------------------------------
describe('Integration: non-DM accessing DM-only endpoint', () => {
  it('returns 403 when a logged-in player hits a DM endpoint', async () => {
    const app = buildApp({ id: 'player-1' });
    mountDmOnlyEndpoint(app);
    // assertSessionDM executes a SELECT ... AND role='dm' query. Empty rows
    // means the caller is not the DM.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await supertest(app).post('/api/sessions/sess-1/dm-action');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only the DM can perform this action');
  });

  it('returns 200 when the actual DM hits the DM endpoint', async () => {
    const app = buildApp({ id: 'dm-user' });
    mountDmOnlyEndpoint(app);
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const res = await supertest(app).post('/api/sessions/sess-1/dm-action');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-session isolation: player in session A cannot read session B's maps
// ---------------------------------------------------------------------------
describe('Integration: cross-session isolation', () => {
  it('player from session A requesting session B maps gets 403', async () => {
    const app = buildApp({ id: 'player-from-A' });
    mountSessionMapsGet(app);
    // assertSessionMember for session B returns empty rows → 403.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await supertest(app).get('/api/sessions/sess-B/maps');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not a member of this session');
  });

  it('DM of a session gets the full map list', async () => {
    const app = buildApp({ id: 'dm-user' });
    mountSessionMapsGet(app);
    // 1. member lookup → ok
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // 2. role lookup → dm
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'dm' }] });
    // 3. dm maps fetch
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'map-1' }, { id: 'map-2' }, { id: 'map-3' }],
    });

    const res = await supertest(app).get('/api/sessions/sess-1/maps');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('player gets only the active player-facing map, not all maps', async () => {
    const app = buildApp({ id: 'player-1' });
    mountSessionMapsGet(app);
    // member ok
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // role: player
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'player' }] });
    // player-map fetch: only the active map row
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'active-map' }] });

    const res = await supertest(app).get('/api/sessions/sess-1/maps');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('active-map');
  });
});

// ---------------------------------------------------------------------------
// 4. Admin-only endpoints (compendium sync) — requireAdmin middleware
// ---------------------------------------------------------------------------
describe('Integration: admin-only endpoint (requireAdmin)', () => {
  const originalAdminIds = process.env.ADMIN_USER_IDS;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.ADMIN_USER_IDS = originalAdminIds;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when unauthenticated', async () => {
    process.env.ADMIN_USER_IDS = 'admin-user';
    const app = buildApp(null);
    mountAdminEndpoint(app);
    const res = await supertest(app).post('/api/compendium/sync');
    expect(res.status).toBe(401);
  });

  it('returns 403 for authenticated non-admin user', async () => {
    process.env.ADMIN_USER_IDS = 'admin-user';
    const app = buildApp({ id: 'random-user', email: 'x@example.com' });
    mountAdminEndpoint(app);
    const res = await supertest(app).post('/api/compendium/sync');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin privileges required');
  });

  it('returns 200 for admin matched by id', async () => {
    process.env.ADMIN_USER_IDS = 'admin-user';
    const app = buildApp({ id: 'admin-user' });
    mountAdminEndpoint(app);
    const res = await supertest(app).post('/api/compendium/sync');
    expect(res.status).toBe(200);
  });

  it('returns 200 for admin matched by email', async () => {
    process.env.ADMIN_USER_IDS = 'admin@example.com';
    const app = buildApp({ id: 'some-id', email: 'admin@example.com' });
    mountAdminEndpoint(app);
    const res = await supertest(app).post('/api/compendium/sync');
    expect(res.status).toBe(200);
  });

  it('returns 403 when ADMIN_USER_IDS is empty and NODE_ENV=production', async () => {
    process.env.ADMIN_USER_IDS = '';
    process.env.NODE_ENV = 'production';
    const app = buildApp({ id: 'some-user' });
    mountAdminEndpoint(app);
    const res = await supertest(app).post('/api/compendium/sync');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin access not configured');
  });
});
