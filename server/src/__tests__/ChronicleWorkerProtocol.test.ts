import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { claim, finish } = vi.hoisted(() => {
  process.env.CHRONICLE_WORKER_TOKEN = 'test-only-token';
  return { claim: vi.fn(), finish: vi.fn() };
});
vi.mock('../services/ChronicleJobs.js', () => ({
  claimChronicleJob: claim,
  finishChronicleJob: finish,
}));
import router from '../routes/internalChronicle.js';
const app = express();
app.use(express.json(), router);
app.use(
  (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'database failure' });
  }
);
const attemptId = '550e8400-e29b-41d4-a716-446655440000';
const output = {
  attemptId,
  recapShort: 'short',
  recapFull: 'full',
  keyEntities: [],
  whereLeftOff: 'Continue.',
};
const post = (path: string) =>
  request(app)
    .post(`/internal/chronicle/jobs/${path}`)
    .set('Authorization', 'Bearer test-only-token');
beforeEach(() => vi.resetAllMocks());

it('rejects unfenced legacy worker results', async () => {
  const res = await post('entry/result').send({ ...output, attemptId: undefined });
  expect(res.status).toBe(400);
  expect(finish).not.toHaveBeenCalled();
});
it('returns the attempt and lease in the claim acknowledgement', async () => {
  claim.mockResolvedValue({
    id: 'entry',
    generation_attempt_id: attemptId,
    generation_lease_until: new Date('2026-09-21T12:00:00Z'),
  });
  const res = await post('claim').send({});
  expect(res.body.job).toMatchObject({
    id: 'entry',
    attemptId,
    leaseUntil: '2026-09-21T12:00:00.000Z',
  });
  expect(claim).toHaveBeenCalledWith('external');
});
it.each(['draft', 'failed'])('acknowledges %s with job and attempt identity', async (status) => {
  finish.mockResolvedValue(status);
  const res = await post('entry/result').send(
    status === 'draft' ? output : { attemptId, error: 'timeout' }
  );
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, entryId: 'entry', attemptId, status });
});
it('rejects completion from a replaced or expired attempt', async () => {
  finish.mockResolvedValue(null);
  const res = await post('entry/result').send(output);
  expect(res.status).toBe(409);
  expect(res.body.ok).not.toBe(true);
});
it('does not return an acknowledgement when persistence fails', async () => {
  finish.mockRejectedValue(new Error('offline'));
  const res = await post('entry/result').send(output);
  expect(res.status).toBe(500);
  expect(res.body.ok).not.toBe(true);
});
