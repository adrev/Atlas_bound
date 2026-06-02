import { describe, it, expect, vi } from 'vitest';
import type { Router } from 'express';
import {
  PRIVATE_NO_STORE,
  PUBLIC_COMPENDIUM_CACHE,
  privateNoStoreCache,
  publicCompendiumCache,
  setPrivateNoStore,
  setPublicCompendiumCache,
} from '../utils/cacheHeaders.js';

vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock('../services/Open5eService.js', () => ({
  isCompendiumSeeded: vi.fn().mockResolvedValue(true),
  getCompendiumStats: vi.fn().mockResolvedValue({ monsters: 0, spells: 0, items: 0 }),
  reseedCompendium: vi.fn().mockResolvedValue(undefined),
}));

import sessionsRouter from '../routes/sessions.js';
import charactersRouter from '../routes/characters.js';
import customContentRouter from '../routes/customContent.js';
import compendiumRouter from '../routes/compendium.js';

type LayerLike = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
};

function findRoute(router: Router, method: string, routePath: string) {
  const stack = (router as unknown as { stack: LayerLike[] }).stack;
  return stack
    .map((layer) => layer.route)
    .find((route) => route?.path === routePath && route.methods[method.toLowerCase()]);
}

function expectRouteHasHandler(router: Router, method: string, routePath: string, handler: unknown) {
  const route = findRoute(router, method, routePath);
  expect(route, `${method.toUpperCase()} ${routePath} should exist`).toBeDefined();
  expect(route!.stack.map((entry) => entry.handle)).toContain(handler);
}

describe('cache header helpers', () => {
  it('sets private no-store for user/session scoped responses', () => {
    const headers = new Map<string, string>();
    setPrivateNoStore({
      setHeader: (name: string, value: string) => headers.set(name, value),
    } as never);
    expect(headers.get('Cache-Control')).toBe(PRIVATE_NO_STORE);
  });

  it('sets public short-lived cache for global compendium reads', () => {
    const headers = new Map<string, string>();
    setPublicCompendiumCache({
      setHeader: (name: string, value: string) => headers.set(name, value),
    } as never);
    expect(headers.get('Cache-Control')).toBe(PUBLIC_COMPENDIUM_CACHE);
  });
});

describe('route cache policies', () => {
  it('marks session and character reads as private no-store', () => {
    expectRouteHasHandler(sessionsRouter, 'get', '/mine', privateNoStoreCache);
    expectRouteHasHandler(charactersRouter, 'get', '/', privateNoStoreCache);
    expectRouteHasHandler(charactersRouter, 'get', '/:id', privateNoStoreCache);
  });

  it('marks custom content reads as private no-store because they are session-scoped', () => {
    for (const routePath of ['/monsters', '/monsters/:slug', '/spells', '/spells/:slug', '/items', '/items/:id']) {
      expectRouteHasHandler(customContentRouter, 'get', routePath, privateNoStoreCache);
    }
  });

  it('marks public compendium reads as public cacheable', () => {
    for (const routePath of [
      '/search',
      '/monsters',
      '/monsters/:slug',
      '/monsters/:slug/versions',
      '/spells',
      '/spells/:slug',
      '/items',
      '/items/:slug',
      '/status',
    ]) {
      expectRouteHasHandler(compendiumRouter, 'get', routePath, publicCompendiumCache);
    }
  });
});
