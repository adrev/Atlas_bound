import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery, mockApplyDamage, mockApplyHeal, mockDamageSideEffects } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockApplyDamage: vi.fn(),
  mockApplyHeal: vi.fn(),
  mockDamageSideEffects: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../services/CombatService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/CombatService.js')>(
    '../services/CombatService.js'
  );
  return { ...actual, applyDamage: mockApplyDamage, applyHeal: mockApplyHeal };
});
vi.mock('../services/damageEffects.js', () => ({
  applyDamageSideEffects: mockDamageSideEffects,
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
import '../services/chatCommands/saveHandler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'uncanny-evasion-session';
const CHARACTER = 'rogue-character';

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function rogueToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 'rogue-token',
    mapId: 'map-1',
    characterId: CHARACTER,
    name: 'Shade',
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
    ownerUserId: 'rogue-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'REACTIONS', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('rogue-token', rogueToken());
  room.tokens.set(
    'released-token',
    rogueToken({
      id: 'released-token',
      characterId: null,
      name: 'Released',
      ownerUserId: null,
    })
  );
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['rogue-user', 'rogue-1', 'player', CHARACTER],
    ['rogue-user', 'rogue-2', 'player', CHARACTER],
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
        tokenId: 'rogue-token',
        characterId: CHARACTER,
        name: 'Shade',
        initiative: 18,
        initiativeBonus: 4,
        hp: 20,
        maxHp: 20,
        tempHp: 0,
        armorClass: 16,
        speed: 30,
        isNPC: false,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        portraitUrl: null,
      },
    ],
  };
  room.actionEconomies.set('rogue-token', {
    action: false,
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
    class: 'Rogue 7',
    level: 7,
    version: 7,
    ...overrides,
  };
}

function arrange(row: Record<string, unknown> | null = characterRow()): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM characters WHERE id = $1')) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
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

function expectNoDamage(emissions: Emission[]): void {
  expect(mockApplyDamage).not.toHaveBeenCalled();
  expect(mockApplyHeal).not.toHaveBeenCalled();
  expect(channelsFor(emissions, 'combat:hp-changed')).toEqual([]);
  expect(publicMessages(emissions)).toEqual([]);
  expect(whispers(emissions)).toHaveLength(1);
}

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('rogue-1')!, command);
}

async function runAsDm(
  emissions: Emission[],
  command: string,
  randomValues: number[]
): Promise<void> {
  const originalRandom = Math.random;
  let index = 0;
  Math.random = () => randomValues[index++] ?? randomValues.at(-1) ?? 0;
  try {
    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('dm-1')!, command);
  } finally {
    Math.random = originalRandom;
  }
}

beforeEach(() => {
  mockQuery.mockReset();
  mockApplyDamage.mockReset();
  mockApplyHeal.mockReset();
  mockDamageSideEffects.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockDamageSideEffects.mockResolvedValue(undefined);
  mockApplyDamage.mockImplementation(
    async (_sessionId: string, _tokenId: string, amount: number) => ({
      hp: 20 - amount,
      tempHp: 0,
      change: amount > 0 ? -amount : 0,
      rawAmount: amount,
      appliedAmount: amount,
      characterId: CHARACTER,
      version: 8,
    })
  );
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
  arrange();
});

