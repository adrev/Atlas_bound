import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idleDelay, postResult, processOne, claimJob } from './worker.mjs';

const job = {
  id: 'entry',
  attemptId: '550e8400-e29b-41d4-a716-446655440000',
  leaseUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
  transcript: 'The party safely crossed the bridge.',
};
const payload = {
  recapShort: 'short',
  recapFull: 'full',
  keyEntities: [],
  whereLeftOff: 'Continue.',
};
const ack = { ok: true, entryId: job.id, attemptId: job.attemptId, status: 'draft' };
const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

test('idle polling backs off exponentially and caps instead of fixed five-second traffic', () => {
  assert.deepEqual(
    [1, 2, 3, 20].map((n) => idleDelay(n, 30_000, 1_800_000)),
    [30_000, 60_000, 120_000, 1_800_000]
  );
});
test('retries identical result after a lost acknowledgement and validates receipt identity', async () => {
  const bodies = [];
  const waits = [];
  let calls = 0;
  const result = await postResult(job, payload, {
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      if (++calls === 1) throw new Error('connection dropped after commit');
      if (calls === 2) return response(200, { ...ack, attemptId: 'another-attempt' });
      return response(200, ack);
    },
    wait: async (ms) => waits.push(ms),
  });
  assert.deepEqual(result, ack);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(JSON.parse(bodies[0]).attemptId, job.attemptId);
  assert.deepEqual(waits, [2000, 4000]);
});
test('409 stops stale delivery immediately without reporting success', async () => {
  let calls = 0;
  await assert.rejects(
    postResult(job, payload, {
      fetchImpl: async () => {
        calls++;
        return response(409, {});
      },
      wait: async () => assert.fail('must not retry stale attempts'),
    }),
    /409/
  );
  assert.equal(calls, 1);
});
test('server errors retry but malformed 2xx never counts as success', async () => {
  let calls = 0;
  await assert.rejects(
    postResult(job, payload, {
      fetchImpl: async () => (++calls === 1 ? response(503, {}) : response(200, { ok: true })),
      wait: async () => {},
    }),
    /Invalid result acknowledgement/
  );
  assert.equal(calls, 8);
});
test('never posts after the known lease expiry', async () => {
  await assert.rejects(
    postResult(job, payload, {
      now: () => Date.parse(job.leaseUntil),
      fetchImpl: async () => assert.fail('expired'),
    }),
    /lease expired/
  );
});
test('delivery failure never replaces successful model output with an error result', async () => {
  const delivered = [];
  const logs = [];
  await assert.rejects(
    processOne({
      claim: async () => job,
      generate: async () => JSON.stringify(payload),
      deliver: async (_job, value) => {
        delivered.push(value);
        throw new Error('delivery unavailable');
      },
      log: { log: (value) => logs.push(value), error: () => {} },
    }),
    /delivery unavailable/
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].recapShort, 'short');
  assert.equal('error' in delivered[0], false);
  assert.equal(
    logs.some((line) => line.includes('acknowledged')),
    false
  );
});
test('inference failure is delivered under the same claim', async () => {
  let delivered;
  assert.equal(
    await processOne({
      claim: async () => job,
      generate: async () => {
        throw new Error('timeout');
      },
      deliver: async (claimed, value) => {
        delivered = { claimed, value };
      },
      log: { log: () => {}, error: () => {} },
    }),
    true
  );
  assert.equal(delivered.claimed.attemptId, job.attemptId);
  assert.equal(delivered.value.error, 'Ollama call failed');
});
test('claim rejects a legacy response without a lease/attempt', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response(200, { job: { id: 'entry', transcript: 'text' } });
  try {
    await assert.rejects(claimJob(), /Invalid claim acknowledgement/);
  } finally {
    globalThis.fetch = original;
  }
});
