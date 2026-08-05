import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Socket } from 'socket.io-client';
import { pullEventCursor, recordEventId, resetEventCursor, getLastEventId } from './eventCursor';
import { useSessionStore } from '../stores/useSessionStore';
import { useCombatStore } from '../stores/useCombatStore';

/**
 * Regression: the event-cursor zero/reset replay-safety bug.
 *
 * The client cursor resets to 0 in two situations — a brand-new session
 * join, and an HTTP 410 (our cursor aged out of the server's replay
 * buffer). While the cursor is 0 the client has NO authoritative baseline
 * in the event stream: state is (re)built by session:join + the /state
 * snapshot, not by replaying the log.
 *
 * The bug: a keep-alive tick could fire `pullEventCursor` while the cursor
 * was still 0, request `?since=0`, and the server would return its entire
 * retained backlog. Replaying that historical log applied events out of
 * context — most visibly an old `combat:ended` whose matching
 * `combat:started` had already fallen out of the buffer (and which the
 * replay dispatcher can't re-establish anyway). That transiently ended an
 * active fight and popped a bogus end-of-battle recap until the next
 * /state poll healed it.
 *
 * Fix: cursor 0 never requests or replays historical backlog. Authoritative
 * hydration must advance the cursor (via `nextEventId`) before delta replay
 * resumes; legitimate nonzero delta replay is unaffected.
 */

function fakeSocket(): Socket {
  return { emit: vi.fn() } as unknown as Socket;
}

type EventBody = {
  events: Array<{ id: number; kind: string; payload: Record<string, unknown> }>;
  latestEventId: number;
};

function jsonResp(body: EventBody | { fullResync: true; latestEventId: number }, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

/** Stub `fetch` with an ordered queue of responses. */
function stubFetch(responses: ReturnType<typeof jsonResp>[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  resetEventCursor();
  useSessionStore.setState({ sessionId: 's1', roomCode: 'ROOM' } as never);
  // Start every case with an active fight so an errant `combat:ended`
  // replay is observable.
  useCombatStore.setState({ active: true } as never);
  useSessionStore.setState({ gameMode: 'combat' } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe('pullEventCursor — initial cursor zero', () => {
  it('never requests or replays the historical backlog at cursor 0', async () => {
    // Even if the server WOULD hand back a backlog with a stale
    // combat:ended, the client must not ask for it while at cursor 0.
    const fetchFn = stubFetch([
      jsonResp({ events: [{ id: 3, kind: 'combat:ended', payload: {} }], latestEventId: 3 }),
    ]);

    const n = await pullEventCursor(fakeSocket());

    expect(n).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled(); // no ?since=0 request at all
    expect(useCombatStore.getState().active).toBe(true); // fight untouched
    expect(getLastEventId()).toBe(0); // cursor still awaiting hydration
  });
});

describe('pullEventCursor — 410 / reset', () => {
  it('resets the cursor to 0 and forces a session:join on 410, without wiping combat', async () => {
    recordEventId(3); // we had a real cursor before it aged out
    const socket = fakeSocket();
    const fetchFn = stubFetch([jsonResp({ fullResync: true, latestEventId: 999 }, 410)]);

    const n = await pullEventCursor(socket);

    expect(n).toBe(0);
    expect(fetchFn.mock.calls[0][0]).toContain('since=3');
    expect(getLastEventId()).toBe(0); // reset — defer to hydration
    expect(socket.emit).toHaveBeenCalledWith('session:join', { roomCode: 'ROOM' });
    expect(useCombatStore.getState().active).toBe(true); // 410 itself never ends combat
  });

  it('the tick right after a 410 reset does not replay the backlog', async () => {
    // First: trigger the 410 → cursor resets to 0.
    const socket = fakeSocket();
    recordEventId(3);
    stubFetch([jsonResp({ fullResync: true, latestEventId: 999 }, 410)]);
    await pullEventCursor(socket);
    expect(getLastEventId()).toBe(0);

    // Next keep-alive tick, cursor still 0 (hydration hasn't landed yet):
    // must NOT request/replay the historical log.
    const backlogFetch = stubFetch([
      jsonResp({ events: [{ id: 2, kind: 'combat:ended', payload: {} }], latestEventId: 2 }),
    ]);
    const n = await pullEventCursor(socket);

    expect(n).toBe(0);
    expect(backlogFetch).not.toHaveBeenCalled();
    expect(useCombatStore.getState().active).toBe(true);
  });
});

describe('pullEventCursor — hydration resume', () => {
  it('resumes delta replay once authoritative hydration advances the cursor', async () => {
    // At cursor 0 the pull is a no-op — no request, no replay.
    const noFetch = stubFetch([]);
    expect(await pullEventCursor(fakeSocket())).toBe(0);
    expect(noFetch).not.toHaveBeenCalled();

    // Authoritative hydration establishes nextEventId. This mirrors what
    // pullStateSnapshot does after a session:join re-sync:
    // `recordEventId(snap.nextEventId)`.
    recordEventId(10);

    // Now a genuine delta replays from the hydrated baseline.
    const fetchFn = stubFetch([
      jsonResp({ events: [{ id: 11, kind: 'combat:ended', payload: {} }], latestEventId: 11 }),
    ]);
    const n = await pullEventCursor(fakeSocket());

    expect(n).toBe(1);
    expect(fetchFn.mock.calls[0][0]).toContain('since=10'); // asks from the baseline, not 0
    expect(getLastEventId()).toBe(11);
    expect(useCombatStore.getState().active).toBe(false); // legit replay applied
    expect(useSessionStore.getState().gameMode).toBe('free-roam');
  });
});

describe('pullEventCursor — normal nonzero delta replay', () => {
  it('replays a nonzero delta and advances the cursor', async () => {
    recordEventId(5);
    const fetchFn = stubFetch([
      jsonResp({ events: [{ id: 6, kind: 'combat:ended', payload: {} }], latestEventId: 6 }),
    ]);

    const n = await pullEventCursor(fakeSocket());

    expect(n).toBe(1);
    expect(fetchFn.mock.calls[0][0]).toContain('since=5');
    expect(useCombatStore.getState().active).toBe(false); // combat:ended applied
    expect(useSessionStore.getState().gameMode).toBe('free-roam');
    expect(getLastEventId()).toBe(6);
  });

  it('advances the cursor to latestEventId on an empty nonzero delta without replaying', async () => {
    recordEventId(4);
    const fetchFn = stubFetch([jsonResp({ events: [], latestEventId: 9 })]);

    const n = await pullEventCursor(fakeSocket());

    expect(n).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(getLastEventId()).toBe(9); // fast-forward, no stale re-ask
    expect(useCombatStore.getState().active).toBe(true); // nothing replayed
  });
});
