import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionEconomy, Feature, Token } from '@dnd-vtt/shared';

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
import '../services/chatCommands/subclassFeaturesHandler.js';
import '../services/chatCommands/utilityHandlers.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'channel-specializations';
const CHARACTER = 'channel-character';
const TARGET_CHARACTER = 'target-character';

const CHANNEL_DIVINITY: Feature = {
  name: 'Channel Divinity',
  description: 'Invoke a Channel Divinity effect.',
  source: 'Cleric / Paladin',
  sourceType: 'class',
  usesTotal: 1,
  usesRemaining: 1,
  resetOn: 'short',
};

function token(id: string, name: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
    name,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000000',
    layer: 'token',
    visible: true,
    conditions: [],
    ownerUserId: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  } as Token;
}

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function seedRoom(activeCombat = true) {
  const room = createRoom(SESSION, 'CHANNEL', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  const caller = token('channel-token', 'Seraphina', {
    characterId: CHARACTER,
    ownerUserId: 'channel-user',
  });
  const target = token('target-token', 'Death Knight', {
    characterId: TARGET_CHARACTER,
  });
  room.tokens.set(caller.id, caller);
  room.tokens.set(target.id, target);
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['channel-user', 'channel-1', 'player', CHARACTER],
    ['channel-user', 'channel-2', 'player', CHARACTER],
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
  const economy: ActionEconomy = {
    action: false,
    bonusAction: false,
    reaction: false,
    movementRemaining: 30,
    movementMax: 30,
  };
  room.actionEconomies.set(caller.id, economy);
  if (activeCombat) {
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      startedAt: '2026-08-05T00:00:00.000Z',
      combatants: [
        {
          tokenId: caller.id,
          characterId: CHARACTER,
          name: caller.name,
          initiative: 20,
          initiativeBonus: 0,
          hp: 30,
          maxHp: 30,
          tempHp: 0,
          armorClass: 18,
          speed: 30,
          isNPC: false,
          conditions: [],
          deathSaves: { successes: 0, failures: 0 },
          portraitUrl: null,
        },
        {
          tokenId: target.id,
          characterId: TARGET_CHARACTER,
          name: target.name,
          initiative: 10,
          initiativeBonus: 0,
          hp: 40,
          maxHp: 40,
          tempHp: 0,
          armorClass: 16,
          speed: 30,
          isNPC: true,
          conditions: [],
          deathSaves: { successes: 0, failures: 0 },
          portraitUrl: null,
        },
      ],
    } as never;
  }
  return { room, caller, target, economy };
}

function actorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHARACTER,
    name: 'Seraphina',
    class: 'Cleric (War) 2 / Paladin (Vengeance) 3',
    level: 5,
    spell_save_dc: 15,
    ability_scores: JSON.stringify({ cha: 16, wis: 16 }),
    features: JSON.stringify([
      CHANNEL_DIVINITY,
      { name: 'Guided Strike' },
      { name: 'Vow of Enmity' },
    ]),
    version: 7,
    ...overrides,
  };
}

function targetRow(): Record<string, unknown> {
  return {
    id: TARGET_CHARACTER,
    name: 'Death Knight',
    ability_scores: JSON.stringify({ wis: 8 }),
    saving_throws: JSON.stringify([]),
    proficiency_bonus: 3,
  };
}

function arrange(
  initialActor: Record<string, unknown> = actorRow(),
  updateResult: 'success' | 'conflict' | 'error' = 'success'
) {
  let actor = { ...initialActor };
  const target = targetRow();
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('UPDATE characters')) {
      if (updateResult === 'error') throw new Error('db unavailable');
      if (updateResult === 'conflict') return { rows: [] };
      const nextVersion = Number(actor.version) + 1;
      actor = { ...actor, features: params?.[0], version: nextVersion };
      return { rows: [{ version: nextVersion }] };
    }
    if (sql.startsWith('UPDATE tokens')) return { rows: [] };
    const id = params?.[0];
    if (id === CHARACTER) return { rows: [actor] };
    if (id === TARGET_CHARACTER) return { rows: [target] };
    return { rows: [] };
  });
  return { actor: () => actor };
}

function publicMessages(emissions: Emission[]): Emission[] {
  return emissions.filter(
    (emission) =>
      emission.channelId === SESSION &&
      emission.event === 'chat:new-message' &&
      (emission.payload as { type?: string }).type === 'system'
  );
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((emission) => emission.event === event)
    .map((emission) => emission.channelId)
    .sort();
}

