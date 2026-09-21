import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { Token } from '@dnd-vtt/shared';
import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import {
  getLastEventId,
  pullEventCursor,
  recordEventId,
  recordSnapshotCursor,
  requestFullRejoin,
  resetEventCursor,
  setRejoinHandler,
} from './eventCursor';
import { pullStateSnapshot, triggerSnapshot } from './stateSnapshot';
import { registerListeners } from './listeners';

function token(x: number): Token {
  return { id: 'hero', mapId: 'map', x, y: 0, conditions: [] } as unknown as Token;
}

function snapshot(generation = 'old', nextEventId = 500, x = 10) {
  return {
    generation,
    nextEventId,
    mapId: 'map',
    tokens: [token(x)],
    combat: null,
    characters: {},
    roundNumber: 0,
  };
}

function replay(generation = 'old', ...ids: number[]) {
  return {
    generation,
    latestEventId: Math.max(...ids),
    events: ids.map((id) => ({
      id,
      kind: 'map:token-moved',
      payload: { tokenId: 'hero', mapId: 'map', x: id, y: 0 },
    })),
  };
}

function response(body: unknown, etag: string | null = null, status = 200) {
  return { status, ok: status === 200, headers: { get: () => etag }, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delayed(body: unknown, phase: 'fetch' | 'json', etag = '"stale"') {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const resp = response(body, etag);
  if (phase === 'json')
    resp.json = async () => {
      entered.resolve();
      await gate.promise;
      return body;
    };
  return {
    result: phase === 'fetch' ? gate.promise.then(() => resp) : Promise.resolve(resp),
    ready: phase === 'fetch' ? Promise.resolve() : entered.promise,
    release: () => gate.resolve(),
  };
}

function socketHarness() {
  const handlers = new Map<string, (payload: never) => void>();
  const socket = {
    emit: vi.fn(),
    on: (kind: string, handler: (payload: never) => void) => handlers.set(kind, handler),
    off: (kind: string) => handlers.delete(kind),
  } as unknown as Socket;
  const cleanup = registerListeners(socket, 'ROOM');
  return {
    socket,
    cleanup,
    sync(generation: string, roomCode = 'ROOM') {
      handlers.get('session:state-sync')!({
        sessionId: 'A',
        roomCode,
        userId: 'user',
        generation,
        isDM: true,
        players: [],
        settings: {},
        currentMapId: 'map',
        gameMode: 'free-roam',
      } as never);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessionId: 'A', roomCode: 'ROOM', userId: 'user', generation: 'old' });
  resetEventCursor();
  useMapStore.setState({ currentMap: { id: 'map' }, tokens: { hero: token(0) } } as never);
  useCombatStore.setState({ active: false, combatants: [] });
  useCharacterStore.setState({ myCharacter: null, allCharacters: {} });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cold hydration generation recovery', () => {
  it.each([0, 500])(
    'requires full rejoin when generation changes, even with cursor %i',
    async (cursor) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(snapshot(), '"old"'))
        .mockResolvedValueOnce(response(snapshot('new', cursor, 99), '"new"'))
        .mockResolvedValue(response(snapshot('new', cursor, 20), '"joined"'));
      vi.stubGlobal('fetch', fetchMock);
      const join = vi.fn();
      const cleanup = setRejoinHandler(join);
      const harness = socketHarness();
      try {
        await pullStateSnapshot();
        expect(getLastEventId()).toBe(500);
        expect((await pullStateSnapshot()).applied).toBe(false);
        expect(join).toHaveBeenCalledOnce();
        expect(getLastEventId()).toBe(0);
        expect(useMapStore.getState().tokens.hero.x).toBe(10);
        expect(useSessionStore.getState().generation).toBeNull();
        await pullStateSnapshot();
        await pullEventCursor(harness.socket);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        harness.sync('new');
        await pullStateSnapshot();
        expect(fetchMock.mock.calls[2][1].headers).toEqual({});
        expect(getLastEventId()).toBe(cursor);
        expect(useMapStore.getState().tokens.hero.x).toBe(20);
      } finally {
        cleanup();
        harness.cleanup();
      }
    }
  );

  it('rejoins on cold/no-room snapshot without applying its empty fallback', async () => {
    recordSnapshotCursor(500);
    const join = vi.fn();
    const cleanup = setRejoinHandler(join);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ ...snapshot(), generation: null, tokens: [], nextEventId: 0 })
        )
    );
    try {
      expect((await pullStateSnapshot()).applied).toBe(false);
      expect(join).toHaveBeenCalledOnce();
      expect(useMapStore.getState().tokens.hero).toBeDefined();
      expect(getLastEventId()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('applies an authoritative empty cursor-zero snapshot after full rejoin', async () => {
    const harness = socketHarness();
    recordSnapshotCursor(500);
    requestFullRejoin(harness.socket);
    harness.sync('new');
    useCombatStore.setState({ active: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ ...snapshot('new', 0), tokens: [] }))
    );
    expect((await pullStateSnapshot()).applied).toBe(true);
    expect(useMapStore.getState().tokens).toEqual({});
    expect(useCombatStore.getState().active).toBe(false);
    expect(getLastEventId()).toBe(0);
    harness.cleanup();
  });

  it.each(['410', 'different generation', 'ahead cursor'])(
    'forces full hydration on events %s',
    async (reason) => {
      recordSnapshotCursor(500);
      const harness = socketHarness();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          reason === '410'
            ? response(null, null, 410)
            : response({
                generation: reason === 'different generation' ? 'new' : 'old',
                events: [],
                latestEventId: 0,
              })
        )
      );
      expect(await pullEventCursor(harness.socket)).toBe(0);
      expect(harness.socket.emit).toHaveBeenCalledWith('session:join', { roomCode: 'ROOM' });
      expect(getLastEventId()).toBe(0);
      expect(useSessionStore.getState().generation).toBeNull();
      harness.cleanup();
    }
  );

  it('does not replay retained history until a fresh snapshot establishes the baseline', async () => {
    recordEventId(5);
    const harness = socketHarness();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot('old', 0)))
      .mockResolvedValueOnce(response(replay('old', 1)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await pullEventCursor(harness.socket)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    resetEventCursor();
    await pullStateSnapshot();
    expect(await pullEventCursor(harness.socket)).toBe(1);
    expect(fetchMock.mock.calls[1][0]).toContain('since=0&generation=old');
    harness.cleanup();
  });

  it('ignores a state-sync belonging to the previous room', () => {
    const harness = socketHarness();
    harness.sync('unexpected', 'PREVIOUS');
    expect(useSessionStore.getState().generation).toBe('old');
    harness.cleanup();
  });
});

