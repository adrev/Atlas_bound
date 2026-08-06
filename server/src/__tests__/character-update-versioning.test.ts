import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import type { CombatState, Token } from '@dnd-vtt/shared';
import type { Request } from 'express';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerCharacterEvents } from '../socket/characterEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';
import { fanoutCharacterUpdateAcrossRooms } from '../services/CharacterUpdateService.js';
import { setIO } from '../socket/ioInstance.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function fakeIo(): { io: Server; emissions: Emission[] } {
  const emissions: Emission[] = [];
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as unknown as Server;
  return { io, emissions };
}

function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const socket = {
    id: 'sock-player',
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(event, handler);
      return socket;
    },
  } as unknown as Socket;
  return { socket, handlers };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

async function getRestUpdateHandler() {
  const { default: router } = await import('../routes/characters.js');
  const layer = (router as unknown as { stack: Array<Record<string, any>> }).stack.find(
    (entry: any) => entry.route?.path === '/:id' && entry.route?.methods?.put
  );
  return layer!.route.stack[0].handle as (req: Request, res: any) => Promise<void>;
}

function seedRoom(sessionId = 'session-character-version', socketId = 'sock-player') {
  const room = createRoom(sessionId, 'CHARVER', 'dm-user');
  addPlayerToRoom(room.sessionId, {
    userId: 'player-1',
    displayName: 'Player',
    socketId,
    role: 'player',
    characterId: 'char-1',
  });
  return room;
}

