import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
  type RoomState,
} from '../utils/roomState.js';
import '../services/chatCommands/encounterAndRestHandlers.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 's-hit-dice-sync';
const DM_TABS = ['dm-1', 'dm-2'];
const OWNER_TABS = ['owner-1', 'owner-2'];

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function token(): Token {
  return {
    id: 'pc-token',
    mapId: 'map-1',
    characterId: 'char-1',
    name: 'Rook',
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#ffffff',
    conditions: [],
    ownerUserId: 'owner-user',
    createdAt: new Date().toISOString(),
  };
}

function seedRoom(): RoomState {
  const room = createRoom(SESSION, 'ROOM-HD', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('pc-token', token());
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-1',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-2',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Rook',
    socketId: 'owner-1',
    role: 'player',
    characterId: 'char-1',
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Rook',
    socketId: 'owner-2',
    role: 'player',
    characterId: 'char-1',
  });
  addPlayerToRoom(SESSION, {
    userId: 'bystander-user',
    displayName: 'Vex',
    socketId: 'bystander',
    role: 'player',
    characterId: null,
  });
  return room;
}

function characterRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'char-1',
    name: 'Rook',
    hit_points: 5,
    max_hit_points: 20,
    ability_scores: { con: 14 },
    hit_dice: [{ dieSize: 10, total: 2, used: 0 }],
    version: 7,
    ...overrides,
  };
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((emission) => emission.event === event)
    .map((emission) => emission.channelId)
    .sort();
}

function characterChanges(emissions: Emission[]): Record<string, unknown> | undefined {
  return (
    emissions.find((emission) => emission.event === 'character:updated')?.payload as
      | { changes?: Record<string, unknown> }
      | undefined
  )?.changes;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('!hd authoritative persistence and privacy', () => {
  it('persists a tracked die with optimistic versioning and syncs every DM and owner tab', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT hit_points')) return { rows: [characterRow()] };
      if (sql.startsWith('UPDATE characters')) return { rows: [{ version: 8 }] };
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hd 1');

    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).startsWith('UPDATE characters')
    );
    expect(update?.[0]).toContain('WHERE id = $3 AND version = $4 RETURNING version');
    expect(update?.[1]).toEqual([
      13,
      JSON.stringify([{ dieSize: 10, total: 2, used: 1 }]),
      'char-1',
      7,
    ]);
    expect(channelsFor(emissions, 'character:updated')).toEqual([...DM_TABS, ...OWNER_TABS]);
    expect(characterChanges(emissions)).toEqual({
      hitPoints: 13,
      hitDice: [{ dieSize: 10, total: 2, used: 1 }],
      version: 8,
    });
  });

  it('includes visible bystanders only when PC stat sharing is enabled', async () => {
    const room = seedRoom();
    room.showPlayersToPlayers = true;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT hit_points')) return { rows: [characterRow()] };
      if (sql.startsWith('UPDATE characters')) return { rows: [{ version: 8 }] };
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hitdice 1');

    expect(channelsFor(emissions, 'character:updated')).toEqual([
      'bystander',
      ...DM_TABS,
      ...OWNER_TABS,
    ]);
  });

  it('fails closed when the write throws and never announces or emits a sheet update', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT hit_points')) return { rows: [characterRow()] };
      if (sql.startsWith('UPDATE characters')) throw new Error('database unavailable');
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hd 1');

    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(emissions.some((emission) => emission.channelId === SESSION)).toBe(false);
    const privateMessage = emissions.find((emission) => emission.channelId === 'owner-2');
    expect(privateMessage).toBeDefined();
    expect(String((privateMessage?.payload as { content?: string }).content)).toContain(
      'could not save'
    );
  });

  it('fails closed on an optimistic conflict without broadcasting the rolled result', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT hit_points')) return { rows: [characterRow()] };
      if (sql.startsWith('UPDATE characters')) return { rows: [] };
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hd 1');

    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(emissions.some((emission) => emission.channelId === SESSION)).toBe(false);
    expect(
      emissions.some((emission) =>
        String((emission.payload as { content?: string }).content).includes('another tab')
      )
    ).toBe(true);
  });

  it('does not write or announce when no tracked Hit Dice remain', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT hit_points')) {
        return { rows: [characterRow({ hit_dice: [{ dieSize: 10, total: 2, used: 2 }] })] };
      }
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hd 1');

    expect(mockQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE characters'))).toBe(
      false
    );
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(emissions.some((emission) => emission.channelId === SESSION)).toBe(false);
  });

  it('rejects Hit Dice during combat before touching the character row', async () => {
    const room = seedRoom();
    room.combatState = { active: true } as CombatState;
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hd 1');

    expect(mockQuery).not.toHaveBeenCalled();
    expect(
      emissions.some((emission) =>
        String((emission.payload as { content?: string }).content).includes('active combat')
      )
    ).toBe(true);
  });

  it('rejects an untracked fallback pool instead of granting repeatable free healing', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT hit_points')) return { rows: [characterRow({ hit_dice: [] })] };
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hd 2 d8');

    expect(mockQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE characters'))).toBe(
      false
    );
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(
      emissions.some((emission) =>
        String((emission.payload as { content?: string }).content).includes('no tracked Hit Dice')
      )
    ).toBe(true);
  });

  it('honors an optional die size for multiclass Hit Dice pools', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT hit_points')) {
        return {
          rows: [
            characterRow({
              hit_dice: [
                { dieSize: 10, total: 2, used: 0 },
                { dieSize: 6, total: 1, used: 0 },
              ],
            }),
          ],
        };
      }
      if (sql.startsWith('UPDATE characters')) return { rows: [{ version: 12 }] };
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-1')!, '!hd 1 d6');

    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).startsWith('UPDATE characters')
    );
    expect(update?.[1]).toEqual([
      11,
      JSON.stringify([
        { dieSize: 10, total: 2, used: 0 },
        { dieSize: 6, total: 1, used: 1 },
      ]),
      'char-1',
      7,
    ]);
    expect(characterChanges(emissions)?.version).toBe(12);
  });
});
