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
import '../services/chatCommands/monkHandler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'monk-ki-session';
const CHARACTER = 'monk-character';
const TARGET_CHARACTER = 'target-character';
const KI_POINTS: Feature = {
  name: 'Ki Points',
  description: 'Monk resource used for class features.',
  source: 'Monk',
  sourceType: 'class',
  usesTotal: 5,
  usesRemaining: 3,
  resetOn: 'short',
};

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function token(id: string, overrides: Partial<Token> = {}): Token {
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
  const room = createRoom(SESSION, 'MONK', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set(
    'monk-token',
    token('monk-token', {
      characterId: CHARACTER,
      name: 'Kai',
      ownerUserId: 'monk-user',
    })
  );
  room.tokens.set(
    'target-token',
    token('target-token', {
      characterId: TARGET_CHARACTER,
      name: 'Ogre',
      ownerUserId: null,
    })
  );
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['monk-user', 'monk-1', 'player', CHARACTER],
    ['monk-user', 'monk-2', 'player', CHARACTER],
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
        tokenId: 'monk-token',
        characterId: CHARACTER,
        name: 'Kai',
        initiative: 18,
        initiativeBonus: 3,
        hp: 35,
        maxHp: 35,
        tempHp: 0,
        armorClass: 17,
        speed: 40,
        isNPC: false,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        portraitUrl: null,
      },
      {
        tokenId: 'target-token',
        characterId: TARGET_CHARACTER,
        name: 'Ogre',
        initiative: 10,
        initiativeBonus: -1,
        hp: 59,
        maxHp: 59,
        tempHp: 0,
        armorClass: 11,
        speed: 40,
        isNPC: true,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        portraitUrl: null,
      },
    ],
  };
  room.actionEconomies.set('monk-token', {
    action: true,
    bonusAction: false,
    reaction: false,
    movementRemaining: 40,
    movementMax: 40,
  });
  return room;
}

function monkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHARACTER,
    class: 'Monk 5',
    level: 5,
    name: 'Kai',
    features: JSON.stringify([KI_POINTS]),
    version: 7,
    ability_scores: JSON.stringify({ wis: 16 }),
    proficiency_bonus: 3,
    ...overrides,
  };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_CHARACTER,
    name: 'Ogre',
    race: null,
    ability_scores: JSON.stringify({ con: 16 }),
    saving_throws: JSON.stringify([]),
    proficiency_bonus: 2,
    ...overrides,
  };
}

function arrange(
  options: {
    monk?: Record<string, unknown> | null;
    target?: Record<string, unknown> | null;
    update?: Array<Record<string, unknown>> | Error;
  } = {}
): void {
  const monk = options.monk === null ? null : monkRow(options.monk);
  const target = options.target === null ? null : targetRow(options.target);
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('UPDATE characters')) {
      if (options.update instanceof Error) throw options.update;
      return { rows: options.update ?? [{ version: 8 }] };
    }
    if (sql.includes('SELECT class, level, name, features')) {
      return { rows: monk ? [monk] : [] };
    }
    if (sql.includes('SELECT ability_scores, saving_throws')) {
      return { rows: target ? [target] : [] };
    }
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

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('monk-1')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
  arrange();
});

