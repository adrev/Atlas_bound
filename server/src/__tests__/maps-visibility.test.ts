import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock the DB pool. vi.hoisted ensures mockQuery exists when vi.mock runs.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

// Avoid pulling multer into the test runtime — its request handlers aren't
// exercised here, and it requires real fs paths in some setups.
vi.mock('../routes/uploads.js', () => ({
  mapUpload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  validateAndSaveUpload: () => 'stub.png',
}));

import mapsRouter from '../routes/maps.js';

// The router registers handlers on an internal stack; pull them out by path.
type Layer = {
  route?: { path: string; stack: Array<{ method: string; handle: (req: Request, res: Response, next?: (err?: unknown) => void) => unknown }>; methods: Record<string, boolean> };
};

function getHandler(method: string, path: string): (req: Request, res: Response) => Promise<unknown> | unknown {
  const layers = (mapsRouter as unknown as { stack: Layer[] }).stack;
  for (const l of layers) {
    if (l.route && l.route.path === path && l.route.methods[method]) {
      // Last layer in the route stack is the actual handler.
      const last = l.route.stack[l.route.stack.length - 1];
      return last.handle as (req: Request, res: Response) => Promise<unknown> | unknown;
    }
  }
  throw new Error(`handler not found for ${method.toUpperCase()} ${path}`);
}

function makeRes() {
  const res: Partial<Response> & { statusCode: number; body: unknown } = {
    statusCode: 200,
    body: undefined,
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res as Response;
  }) as unknown as Response['json'];
  return res as Response & { statusCode: number; body: unknown };
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId/maps — DM vs player visibility
// ---------------------------------------------------------------------------
describe('GET /sessions/:sessionId/maps visibility', () => {
  const handler = getHandler('get', '/sessions/:sessionId/maps');

  it('DM receives every map in the session', async () => {
    // 1. assertSessionMember — member row exists
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // 2. role lookup → dm
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'dm' }] });
    // 3. full map list
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'm1', session_id: 's1', name: 'Prep Dungeon', image_url: null, width: 10, height: 10, grid_size: 70, grid_type: 'square', created_at: 'now' },
        { id: 'm2', session_id: 's1', name: 'Active Tavern', image_url: null, width: 10, height: 10, grid_size: 70, grid_type: 'square', created_at: 'now' },
      ],
    });

    const req = { user: { id: 'dm-user' }, params: { sessionId: 's1' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as Array<{ id: string }>;
    expect(body.map(m => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('player only receives the currently active player map', async () => {
    // 1. member check passes
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // 2. role → player
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'player' }] });
    // 3. session lookup → player_map_id = m2
    mockQuery.mockResolvedValueOnce({ rows: [{ player_map_id: 'm2', current_map_id: 'm2' }] });
    // 4. single-map lookup
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'm2', session_id: 's1', name: 'Active Tavern', image_url: null, width: 10, height: 10, grid_size: 70, grid_type: 'square', created_at: 'now' },
      ],
    });

    const req = { user: { id: 'player-user' }, params: { sessionId: 's1' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('m2');
  });

  it('player receives empty list when no player map is set', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'player' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ player_map_id: null, current_map_id: null }] });

    const req = { user: { id: 'player-user' }, params: { sessionId: 's1' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('falls back to current_map_id when player_map_id is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'player' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ player_map_id: null, current_map_id: 'm3' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'm3', session_id: 's1', name: 'Fallback', image_url: null, width: 10, height: 10, grid_size: 70, grid_type: 'square', created_at: 'now' },
      ],
    });

    const req = { user: { id: 'player-user' }, params: { sessionId: 's1' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as Array<{ id: string }>;
    expect(body[0].id).toBe('m3');
  });
});

// ---------------------------------------------------------------------------
// GET /api/maps/:id — per-map access check
// ---------------------------------------------------------------------------
describe('GET /maps/:id visibility', () => {
  const handler = getHandler('get', '/maps/:id');

  it('returns 403 when a player requests a non-active map', async () => {
    // 1. maps row lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm-prep', session_id: 's1', name: 'Prep', image_url: null,
        width: 10, height: 10, grid_size: 70, grid_type: 'square',
        grid_offset_x: 0, grid_offset_y: 0,
        walls: '[]', fog_state: '[]', created_at: 'now',
      }],
    });
    // 2. assertSessionMember → OK
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // 3. role → player
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'player' }] });
    // 4. sessions lookup → active map is different
    mockQuery.mockResolvedValueOnce({ rows: [{ player_map_id: 'm-active', current_map_id: 'm-active' }] });

    const req = { user: { id: 'player-user' }, params: { id: 'm-prep' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Not authorized to view this map' });
  });

  it('allows a player to fetch the currently active map', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm-active', session_id: 's1', name: 'Active', image_url: null,
        width: 10, height: 10, grid_size: 70, grid_type: 'square',
        grid_offset_x: 0, grid_offset_y: 0,
        walls: '[]', fog_state: '[]', created_at: 'now',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'player' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ player_map_id: 'm-active', current_map_id: 'm-active' }] });
    // tokens lookup
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = { user: { id: 'player-user' }, params: { id: 'm-active' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { id: string };
    expect(body.id).toBe('m-active');
  });

  it('allows a DM to fetch any map in their session', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm-prep', session_id: 's1', name: 'Prep', image_url: null,
        width: 10, height: 10, grid_size: 70, grid_type: 'square',
        grid_offset_x: 0, grid_offset_y: 0,
        walls: '[]', fog_state: '[]', created_at: 'now',
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'dm' }] });
    // No session-map lookup for DMs; go straight to tokens.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = { user: { id: 'dm-user' }, params: { id: 'm-prep' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { id: string };
    expect(body.id).toBe('m-prep');
  });
});