function seedActiveCombat(
  sessionId = 'session-character-version',
  tokenId = 'token-1',
  socketId = 'sock-player'
) {
  const room = seedRoom(sessionId, socketId);
  const token: Token = {
    id: tokenId,
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
    ownerUserId: 'player-1',
    createdAt: new Date(0).toISOString(),
  };
  room.tokens.set(token.id, token);
  room.combatState = {
    sessionId: room.sessionId,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    startedAt: new Date(0).toISOString(),
    combatants: [
      {
        tokenId: token.id,
        characterId: 'char-1',
        name: 'Rook',
        initiative: 12,
        initiativeBonus: 2,
        hp: 10,
        maxHp: 20,
        tempHp: 0,
        armorClass: 15,
        speed: 30,
        isNPC: false,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        portraitUrl: null,
      },
    ],
  } satisfies CombatState;
  return room;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('character:update version conflict handling', () => {
  it('preserves spent server-managed resources during socket feature edits', async () => {
    seedRoom();
    const existingFeatures = [
      {
        name: 'Racial Spell: Hellish Rebuke',
        usesTotal: 1,
        usesRemaining: 0,
        resetOn: 'long',
      },
    ];
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, user_id, version, wild_shape FROM characters')) {
        return { rows: [{ id: 'char-1', user_id: 'player-1', version: 3 }] };
      }
      if (sql.includes('SELECT features FROM characters')) {
        return { rows: [{ features: JSON.stringify(existingFeatures) }] };
      }
      if (sql.trim().startsWith('UPDATE characters SET')) return { rows: [{ version: 4 }] };
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:update')?.({
      characterId: 'char-1',
      changes: {
        features: [
          { name: 'Editable Feature', description: 'Still editable' },
          { name: 'Ki Points', usesTotal: 99, usesRemaining: 99 },
        ],
      },
      expectedVersion: 3,
    });

    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).trim().startsWith('UPDATE characters SET')
    );
    const persisted = JSON.parse(update?.[1]?.[0] as string) as Array<Record<string, unknown>>;
    expect(persisted).toEqual([
      { name: 'Editable Feature', description: 'Still editable' },
      existingFeatures[0],
    ]);
    const updatePayload = emissions.find((entry) => entry.event === 'character:updated')
      ?.payload as { changes?: { features?: unknown[] } } | undefined;
    expect(updatePayload?.changes?.features).toEqual(persisted);
  });

  it('runs live combat synchronization from the committed REST fallback route', async () => {
    const room = seedActiveCombat();
    const { io, emissions } = fakeIo();
    setIO(io);
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM characters c') && sql.includes('AS is_owner')) {
        return {
          rows: [
            {
              user_id: 'player-1',
              is_owner: true,
              is_dm_in_session: false,
              is_linked_session_dm: false,
              is_token_session_dm: false,
            },
          ],
        };
      }
      if (sql.trim().startsWith('UPDATE characters SET')) {
        return {
          rows: [
            {
              id: 'char-1',
              user_id: 'player-1',
              name: 'Rook',
              hit_points: 9,
              max_hit_points: 20,
              temp_hit_points: 0,
              armor_class: 15,
              speed: 30,
              death_saves: { successes: 0, failures: 0 },
              version: 4,
              wild_shape: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const req = {
      user: { id: 'player-1' },
      params: { id: 'char-1' },
      body: { hitPoints: 9, expectedVersion: 3 },
    } as unknown as Request;
    const res = fakeResponse();

    try {
      const handler = await getRestUpdateHandler();
      await handler(req, res);
    } finally {
      setIO(null as unknown as Server);
    }

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'char-1', hitPoints: 9, version: 4 });
    expect(room.combatState?.combatants[0].hp).toBe(9);
    expect(emissions.some((entry) => entry.event === 'combat:state-sync')).toBe(true);
    expect(emissions.some((entry) => entry.event === 'character:updated')).toBe(true);
  });

  it('synchronizes REST fallback fanout across every live room that references the character', () => {
    const firstRoom = seedActiveCombat();
    const secondRoom = seedActiveCombat('session-character-version-2', 'token-2', 'sock-player-2');
    const unrelatedRoom = createRoom('session-character-version-3', 'OTHER', 'other-dm');
    mockQuery.mockResolvedValue({ rows: [] });
    const { io, emissions } = fakeIo();

    fanoutCharacterUpdateAcrossRooms(io, 'char-1', 'player-1', {
      hitPoints: 8,
      tempHitPoints: 2,
      version: 4,
    });

    expect(firstRoom.combatState?.combatants[0]).toMatchObject({ hp: 8, tempHp: 2 });
    expect(secondRoom.combatState?.combatants[0]).toMatchObject({ hp: 8, tempHp: 2 });
    expect(unrelatedRoom.combatState).toBeNull();
    expect(
      emissions
        .filter((entry) => entry.event === 'combat:state-sync')
        .map((entry) => entry.channelId)
        .sort()
    ).toEqual(['sock-player', 'sock-player-2']);
    expect(
      emissions
        .filter((entry) => entry.event === 'character:updated')
        .map((entry) => entry.channelId)
        .sort()
    ).toEqual(['sock-player', 'sock-player-2']);
  });

  it('synchronizes committed HP fields into active combat state and fans out the tracker', async () => {
    const room = seedActiveCombat();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, user_id, version, wild_shape FROM characters')) {
        return { rows: [{ id: 'char-1', user_id: 'player-1', version: 3 }] };
      }
      if (sql.trim().startsWith('UPDATE characters SET')) return { rows: [{ version: 4 }] };
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:update')?.({
      characterId: 'char-1',
      changes: {
        hitPoints: 15,
        maxHitPoints: 25,
        tempHitPoints: 3,
        deathSaves: { successes: 1, failures: 0 },
        armorClass: 16,
        speed: 35,
      },
      expectedVersion: 3,
    });

    expect(room.combatState?.combatants[0]).toMatchObject({
      hp: 15,
      maxHp: 25,
      tempHp: 3,
      deathSaves: { successes: 1, failures: 0 },
      armorClass: 16,
      speed: 35,
    });
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE combat_state'))
    ).toBe(true);
    expect(emissions.some((entry) => entry.event === 'combat:state-sync')).toBe(true);
    expect(emissions.some((entry) => entry.event === 'character:updated')).toBe(true);
  });

  it('keeps beast-form AC and speed while syncing underlying Wild Shape character HP', async () => {
    const room = seedActiveCombat();
    const wildShape = JSON.stringify({
      formSlug: 'brown-bear',
      formName: 'Brown Bear',
      formHp: 22,
      formMaxHp: 34,
      formAc: 11,
      formSpeed: { walk: 40 },
      formCr: 1,
      moon: true,
    });
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, user_id, version, wild_shape FROM characters')) {
        return {
          rows: [{ id: 'char-1', user_id: 'player-1', version: 3, wild_shape: wildShape }],
        };
      }
      if (sql.trim().startsWith('UPDATE characters SET')) return { rows: [{ version: 4 }] };
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:update')?.({
      characterId: 'char-1',
      changes: { hitPoints: 12, maxHitPoints: 24, armorClass: 18, speed: 40 },
      expectedVersion: 3,
    });

    expect(room.combatState?.combatants[0]).toMatchObject({
      hp: 12,
      maxHp: 24,
      armorClass: 15,
      speed: 30,
    });
    expect(emissions.some((entry) => entry.event === 'combat:state-sync')).toBe(true);
  });

  it('does not rewrite combat state for a non-combat character field', async () => {
    seedActiveCombat();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, user_id, version, wild_shape FROM characters')) {
        return { rows: [{ id: 'char-1', user_id: 'player-1', version: 3 }] };
      }
      if (sql.trim().startsWith('UPDATE characters SET')) return { rows: [{ version: 4 }] };
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:update')?.({
      characterId: 'char-1',
      changes: { notes: { backstory: 'Still secret' } },
      expectedVersion: 3,
    });

    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE combat_state'))
    ).toBe(false);
    expect(emissions.some((entry) => entry.event === 'combat:state-sync')).toBe(false);
    expect(emissions.some((entry) => entry.event === 'character:updated')).toBe(true);
  });

  it('rejects stale character writes and returns the latest character to the sender', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, user_id, version, wild_shape FROM characters')) {
        return { rows: [{ id: 'char-1', user_id: 'player-1', version: 3 }] };
      }
      if (sql.trim().startsWith('UPDATE characters SET')) return { rows: [] };
      if (sql.includes('SELECT * FROM characters WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'char-1',
              user_id: 'player-1',
              version: 4,
              name: 'Rook',
              hit_points: 10,
              max_hit_points: 20,
              temp_hit_points: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:update')?.({
      characterId: 'char-1',
      changes: { hitPoints: 15 },
      expectedVersion: 3,
    });

    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).trim().startsWith('UPDATE characters SET')
    );
    expect(update?.[0]).toContain('AND version = $3 RETURNING version');
    expect(update?.[1]).toEqual([15, 'char-1', 3]);
    expect(emissions.some((e) => e.event === 'character:updated')).toBe(false);
    expect(emissions.map((e) => e.event)).toEqual(['character:update-conflict']);
    const conflict = emissions[0].payload as {
      character?: { id?: string; version?: number; hitPoints?: number };
    };
    expect(conflict.character?.id).toBe('char-1');
    expect(conflict.character?.version).toBe(4);
    expect(conflict.character?.hitPoints).toBe(10);
  });

  it('rejects a versionless legacy write and returns the authoritative character', async () => {
    seedRoom();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, user_id, version, wild_shape FROM characters')) {
        return { rows: [{ id: 'char-1', user_id: 'player-1', version: 3 }] };
      }
      if (sql.includes('SELECT * FROM characters WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'char-1',
              user_id: 'player-1',
              version: 3,
              name: 'Rook',
              hit_points: 10,
              max_hit_points: 20,
              temp_hit_points: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();
    const { socket, handlers } = fakeSocket();
    registerCharacterEvents(io, socket);

    await handlers.get('character:update')?.({
      characterId: 'char-1',
      changes: { hitPoints: 15 },
    });

    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).trim().startsWith('UPDATE characters SET'))
    ).toBe(false);
    expect(emissions.map((entry) => entry.event)).toEqual(['character:update-conflict']);
    const conflict = emissions[0].payload as {
      character?: { version?: number; hitPoints?: number };
    };
    expect(conflict.character).toMatchObject({ version: 3, hitPoints: 10 });
  });
});
