import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Token } from '@dnd-vtt/shared';

const { mockQuery, mockConnect, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery, connect: mockConnect },
}));

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

const SESSION = 'lay-on-hands-session';
const PALADIN_CHARACTER = 'paladin-character';
const ALLY_CHARACTER = 'ally-character';
const LAY_ON_HANDS: Feature = {
  name: 'Lay on Hands',
  description: 'Healing pool',
  source: 'Paladin',
  sourceType: 'class',
  usesTotal: 15,
  usesRemaining: 10,
  resetOn: 'long',
};

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function token(id: string, overrides: Partial<Token>): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
    name: id,
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
    ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'LAY', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set(
    'paladin-token',
    token('paladin-token', {
      characterId: PALADIN_CHARACTER,
      ownerUserId: 'paladin-user',
      name: 'Aldric',
    })
  );
  room.tokens.set(
    'ally-token',
    token('ally-token', {
      characterId: ALLY_CHARACTER,
      ownerUserId: 'ally-user',
      name: 'Mira',
    })
  );
  room.tokens.set(
    'off-map-mira',
    token('off-map-mira', {
      mapId: 'map-2',
      characterId: 'off-map-character',
      ownerUserId: 'other-user',
      name: 'Mira',
      createdAt: '2099-01-01T00:00:00.000Z',
    })
  );
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['paladin-user', 'paladin-1', 'player', PALADIN_CHARACTER],
    ['paladin-user', 'paladin-2', 'player', PALADIN_CHARACTER],
    ['ally-user', 'ally-1', 'player', ALLY_CHARACTER],
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
  return room;
}

function paladinRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PALADIN_CHARACTER,
    class: 'Paladin 3',
    level: 3,
    hit_points: 11,
    max_hit_points: 20,
    temp_hit_points: 0,
    features: JSON.stringify([LAY_ON_HANDS]),
    version: 7,
    ...overrides,
  };
}

function allyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ALLY_CHARACTER,
    class: 'Rogue 3',
    level: 3,
    hit_points: 5,
    max_hit_points: 20,
    temp_hit_points: 2,
    features: '[]',
    version: 11,
    ...overrides,
  };
}

function arrange(
  options: {
    paladin?: Record<string, unknown> | null;
    ally?: Record<string, unknown> | null;
    callerUpdate?: Array<Record<string, unknown>> | Error;
    targetUpdate?: Array<Record<string, unknown>> | Error;
  } = {}
): void {
  const paladin = options.paladin === null ? null : paladinRow(options.paladin);
  const ally = options.ally === null ? null : allyRow(options.ally);
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT * FROM characters')) {
      const row = params?.[0] === PALADIN_CHARACTER ? paladin : ally;
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE characters') && sql.includes('SET hit_points = $1, features')) {
      if (options.callerUpdate instanceof Error) throw options.callerUpdate;
      return { rows: options.callerUpdate ?? [{ version: 8 }] };
    }
    if (sql.startsWith('UPDATE characters') && sql.includes('SET features = $1')) {
      if (options.callerUpdate instanceof Error) throw options.callerUpdate;
      return { rows: options.callerUpdate ?? [{ version: 8 }] };
    }
    if (sql.startsWith('UPDATE characters') && sql.includes('SET hit_points = $1')) {
      if (options.targetUpdate instanceof Error) throw options.targetUpdate;
      return { rows: options.targetUpdate ?? [{ version: 12 }] };
    }
    return { rows: [] };
  });
}

function transactionUpdates(): Array<[string, unknown[]]> {
  return mockClientQuery.mock.calls
    .filter((call) => String(call[0]).startsWith('UPDATE characters'))
    .map((call) => [call[0] as string, call[1] as unknown[]]);
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((emission) => emission.event === event)
    .map((emission) => emission.channelId)
    .sort();
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

function whispers(emissions: Emission[]): string[] {
  return emissions
    .filter(
      (emission) =>
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'whisper'
    )
    .map((emission) => (emission.payload as { content: string }).content);
}

function expectFailedClosed(emissions: Emission[]): void {
  expect(transactionUpdates()).toEqual([]);
  expect(channelsFor(emissions, 'character:updated')).toEqual([]);
  expect(channelsFor(emissions, 'combat:hp-changed')).toEqual([]);
  expect(channelsFor(emissions, 'combat:action-used')).toEqual([]);
  expect(publicMessages(emissions)).toEqual([]);
  expect(whispers(emissions)).toHaveLength(1);
}

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('paladin-1')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockClientQuery.mockReset();
  mockRelease.mockReset();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
  arrange();
});

