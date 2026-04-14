import { describe, it, expect, vi } from 'vitest';

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
});
