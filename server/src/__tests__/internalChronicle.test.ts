/**
 * Internal Chronicle worker endpoints — same harness pattern as the
 * other route tests (mock pg pool, drive via http, no real network).
 *
 * Token gating: the env var is set inside vi.hoisted so the route
 * module reads the test value at import time. Tests then exercise
 * the missing/wrong/right header cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

const { mockQuery, env } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  env: { CHRONICLE_WORKER_TOKEN: 'test-secret' },
}));

vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

// Set env BEFORE importing the route — module reads it at top level.
process.env.CHRONICLE_WORKER_TOKEN = env.CHRONICLE_WORKER_TOKEN;
const internalRouter = (await import('../routes/internalChronicle.js')).default;

async function send(
  app: express.Express,
  method: 'POST',
  path: string,
  options: { body?: unknown; auth?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  try {
    return await new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.body) headers['Content-Type'] = 'application/json';
      if (options.auth) headers['Authorization'] = options.auth;
      const req = http.request(
        { method, host: '127.0.0.1', port, path, headers },
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
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    });
  } finally {
    server.close();
  }
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', internalRouter);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ── Auth gate ────────────────────────────────────────────────────

describe('worker token gate', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const app = makeApp();
    const { status } = await send(app, 'POST', '/api/internal/chronicle/jobs/claim');
    expect(status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is wrong', async () => {
    const app = makeApp();
    const { status } = await send(app, 'POST', '/api/internal/chronicle/jobs/claim', {
      auth: 'Bearer wrong-secret',
    });
    expect(status).toBe(401);
  });

  it('passes through with a correct token', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { status } = await send(app, 'POST', '/api/internal/chronicle/jobs/claim', {
      auth: 'Bearer test-secret',
    });
    expect(status).toBe(204);
  });
});

// ── POST /jobs/claim ─────────────────────────────────────────────

describe('POST /api/internal/chronicle/jobs/claim', () => {
  it('returns 204 when no pending rows are available', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await send(app, 'POST', '/api/internal/chronicle/jobs/claim', {
      auth: 'Bearer test-secret',
    });
    expect(status).toBe(204);
    expect(body).toEqual({});
  });

  it('returns the claimed job and flips status to generating atomically', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'entry-1',
        campaign_id: 'sess-A',
        sequence_number: 7,
        raw_transcript: '<Liraya>: hi\n[Roll] Liraya rolled 17 on Stealth',
        session_started_at: '2026-04-29T18:00:00Z',
        session_ended_at: '2026-04-29T20:30:00Z',
        campaign_name: 'Mists of Thornreach',
        party_names: ['Liraya', 'Bren'],
      }],
    });

    const { status, body } = await send(app, 'POST', '/api/internal/chronicle/jobs/claim', {
      auth: 'Bearer test-secret',
    });
    expect(status).toBe(200);
    expect(body.job).toMatchObject({
      id: 'entry-1',
      campaignId: 'sess-A',
      campaignName: 'Mists of Thornreach',
      sequenceNumber: 7,
      partyNames: ['Liraya', 'Bren'],
    });

    // The SQL must use FOR UPDATE SKIP LOCKED so two workers can't
    // claim the same row in parallel.
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/SET status = 'generating'/);
  });
});

// ── POST /jobs/:id/result ────────────────────────────────────────

describe('POST /api/internal/chronicle/jobs/:id/result (success)', () => {
  it('rejects payloads with neither success nor error shape', async () => {
    const app = makeApp();
    const { status, body } = await send(app, 'POST', '/api/internal/chronicle/jobs/abc/result', {
      auth: 'Bearer test-secret',
      body: { recapShort: '' }, // empty string fails min(1)
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Body must be either/);
  });

  it('updates the row to draft and stamps the recap fields', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const { status, body } = await send(app, 'POST', '/api/internal/chronicle/jobs/abc/result', {
      auth: 'Bearer test-secret',
      body: {
        recapShort: 'The party slew the dragon.',
        recapFull: 'After a long battle, the dragon fell.',
        keyEntities: ['Liraya', 'Thorndor'],
        whereLeftOff: 'The smoke clears. Your move, Bren.',
        modelUsed: 'gemma4:26b',
      },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, status: 'draft' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = 'draft'/);
    expect(sql).toMatch(/AND status IN \('generating', 'pending'\)/);
    expect(params[0]).toBe('abc');
    expect(params[5]).toBe('gemma4:26b');
  });

  it('returns 409 when the row is no longer in a claimable state', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const { status, body } = await send(app, 'POST', '/api/internal/chronicle/jobs/abc/result', {
      auth: 'Bearer test-secret',
      body: {
        recapShort: 'x', recapFull: 'y', keyEntities: [], whereLeftOff: 'z',
      },
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/claimable state/i);
  });
});

describe('POST /api/internal/chronicle/jobs/:id/result (failure)', () => {
  it('flips the row to failed and stamps a combined error message', async () => {
    const app = makeApp();
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const { status, body } = await send(app, 'POST', '/api/internal/chronicle/jobs/abc/result', {
      auth: 'Bearer test-secret',
      body: { error: 'Ollama timeout', hint: 'No response in 90s' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, status: 'failed' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = 'failed'/);
    expect(params[1]).toBe('Ollama timeout: No response in 90s');
  });
});
