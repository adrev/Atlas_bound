import { describe, it, expect, beforeEach } from 'vitest';
import { createRoom, getRoom, MAX_EVENT_LOG } from '../utils/roomState.js';
import { broadcastEvent } from '../utils/eventBroadcast.js';

/**
 * Unit tests for the event-cursor machinery. The goal: any client
 * that missed a broadcast can recover by asking for everything
 * after its `lastEventId`, and the cursor stays internally
 * consistent under churn.
 *
 * These tests drive the server-side pieces directly (no sockets)
 * since the sync guarantee is really about the event log, not
 * about socket.io's delivery mechanics.
 */

function mockIo(): { emitted: Array<{ kind: string; payload: unknown }> } & {
  to: (sid: string) => { emit: (k: string, p: unknown) => void };
} {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  return {
    emitted,
    to: (_sid: string) => ({
      emit: (kind: string, payload: unknown) => {
        emitted.push({ kind, payload });
      },
    }),
  };
}

describe('event cursor', () => {
  beforeEach(() => {
    // Fresh room per test so ID counters don't leak between cases.
    const existing = getRoom('test-session');
    if (existing) {
      // Can't easily delete from createRoom's internal Map, so just
      // reset the counters on the room we already have.
      existing.nextEventId = 0;
      existing.eventLog = [];
    } else {
      createRoom('test-session', 'TESTCODE', 'dm-user');
    }
  });

  it('assigns monotonically increasing ids to each broadcast', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'map:token-moved', { x: 1 });
    broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'map:token-moved', { x: 2 });
    broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'character:updated', { changes: {} });

    expect(room.eventLog.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(room.nextEventId).toBe(3);
  });

  it('injects _eventId into the live emit payload', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'map:token-moved', { x: 7 });

    const emitted = (io as unknown as { emitted: Array<{ kind: string; payload: { x?: number; _eventId?: number } }> }).emitted;
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('map:token-moved');
    expect(emitted[0].payload._eventId).toBe(1);
    expect(emitted[0].payload.x).toBe(7);
  });

  it('caps the log at MAX_EVENT_LOG entries (drops oldest)', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    for (let i = 0; i < MAX_EVENT_LOG + 50; i++) {
      broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'map:token-moved', { i });
    }
    expect(room.eventLog.length).toBe(MAX_EVENT_LOG);
    // Oldest entries dropped → the first id in the log should be past 50.
    expect(room.eventLog[0].id).toBe(51);
    expect(room.eventLog[room.eventLog.length - 1].id).toBe(MAX_EVENT_LOG + 50);
  });

  it('records tokenId on events that tag one (for hidden-token filtering on replay)', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'map:token-moved', { x: 0 }, { tokenId: 'tok-42' });
    expect(room.eventLog[0].tokenId).toBe('tok-42');
  });

  it('does not record tokenId when unset', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'character:updated', { changes: {} });
    expect(room.eventLog[0].tokenId).toBeNull();
  });

  it('delta since 0 returns every logged event', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    for (let i = 0; i < 10; i++) {
      broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'evt', { i });
    }
    const delta = room.eventLog.filter((e) => e.id > 0);
    expect(delta).toHaveLength(10);
    expect(delta[0].id).toBe(1);
    expect(delta[9].id).toBe(10);
  });

  it('delta since mid-stream returns only the tail', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    for (let i = 0; i < 10; i++) {
      broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'evt', { i });
    }
    const delta = room.eventLog.filter((e) => e.id > 6);
    expect(delta.map((e) => e.id)).toEqual([7, 8, 9, 10]);
  });

  it('delta since head returns empty (client is already caught up)', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    for (let i = 0; i < 5; i++) {
      broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'evt', { i });
    }
    const delta = room.eventLog.filter((e) => e.id > 5);
    expect(delta).toHaveLength(0);
  });

  it('detects "cursor fell out of replay buffer" case', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    // Fill past MAX_EVENT_LOG + a bit, so the oldest entries drop.
    for (let i = 0; i < MAX_EVENT_LOG + 100; i++) {
      broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'evt', { i });
    }
    const oldestId = room.eventLog[0].id; // 101
    // Client's cursor at 50 is older than the oldest retained event.
    // Route handler checks `since < oldest - 1` and returns 410.
    expect(50 < oldestId - 1).toBe(true);
  });

  it('broadcast fans out to the session room id', () => {
    const room = getRoom('test-session')!;
    const io = mockIo();
    const spy: string[] = [];
    const originalTo = io.to;
    io.to = (sid: string) => {
      spy.push(sid);
      return originalTo(sid);
    };
    broadcastEvent(io as unknown as Parameters<typeof broadcastEvent>[0], room, 'evt', {});
    expect(spy).toContain(room.sessionId);
  });
});
