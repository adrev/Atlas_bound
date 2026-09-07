import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { readSessionCookie, validateSession } = vi.hoisted(() => ({
  readSessionCookie: vi.fn(),
  validateSession: vi.fn(),
}));
vi.mock('../auth/lucia.js', () => ({ lucia: { readSessionCookie, validateSession } }));

import { createErrorsRouter } from '../routes/errors.js';
import { BoundedRateLimiter } from '../utils/boundedRateLimiter.js';

let now: number;
beforeEach(() => {
  vi.resetAllMocks();
  now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  readSessionCookie.mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

function app(limiter = new BoundedRateLimiter(20, 60_000, 10_000)) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/errors', createErrorsRouter(limiter));
  return app;
}

describe('error report request chain', () => {
  it('counts spoofed XFF prefixes against the same trusted client IP', async () => {
    const server = app();
    for (let i = 0; i < 21; i++) {
      const response = await supertest(server)
        .post('/api/errors')
        .set('X-Forwarded-For', `spoof-${i}, 198.51.100.10`)
        .send({ message: 'Fixture error' });
      expect(response.status).toBe(i < 20 ? 204 : 429);
    }
    expect(console.error).toHaveBeenCalledTimes(20);
    expect(readSessionCookie).toHaveBeenCalledTimes(20);
    for (const [log] of vi.mocked(console.error).mock.calls) {
      expect(JSON.parse(log).ip).toBe('198.51.100.10');
    }
  });

  it('normalizes IPv6 spellings and interface IDs in the same subnet', async () => {
    const server = app(new BoundedRateLimiter(2, 60_000, 10));
    const ips = [
      '2001:db8:abcd:1200::1',
      '2001:0db8:abcd:1200:0000:0000:0000:0001',
      '2001:db8:abcd:1201::2',
    ];
    for (let i = 0; i < ips.length; i++) {
      const response = await supertest(server)
        .post('/api/errors')
        .set('X-Forwarded-For', ips[i])
        .send({ message: 'Fixture' });
      expect(response.status).toBe(i < 2 ? 204 : 429);
    }
  });

  it('expires inactive keys and fails closed at capacity without resetting active limits', async () => {
    const limiter = new BoundedRateLimiter(1, 60_000, 2);
    const server = app(limiter);
    const report = (ip: string) =>
      supertest(server).post('/api/errors').set('X-Forwarded-For', ip).send({ message: 'Fixture' });
    expect((await report('198.51.100.1')).status).toBe(204);
    now += 30_000;
    expect((await report('198.51.100.2')).status).toBe(204);
    expect((await report('198.51.100.3')).status).toBe(429);
    expect((await report('198.51.100.1')).status).toBe(429);
    expect(limiter.size).toBe(2);
    now += 30_000;
    expect((await report('198.51.100.3')).status).toBe(204);
    expect((await report('198.51.100.2')).status).toBe(429);
    expect(limiter.size).toBe(2);
    now += 60_000;
    expect((await report('198.51.100.4')).status).toBe(204);
    expect(limiter.size).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(4);
  });

  it('retains rolling-window behavior when newer hits keep a key alive', async () => {
    const server = app(new BoundedRateLimiter(2, 60_000, 10));
    const report = () =>
      supertest(server)
        .post('/api/errors')
        .set('X-Forwarded-For', '198.51.100.1')
        .send({ message: 'Fixture' });
    expect((await report()).status).toBe(204);
    now += 30_000;
    expect((await report()).status).toBe(204);
    expect((await report()).status).toBe(429);
    now += 30_000;
    expect((await report()).status).toBe(204);
    expect((await report()).status).toBe(429);
  });

  it('keeps malformed payloads out of the log and limiter', async () => {
    const limiter = new BoundedRateLimiter(1, 60_000, 1);
    const server = app(limiter);
    const response = await supertest(server)
      .post('/api/errors')
      .send({ message: 'x'.repeat(2001) });
    expect(response.status).toBe(400);
    expect(limiter.size).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    expect(readSessionCookie).not.toHaveBeenCalled();
  });

  it('continues reporting anonymously when session lookup fails', async () => {
    readSessionCookie.mockReturnValue('expired');
    validateSession.mockRejectedValue(new Error('Fixture auth failure'));
    expect((await supertest(app()).post('/api/errors').send({ message: 'Fixture' })).status).toBe(
      204
    );
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0][0]).userId).toBeNull();
  });
});
