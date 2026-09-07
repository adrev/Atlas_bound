import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character, Combatant, Token } from '@dnd-vtt/shared';
import type { Socket } from 'socket.io-client';
import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useCombatStore } from '../stores/useCombatStore';
import { getLastEventId, pullEventCursor, recordEventId, resetEventCursor } from './eventCursor';
import { pullStateSnapshot, triggerSnapshot } from './stateSnapshot';
import { registerListeners } from './listeners';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function token(version: number): Token {
  return {
    id: 'token',
    mapId: 'map',
    name: 'Hero',
    x: (version - 1) * 100,
    y: 0,
    version,
    conditions: [],
    characterId: null,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    ownerUserId: null,
    createdAt: new Date(0).toISOString(),
  };
}

function snapshot(version: number, characterId = 'hero') {
  return {
    mapId: 'map',
    tokens: [token(version)],
    combat: {
      active: true,
      roundNumber: version,
      currentTurnIndex: 0,
      currentTokenId: 'token',
      combatants: [{ tokenId: 'token', name: characterId, hp: version } as Combatant],
      startedAt: 1,
    },
    characters: {
      [characterId]: { id: characterId, userId: 'other', name: characterId, version } as Character,
    },
    nextEventId: version,
    roundNumber: version,
  };
}

function replay(...ids: number[]) {
  return {
    events: ids.map((id) => ({
      id,
      kind: 'map:token-moved',
      payload: { tokenId: 'token', mapId: 'map', x: (id - 1) * 100, y: 0, version: id },
    })),
    latestEventId: Math.max(...ids),
  };
}

function response(body: unknown, etag: string | null = null, status = 200) {
  return {
    status,
    ok: status === 200,
    headers: { get: () => etag },
    json: vi.fn(async () => body),
  };
}

function delayedResponse(body: unknown, phase: 'fetch' | 'json', etag: string | null = null) {
  const gate = deferred<void>();
  const enteredJson = deferred<void>();
  const resp = response(body, etag);
  if (phase === 'json') {
    resp.json.mockImplementation(async () => {
      enteredJson.resolve();
      await gate.promise;
      return body;
    });
  }
  return {
    result: phase === 'fetch' ? gate.promise.then(() => resp) : Promise.resolve(resp),
    ready: phase === 'json' ? enteredJson.promise : Promise.resolve(),
    release: () => gate.resolve(),
  };
}

function socketHarness() {
  const handlers = new Map<string, (payload: Record<string, unknown>) => void>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((kind, handler) => handlers.set(kind, handler)),
    off: vi.fn((kind) => handlers.delete(kind)),
  } as unknown as Socket;
  registerListeners(socket);
  return {
    socket,
    liveMove(id: number) {
      // useSocket's onAny cursor tracking runs before the registered listener.
      recordEventId(id);
      handlers.get('map:token-moved')!(replay(id).events[0].payload);
    },
  };
}

