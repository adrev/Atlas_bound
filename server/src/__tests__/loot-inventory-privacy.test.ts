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

async function takeHandler() {
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
    (entry) => entry.route?.path === '/characters/:id/loot/take' && entry.route.methods.post
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
    characterId: 'target-character',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-socket-2',
    role: 'player',
    characterId: 'target-character',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'other-user',
    displayName: 'Other',
    socketId: 'other-socket',
    role: 'player',
    characterId: null,
  });
}

function arrangeQueries() {
  poolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT user_id FROM characters')) {
      return { rows: [{ user_id: 'owner-user' }] };
    }
    if (sql.includes('FROM session_players') && sql.includes('character_id')) {
      return { rows: [{ session_id: 'loot-session' }] };
    }
    return { rows: [] };
  });
  clientQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'entry-1',
          character_id: 'source-character',
          item_slug: null,
          custom_item_id: null,
          item_name: 'Silver Key',
          item_rarity: 'common',
          quantity: 2,
          equipped: 0,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'target-character',
          inventory: '[]',
          user_id: 'owner-user',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ version: 8 }] })
    .mockResolvedValueOnce({ rows: [] });
}

async function takeLoot() {
  const handler = await takeHandler();
  const req = {
    params: { id: 'source-character' },
    body: { entryId: 'entry-1', targetCharacterId: 'target-character' },
    user: { id: 'owner-user' },
  } as unknown as Request;
  const res = makeResponse();
  await handler(req, res);
  return res;
}

beforeEach(() => {
  getAllRooms().clear();
  emissions.length = 0;
  poolQuery.mockReset();
  clientQuery.mockReset();
});

describe('loot inventory update privacy', () => {
  it('sends inventory and version only to DMs and every owner tab by default', async () => {
    seedRoom(false);
    arrangeQueries();

    const res = await takeLoot();

    expect(res.statusCode).toBe(200);
    expect(res.body?.version).toBe(8);
    const updates = emissions.filter((entry) => entry.event === 'character:updated');
    expect(updates.map((entry) => entry.socketId).sort()).toEqual([
      'dm-socket',
      'owner-socket',
      'owner-socket-2',
    ]);
    expect(updates[0].payload).toMatchObject({
      characterId: 'target-character',
      changes: { version: 8 },
    });
  });

  it('includes other players only after the DM enables party-sheet sharing', async () => {
    seedRoom(true);
    arrangeQueries();

    await takeLoot();

    const recipients = emissions
      .filter((entry) => entry.event === 'character:updated')
      .map((entry) => entry.socketId)
      .sort();
    expect(recipients).toEqual(['dm-socket', 'other-socket', 'owner-socket', 'owner-socket-2']);
  });
});