describe('authoritative Monk Ki', () => {
  it('reads status from persisted features without using the legacy room pool', async () => {
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!ki status');

    expect(updateCalls()).toEqual([]);
    expect(room.pointPools.size).toBe(0);
    expect(whispers(emissions)[0]).toContain('3/5');
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('persists a spend with a version guard and scopes exact totals to DMs and the owner', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!ki use 2');

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params.slice(1)).toEqual([CHARACTER, 7]);
    const features = JSON.parse(params[0] as string) as Feature[];
    expect(features[0]).toMatchObject({ usesTotal: 5, usesRemaining: 1, resetOn: 'short' });
    expect(channelsFor(emissions, 'character:updated')).toEqual([
      'dm-1',
      'dm-2',
      'monk-1',
      'monk-2',
    ]);
    expect(publicMessages(emissions)).toHaveLength(1);
    expect(publicMessages(emissions)[0].content).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it('seeds a missing eligible feature using the D&D Beyond-compatible name', async () => {
    arrange({ monk: { features: '[]' } });
    const emissions: Emission[] = [];
    await run(emissions, '!ki use 1');

    const features = JSON.parse(updateCalls()[0][1][0] as string) as Feature[];
    expect(features.at(-1)).toMatchObject({
      name: 'Ki Points',
      usesTotal: 5,
      usesRemaining: 4,
      resetOn: 'short',
    });
  });

  it.each([
    ['version conflict', []],
    ['database failure', new Error('database unavailable')],
  ])('fails closed on %s', async (_label, update) => {
    arrange({ update });
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!patient');

    expect(room.actionEconomies.get('monk-token')?.bonusAction).toBe(false);
    expect(room.tokens.get('monk-token')?.conditions).not.toContain('dodging');
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
    expect(whispers(emissions)).toHaveLength(1);
  });

  it('executes an already-committed feature when only version synchronization is malformed', async () => {
    arrange({ update: [{ version: 'invalid' }] });
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!patient');

    expect(room.actionEconomies.get('monk-token')?.bonusAction).toBe(true);
    expect(room.tokens.get('monk-token')?.conditions).toContain('dodging');
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(whispers(emissions)[0]).toContain('spend was saved');
    expect(publicMessages(emissions)).toHaveLength(1);
  });

  it('denies level-one monks and sends manual reset through the rest flow', async () => {
    arrange({ monk: { class: 'Monk 1', level: 1 } });
    const levelEmissions: Emission[] = [];
    await run(levelEmissions, '!ki use 1');
    expect(updateCalls()).toEqual([]);
    expect(whispers(levelEmissions)[0]).toContain('Monk level 2');

    arrange();
    mockQuery.mockClear();
    const resetEmissions: Emission[] = [];
    await run(resetEmissions, '!ki reset');
    expect(updateCalls()).toEqual([]);
    expect(whispers(resetEmissions)[0]).toContain('Short Rest or Long Rest');
  });

  it.each(['!ki use 0', '!ki use -1', '!ki use 2 extra'])(
    'strictly rejects %s',
    async (command) => {
      const emissions: Emission[] = [];
      await run(emissions, command);
      expect(updateCalls()).toEqual([]);
      expect(publicMessages(emissions)).toEqual([]);
      expect(whispers(emissions)).toHaveLength(1);
    }
  );

  it('requires the Attack action before Flurry, then spends Ki before the bonus action', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.actionEconomies.get('monk-token')!.action = false;
    const deniedEmissions: Emission[] = [];
    await run(deniedEmissions, '!flurry');
    expect(updateCalls()).toEqual([]);
    expect(room.actionEconomies.get('monk-token')?.bonusAction).toBe(false);

    room.actionEconomies.get('monk-token')!.action = true;
    mockQuery.mockClear();
    const allowedEmissions: Emission[] = [];
    await run(allowedEmissions, '!flurry');
    expect(updateCalls()).toHaveLength(1);
    expect(room.actionEconomies.get('monk-token')?.bonusAction).toBe(true);
    expect(channelsFor(allowedEmissions, 'combat:action-used')).toEqual([
      'dm-1',
      'dm-2',
      'monk-1',
      'monk-2',
    ]);
  });

  it('rejects bonus-action features outside the active Monk turn before spending Ki', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState!.currentTurnIndex = 1;
    const emissions: Emission[] = [];
    await run(emissions, '!stepwind dash');

    expect(updateCalls()).toEqual([]);
    expect(room.actionEconomies.get('monk-token')?.bonusAction).toBe(false);
    expect(whispers(emissions)[0]).toContain('only on their turn');
  });

  it('derives Stunning Strike DC server-side and spends Ki before resolving the save', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const emissions: Emission[] = [];
    await run(emissions, '!stunstrike Ogre');
    random.mockRestore();

    const updateIndex = mockQuery.mock.calls.findIndex((call) =>
      String(call[0]).startsWith('UPDATE characters')
    );
    const saveIndex = mockQuery.mock.calls.findIndex((call) =>
      String(call[0]).includes('SELECT ability_scores, saving_throws')
    );
    expect(updateIndex).toBeGreaterThan(-1);
    expect(saveIndex).toBeGreaterThan(updateIndex);
    expect(publicMessages(emissions)[0].content).toContain('CON DC 14');
    expect(publicMessages(emissions)[0].actionResult).toMatchObject({
      action: { name: 'Stunning Strike (CON DC 14)' },
    });
  });

  it('does not spend Ki on a hidden-map target', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.get('target-token')!.mapId = 'map-2';
    const emissions: Emission[] = [];
    await run(emissions, '!stunstrike Ogre');

    expect(updateCalls()).toEqual([]);
    expect(whispers(emissions)[0]).toContain('no visible token');
    expect(publicMessages(emissions)).toEqual([]);
  });
});
