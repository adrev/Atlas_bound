import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';

interface Emission {
  socketId: string;
  event: string;
  payload: Record<string, unknown>;
}

const { clientQuery, poolQuery, emissions } = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  poolQuery: vi.fn(),
  emissions: [] as Emission[],
}));

vi.mock('../db/connection.js', () => ({
  default: {
    query: poolQuery,
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
  },
}));

vi.mock('../utils/authorization.js', () => ({
  getAuthUserId: () => 'owner-user',
  assertCharacterOwnerOrDM: vi.fn(async () => undefined),
}));

vi.mock('../socket/ioInstance.js', () => ({
  getIO: () => ({
    to: (socketId: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emissions.push({ socketId, event, payload }),
    }),
  }),
}));

function makeResponse() {
  const res: Partial<Response> & { statusCode: number; body?: Record<string, unknown> } = {
    statusCode: 200,
  };
  res.status = vi.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res as Response;
  }) as never;
  res.json = vi.fn((body: Record<string, unknown>) => {
    res.body = body;
    return res as Response;
  }) as never;
  return res as Response & { statusCode: number; body?: Record<string, unknown> };
}

async function routeHandler(path: string) {
  const router = (await import('../routes/loot.js')).default as never as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
      };
    }>;
  };
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods.post
  );
  return layer!.route!.stack[0].handle;
}

function seedRoom(showPlayersToPlayers: boolean) {
  const room = createRoom('loot-session', 'LOOT', 'dm-user');
  room.showPlayersToPlayers = showPlayersToPlayers;
  addPlayerToRoom(room.sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-socket',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-socket',
    role: 'player',
    characterId: 'char-1',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-socket-2',
    role: 'player',
    characterId: 'char-1',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'other-user',
    displayName: 'Other',
    socketId: 'other-socket',
    role: 'player',
    characterId: null,
  });
}

function characterUpdates() {
  return emissions.filter((entry) => entry.event === 'character:updated');
}

beforeEach(() => {
  getAllRooms().clear();
  emissions.length = 0;
  poolQuery.mockReset();
  clientQuery.mockReset();
});

describe('POST /characters/:id/inventory/enrich version + fanout', () => {
  function arrangeEnrichQueries(opts: {
    ownerUserId: string | null;
    inventory?: unknown[];
    version?: unknown;
  }) {
    const inventory = opts.inventory ?? [{ name: 'Longsword', type: 'gear' }];
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, inventory, user_id FROM characters')) {
        return {
          rows: [
            { id: 'char-1', inventory: JSON.stringify(inventory), user_id: opts.ownerUserId },
          ],
        };
      }
      if (sql.includes('LOWER(name) = $1')) {
        return {
          rows: [
            { slug: 'longsword', type: 'Martial Weapon', rarity: 'common', raw_json: '{}' },
          ],
        };
      }
      if (sql.includes('RETURNING version')) {
        return { rows: [{ version: opts.version ?? 7 }] };
      }
      if (sql.includes('character_sessions')) {
        return { rows: [{ session_id: 'loot-session' }] };
      }
      return { rows: [] };
    });
  }

  async function enrich() {
    const handler = await routeHandler('/characters/:id/inventory/enrich');
    const req = {
      params: { id: 'char-1' },
      body: {},
      user: { id: 'owner-user' },
    } as unknown as Request;
    const res = makeResponse();
    await handler(req, res);
    return res;
  }

  it('returns the authoritative version and fans out to DMs plus every owner tab', async () => {
    seedRoom(false);
    arrangeEnrichQueries({ ownerUserId: 'owner-user' });

    const res = await enrich();

    expect(res.statusCode).toBe(200);
    expect(res.body?.updated).toBe(true);
    expect(res.body?.version).toBe(7);
    const updates = characterUpdates();
    expect(updates.map((entry) => entry.socketId).sort()).toEqual([
      'dm-socket',
      'owner-socket',
      'owner-socket-2',
    ]);
    expect(updates[0].payload).toMatchObject({
      characterId: 'char-1',
      changes: { version: 7 },
    });
    expect(Array.isArray((updates[0].payload.changes as Record<string, unknown>).inventory)).toBe(
      true
    );
  });

  it('includes other players only after the DM enables party-sheet sharing', async () => {
    seedRoom(true);
    arrangeEnrichQueries({ ownerUserId: 'owner-user' });

    await enrich();

    expect(characterUpdates().map((entry) => entry.socketId).sort()).toEqual([
      'dm-socket',
      'other-socket',
      'owner-socket',
      'owner-socket-2',
    ]);
  });

  it('does not write or broadcast when nothing was enriched', async () => {
    seedRoom(true);
    arrangeEnrichQueries({
      ownerUserId: 'owner-user',
      inventory: [{ name: 'Longsword', type: 'weapon', slug: 'longsword' }],
    });

    const res = await enrich();

    expect(res.body?.updated).toBe(false);
    expect(res.body?.version).toBeUndefined();
    expect(
      poolQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE characters'))
    ).toBe(false);
    expect(characterUpdates()).toEqual([]);
  });

  it('omits version but still broadcasts inventory when the returned version is invalid', async () => {
    seedRoom(false);
    arrangeEnrichQueries({ ownerUserId: 'owner-user', version: 0 });

    const res = await enrich();

    expect(res.body?.updated).toBe(true);
    expect(res.body?.version).toBeUndefined();
    const updates = characterUpdates();
    expect(updates.length).toBeGreaterThan(0);
    const changes = updates[0].payload.changes as Record<string, unknown>;
    expect(changes.version).toBeUndefined();
    expect(Array.isArray(changes.inventory)).toBe(true);
  });

  it('restricts NPC-owned inventories to DM tabs while creature sharing is off', async () => {
    seedRoom(true);
    arrangeEnrichQueries({ ownerUserId: 'npc' });

    const res = await enrich();

    expect(res.body?.version).toBe(7);
    expect(characterUpdates().map((entry) => entry.socketId)).toEqual(['dm-socket']);
  });
});

