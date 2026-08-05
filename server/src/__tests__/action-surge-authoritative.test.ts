import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
} from '../utils/roomState.js';
import '../services/chatCommands/classAbilityHandlers.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'action-surge-session';
const CHARACTER = 'fighter-character';
const SURGE: Feature = {
  name: 'Action Surge',
  description: 'Take one additional action.',
  source: 'Fighter',
  sourceType: 'class',
  usesTotal: 1,
  usesRemaining: 1,
  resetOn: 'short',
};

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function fighterToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 'fighter-token',
    mapId: 'map-1',
    characterId: CHARACTER,
    name: 'Brakka',
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
    ownerUserId: 'fighter-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'SURGE', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('fighter-token', fighterToken());
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['fighter-user', 'fighter-1', 'player', CHARACTER],
    ['fighter-user', 'fighter-2', 'player', CHARACTER],
    ['bystander-user', 'bystander-1', 'player', null],
  ] as const) {
    addPlayerToRoom(SESSION, {
      userId: player[0],
      displayName: player[0],
      socketId: player[1],
      role: player[2],
      characterId: player[3],
    });
  }
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    startedAt: new Date().toISOString(),
    combatants: [
      {
        tokenId: 'fighter-token',
        characterId: CHARACTER,
        name: 'Brakka',
        initiative: 18,
        initiativeBonus: 2,
        hp: 20,
        maxHp: 20,
        tempHp: 0,
        armorClass: 18,
        speed: 30,
        isNPC: false,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        portraitUrl: null,
      },
    ],
  };
  room.actionEconomies.set('fighter-token', {
    action: true,
    bonusAction: false,
    reaction: false,
    movementRemaining: 30,
    movementMax: 30,
  });
  return room;
}

function characterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHARACTER,
    class: 'Fighter 2',
    level: 2,
    features: JSON.stringify([SURGE]),
    version: 7,
    ...overrides,
  };
}

function arrange(
  row: Record<string, unknown> | null = characterRow(),
  update: Array<Record<string, unknown>> | Error = [{ version: 8 }]
): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE characters')) {
      if (update instanceof Error) throw update;
      return { rows: update };
    }
    if (sql.includes('SELECT * FROM characters')) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
}

function updateCalls(): Array<[string, unknown[]]> {
  return mockQuery.mock.calls
    .filter((call) => String(call[0]).startsWith('UPDATE characters'))
    .map((call) => [call[0] as string, call[1] as unknown[]]);
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((emission) => emission.event === event)
    .map((emission) => emission.channelId)
    .sort();
}

function whispers(emissions: Emission[]): string[] {
  return emissions
    .filter(
      (emission) =>
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'whisper'
    )
    .map((emission) => (emission.payload as { content: string }).content);
}

function publicMessages(emissions: Emission[]): Array<Record<string, unknown>> {
  return emissions
    .filter(
      (emission) =>
        emission.channelId === SESSION &&
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'system'
    )
    .map((emission) => emission.payload as Record<string, unknown>);
}

function expectFailedClosed(emissions: Emission[]): void {
  expect(updateCalls()).toEqual([]);
  expect(channelsFor(emissions, 'character:updated')).toEqual([]);
  expect(channelsFor(emissions, 'combat:action-used')).toEqual([]);
  expect(publicMessages(emissions)).toEqual([]);
  expect(whispers(emissions)).toHaveLength(1);
}

async function run(emissions: Emission[], command = '!actionsurge'): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('fighter-1')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
  arrange();
});

