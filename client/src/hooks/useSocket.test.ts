import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { useSocket } from './useSocket';
import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';
import { getLastEventId, pullEventCursor, recordSnapshotCursor } from '../socket/eventCursor';
import { pullStateSnapshot } from '../socket/stateSnapshot';

const hook = vi.hoisted(() => ({
  socket: null as unknown as Socket,
  cleanup: undefined as void | (() => void),
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void | (() => void)) => {
    hook.cleanup = effect();
  },
}));
vi.mock('../socket/client', () => ({
  getSocket: () => hook.socket,
  disconnectSocket: () => hook.socket.disconnect(),
}));

function harness() {
  const handlers = new Map<string, Set<(payload: never) => void>>();
  const anyHandlers = new Set<(kind: string, payload?: unknown) => void>();
  const receive = (kind: string, payload?: unknown) => {
    for (const handler of anyHandlers) handler(kind, payload);
    for (const handler of handlers.get(kind) ?? []) handler(payload as never);
  };
  const socket = {
    connected: false,
    emit: vi.fn(),
    on(kind: string, handler: (payload: never) => void) {
      const callbacks = handlers.get(kind) ?? new Set();
      callbacks.add(handler);
      handlers.set(kind, callbacks);
    },
    off(kind: string, handler?: (payload: never) => void) {
      if (handler) handlers.get(kind)?.delete(handler);
      else handlers.delete(kind);
    },
    onAny: (handler: (kind: string, payload?: unknown) => void) => anyHandlers.add(handler),
    offAny: (handler: (kind: string, payload?: unknown) => void) => anyHandlers.delete(handler),
    connect: vi.fn(() => {
      if (socket.connected) return;
      socket.connected = true;
      receive('connect');
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
      receive('disconnect');
    }),
    io: { on: vi.fn(), off: vi.fn() },
  };
  return {
    socket,
    receive,
    sync(generation = 'old', nextEventId = 0) {
      receive('session:state-sync', {
        generation,
        nextEventId,
        sessionId: 'A',
        roomCode: 'ROOM',
        userId: 'user',
        isDM: true,
        players: [],
        settings: {},
        currentMapId: 'map',
        gameMode: 'combat',
      });
    },
    joins: () => socket.emit.mock.calls.filter(([kind]) => kind === 'session:join'),
  };
}

function snapshot(generation: string, nextEventId: number, x: number, combat: unknown = null) {
  return {
    generation,
    nextEventId,
    mapId: 'map',
    tokens: [{ id: 'hero', mapId: 'map', x, y: 0, conditions: [] }],
    combat,
    characters: {},
    roundNumber: 1,
  };
}