describe('in-flight request fencing', () => {
  it.each(['old', 'new'])(
    'rejects a delayed 304 across rejoin into generation %s',
    async (generation) => {
      const gate = deferred<ReturnType<typeof response>>();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(snapshot(), '"old-validator"'))
        .mockReturnValueOnce(gate.promise)
        .mockResolvedValue(response(snapshot(generation, 0, 20), '"fresh-validator"'));
      vi.stubGlobal('fetch', fetchMock);
      const harness = socketHarness();
      await pullStateSnapshot();
      const pending = pullStateSnapshot();
      expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'If-None-Match': '"old-validator"' });
      requestFullRejoin(harness.socket);
      harness.sync(generation);
      gate.resolve(response(null, null, 304));
      expect(await pending).toEqual({ ok: false, applied: false });
      expect((await pullStateSnapshot()).applied).toBe(true);
      expect(fetchMock.mock.calls[2][1].headers).toEqual({});
      expect(useMapStore.getState().tokens.hero.x).toBe(20);
      harness.cleanup();
    }
  );

  it.each(['fetch', 'json'] as const)(
    'discards prior-generation snapshot and ETag delayed at %s',
    async (phase) => {
      const stale = delayed(snapshot('old', 501, 99), phase);
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValue(response(snapshot('new', 0, 20), '"new"'));
      vi.stubGlobal('fetch', fetchMock);
      const pending = pullStateSnapshot();
      await stale.ready;
      const harness = socketHarness();
      requestFullRejoin(harness.socket);
      harness.sync('new');
      await pullStateSnapshot();
      stale.release();
      expect((await pending).applied).toBe(false);
      expect(useMapStore.getState().tokens.hero.x).toBe(20);
      expect(getLastEventId()).toBe(0);
      await pullStateSnapshot();
      expect(fetchMock.mock.calls[2][1].headers).toEqual({ 'If-None-Match': '"new"' });
      harness.cleanup();
    }
  );

  it.each(['session switch', 'same-session re-entry', 'same-generation rejoin'])(
    'fences %s even if cursor/generation repeat',
    async (transition) => {
      const stale = delayed(snapshot('old', 501, 99), 'json');
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockReturnValueOnce(stale.result)
          .mockResolvedValue(response(snapshot('old', 0, 20)))
      );
      const pending = pullStateSnapshot();
      await stale.ready;
      if (transition === 'session switch') useSessionStore.setState({ sessionId: 'B' });
      else if (transition === 'same-session re-entry') {
        useSessionStore.getState().reset();
        useSessionStore.setState({
          sessionId: 'A',
          roomCode: 'ROOM',
          userId: 'user',
          generation: 'old',
        });
      } else {
        const harness = socketHarness();
        harness.sync('old');
        harness.cleanup();
      }
      await pullStateSnapshot();
      stale.release();
      expect((await pending).applied).toBe(false);
      expect(useMapStore.getState().tokens.hero.x).toBe(20);
    }
  );

  it.each(['fetch', 'json'] as const)('discards old replay delayed at %s', async (phase) => {
    recordSnapshotCursor(500);
    const stale = delayed(replay('old', 501), phase);
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(stale.result));
    const harness = socketHarness();
    const pending = pullEventCursor(harness.socket);
    await stale.ready;
    requestFullRejoin(harness.socket);
    harness.sync('new');
    recordSnapshotCursor(0);
    stale.release();
    expect(await pending).toBe(0);
    expect(getLastEventId()).toBe(0);
    expect(useMapStore.getState().tokens.hero.x).toBe(0);
    harness.cleanup();
  });

  it('ignores old 410s after a new generation has joined', async () => {
    recordSnapshotCursor(500);
    const gate = deferred<ReturnType<typeof response>>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(gate.promise));
    const harness = socketHarness();
    const pending = pullEventCursor(harness.socket);
    harness.sync('new');
    recordSnapshotCursor(0);
    gate.resolve(response(null, null, 410));
    await pending;
    expect(harness.socket.emit).not.toHaveBeenCalled();
    expect(useSessionStore.getState().generation).toBe('new');
    harness.cleanup();
  });

  it('drops old debounced snapshot triggers on rejoin', async () => {
    vi.stubGlobal('fetch', vi.fn());
    triggerSnapshot('old mutation');
    requestFullRejoin();
    useSessionStore.setState({ generation: 'new' });
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the latest of equal-cursor snapshots resolving in reverse order', async () => {
    const stale = delayed(snapshot('old', 500, 99), 'json');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValue(response(snapshot('old', 500, 20)))
    );
    const pending = pullStateSnapshot();
    await stale.ready;
    await pullStateSnapshot();
    stale.release();
    expect((await pending).applied).toBe(false);
    expect(useMapStore.getState().tokens.hero.x).toBe(20);
  });

  it('replays only the fresh suffix when a newer snapshot overtakes replay', async () => {
    recordSnapshotCursor(1);
    const stale = delayed(replay('old', 4, 2, 3, 4), 'json');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(stale.result)
        .mockResolvedValue(response(snapshot('old', 3, 3)))
    );
    const harness = socketHarness();
    const pending = pullEventCursor(harness.socket);
    await stale.ready;
    await pullStateSnapshot();
    stale.release();
    expect(await pending).toBe(1);
    expect(useMapStore.getState().tokens.hero.x).toBe(4);
    expect(getLastEventId()).toBe(4);
    harness.cleanup();
  });

  it('does not cache a snapshot rejected after a newer live event', async () => {
    const stale = delayed(snapshot('old', 1, 99), 'json');
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.result)
      .mockResolvedValue(response(snapshot('old', 3, 3)));
    vi.stubGlobal('fetch', fetchMock);
    const pending = pullStateSnapshot();
    await stale.ready;
    recordEventId(2);
    stale.release();
    expect((await pending).applied).toBe(false);
    await pullStateSnapshot();
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
  });
});