describe('authoritative Action Surge', () => {
  it('persists one use before granting the additional action', async () => {
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions);

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('SET features = $1');
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params.slice(1)).toEqual([CHARACTER, 7]);
    const features = JSON.parse(params[0] as string) as Feature[];
    expect(features[0]).toMatchObject({ usesTotal: 1, usesRemaining: 0, resetOn: 'short' });
    expect(room.actionEconomies.get('fighter-token')).toMatchObject({
      action: false,
      actionSurgeUsed: true,
    });
  });

  it('seeds a missing feature only for an eligible Fighter', async () => {
    arrange(characterRow({ features: '[]' }));
    const emissions: Emission[] = [];
    await run(emissions);

    const features = JSON.parse(updateCalls()[0][1][0] as string) as Feature[];
    expect(features.at(-1)).toMatchObject({
      name: 'Action Surge',
      sourceType: 'class',
      usesTotal: 1,
      usesRemaining: 0,
      resetOn: 'short',
    });
  });

  it('uses Fighter class level and grants two rest uses at Fighter 17', async () => {
    arrange(
      characterRow({
        class: 'Rogue 3 / Fighter (Champion) 17',
        level: 20,
        features: JSON.stringify([{ ...SURGE, usesTotal: 99, usesRemaining: 99 }]),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions);

    const features = JSON.parse(updateCalls()[0][1][0] as string) as Feature[];
    expect(features[0]).toMatchObject({ usesTotal: 2, usesRemaining: 1 });
  });

  it('reports status privately without spending', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!actionsurge status');
    expect(updateCalls()).toEqual([]);
    expect(whispers(emissions)[0]).toContain('1/1');
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('scopes exact resource and action state to every DM and owner tab', async () => {
    const emissions: Emission[] = [];
    await run(emissions);
    const expected = ['dm-1', 'dm-2', 'fighter-1', 'fighter-2'];
    expect(channelsFor(emissions, 'character:updated')).toEqual(expected);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual(expected);
    expect(emissions.filter((emission) => emission.channelId === 'bystander-1')).toEqual([]);
  });

  it('keeps remaining resource totals out of public chat', async () => {
    const emissions: Emission[] = [];
    await run(emissions);
    expect(publicMessages(emissions)).toHaveLength(1);
    expect(publicMessages(emissions)[0].content).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it('requires Fighter level 2, using the Fighter level in a multiclass', async () => {
    arrange(characterRow({ class: 'Fighter 1 / Rogue 6', level: 7 }));
    const emissions: Emission[] = [];
    await run(emissions);
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0]).toContain('Fighter level 2');
  });

  it.each([{ features: '{bad json' }, { features: '[null]' }, { version: 'bad' }])(
    'fails closed for malformed character state %#',
    async (overrides) => {
      arrange(characterRow(overrides));
      const emissions: Emission[] = [];
      await run(emissions);
      expectFailedClosed(emissions);
    }
  );

  it('refuses an exhausted resource', async () => {
    arrange(characterRow({ features: JSON.stringify([{ ...SURGE, usesRemaining: 0 }]) }));
    const emissions: Emission[] = [];
    await run(emissions);
    expectFailedClosed(emissions);
  });

  it('requires active combat, the current turn, and an available economy', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState!.active = false;
    const inactive: Emission[] = [];
    await run(inactive);
    expectFailedClosed(inactive);

    room.combatState!.active = true;
    room.combatState!.combatants[0].tokenId = 'someone-else';
    const offTurn: Emission[] = [];
    await run(offTurn);
    expectFailedClosed(offTurn);

    room.combatState!.combatants[0].tokenId = 'fighter-token';
    room.actionEconomies.delete('fighter-token');
    const noEconomy: Emission[] = [];
    await run(noEconomy);
    expectFailedClosed(noEconomy);
  });

  it('requires the normal action to be spent first so the extra action cannot be wasted', async () => {
    getAllRooms().get(SESSION)!.actionEconomies.get('fighter-token')!.action = false;
    const emissions: Emission[] = [];
    await run(emissions);
    expectFailedClosed(emissions);
  });

  it('allows only one Action Surge per turn, including a level-17 Fighter', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.actionEconomies.get('fighter-token')!.actionSurgeUsed = true;
    arrange(
      characterRow({
        class: 'Fighter 17',
        level: 17,
        features: JSON.stringify([{ ...SURGE, usesTotal: 2, usesRemaining: 1 }]),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions);
    expectFailedClosed(emissions);
  });

  it('resets the once-per-turn marker when combat creates the next turn economy', () => {
    const room = getAllRooms().get(SESSION)!;
    const nextTurnEconomy = {
      action: false,
      bonusAction: false,
      reaction: false,
      movementRemaining: 30,
      movementMax: 30,
    };
    room.actionEconomies.set('fighter-token', nextTurnEconomy);
    expect(room.actionEconomies.get('fighter-token')?.actionSurgeUsed).toBeUndefined();
  });

  it('does not grant the action when the guarded update conflicts or throws', async () => {
    const room = getAllRooms().get(SESSION)!;
    arrange(characterRow(), []);
    const conflict: Emission[] = [];
    await run(conflict);
    expect(room.actionEconomies.get('fighter-token')?.action).toBe(true);
    expect(room.actionEconomies.get('fighter-token')?.actionSurgeUsed).toBeUndefined();
    expect(channelsFor(conflict, 'combat:action-used')).toEqual([]);

    arrange(characterRow(), new Error('db unavailable'));
    const failure: Emission[] = [];
    await run(failure);
    expect(room.actionEconomies.get('fighter-token')?.action).toBe(true);
    expect(channelsFor(failure, 'combat:action-used')).toEqual([]);
  });

  it('does not grant the action after a write returns an unusable version', async () => {
    const room = getAllRooms().get(SESSION)!;
    arrange(characterRow(), [{ version: null }]);
    const emissions: Emission[] = [];
    await run(emissions);
    expect(room.actionEconomies.get('fighter-token')?.action).toBe(true);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('rejects malformed arguments and an off-map caller without DB traffic', async () => {
    const malformed: Emission[] = [];
    await run(malformed, '!actionsurge now');
    expect(mockQuery).not.toHaveBeenCalled();
    expectFailedClosed(malformed);

    getAllRooms().get(SESSION)!.tokens.get('fighter-token')!.mapId = 'map-2';
    const offMap: Emission[] = [];
    await run(offMap);
    expect(mockQuery).not.toHaveBeenCalled();
    expectFailedClosed(offMap);
  });
});