function response(body: unknown, etag = '"snapshot"') {
  return { status: 200, ok: true, headers: { get: () => etag }, json: async () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval, clearInterval }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  useSessionStore.getState().reset();
  useMapStore.setState({ currentMap: { id: 'map' }, tokens: {} } as never);
  useCombatStore.setState({ active: false, combatants: [] });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  hook.cleanup?.();
  hook.cleanup = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSocket hydration lifecycle', () => {
  it('reconciles a cold restart with the same durable generation and resumed cursor', async () => {
    const h = harness();
    hook.socket = h.socket as unknown as Socket;
    useSocket('ROOM');
    h.sync('durable', 500);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(snapshot('durable', 500, 10), '"durable"'));
    vi.stubGlobal('fetch', fetchMock);
    await pullStateSnapshot();
    h.socket.disconnect();
    h.socket.connect();
    h.sync('durable', 500);
    expect(getLastEventId()).toBe(500);
    await pullEventCursor(hook.socket);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await pullStateSnapshot()).applied).toBe(true);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
    h.receive('session:heartbeat-ack', { ok: true, generation: 'durable', nextEventId: 500 });
    expect(h.joins()).toHaveLength(2);
    expect(useSessionStore.getState().generation).toBe('durable');
  });

  it('attaches before connecting and emits exactly one join per reconnect', () => {
    const h = harness();
    hook.socket = h.socket as unknown as Socket;
    useSocket('ROOM');
    expect(h.joins()).toHaveLength(1);
    expect(h.socket.io.on).not.toHaveBeenCalled();
    h.sync();
    recordSnapshotCursor(500);
    h.socket.disconnect();
    expect(useSessionStore.getState().generation).toBeNull();
    expect(getLastEventId()).toBe(0);
    h.socket.connect();
    expect(h.joins()).toHaveLength(2);
  });

  it.each([
    { ok: true, generation: 'new' },
    { ok: false, rejoinRequired: true },
  ])(
    'uses full rejoin for heartbeat %j and does not trust its generation as hydration',
    async (ack) => {
      const h = harness();
      hook.socket = h.socket as unknown as Socket;
      useSocket('ROOM');
      h.sync();
      recordSnapshotCursor(500);
      h.receive('session:heartbeat-ack', ack);
      expect(h.joins()).toHaveLength(2);
      expect(useSessionStore.getState().generation).toBeNull();
      expect(getLastEventId()).toBe(0);
      await pullStateSnapshot();
      await pullEventCursor(hook.socket);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('blocks polling and buffered joins until the socket is connected and hydrated', async () => {
    const h = harness();
    hook.socket = h.socket as unknown as Socket;
    h.socket.connect.mockImplementation(() => {});
    useSocket('ROOM');
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.joins()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    h.socket.connected = true;
    h.receive('connect');
    expect(h.joins()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('restores full map/combat state after rejoin without an old request overwriting it', async () => {
    const h = harness();
    hook.socket = h.socket as unknown as Socket;
    useSocket('ROOM');
    h.sync();
    let release!: (value: ReturnType<typeof response>) => void;
    const stale = new Promise<ReturnType<typeof response>>((resolve) => {
      release = resolve;
    });
    const actionEconomy = {
      tokenId: 'hero',
      actionUsed: true,
      bonusActionUsed: true,
      reactionUsed: true,
      movementUsed: 25,
      movementRemaining: 5,
    };
    const combat = {
      active: true,
      roundNumber: 7,
      currentTurnIndex: 0,
      currentTokenId: 'hero',
      combatants: [{ tokenId: 'hero', name: 'Hero', hp: 4, conditions: [] }],
      startedAt: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot('old', 500, 1), '"old"'))
      .mockReturnValueOnce(stale)
      .mockResolvedValue(response(snapshot('new', 0, 20, combat), '"new"'));
    vi.stubGlobal('fetch', fetchMock);
    await pullStateSnapshot();
    const pending = pullStateSnapshot();
    h.socket.disconnect();
    h.socket.connect();
    await pullStateSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    h.sync('new');
    h.receive('map:loaded', {
      map: { id: 'map', name: 'Restored map', walls: [], fogState: [], zones: [] },
      tokens: snapshot('new', 0, 20).tokens,
      drawings: [],
    });
    h.receive('combat:state-sync', { ...combat, actionEconomy });
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock.mock.calls[2][1].headers).toEqual({});
    release(response(snapshot('old', 501, 99), '"obsolete"'));
    expect((await pending).applied).toBe(false);
    expect(useMapStore.getState().tokens.hero.x).toBe(20);
    expect(useCombatStore.getState()).toMatchObject({
      active: true,
      roundNumber: 7,
      currentTurnIndex: 0,
      actionEconomy,
    });
    expect(getLastEventId()).toBe(0);
  });

  it('cleans up listeners and recovery work on unmount', async () => {
    const h = harness();
    hook.socket = h.socket as unknown as Socket;
    useSocket('ROOM');
    h.sync();
    hook.cleanup?.();
    hook.cleanup = undefined;
    h.receive('connect');
    h.receive('session:heartbeat-ack', { rejoinRequired: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.joins()).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(useSessionStore.getState().generation).toBeNull();
  });
});