describe('POST /characters/:id/loot/drop version + fanout', () => {
  function arrangeDropQueries(opts: { ownerUserId: string | null; version?: unknown }) {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM maps WHERE id')) {
        return { rows: [{ session_id: 'loot-session' }] };
      }
      if (sql.includes('SELECT role FROM session_players')) {
        return { rows: [{ role: 'dm' }] };
      }
      if (sql.includes('character_sessions')) {
        return { rows: [{ session_id: 'loot-session' }] };
      }
      return { rows: [] };
    });
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              id: 'char-1',
              inventory: JSON.stringify([{ name: 'Silver Key', quantity: 1 }]),
              user_id: opts.ownerUserId,
            },
          ],
        };
      }
      if (sql.includes('RETURNING version')) {
        return { rows: [{ version: opts.version ?? 9 }] };
      }
      return { rows: [] };
    });
  }

  async function dropLoot() {
    const handler = await routeHandler('/characters/:id/loot/drop');
    const req = {
      params: { id: 'char-1' },
      body: { itemIndex: 0, mapId: 'map-1', x: 1, y: 2 },
      user: { id: 'owner-user' },
    } as unknown as Request;
    const res = makeResponse();
    await handler(req, res);
    return res;
  }

  it('returns the authoritative version and fans out to DMs plus every owner tab', async () => {
    seedRoom(false);
    arrangeDropQueries({ ownerUserId: 'owner-user' });

    const res = await dropLoot();

    expect(res.statusCode).toBe(200);
    expect(res.body?.version).toBe(9);
    expect(res.body?.token).toBeTruthy();
    const updates = characterUpdates();
    expect(updates.map((entry) => entry.socketId).sort()).toEqual([
      'dm-socket',
      'owner-socket',
      'owner-socket-2',
    ]);
    expect(updates[0].payload).toMatchObject({
      characterId: 'char-1',
      changes: { version: 9, inventory: [] },
    });
  });

  it('includes other players only after the DM enables party-sheet sharing', async () => {
    seedRoom(true);
    arrangeDropQueries({ ownerUserId: 'owner-user' });

    await dropLoot();

    expect(characterUpdates().map((entry) => entry.socketId).sort()).toEqual([
      'dm-socket',
      'other-socket',
      'owner-socket',
      'owner-socket-2',
    ]);
  });

  it('omits version but still broadcasts inventory when the returned version is invalid', async () => {
    seedRoom(false);
    arrangeDropQueries({ ownerUserId: 'owner-user', version: 'not-a-version' });

    const res = await dropLoot();

    expect(res.statusCode).toBe(200);
    expect(res.body?.version).toBeUndefined();
    const updates = characterUpdates();
    expect(updates.length).toBeGreaterThan(0);
    const changes = updates[0].payload.changes as Record<string, unknown>;
    expect(changes.version).toBeUndefined();
    expect(changes.inventory).toEqual([]);
  });

  it('restricts NPC-owned source inventories to DM tabs while creature sharing is off', async () => {
    seedRoom(true);
    arrangeDropQueries({ ownerUserId: 'npc' });

    await dropLoot();

    expect(characterUpdates().map((entry) => entry.socketId)).toEqual(['dm-socket']);
  });
});