describe('authoritative Uncanny Dodge', () => {
  it('applies half of odd incoming damage instead of healing a client-reported refund', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!uncanny 19 slashing');

    expect(mockApplyDamage).toHaveBeenCalledWith(SESSION, 'rogue-token', 9, {
      damageType: 'slashing',
    });
    expect(mockApplyHeal).not.toHaveBeenCalled();
    expect(mockDamageSideEffects).toHaveBeenCalledWith(
      expect.anything(),
      getAllRooms().get(SESSION),
      'rogue-token',
      9
    );
    expect(publicMessages(emissions)[0].content).toContain('19 slashing');
  });

  it('reserves and spends the reaction only after authoritative damage succeeds', async () => {
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!uncanny 18');
    expect(room.actionEconomies.get('rogue-token')?.reaction).toBe(true);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([
      'dm-1',
      'dm-2',
      'rogue-1',
      'rogue-2',
    ]);

    room.actionEconomies.get('rogue-token')!.reaction = false;
    mockApplyDamage.mockRejectedValueOnce(new Error('db unavailable'));
    const failed: Emission[] = [];
    await run(failed, '!uncanny 18');
    expect(room.actionEconomies.get('rogue-token')?.reaction).toBe(false);
    expect(publicMessages(failed)).toEqual([]);
    expect(channelsFor(failed, 'combat:action-used')).toEqual([]);
  });

  it('uses Rogue class level rather than total multiclass level', async () => {
    arrange(characterRow({ class: 'Rogue 4 / Fighter 6', level: 10 }));
    const rejected: Emission[] = [];
    await run(rejected, '!uncanny 10');
    expectNoDamage(rejected);
    expect(whispers(rejected)[0]).toContain('Rogue level 5');

    arrange(characterRow({ class: 'Rogue 5 / Fighter 5', level: 10 }));
    const accepted: Emission[] = [];
    await run(accepted, '!uncanny 10');
    expect(mockApplyDamage).toHaveBeenCalledTimes(1);
  });

  it.each([
    '!uncanny',
    '!uncanny 10junk',
    '!uncanny 0',
    '!uncanny 10000',
    '!uncanny 10 happiness',
    '!uncanny 10 fire extra',
  ])('strictly rejects malformed input: %s', async (command) => {
    const emissions: Emission[] = [];
    await run(emissions, command);
    expectNoDamage(emissions);
  });

  it('requires current-map ownership, active combat, an actionable token, and reaction state', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.get('rogue-token')!.mapId = 'map-2';
    const offMap: Emission[] = [];
    await run(offMap, '!uncanny 10');
    expectNoDamage(offMap);

    room.tokens.get('rogue-token')!.mapId = 'map-1';
    room.combatState!.active = false;
    const inactive: Emission[] = [];
    await run(inactive, '!uncanny 10');
    expectNoDamage(inactive);

    room.combatState!.active = true;
    room.tokens.get('rogue-token')!.conditions = ['stunned'];
    const stunned: Emission[] = [];
    await run(stunned, '!uncanny 10');
    expectNoDamage(stunned);

    room.tokens.get('rogue-token')!.conditions = [];
    room.actionEconomies.delete('rogue-token');
    const noEconomy: Emission[] = [];
    await run(noEconomy, '!uncanny 10');
    expectNoDamage(noEconomy);
  });

  it('refuses a second reaction and malformed class state', async () => {
    getAllRooms().get(SESSION)!.actionEconomies.get('rogue-token')!.reaction = true;
    const spent: Emission[] = [];
    await run(spent, '!uncanny 10');
    expectNoDamage(spent);

    getAllRooms().get(SESSION)!.actionEconomies.get('rogue-token')!.reaction = false;
    arrange(characterRow({ class: 'Rogue 99', level: 20 }));
    const malformed: Emission[] = [];
    await run(malformed, '!uncanny 10');
    expectNoDamage(malformed);
  });
});

