import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  claim: vi.fn(),
  finish: vi.fn(),
  execute: vi.fn(),
  recover: vi.fn(),
  requeue: vi.fn(),
  backend: 'vertex',
}));
vi.mock('../db/connection.js', () => ({ default: { query: mocks.query } }));
vi.mock('../utils/authorization.js', () => ({
  getAuthUserId: () => 'dm',
  assertSessionDM: vi.fn(),
  assertSessionMember: vi.fn(),
}));
vi.mock('../services/ChronicleExecution.js', () => ({ executeChronicle: mocks.execute }));
vi.mock('../services/ChronicleJobs.js', () => ({
  get CHRONICLE_BACKEND() {
    return mocks.backend;
  },
  claimChronicleJob: mocks.claim,
  finishChronicleJob: mocks.finish,
  recoverInterruptedChronicles: mocks.recover,
  requeueExternalChronicle: mocks.requeue,
}));
import router from '../routes/chronicle.js';

const app = express();
app.use(express.json(), router);
app.use(
  (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'database failure' });
  }
);
const job = {
  id: 'entry',
  campaign_id: 'campaign',
  campaign_name: 'Campaign',
  sequence_number: 1,
  raw_transcript: 'The party found a dragon and fled.',
  generation_attempt_id: 'attempt',
};
const output = {
  recapShort: 'short',
  recapFull: 'full',
  keyEntities: [],
  whereLeftOff: 'Continue.',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.backend = 'vertex';
  mocks.query.mockResolvedValue({
    rows: [{ ...job, generation_backend: 'vertex', status: 'failed' }],
    rowCount: 1,
  });
  mocks.claim.mockResolvedValue(job);
  mocks.execute.mockResolvedValue(output);
  mocks.finish.mockResolvedValue('draft');
});

describe('request-bound Chronicle routes', () => {
  it('does not respond until model execution AND result persistence finish', async () => {
    const model = deferred<typeof output>();
    const persistence = deferred<string>();
    mocks.execute.mockReturnValue(model.promise);
    mocks.finish.mockReturnValue(persistence.promise);
    let responded = false;
    const response = request(app)
      .post('/sessions/campaign/chronicle/generate')
      .send({ transcript: job.raw_transcript })
      .then((r) => {
        responded = true;
        return r;
      });
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(responded).toBe(false);
    model.resolve(output);
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce());
    expect(responded).toBe(false);
    persistence.resolve('draft');
    expect((await response).status).toBe(201);
    expect(mocks.finish.mock.calls[0][1]).toBe('attempt');
  });

  it('never acknowledges a failed database write', async () => {
    mocks.finish.mockRejectedValue(new Error('offline'));
    const res = await request(app)
      .post('/sessions/campaign/chronicle/generate')
      .send({ transcript: job.raw_transcript });
    expect(res.status).toBe(500);
    expect(res.body.status).not.toBe('draft');
  });

  it('cancels model execution if the HTTP client disconnects', async () => {
    mocks.execute.mockImplementation(
      (_input: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ error: 'request interrupted' }), {
            once: true,
          });
        })
    );
    mocks.finish.mockResolvedValue('failed');
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const req = http.request({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      path: '/sessions/campaign/chronicle/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    req.on('error', () => {});
    try {
      req.end(JSON.stringify({ transcript: job.raw_transcript }));
      await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
      req.destroy();
      await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce());
      expect(mocks.finish.mock.calls[0][3]).toEqual({ error: 'request interrupted' });
    } finally {
      req.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns a persisted failed result, not a false pending acknowledgement', async () => {
    mocks.execute.mockResolvedValue({ error: 'timeout' });
    mocks.finish.mockResolvedValue('failed');
    const res = await request(app)
      .post('/sessions/campaign/chronicle/generate')
      .send({ transcript: job.raw_transcript });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');
  });

  it.each(['pending', 'generating', 'failed'])(
    'allows atomic recovery/retry from %s',
    async (status) => {
      mocks.query.mockResolvedValue({ rows: [{ ...job, generation_backend: 'vertex', status }] });
      const res = await request(app).post('/chronicle/entry/retry').send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('draft');
      expect(mocks.claim).toHaveBeenCalledWith('vertex', 'entry');
    }
  );

  it('does not run another model for an active or superseded attempt', async () => {
    mocks.claim.mockResolvedValue(null);
    const res = await request(app).post('/chronicle/entry/retry').send({});
    expect(res.status).toBe(409);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects a late result rather than acknowledging it', async () => {
    mocks.finish.mockResolvedValue(null);
    const res = await request(app).post('/chronicle/entry/retry').send({});
    expect(res.status).toBe(409);
  });

  it('retains 202 only for persisted external-worker jobs', async () => {
    mocks.backend = 'external';
    const res = await request(app)
      .post('/sessions/campaign/chronicle/generate')
      .send({ transcript: job.raw_transcript });
    expect(res.status).toBe(202);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[1][1][8]).toBe('external');
  });

  it('recovers interruption metadata while listing DM entries', async () => {
    const res = await request(app).get('/sessions/campaign/chronicle');
    expect(res.status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledWith('campaign');
  });

  it('requeues external retries without using Vertex', async () => {
    mocks.query.mockResolvedValue({
      rows: [{ ...job, generation_backend: 'external', status: 'generating' }],
    });
    mocks.requeue.mockResolvedValue(true);
    const res = await request(app).post('/chronicle/entry/retry').send({});
    expect(res.status).toBe(202);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