function expectToken(version: number) {
  expect(useMapStore.getState().tokens.token).toMatchObject({
    x: (version - 1) * 100,
    version,
  });
  expect(getLastEventId()).toBe(version);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEventCursor();
  useSessionStore.setState({ sessionId: 'A', roomCode: 'ROOM-A', userId: 'user' });
  useMapStore.setState({ tokens: { token: token(1) }, currentMap: { id: 'map' } } as never);
  useCombatStore.setState({ active: false, combatants: [] });
  useCharacterStore.setState({ myCharacter: null, allCharacters: {} });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sync response generation fencing', () => {
  it.each(['fetch', 'json'] as const)(
    'ignores A snapshot after entering B during %s',
    async (phase) => {
      recordEventId(20);
      const stale = delayedResponse(snapshot(500, 'old-A'), phase, '"A-500"');
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValue(response(snapshot(1, 'new-B'), '"B-1"'));
      vi.stubGlobal('fetch', fetchMock);
      const pending = pullStateSnapshot();
      await stale.ready;

      useSessionStore.setState({ sessionId: 'B', roomCode: 'ROOM-B' });
      expect(getLastEventId()).toBe(0);
      await pullStateSnapshot();
      stale.release();
      expect((await pending).applied).toBe(false);
      expectToken(1);
      expect(Object.keys(useCharacterStore.getState().allCharacters)).toEqual(['new-B']);
      expect(useCombatStore.getState().combatants[0].name).toBe('new-B');
      expect(useCombatStore.getState().roundNumber).toBe(1);
      await pullStateSnapshot();
      expect(fetchMock.mock.calls[2][1].headers).toEqual({ 'If-None-Match': '"B-1"' });
    }
  );

  it.each(['navigation', 'cursor reset'] as const)(
    'fences same-session re-entry through %s',
    async (reason) => {
      const stale = delayedResponse(snapshot(500), 'json', '"old-entry"');
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValue(response(snapshot(1), '"new-entry"'));
      vi.stubGlobal('fetch', fetchMock);
      const pending = pullStateSnapshot();
      await stale.ready;
      if (reason === 'navigation') {
        useSessionStore.getState().reset();
        useSessionStore.setState({ sessionId: 'A', roomCode: 'ROOM-A', userId: 'user' });
      } else {
        resetEventCursor();
      }
      await pullStateSnapshot();
      stale.release();
      expect((await pending).applied).toBe(false);
      expectToken(1);
      expect(fetchMock.mock.calls[1][1].headers).toEqual({});
    }
  );

  it.each(['fetch', 'json'] as const)(
    'ignores replay from an old session during %s',
    async (phase) => {
      recordEventId(1);
      const stale = delayedResponse(replay(500), phase);
      vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(stale.result));
      const pending = pullEventCursor(socketHarness().socket);
      await stale.ready;
      useSessionStore.setState({ sessionId: 'B', roomCode: 'ROOM-B' });
      recordEventId(1);
      stale.release();
      expect(await pending).toBe(0);
      expectToken(1);
    }
  );

  it.each(['navigation', 'cursor reset'] as const)(
    'ignores replay after same-session %s',
    async (reason) => {
      recordEventId(1);
      const stale = delayedResponse(replay(500), 'json');
      vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(stale.result));
      const pending = pullEventCursor(socketHarness().socket);
      await stale.ready;
      if (reason === 'navigation') {
        useSessionStore.getState().reset();
        useSessionStore.setState({ sessionId: 'A', roomCode: 'ROOM-A', userId: 'user' });
      } else {
        resetEventCursor();
      }
      recordEventId(1);
      stale.release();
      expect(await pending).toBe(0);
      expectToken(1);
    }
  );

  it('drops delayed empty replay ranges rather than advancing another session', async () => {
    recordEventId(1);
    const stale = delayedResponse({ events: [], latestEventId: 500 }, 'json');
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(stale.result));
    const pending = pullEventCursor(socketHarness().socket);
    await stale.ready;
    useSessionStore.setState({ sessionId: 'B', roomCode: 'ROOM-B' });
    recordEventId(1);
    stale.release();
    expect(await pending).toBe(0);
    expectToken(1);
  });

  it('does not run a debounced snapshot in a later session generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(snapshot(1)));
    vi.stubGlobal('fetch', fetchMock);
    triggerSnapshot('old-session-mutation');
    resetEventCursor();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('replay, snapshot and live event ordering', () => {
  it.each(['fetch', 'json'] as const)(
    'does not replay event 2 over snapshot 3 delayed at %s',
    async (phase) => {
      recordEventId(1);
      const stale = delayedResponse(replay(2), phase);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockReturnValueOnce(stale.result)
          .mockResolvedValueOnce(response(snapshot(3)))
      );
      const pending = pullEventCursor(socketHarness().socket);
      await stale.ready;
      await pullStateSnapshot();
      expectToken(3);
      stale.release();
      expect(await pending).toBe(0);
      expectToken(3);
    }
  );

  it('keeps the fresh suffix of a replay overtaken by snapshot 3', async () => {
    recordEventId(1);
    const stale = delayedResponse(replay(2, 3, 4), 'json');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValueOnce(response(snapshot(3)))
    );
    const pending = pullEventCursor(socketHarness().socket);
    await stale.ready;
    await pullStateSnapshot();
    stale.release();
    expect(await pending).toBe(1);
    expectToken(4);
  });

  it('does not apply snapshot 2 after replay 3', async () => {
    recordEventId(1);
    const stale = delayedResponse(snapshot(2), 'json');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValueOnce(response(replay(3)))
    );
    const pending = pullStateSnapshot();
    await stale.ready;
    expect(await pullEventCursor(socketHarness().socket)).toBe(1);
    stale.release();
    expect((await pending).applied).toBe(false);
    expectToken(3);
  });

  it.each(['snapshot', 'replay'] as const)(
    'does not apply delayed %s 2 after live event 3',
    async (kind) => {
      recordEventId(1);
      const stale = delayedResponse(kind === 'snapshot' ? snapshot(2) : replay(2), 'json');
      vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(stale.result));
      const harness = socketHarness();
      const pending = kind === 'snapshot' ? pullStateSnapshot() : pullEventCursor(harness.socket);
      await stale.ready;
      harness.liveMove(3);
      stale.release();
      await pending;
      expectToken(3);
    }
  );

  it('orders a replay batch and only dispatches each event once', async () => {
    recordEventId(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(replay(3, 2, 3))));
    const moves = vi.spyOn(useMapStore.getState(), 'moveToken');
    try {
      expect(await pullEventCursor(socketHarness().socket)).toBe(2);
      expect(moves.mock.calls.map((call) => call[1])).toEqual([100, 200]);
      expectToken(3);
    } finally {
      moves.mockRestore();
    }
  });

  it('does not replay an overlapping older response twice', async () => {
    recordEventId(1);
    const stale = delayedResponse(replay(2), 'json');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValueOnce(response(replay(2, 3)))
    );
    const socket = socketHarness().socket;
    const pending = pullEventCursor(socket);
    await stale.ready;
    expect(await pullEventCursor(socket)).toBe(2);
    stale.release();
    expect(await pending).toBe(0);
    expectToken(3);
  });

  it('does not rewind an unversioned mutation when equal-cursor snapshots finish in reverse', async () => {
    const stale = delayedResponse(snapshot(1), 'json', '"older"');
    const fresh = { ...snapshot(1), tokens: [{ ...token(1), x: 300 }] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValueOnce(stale.result).mockResolvedValueOnce(response(fresh, '"newer"'))
    );
    const pending = pullStateSnapshot();
    await stale.ready;
    await pullStateSnapshot();
    stale.release();
    expect((await pending).applied).toBe(false);
    expect(useMapStore.getState().tokens.token.x).toBe(300);
  });

  it('hydrates a newer token version even if its position has not changed', async () => {
    const fresh = { ...snapshot(3), tokens: [{ ...token(1), version: 3 }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fresh)));
    await pullStateSnapshot();
    expect(useMapStore.getState().tokens.token).toMatchObject({ x: 0, version: 3 });
    expect(getLastEventId()).toBe(3);
  });
});

