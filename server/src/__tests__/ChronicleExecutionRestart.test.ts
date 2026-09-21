import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { workers } = vi.hoisted(() => ({
  workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }>,
}));
vi.mock('../db/connection.js', () => ({ default: {} }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn().mockResolvedValue(0);
    constructor() {
      super();
      workers.push(this);
    }
  },
}));
import { executeChronicle } from '../services/ChronicleExecution.js';
import { VERTEX_TIMEOUT_MS } from '../services/ChronicleJobs.js';
const input = {
  campaignName: 'C',
  sequenceNumber: 1,
  transcript: 'The party crossed the bridge safely.',
};
beforeEach(() => {
  workers.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('terminates hung credential/model work at the deadline', async () => {
  const promise = executeChronicle(input);
  await vi.advanceTimersByTimeAsync(VERTEX_TIMEOUT_MS);
  expect(await promise).toMatchObject({ error: 'Chronicle generation timed out' });
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('waits for worker termination before returning any result', async () => {
  const promise = executeChronicle(input);
  let finishTermination!: (value: number) => void;
  workers[0].terminate.mockReturnValue(
    new Promise<number>((r) => {
      finishTermination = r;
    })
  );
  let completed = false;
  const observed = promise.then((r) => {
    completed = true;
    return r;
  });
  workers[0].emit('message', { error: 'model failure' });
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(false);
  finishTermination(0);
  expect(await observed).toEqual({ error: 'model failure' });
  expect(vi.getTimerCount()).toBe(0);
});
it('turns worker crashes into persistable errors', async () => {
  const promise = executeChronicle(input);
  workers[0].emit('error', new Error('crashed'));
  expect(await promise).toMatchObject({ error: 'Vertex AI worker failed', hint: 'crashed' });
});
it('ignores late messages after the timeout', async () => {
  const promise = executeChronicle(input);
  await vi.advanceTimersByTimeAsync(VERTEX_TIMEOUT_MS);
  workers[0].emit('message', { recapShort: 'late' });
  expect(await promise).toMatchObject({ error: 'Chronicle generation timed out' });
});
it('terminates work when the owning request disconnects', async () => {
  const controller = new AbortController();
  const promise = executeChronicle(input, controller.signal);
  controller.abort();
  expect(await promise).toMatchObject({ error: 'Chronicle request interrupted' });
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('does not start work for an already disconnected request', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await executeChronicle(input, controller.signal)).toMatchObject({
    error: 'Chronicle request interrupted',
  });
  expect(workers).toHaveLength(0);
});
