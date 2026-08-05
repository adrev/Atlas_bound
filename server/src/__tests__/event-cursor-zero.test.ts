import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';

/**
 * Regression: GET /api/sessions/:id/events must never serve the retained
 * backlog to a zero cursor. A `?since=0` (or missing `since`) request comes
 * from a client with no authoritative baseline yet — a fresh join or a
 * client that just reset after a 410. Handing back the full log makes it
 * replay historical events out of context (e.g. an aged `combat:ended`
 * whose `combat:started` has already dropped out of the buffer), which
 * transiently wipes an active fight. The server returns an empty delta with
 * the current cursor so the client resumes nonzero replay from a known-good
 * baseline (and older clients fast-forward via their empty-delta branch).
 * Nonzero deltas must keep returning the normal tail.
 */

// Route module needs the DB + compendium mocks to import cleanly; the
// events handler only touches the DB through assertSessionMember, which we
// satisfy with a non-empty membership row.
vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [{ member: 1 }] }) },
}));
vi.mock('../services/Open5eService.js', () => ({
  isCompendiumSeeded: vi.fn().mockResolvedValue(true),
  getCompendiumStats: vi.fn().mockResolvedValue({ monsters: 0, spells: 0, items: 0 }),
  reseedCompendium: vi.fn().mockResolvedValue(undefined),
}));

import sessionsRouter from '../routes/sessions.js';
import { createRoom, getRoom } from '../utils/roomState.js';
import { broadcastEvent } from '../utils/eventBroadcast.js';

const SESSION = 'sess-cursor-zero';

function mockIo() {
  return { to: () => ({ emit: () => {} }) } as unknown as Parameters<typeof broadcastEvent>[0];
}

function buildApp() {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: { id: string } }).user = { id: 'u-member' };
    next();
  });
  app.use('/api/sessions', sessionsRouter);
  return app;
}

/** Reset the room to a known event log with `count` plain events. */
function seedRoom(count: number) {
  let room = getRoom(SESSION);
  if (!room) room = createRoom(SESSION, 'ZEROCODE', 'u-member');
  room.nextEventId = 0;
  room.eventLog = [];
  room.playerMapId = null;
  const io = mockIo();
  for (let i = 0; i < count; i++) {
    broadcastEvent(io, room, 'combat:ended', {});
  }
  return room;
}

describe('GET /events — zero-cursor backlog guard', () => {
  beforeEach(() => {
    seedRoom(5); // eventLog ids 1..5, nextEventId = 5
  });

  it('returns an empty delta (not the backlog) for since=0', async () => {
    const res = await supertest(buildApp()).get(`/api/sessions/${SESSION}/events?since=0`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.latestEventId).toBe(5); // client fast-forwards to here
  });

  it('treats a missing since (defaults to 0) the same way', async () => {
    const res = await supertest(buildApp()).get(`/api/sessions/${SESSION}/events`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.latestEventId).toBe(5);
  });

  it('still returns the tail for a legitimate nonzero cursor', async () => {
    const res = await supertest(buildApp()).get(`/api/sessions/${SESSION}/events?since=3`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { id: number }) => e.id)).toEqual([4, 5]);
    expect(res.body.latestEventId).toBe(5);
  });

  it('rejects a negative since as a bad request', async () => {
    const res = await supertest(buildApp()).get(`/api/sessions/${SESSION}/events?since=-1`);
    expect(res.status).toBe(400);
  });
});