describe('conditional response and reset recovery', () => {
  it.each(['navigation', 'snapshot'] as const)('ignores a 410 overtaken by %s', async (kind) => {
    recordEventId(1);
    const gate = deferred<ReturnType<typeof response>>();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(gate.promise)
        .mockResolvedValueOnce(response(snapshot(3)))
    );
    const socket = socketHarness().socket;
    const pending = pullEventCursor(socket);
    if (kind === 'navigation') {
      useSessionStore.setState({ sessionId: 'B', roomCode: 'ROOM-B' });
      recordEventId(3);
    } else {
      await pullStateSnapshot();
    }
    gate.resolve(response(null, null, 410));
    expect(await pending).toBe(0);
    expect(getLastEventId()).toBe(3);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('a current 410 invalidates pending bodies and the cached snapshot validator', async () => {
    const stale = delayedResponse(snapshot(2), 'json', '"stale"');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot(1), '"baseline"'))
      .mockReturnValueOnce(stale.result)
      .mockResolvedValueOnce(response(null, null, 410))
      .mockResolvedValueOnce(response(snapshot(3), '"recovered"'));
    vi.stubGlobal('fetch', fetchMock);
    await pullStateSnapshot();
    const pending = pullStateSnapshot();
    await stale.ready;
    const socket = socketHarness().socket;
    await pullEventCursor(socket);
    expect(socket.emit).toHaveBeenCalledWith('session:join', { roomCode: 'ROOM-A' });
    expect(getLastEventId()).toBe(0);
    stale.release();
    expect((await pending).applied).toBe(false);
    await pullStateSnapshot();
    expect(fetchMock.mock.calls[3][1].headers).toEqual({});
    expectToken(3);
  });

  it('does not cache a discarded snapshot and become stuck accepting 304s', async () => {
    recordEventId(1);
    const stale = delayedResponse(snapshot(2), 'fetch', '"rejected"');
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.result)
      .mockImplementation(async (_url, options) =>
        options.headers['If-None-Match']
          ? response(null, null, 304)
          : response(snapshot(4), '"recovered"')
      );
    vi.stubGlobal('fetch', fetchMock);
    const pending = pullStateSnapshot();
    await stale.ready;
    socketHarness().liveMove(3);
    stale.release();
    expect((await pending).applied).toBe(false);
    expect(await pullStateSnapshot()).toEqual({ ok: true, applied: true });
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
    expectToken(4);
  });

  it.each(['no-room', 'invalid-json'] as const)(
    'does not cache a rejected %s response',
    async (kind) => {
      const rejected = response({ tokens: [], combat: null, nextEventId: 0 }, '"rejected"');
      if (kind === 'invalid-json') rejected.json.mockRejectedValue(new SyntaxError('Invalid JSON'));
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(rejected)
        .mockImplementation(async (_url, options) =>
          options.headers['If-None-Match']
            ? response(null, null, 304)
            : response(snapshot(2), '"recovered"')
        );
      vi.stubGlobal('fetch', fetchMock);
      expect((await pullStateSnapshot()).applied).toBe(false);
      expect(await pullStateSnapshot()).toEqual({ ok: true, applied: true });
      expectToken(2);
    }
  );

  it('rejects a conditional 304 overtaken by replay and recovers with a fresh body', async () => {
    const gate = deferred<ReturnType<typeof response>>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot(1), '"baseline"'))
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce(response(replay(2)))
      .mockResolvedValueOnce(response(snapshot(3), '"recovered"'));
    vi.stubGlobal('fetch', fetchMock);
    await pullStateSnapshot();
    const pending = pullStateSnapshot();
    await pullEventCursor(socketHarness().socket);
    gate.resolve(response(null, null, 304));
    expect(await pending).toEqual({ ok: false, applied: false });
    await pullStateSnapshot();
    expect(fetchMock.mock.calls[3][1].headers).toEqual({});
    expectToken(3);
  });

  it('a pre-mutation 200 cannot reinstate an invalidated validator', async () => {
    const stale = delayedResponse(snapshot(1), 'json', '"pre-mutation"');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot(1), '"baseline"'))
      .mockReturnValueOnce(stale.result)
      .mockResolvedValueOnce(response(snapshot(2), '"recovered"'));
    vi.stubGlobal('fetch', fetchMock);
    await pullStateSnapshot();
    const pending = pullStateSnapshot();
    await stale.ready;
    triggerSnapshot('mutation-without-event-id');
    stale.release();
    expect((await pending).applied).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock.mock.calls[2][1].headers).toEqual({});
    expectToken(2);
  });

  it.each(['mutation', 'cursor reset', 'navigation'] as const)(
    'a stale conditional 304 cannot mask %s recovery',
    async (reason) => {
      const gate = deferred<ReturnType<typeof response>>();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(snapshot(1), '"baseline"'))
        .mockReturnValueOnce(gate.promise)
        .mockResolvedValue(response(snapshot(2), '"recovered"'));
      vi.stubGlobal('fetch', fetchMock);
      await pullStateSnapshot();
      const pending = pullStateSnapshot();
      expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'If-None-Match': '"baseline"' });
      if (reason === 'mutation') {
        triggerSnapshot('mutation-without-event-id');
      } else if (reason === 'cursor reset') {
        resetEventCursor();
      } else {
        useSessionStore.getState().reset();
        useSessionStore.setState({ sessionId: 'A', roomCode: 'ROOM-A', userId: 'user' });
      }
      gate.resolve(response(null, null, 304));
      expect(await pending).toEqual({ ok: false, applied: false });
      await pullStateSnapshot();
      expect(fetchMock.mock.calls[2][1].headers).toEqual({});
      expectToken(2);
    }
  );
});
