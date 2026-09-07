import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { config, mockQuery, readSessionCookie, validateSession } = vi.hoisted(() => ({
  config: { root: '', bucket: '' },
  mockQuery: vi.fn(),
  readSessionCookie: vi.fn(),
  validateSession: vi.fn(),
}));
vi.mock('../config.js', () => ({
  get UPLOAD_DIR() {
    return config.root;
  },
  get UPLOAD_GCS_BUCKET() {
    return config.bucket;
  },
}));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../auth/lucia.js', () => ({ lucia: { readSessionCookie, validateSession } }));

const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fixtures = [
  'tokens/public.png',
  'spells/public.png',
  'items/public.png',
  'handouts/public.png',
  'maps/active map.png',
  'maps/prep.png',
  'maps/foreign.png',
  'maps/thumbnails/active.jpg',
  'maps/thumbnails/foreign.jpg',
  'portraits/shared.png',
  'portraits/foreign.png',
  'private/foreign.png',
];

describe.each(['local', 'gcs', 'gcs-fallback'] as const)('upload request chain: %s', (storage) => {
  let server: Server;
  let fetchMock: ReturnType<typeof vi.fn>;
  let objectNames: string[];

  beforeEach(async () => {
    config.root = mkdtempSync(path.join(tmpdir(), 'atlas-upload-acl-'));
    config.bucket = storage === 'local' ? '' : 'test-private-bucket';
    for (const file of fixtures) {
      const filename = path.join(config.root, file);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, imageBytes);
    }
    readSessionCookie.mockImplementation(
      (cookie: string) => /auth_session=([^;]+)/.exec(cookie)?.[1] ?? null
    );
    validateSession.mockImplementation(async (id: string) =>
      id === 'expired'
        ? { session: null, user: null }
        : { session: { id, userId: id }, user: { id } }
    );
    mockQuery.mockImplementation(async (sql: string, [url, userId]: string[]) => {
      const ownMap =
        url === '/uploads/maps/active map.png' || url === '/uploads/maps/thumbnails/active.jpg';
      const prepMap = url === '/uploads/maps/prep.png';
      const sharedPortrait = url === '/uploads/portraits/shared.png';
      expect(sql).toMatch(/FROM (maps m|characters c)/);
      const allowed = sharedPortrait || ownMap || (prepMap && userId === 'dm');
      return { rows: allowed && (userId === 'dm' || userId === 'player') ? [{ ok: 1 }] : [] };
    });
    objectNames = [];
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'metadata.google.internal') {
        return new Response(JSON.stringify({ access_token: 'fixture', expires_in: 300 }));
      }
      expect(url.hostname).toBe('storage.googleapis.com');
      const objectName = decodeURIComponent(url.pathname.split('/o/')[1]);
      objectNames.push(objectName);
      if (storage === 'gcs-fallback' || !fixtures.includes(objectName.slice('uploads/'.length))) {
        return new Response('', { status: 404 });
      }
      return new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { createUploadRouter } = await import('../utils/serveUploads.js');
    const app = express();
    app.use('/uploads', createUploadRouter());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
  });

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    rmSync(config.root, { recursive: true, force: true });
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // A raw HTTP path is intentional: URL-based clients may normalize the
  // attack before it reaches Express, accidentally testing a different URL.
  function get(rawPath: string, user: string | null = 'player') {
    return new Promise<{
      status: number;
      body: Buffer;
      headers: import('node:http').IncomingHttpHeaders;
    }>((resolve, reject) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: rawPath,
          headers: user ? { Cookie: `auth_session=${user}` } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it.each([
    '/tokens/%2e%2e/maps/foreign.png',
    '/tokens/%2E./maps/foreign.png',
    '/tokens/%2e%2e%2fmaps/foreign.png',
    '/items/%2e%2e/maps/thumbnails/foreign.jpg',
    '/spells/%2e%2e/portraits/foreign.png',
    '/handouts/%2e%2e/private/foreign.png',
    '/tokens/%252e%252e/maps/foreign.png',
    '/tokens/%252e%252e%252fmaps/foreign.png',
    '/tokens/%5c..%5cmaps/foreign.png',
    '/tokens/../maps/foreign.png',
    '/tokens/./public.png',
    '/maps//foreign.png',
    '/maps/foreign.png%00',
    '/maps/%ZZ.png',
  ])('rejects %s before any storage lookup', async (attack) => {
    const result = await get(`/uploads${attack}`);
    expect(result.status).toBe(400);
    expect(result.body.equals(imageBytes)).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/maps/foreign.png',
    '/%6daps/foreign.png',
    '/maps/thumbnails/foreign.jpg',
    '/portraits/foreign.png',
  ])('denies unauthorized canonical or encoded namespace %s', async (asset) => {
    expect((await get(`/uploads${asset}`)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([null, 'expired'])('requires a valid session (%s)', async (user) => {
    expect((await get('/uploads/tokens/public.png', user)).status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['tokens', 'spells', 'items', 'handouts'])(
    'preserves authenticated %s reads',
    async (folder) => {
      const result = await get(`/uploads/${folder}/public.png`);
      expect(result.status).toBe(200);
      expect(result.body).toEqual(imageBytes);
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );

  it('uses the same decoded map URL for ACL, GCS object, and local fallback', async () => {
    const result = await get('/uploads/%6daps/active%20map.png?version=1');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(imageBytes);
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('m.image_url = $1'), [
      '/uploads/maps/active map.png',
      'player',
    ]);
    expect(objectNames).toEqual(storage === 'local' ? [] : ['uploads/maps/active map.png']);
  });

  it('preserves thumbnail, shared portrait, and DM-only prep access', async () => {
    for (const asset of ['/maps/thumbnails/active.jpg', '/portraits/shared.png']) {
      expect((await get(`/uploads${asset}`)).body).toEqual(imageBytes);
    }
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('m.thumbnail_url = $1'), [
      '/uploads/maps/thumbnails/active.jpg',
      'player',
    ]);
    expect((await get('/uploads/maps/prep.png')).status).toBe(403);
    expect((await get('/uploads/maps/prep.png', 'dm')).status).toBe(200);
  });

  it('keeps unknown namespaces default-denied', async () => {
    expect((await get('/uploads/private/foreign.png')).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
