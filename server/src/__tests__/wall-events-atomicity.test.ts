import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientQuery, connect, release, getPlayerBySocketId, resolveViewingMapId, socketsOnMap } =
  vi.hoisted(() => ({
    clientQuery: vi.fn(),
    connect: vi.fn(),
    release: vi.fn(),
    getPlayerBySocketId: vi.fn(),
    resolveViewingMapId: vi.fn(),
    socketsOnMap: vi.fn(),
  }));

vi.mock('../db/connection.js', () => ({
  default: { connect },
}));

vi.mock('../utils/roomState.js', () => ({
  getPlayerBySocketId,
  resolveViewingMapId,
  socketsOnMap,
}));

import { registerWallEvents } from '../socket/wallEvents.js';

type Handler = (data: unknown) => Promise<void> | void;

function harness() {
  const handlers: Record<string, Handler> = {};
  const emissions: Array<{ socketId: string; event: string; payload: unknown }> = [];
  const socket = {
    id: 'dm-socket',
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    emit: vi.fn(),
  };
  const io = {
    to: (socketId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ socketId, event, payload }),
    }),
  };
  registerWallEvents(io as never, socket as never);
  return { handlers, emissions, socket };
}

beforeEach(() => {
  clientQuery.mockReset();
  connect.mockReset();
  release.mockReset();
  connect.mockResolvedValue({ query: clientQuery, release });
  getPlayerBySocketId.mockReset();
  getPlayerBySocketId.mockReturnValue({
    player: { userId: 'dm-user', role: 'dm' },
    room: { sessionId: 'session-1' },
  });
  resolveViewingMapId.mockReset();
  resolveViewingMapId.mockReturnValue('map-1');
  socketsOnMap.mockReset();
  socketsOnMap.mockReturnValue(['dm-socket', 'player-socket']);
});

describe('wall edit atomicity', () => {
  it('adds a wall while holding a database row lock and broadcasts only after commit', async () => {
    const order: string[] = [];
    clientQuery.mockImplementation(async (sql: string) => {
      order.push(sql);
      if (/SELECT walls/.test(sql)) return { rows: [{ walls: '[]' }] };
      return { rows: [] };
    });
    const { handlers, emissions } = harness();

    await handlers['map:wall-add']!({ x1: 0, y1: 0, x2: 70, y2: 70 });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('BEGIN');
    expect(order[1]).toMatch(/SELECT walls FROM maps WHERE id = \$1 FOR UPDATE/);
    expect(order[2]).toMatch(/UPDATE maps SET walls/);
    expect(order[3]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    expect(emissions).toHaveLength(2);
    expect(emissions[0]?.payload).toMatchObject({
      mapId: 'map-1',
      walls: [{ x1: 0, y1: 0, x2: 70, y2: 70 }],
    });
  });

  it('removes from the locked latest wall array instead of a stale snapshot', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT walls/.test(sql)) {
        return {
          rows: [
            {
              walls: JSON.stringify([
                { x1: 0, y1: 0, x2: 70, y2: 70 },
                { x1: 70, y1: 70, x2: 140, y2: 140 },
              ]),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { handlers, emissions } = harness();

    await handlers['map:wall-remove']!({ index: 0 });

    const update = clientQuery.mock.calls.find(([sql]) =>
      /UPDATE maps SET walls/.test(String(sql))
    );
    expect(JSON.parse(String(update?.[1]?.[0]))).toEqual([{ x1: 70, y1: 70, x2: 140, y2: 140 }]);
    expect(emissions[0]?.payload).toMatchObject({
      walls: [{ x1: 70, y1: 70, x2: 140, y2: 140 }],
    });
  });

  it('rolls back an invalid removal without writing or broadcasting', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT walls/.test(sql)) {
        return { rows: [{ walls: JSON.stringify([{ x1: 0, y1: 0, x2: 70, y2: 70 }]) }] };
      }
      return { rows: [] };
    });
    const { handlers, emissions } = harness();

    await handlers['map:wall-remove']!({ index: 9 });

    const sql = clientQuery.mock.calls.map(([query]) => String(query));
    expect(sql).toContain('ROLLBACK');
    expect(sql.some((query) => /UPDATE maps SET walls/.test(query))).toBe(false);
    expect(emissions).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the client when persistence fails', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (/SELECT walls/.test(sql)) return { rows: [{ walls: '[]' }] };
      if (/UPDATE maps SET walls/.test(sql)) throw new Error('write failed');
      return { rows: [] };
    });
    const { handlers, emissions, socket } = harness();

    await handlers['map:wall-add']!({ x1: 0, y1: 0, x2: 70, y2: 70 });

    const sql = clientQuery.mock.calls.map(([query]) => String(query));
    expect(sql).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
    expect(emissions).toEqual([]);
    expect(socket.emit).toHaveBeenCalledWith('session:error', {
      message: 'An unexpected error occurred',
    });
  });
});