describe('authoritative Evasion', () => {
  it('automatically applies zero damage on a server-rolled successful DEX save', async () => {
    const emissions: Emission[] = [];
    await runAsDm(emissions, '!save dex 10 1d10/fire Shade', [0.9, 0.9]);
    expect(mockApplyDamage).not.toHaveBeenCalled();
    expect(mockApplyHeal).not.toHaveBeenCalled();
    expect(publicMessages(emissions)[0].content).toContain('SAVED (Evasion: none)');
    expect(publicMessages(emissions)[0].content).toContain('0 fire dmg');
  });

  it('automatically applies floor-half damage on a failed DEX save', async () => {
    const emissions: Emission[] = [];
    await runAsDm(emissions, '!save dex 20 1d10/lightning Shade', [0.9, 0]);
    expect(mockApplyDamage).toHaveBeenCalledWith(SESSION, 'rogue-token', 5);
    expect(mockApplyHeal).not.toHaveBeenCalled();
    expect(publicMessages(emissions)[0].content).toContain('FAILED (Evasion: half)');
  });

  it.each([
    ['Rogue 7', 7],
    ['Monk 7', 7],
    ['Fighter 3 / Monk 7', 10],
  ])('reports a real level-7 qualifying class privately: %s', async (className, level) => {
    arrange(characterRow({ class: className, level }));
    const emissions: Emission[] = [];
    await run(emissions, '!evasion status');
    expect(mockApplyDamage).not.toHaveBeenCalled();
    expect(whispers(emissions)[0]).toContain('applied automatically');
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('does not add multiclass levels together to unlock Evasion', async () => {
    arrange(characterRow({ class: 'Rogue 4 / Monk 3', level: 7 }));
    const emissions: Emission[] = [];
    await run(emissions, '!evasion');
    expectNoDamage(emissions);
    expect(whispers(emissions)[0]).toContain('Rogue or Monk level 7');
  });

  it('does not apply Evasion to non-DEX saves or malformed class state', async () => {
    const constitution: Emission[] = [];
    await runAsDm(constitution, '!save con 20 1d10/poison Shade', [0.9, 0]);
    expect(mockApplyDamage).toHaveBeenCalledWith(SESSION, 'rogue-token', 10);

    mockApplyDamage.mockClear();
    arrange(characterRow({ level: 7.5 }));
    const malformed: Emission[] = [];
    await runAsDm(malformed, '!save dex 20 1d10/fire Shade', [0.9, 0]);
    expect(mockApplyDamage).toHaveBeenCalledWith(SESSION, 'rogue-token', 10);
  });

  it('rejects the legacy player-reported outcome/damage form without changing HP', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!evasion pass 9999');
    expectNoDamage(emissions);
    expect(whispers(emissions)[0]).toContain('usage');
  });
});

describe('damage result synchronization', () => {
  it('keeps exact HP private while forwarding version, conditions, and death-save state', async () => {
    mockApplyDamage.mockResolvedValueOnce({
      hp: 0,
      tempHp: 0,
      change: -9,
      rawAmount: 9,
      appliedAmount: 9,
      characterId: CHARACTER,
      version: 12,
      concentrationDropped: true,
      autoDeathSaveFailure: { successes: 0, failures: 1 },
      autoAppliedConditions: ['unconscious'],
      releasedGrappleTokenIds: ['released-token'],
    });
    const emissions: Emission[] = [];
    await run(emissions, '!uncanny 18');

    const privateChannels = ['dm-1', 'dm-2', 'rogue-1', 'rogue-2'];
    expect(channelsFor(emissions, 'combat:hp-changed')).toEqual(privateChannels);
    expect(channelsFor(emissions, 'character:updated')).toEqual(privateChannels);
    expect(channelsFor(emissions, 'combat:death-save-updated')).toEqual(privateChannels);
    expect(
      emissions.filter(
        (emission) =>
          emission.channelId === 'bystander-1' &&
          ['combat:hp-changed', 'character:updated', 'combat:death-save-updated'].includes(
            emission.event
          )
      )
    ).toEqual([]);
    const characterUpdate = emissions.find((emission) => emission.event === 'character:updated')
      ?.payload as { changes: Record<string, unknown> };
    expect(characterUpdate.changes).toMatchObject({
      hitPoints: 0,
      version: 12,
      concentratingOn: null,
      deathSaves: { successes: 0, failures: 1 },
    });
    expect(
      emissions.some(
        (emission) =>
          emission.event === 'map:token-updated' &&
          (emission.payload as { tokenId?: string }).tokenId === 'released-token'
      )
    ).toBe(true);
  });
});