async function run(command: string, emissions: Emission[]): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('channel-1')!, command);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('specialized Channel Divinity commands', () => {
  it('shares one persisted pool across specialized commands', async () => {
    seedRoom();
    const state = arrange();
    const guided: Emission[] = [];
    await run('!guided', guided);

    const features = JSON.parse(String(state.actor().features)) as Feature[];
    expect(features.find((feature) => feature.name === 'Channel Divinity')).toMatchObject({
      usesTotal: 1,
      usesRemaining: 0,
      resetOn: 'short',
    });
    expect(publicMessages(guided)).toHaveLength(1);
    expect(channelsFor(guided, 'character:updated')).toEqual([
      'channel-1',
      'channel-2',
      'dm-1',
      'dm-2',
    ]);
    expect(guided.filter((emission) => emission.channelId === 'bystander-1')).toEqual([]);

    const vow: Emission[] = [];
    await run('!vow Death Knight', vow);
    expect(publicMessages(vow)).toEqual([]);
    expect(getAllRooms().get(SESSION)!.tokens.get('target-token')!.conditions).not.toContain(
      'vowed'
    );
  });

  it('commits Sacred Weapon before spending the combat action', async () => {
    const { economy } = seedRoom();
    arrange(
      actorRow({
        class: 'Paladin (Devotion) 3',
        level: 3,
        features: JSON.stringify([CHANNEL_DIVINITY, { name: 'Sacred Weapon' }]),
      })
    );
    const emissions: Emission[] = [];
    await run('!sacredweapon', emissions);
    expect(economy.action).toBe(true);
    expect(publicMessages(emissions)[0]?.payload).toMatchObject({ type: 'system' });
    expect(emissions.some((emission) => emission.event === 'combat:action-used')).toBe(true);
  });

  it('leaves Vow target and bonus action untouched when the resource write conflicts', async () => {
    const { target, economy } = seedRoom();
    arrange(actorRow(), 'conflict');
    const emissions: Emission[] = [];
    await run('!vow Death Knight', emissions);
    expect(economy.bonusAction).toBe(false);
    expect(target.conditions).not.toContain('vowed');
    expect(publicMessages(emissions)).toEqual([]);
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
  });

  it('spends Turn Undead and its action before rolling and applying frightened', async () => {
    const { target, economy } = seedRoom();
    arrange(
      actorRow({
        class: 'Cleric 2',
        level: 2,
        features: JSON.stringify([CHANNEL_DIVINITY]),
      })
    );
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const emissions: Emission[] = [];
    await run('!turnundead Death Knight', emissions);
    expect(economy.action).toBe(true);
    expect(target.conditions).toContain('frightened');
    expect(
      String((publicMessages(emissions)[0]?.payload as { content?: string }).content)
    ).toContain('FAILED');
  });

  it('does not roll, mutate, or spend Turn Undead when the guarded write fails', async () => {
    const { target, economy } = seedRoom();
    arrange(
      actorRow({
        class: 'Cleric 2',
        level: 2,
        features: JSON.stringify([CHANNEL_DIVINITY]),
      }),
      'conflict'
    );
    const random = vi.spyOn(Math, 'random');
    const emissions: Emission[] = [];
    await run('!turnundead Death Knight', emissions);
    expect(random).not.toHaveBeenCalled();
    expect(economy.action).toBe(false);
    expect(target.conditions).not.toContain('frightened');
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('rejects hidden and off-map targets before resource reads or writes', async () => {
    const { target } = seedRoom();
    target.visible = false;
    arrange();
    const hidden: Emission[] = [];
    await run('!vow Death Knight', hidden);
    expect(mockQuery).not.toHaveBeenCalled();

    target.visible = true;
    target.mapId = 'map-2';
    const offMap: Emission[] = [];
    await run('!turnundead Death Knight', offMap);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('requires Cleric 2 for Turn Undead rather than accepting a Paladin pool', async () => {
    seedRoom();
    arrange(
      actorRow({
        class: 'Paladin (Devotion) 3',
        level: 3,
        features: JSON.stringify([CHANNEL_DIVINITY]),
      })
    );
    const emissions: Emission[] = [];
    await run('!turnundead Death Knight', emissions);
    expect(
      mockQuery.mock.calls.some((call) => String(call[0]).startsWith('UPDATE characters'))
    ).toBe(false);
    expect(publicMessages(emissions)).toEqual([]);
  });
});