describe('authoritative Lay on Hands', () => {
  it('atomically spends the pool and heals an ally with both version guards', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 5');

    expect(mockClientQuery.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining('SET features = $1'),
      expect.stringContaining('SET hit_points = $1'),
      'COMMIT',
    ]);
    const updates = transactionUpdates();
    expect(updates[0][1].slice(1)).toEqual([PALADIN_CHARACTER, 7]);
    expect(updates[1][1]).toEqual([10, ALLY_CHARACTER, 11]);
    const features = JSON.parse(updates[0][1][0] as string) as Feature[];
    expect(features[0]).toMatchObject({ usesTotal: 15, usesRemaining: 5, resetOn: 'long' });
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('uses one atomic update when the paladin heals themself', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!lay self 5');

    const [[sql, params]] = transactionUpdates();
    expect(sql).toContain('SET hit_points = $1, features = $2');
    expect(params[0]).toBe(16);
    expect(params.slice(2)).toEqual([PALADIN_CHARACTER, 7]);
    expect(channelsFor(emissions, 'character:updated')).toEqual([
      'dm-1',
      'dm-2',
      'paladin-1',
      'paladin-2',
    ]);
  });

  it('seeds a missing eligible feature and uses Paladin multiclass level', async () => {
    arrange({ paladin: { class: 'Fighter 3 / Paladin (Devotion) 2', level: 5, features: '[]' } });
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 4');

    const features = JSON.parse(transactionUpdates()[0][1][0] as string) as Feature[];
    expect(features.at(-1)).toMatchObject({
      name: 'Lay on Hands',
      sourceType: 'class',
      usesTotal: 10,
      usesRemaining: 6,
      resetOn: 'long',
    });
  });

  it('reports pool status privately without writing', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!lay status');

    expect(mockConnect).not.toHaveBeenCalled();
    expect(whispers(emissions)[0]).toContain('10/15');
    expect(publicMessages(emissions)).toEqual([]);
  });

  it.each(['!lay Mira 5abc', '!lay Mira -1', '!lay Mira 0', '!lay Mira 16'])(
    'strictly rejects invalid amount %s',
    async (command) => {
      const emissions: Emission[] = [];
      await run(emissions, command);
      expectFailedClosed(emissions);
      expect(mockConnect).not.toHaveBeenCalled();
    }
  );

  it('rejects a spend larger than the remaining pool', async () => {
    arrange({ paladin: { features: JSON.stringify([{ ...LAY_ON_HANDS, usesRemaining: 2 }]) } });
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 3');
    expectFailedClosed(emissions);
  });

  it('rejects full targets and prevents points being wasted on overhealing', async () => {
    arrange({ ally: { hit_points: 20 } });
    const fullEmissions: Emission[] = [];
    await run(fullEmissions, '!lay Mira 1');
    expectFailedClosed(fullEmissions);

    arrange({ ally: { hit_points: 18 } });
    const overEmissions: Emission[] = [];
    await run(overEmissions, '!lay Mira 3');
    expectFailedClosed(overEmissions);
  });

  it.each([{ features: '{bad json' }, { features: '[null]' }, { version: 'bad' }])(
    'fails closed for malformed caller state %#',
    async (paladin) => {
      arrange({ paladin });
      const emissions: Emission[] = [];
      await run(emissions, '!lay Mira 1');
      expectFailedClosed(emissions);
    }
  );

  it('requires the target to be visible on the current map', async () => {
    getAllRooms().get(SESSION)!.tokens.get('ally-token')!.visible = false;
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 1');
    expectFailedClosed(emissions);
    expect(mockQuery.mock.calls.filter((call) => call[1]?.[0] === ALLY_CHARACTER)).toEqual([]);
  });

  it('does not select a newer duplicate target on another map', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 1');
    expect(transactionUpdates()[1][1][1]).toBe(ALLY_CHARACTER);
  });

  it('rolls back both mutations when either guarded write conflicts', async () => {
    arrange({ targetUpdate: [] });
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 1');

    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('ROLLBACK');
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(channelsFor(emissions, 'combat:hp-changed')).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('rolls back and releases the client on a database error', async () => {
    arrange({ callerUpdate: new Error('db unavailable') });
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 1');
    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('keeps each exact character update scoped to DMs and the relevant owner', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 5');

    const callerChannels = emissions
      .filter(
        (emission) =>
          emission.event === 'character:updated' &&
          (emission.payload as { characterId: string }).characterId === PALADIN_CHARACTER
      )
      .map((emission) => emission.channelId)
      .sort();
    const targetChannels = emissions
      .filter(
        (emission) =>
          emission.event === 'character:updated' &&
          (emission.payload as { characterId: string }).characterId === ALLY_CHARACTER
      )
      .map((emission) => emission.channelId)
      .sort();
    expect(callerChannels).toEqual(['dm-1', 'dm-2', 'paladin-1', 'paladin-2']);
    expect(targetChannels).toEqual(['ally-1', 'dm-1', 'dm-2']);
    expect(channelsFor(emissions, 'combat:hp-changed')).toEqual(['ally-1', 'dm-1', 'dm-2']);
  });

  it('keeps exact HP and remaining pool totals out of public chat', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 5');
    const [message] = publicMessages(emissions);
    expect(message.content).toContain('regains **5 HP**');
    expect(message.content).not.toContain('5/15');
    expect(message.content).not.toContain('10/20');
    expect(JSON.stringify(message.actionResult)).not.toContain('hpBefore');
    expect(JSON.stringify(message.actionResult)).not.toContain('hpAfter');
    expect(whispers(emissions).at(-1)).toContain('5/15');
  });

  it('spends the combat action only after a successful commit and syncs the target combatant', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      startedAt: new Date().toISOString(),
      combatants: [
        {
          tokenId: 'paladin-token',
          characterId: PALADIN_CHARACTER,
          name: 'Aldric',
          initiative: 20,
          initiativeBonus: 0,
          hp: 11,
          maxHp: 20,
          tempHp: 0,
          armorClass: 18,
          speed: 30,
          isNPC: false,
          conditions: [],
          deathSaves: { successes: 0, failures: 0 },
          portraitUrl: null,
        },
        {
          tokenId: 'ally-token',
          characterId: ALLY_CHARACTER,
          name: 'Mira',
          initiative: 10,
          initiativeBonus: 0,
          hp: 5,
          maxHp: 20,
          tempHp: 2,
          armorClass: 14,
          speed: 30,
          isNPC: false,
          conditions: [],
          deathSaves: { successes: 0, failures: 0 },
          portraitUrl: null,
        },
      ],
    };
    room.actionEconomies.set('paladin-token', {
      action: false,
      bonusAction: false,
      reaction: false,
      movementRemaining: 30,
      movementMax: 30,
    });
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 5');

    expect(room.actionEconomies.get('paladin-token')?.action).toBe(true);
    expect(room.combatState?.combatants[1].hp).toBe(10);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([
      'dm-1',
      'dm-2',
      'paladin-1',
      'paladin-2',
    ]);
  });

  it('refuses off-turn and already-spent-action combat use without writing', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      startedAt: new Date().toISOString(),
      combatants: [
        {
          tokenId: 'ally-token',
          characterId: ALLY_CHARACTER,
          name: 'Mira',
          initiative: 10,
          initiativeBonus: 0,
          hp: 5,
          maxHp: 20,
          tempHp: 0,
          armorClass: 14,
          speed: 30,
          isNPC: false,
          conditions: [],
          deathSaves: { successes: 0, failures: 0 },
          portraitUrl: null,
        },
      ],
    };
    room.actionEconomies.set('paladin-token', {
      action: true,
      bonusAction: false,
      reaction: false,
      movementRemaining: 30,
      movementMax: 30,
    });
    const emissions: Emission[] = [];
    await run(emissions, '!lay Mira 1');
    expectFailedClosed(emissions);
  });
});
