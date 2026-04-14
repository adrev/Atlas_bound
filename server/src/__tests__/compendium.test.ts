import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DB connection so importing the router doesn't require Postgres.
vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// Mock the Open5e service (only signatures needed for the module to load).
vi.mock('../services/Open5eService.js', () => ({
  isCompendiumSeeded: vi.fn().mockResolvedValue(true),
  getCompendiumStats: vi.fn().mockResolvedValue({ monsters: 0, spells: 0, items: 0 }),
  reseedCompendium: vi.fn().mockResolvedValue(undefined),
}));

// Keep the real auth middleware import so we can assert it is in the stack.
import { requireAuth } from '../auth/middleware.js';
import { requireAdmin } from '../auth/admin.js';
import compendiumRouter from '../routes/compendium.js';

type LayerLike = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown; name?: string }>;
  };
};

function findRoute(method: string, routePath: string) {
  const stack = (compendiumRouter as unknown as { stack: LayerLike[] }).stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    if (layer.route.path === routePath && layer.route.methods[method.toLowerCase()]) {
      return layer.route;
    }
  }
  return undefined;
}

describe('compendium router security', () => {
  it('POST /sync has requireAuth middleware in its handler stack', () => {
    const route = findRoute('post', '/sync');
    expect(route, 'POST /sync route should exist').toBeDefined();
    const handlers = route!.stack.map((s) => s.handle);
    expect(handlers).toContain(requireAuth);
  });

  it('POST /monsters/:slug/token-image has requireAuth middleware in its handler stack', () => {
    const route = findRoute('post', '/monsters/:slug/token-image');
    expect(route, 'POST /monsters/:slug/token-image route should exist').toBeDefined();
    const handlers = route!.stack.map((s) => s.handle);
    expect(handlers).toContain(requireAuth);
  });

  it('GET routes remain public (no requireAuth in stack)', () => {
    // Sanity check a representative read-only endpoint.
    const route = findRoute('get', '/search');
    expect(route, 'GET /search route should exist').toBeDefined();
    const handlers = route!.stack.map((s) => s.handle);
    expect(handlers).not.toContain(requireAuth);
  });

  it('POST /sync has requireAdmin middleware in its handler stack', () => {
    const route = findRoute('post', '/sync');
    const handlers = route!.stack.map((s) => s.handle);
    expect(handlers).toContain(requireAdmin);
  });

  it('POST /monsters/:slug/token-image has requireAdmin middleware in its handler stack', () => {
    const route = findRoute('post', '/monsters/:slug/token-image');
    const handlers = route!.stack.map((s) => s.handle);
    expect(handlers).toContain(requireAdmin);
  });
});

// -----------------------------------------------------------------------
// requireAdmin behaviour — verifies non-admin authenticated users get 403.
// -----------------------------------------------------------------------
describe('requireAdmin middleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = 'admin-user-1,admin@example.com';
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  type FakeRes = {
    statusCode?: number;
    body?: unknown;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };

  function makeRes(): FakeRes {
    const res = {} as FakeRes;
    res.status = vi.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = vi.fn().mockImplementation((body: unknown) => {
      res.body = body;
      return res;
    });
    return res;
  }

  type FakeReq = { user?: { id?: string; email?: string | null } };

  function callRequireAdmin(req: FakeReq, res: FakeRes, next: () => void) {
    // Cast only at the boundary — keeps the rest of the test strongly typed.
    (requireAdmin as unknown as (
      r: FakeReq,
      s: FakeRes,
      n: () => void,
    ) => void)(req, res, next);
  }

  it('returns 403 for a non-admin authenticated user', () => {
    const req: FakeReq = { user: { id: 'regular-user', email: 'user@example.com' } };
    const res = makeRes();
    const next = vi.fn();
    callRequireAdmin(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Admin privileges required' });
  });

  it('calls next() for an admin (matched by id)', () => {
    const req: FakeReq = { user: { id: 'admin-user-1', email: 'anything@example.com' } };
    const res = makeRes();
    const next = vi.fn();
    callRequireAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() for an admin (matched by email)', () => {
    const req: FakeReq = { user: { id: 'some-id', email: 'admin@example.com' } };
    const res = makeRes();
    const next = vi.fn();
    callRequireAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when req.user is missing', () => {
    const req: FakeReq = {};
    const res = makeRes();
    const next = vi.fn();
    callRequireAdmin(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses access when ADMIN_USER_IDS is empty in production', () => {
    process.env.ADMIN_USER_IDS = '';
    const req: FakeReq = { user: { id: 'anyone', email: 'a@b.c' } };
    const res = makeRes();
    const next = vi.fn();
    callRequireAdmin(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows access with a warning when ADMIN_USER_IDS is empty in non-production', () => {
    process.env.ADMIN_USER_IDS = '';
    process.env.NODE_ENV = 'development';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req: FakeReq = { user: { id: 'anyone', email: 'a@b.c' } };
    const res = makeRes();
    const next = vi.fn();
    callRequireAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
