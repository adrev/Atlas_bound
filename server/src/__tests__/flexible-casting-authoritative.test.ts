import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import { computeRest } from '../services/RestService.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
} from '../utils/roomState.js';
import '../services/chatCommands/sorcererHandler.js';
import '../services/chatCommands/subclassFeaturesTier10Handler.js';
import '../services/chatCommands/subclassFeaturesTier11Handler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'sorcery-point-authority';
const CHARACTER = 'sorcerer-character';
const FONT_OF_MAGIC: Feature = {
  name: 'Font of Magic',
  description: 'Sorcery Points used for Flexible Casting and Metamagic.',
  source: 'Sorcerer',
  sourceType: 'class',
  usesTotal: 5,
  usesRemaining: 2,
  resetOn: 'long',
};

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function sorcererToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 'sorcerer-token',
    mapId: 'map-1',
    characterId: CHARACTER,
    name: 'Ember',
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
    ownerUserId: 'sorcerer-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'SORCERY', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('sorcerer-token', sorcererToken());
  room.tokens.set(
    'enemy-token',
    sorcererToken({
      id: 'enemy-token',
      characterId: null,
      name: 'Enemy',
      ownerUserId: null,
    })
  );
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['sorcerer-user', 'sorcerer-1', 'player', CHARACTER],
    ['sorcerer-user', 'sorcerer-2', 'player', CHARACTER],
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
        tokenId: 'sorcerer-token',
        characterId: CHARACTER,
        name: 'Ember',
        initiative: 16,
        initiativeBonus: 2,
        hp: 27,
        maxHp: 27,
        tempHp: 0,
        armorClass: 15,
        speed: 30,
        isNPC: false,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        portraitUrl: null,
      },
      {
        tokenId: 'enemy-token',
        characterId: null,
        name: 'Enemy',
        initiative: 10,
        initiativeBonus: 0,
        hp: 20,
        maxHp: 20,
        tempHp: 0,
        armorClass: 13,
        speed: 30,
        isNPC: true,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        portraitUrl: null,
      },
    ],
  };
  room.actionEconomies.set('sorcerer-token', {
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
    class: 'Sorcerer 5',
    level: 5,
    name: 'Ember',
    features: JSON.stringify([FONT_OF_MAGIC]),
    spell_slots: JSON.stringify({
      1: { max: 3, used: 0 },
      2: { max: 2, used: 2 },
    }),
    user_id: 'sorcerer-user',
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
    if (sql.includes('SELECT class, level, name, features')) {
      return { rows: row ? [row] : [] };
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

function featureFromUpdate(callIndex = 0): Feature {
  const features = JSON.parse(updateCalls()[callIndex][1][0] as string) as Feature[];
  return features.find((feature) => feature.name === 'Font of Magic')!;
}

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('sorcerer-1')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
  arrange();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authoritative Sorcery Points', () => {
  it('reads persisted status without seeding the legacy room pool', async () => {
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!sp status');

    expect(updateCalls()).toEqual([]);
    expect(room.pointPools.size).toBe(0);
    expect(whispers(emissions)[0]).toContain('2/5');
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('persists a spend with a version guard and keeps exact totals private', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!sp use 1');

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('SET features = $1');
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params.slice(1)).toEqual([CHARACTER, 7]);
    expect(featureFromUpdate()).toMatchObject({
      usesTotal: 5,
      usesRemaining: 1,
      resetOn: 'long',
    });
    expect(channelsFor(emissions, 'character:updated')).toEqual([
      'dm-1',
      'dm-2',
      'sorcerer-1',
      'sorcerer-2',
    ]);
    expect(publicMessages(emissions)).toHaveLength(1);
    expect(publicMessages(emissions)[0].content).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it('seeds the D&D Beyond-compatible Font of Magic feature', async () => {
    arrange(characterRow({ features: '[]' }));
    const emissions: Emission[] = [];
    await run(emissions, '!sp use 1');

    expect(featureFromUpdate()).toMatchObject({
      name: 'Font of Magic',
      usesTotal: 5,
      usesRemaining: 4,
      resetOn: 'long',
    });
  });

  it('uses Sorcerer multiclass level rather than total character level', async () => {
    arrange(
      characterRow({
        class: 'Fighter 3 / Sorcerer (Draconic Bloodline) 2',
        level: 5,
        features: JSON.stringify([{ ...FONT_OF_MAGIC, usesTotal: 99, usesRemaining: 99 }]),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions, '!sp use 1');

    expect(featureFromUpdate()).toMatchObject({ usesTotal: 2, usesRemaining: 1 });
  });

  it('denies Sorcerer level 1 and sends reset through the long-rest flow', async () => {
    arrange(characterRow({ class: 'Sorcerer 1', level: 1 }));
    const denied: Emission[] = [];
    await run(denied, '!sp use 1');
    expect(updateCalls()).toEqual([]);
    expect(whispers(denied)[0]).toContain('Sorcerer level 2');

    arrange();
    mockQuery.mockClear();
    const reset: Emission[] = [];
    await run(reset, '!sp reset');
    expect(updateCalls()).toEqual([]);
    expect(whispers(reset)[0]).toContain('Long Rest');
  });

  it.each(['!sp use 0', '!sp use -1', '!sp use 1junk', '!sp use 1 extra'])(
    'strictly rejects %s',
    async (command) => {
      const emissions: Emission[] = [];
      await run(emissions, command);
      expect(updateCalls()).toEqual([]);
      expect(publicMessages(emissions)).toEqual([]);
    }
  );

  it.each([
    ['version conflict', []],
    ['database failure', new Error('database unavailable')],
  ])('fails closed on %s', async (_label, update) => {
    arrange(characterRow(), update);
    const emissions: Emission[] = [];
    await run(emissions, '!sp use 1');

    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
    expect(whispers(emissions)).toHaveLength(1);
  });

  it('does not resolve a caller token from another map', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.get('sorcerer-token')!.mapId = 'map-2';
    const emissions: Emission[] = [];
    await run(emissions, '!sp status');

    expect(mockQuery).not.toHaveBeenCalled();
    expect(whispers(emissions)[0]).toContain('on this map');
  });

  it('refreshes the persisted feature through a long rest', () => {
    const result = computeRest(
      {
        id: CHARACTER,
        name: 'Ember',
        features: [{ ...FONT_OF_MAGIC, usesRemaining: 0 }],
      },
      'long'
    );
    expect(result.updates.features).toEqual([{ ...FONT_OF_MAGIC, usesRemaining: 5 }]);
  });
});

describe('authoritative Metamagic', () => {
  it('requires Sorcerer level 3 and persists the point cost', async () => {
    arrange(characterRow({ class: 'Sorcerer 2', level: 2 }));
    const denied: Emission[] = [];
    await run(denied, '!meta subtle');
    expect(updateCalls()).toEqual([]);
    expect(whispers(denied)[0]).toContain('Sorcerer level 3');

    arrange(characterRow({ class: 'Sorcerer 3', level: 3 }));
    mockQuery.mockClear();
    const allowed: Emission[] = [];
    await run(allowed, '!meta subtle');
    expect(featureFromUpdate()).toMatchObject({ usesTotal: 3, usesRemaining: 1 });
    expect(publicMessages(allowed)[0].content).toContain('Subtle Spell (1 SP)');
    expect(publicMessages(allowed)[0].content).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it.each(['!meta twinned', '!meta twinned -1', '!meta quickened extra'])(
    'rejects invalid syntax %s before spending',
    async (command) => {
      const emissions: Emission[] = [];
      await run(emissions, command);
      expect(updateCalls()).toEqual([]);
      expect(publicMessages(emissions)).toEqual([]);
    }
  );
});

describe('atomic Flexible Casting', () => {
  it('stores the slot and Sorcery Point changes in one guarded update', async () => {
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!flexible slot2sp 1');

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('SET features = $1, spell_slots = $2');
    expect(sql).toContain('WHERE id = $3 AND version = $4');
    expect(params.slice(2)).toEqual([CHARACTER, 7]);
    expect(featureFromUpdate()).toMatchObject({ usesRemaining: 3 });
    expect(JSON.parse(params[1] as string)).toEqual({
      1: { max: 3, used: 1 },
      2: { max: 2, used: 2 },
    });
    expect(room.actionEconomies.get('sorcerer-token')?.bonusAction).toBe(true);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([
      'dm-1',
      'dm-2',
      'sorcerer-1',
      'sorcerer-2',
    ]);
  });

  it('atomically spends points and restores an expended normal slot', async () => {
    arrange(
      characterRow({
        features: JSON.stringify([{ ...FONT_OF_MAGIC, usesRemaining: 5 }]),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions, '!flexible sp2slot 2');

    expect(featureFromUpdate()).toMatchObject({ usesRemaining: 2 });
    expect(JSON.parse(updateCalls()[0][1][1] as string)['2']).toEqual({ max: 2, used: 1 });
  });

  it('caps points at the class maximum and reports the amount actually gained', async () => {
    arrange(
      characterRow({
        features: JSON.stringify([{ ...FONT_OF_MAGIC, usesRemaining: 4 }]),
        spell_slots: JSON.stringify({ 5: { max: 1, used: 0 } }),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions, '!flexible slot2sp 5');

    expect(featureFromUpdate()).toMatchObject({ usesRemaining: 5 });
    expect(publicMessages(emissions)[0].content).toContain('into 1 Sorcery Points');
  });

  it('grants the full slot level when converting a slot above 5th level', async () => {
    arrange(
      characterRow({
        class: 'Sorcerer 20',
        level: 20,
        features: JSON.stringify([
          { ...FONT_OF_MAGIC, usesTotal: 20, usesRemaining: 0 },
        ]),
        spell_slots: JSON.stringify({ 9: { max: 1, used: 0 } }),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions, '!flexible slot2sp 9');

    expect(featureFromUpdate()).toMatchObject({ usesTotal: 20, usesRemaining: 9 });
    expect(publicMessages(emissions)[0].content).toContain('into 9 Sorcery Points');
  });

  it('allows conversion outside combat without consuming an action state', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = null;
    const emissions: Emission[] = [];
    await run(emissions, '!flexible slot2sp 1');

    expect(updateCalls()).toHaveLength(1);
    expect(room.actionEconomies.get('sorcerer-token')?.bonusAction).toBe(false);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([]);
  });

  it('rejects off-turn and already-spent bonus actions before writing', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState!.currentTurnIndex = 1;
    const offTurn: Emission[] = [];
    await run(offTurn, '!flexible slot2sp 1');
    expect(updateCalls()).toEqual([]);

    room.combatState!.currentTurnIndex = 0;
    room.actionEconomies.get('sorcerer-token')!.bonusAction = true;
    mockQuery.mockClear();
    const spent: Emission[] = [];
    await run(spent, '!flexible slot2sp 1');
    expect(updateCalls()).toEqual([]);
  });

  it.each([
    ['version conflict', []],
    ['database failure', new Error('database unavailable')],
  ])('does not consume the bonus action on %s', async (_label, update) => {
    arrange(characterRow(), update);
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!flexible slot2sp 1');

    expect(room.actionEconomies.get('sorcerer-token')?.bonusAction).toBe(false);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('executes an already-committed conversion when only synchronization is malformed', async () => {
    arrange(characterRow(), [{ version: 'invalid' }]);
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!flexible slot2sp 1');

    expect(room.actionEconomies.get('sorcerer-token')?.bonusAction).toBe(true);
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(whispers(emissions)[0]).toContain('change was saved');
    expect(publicMessages(emissions)).toHaveLength(1);
  });

  it('labels temporary slots above the normal maximum as unsupported instead of charging points', async () => {
    arrange(
      characterRow({
        features: JSON.stringify([{ ...FONT_OF_MAGIC, usesRemaining: 5 }]),
        spell_slots: JSON.stringify({ 2: { max: 2, used: 0 } }),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions, '!flexible sp2slot 2');

    expect(updateCalls()).toEqual([]);
    expect(whispers(emissions)[0]).toContain('not automated yet');
  });

  it.each([
    { features: '{bad json' },
    { features: '[null]' },
    { spell_slots: '{bad json' },
    { spell_slots: JSON.stringify({ 1: { max: 2, used: 3 } }) },
    { version: 'invalid' },
  ])('fails closed for malformed resource state %#', async (overrides) => {
    arrange(characterRow(overrides));
    const emissions: Emission[] = [];
    await run(emissions, '!flexible slot2sp 1');
    expect(updateCalls()).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
  });
});

describe('persisted Sorcery Point subclass consumers', () => {
  it('does not announce Elemental Affinity resistance when the spend fails', async () => {
    arrange(
      characterRow({
        class: 'Sorcerer (Draconic Bloodline)',
        level: 6,
        features: JSON.stringify([
          { name: 'Elemental Affinity', description: '', source: 'Sorcerer', sourceType: 'class' },
          { name: 'Red Dragon Ancestor', description: '', source: 'Sorcerer', sourceType: 'class' },
          { ...FONT_OF_MAGIC, usesTotal: 6, usesRemaining: 4 },
        ]),
      }),
      new Error('database unavailable')
    );
    const emissions: Emission[] = [];
    await run(emissions, '!elemental resist');

    const selectSql = String(
      mockQuery.mock.calls.find((call) =>
        String(call[0]).includes('SELECT class, level, name, features, ability_scores')
      )?.[0]
    );
    expect(selectSql).toContain('version');
    expect(selectSql).toContain('user_id');
    expect(publicMessages(emissions)).toEqual([]);
    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
  });

  it('enforces Hound level, map scope, spend ordering, and bonus action', async () => {
    arrange(
      characterRow({
        class: 'Sorcerer (Shadow Magic)',
        level: 5,
        features: JSON.stringify([
          { name: 'Hound of Ill Omen', description: '', source: 'Sorcerer', sourceType: 'class' },
          { ...FONT_OF_MAGIC, usesRemaining: 5 },
        ]),
      })
    );
    const tooLow: Emission[] = [];
    await run(tooLow, '!hound Enemy');
    expect(updateCalls()).toEqual([]);
    expect(whispers(tooLow)[0]).toContain('Sorcerer level 6');

    const room = getAllRooms().get(SESSION)!;
    room.tokens.get('enemy-token')!.mapId = 'map-2';
    arrange(
      characterRow({
        class: 'Sorcerer (Shadow Magic)',
        level: 6,
        features: JSON.stringify([
          { name: 'Hound of Ill Omen', description: '', source: 'Sorcerer', sourceType: 'class' },
          { ...FONT_OF_MAGIC, usesTotal: 6, usesRemaining: 5 },
        ]),
      })
    );
    mockQuery.mockClear();
    const offMap: Emission[] = [];
    await run(offMap, '!hound Enemy');
    expect(updateCalls()).toEqual([]);
    expect(whispers(offMap)[0]).toContain('on this map');

    room.tokens.get('enemy-token')!.mapId = 'map-1';
    arrange(
      characterRow({
        class: 'Sorcerer (Shadow Magic)',
        level: 6,
        features: JSON.stringify([
          { name: 'Hound of Ill Omen', description: '', source: 'Sorcerer', sourceType: 'class' },
          { ...FONT_OF_MAGIC, usesTotal: 6, usesRemaining: 5 },
        ]),
      }),
      new Error('database unavailable')
    );
    mockQuery.mockClear();
    const failed: Emission[] = [];
    await run(failed, '!hound Enemy');
    expect(room.actionEconomies.get('sorcerer-token')?.bonusAction).toBe(false);
    expect(publicMessages(failed)).toEqual([]);

    arrange(
      characterRow({
        class: 'Sorcerer (Shadow Magic)',
        level: 6,
        features: JSON.stringify([
          { name: 'Hound of Ill Omen', description: '', source: 'Sorcerer', sourceType: 'class' },
          { ...FONT_OF_MAGIC, usesTotal: 6, usesRemaining: 5 },
        ]),
      })
    );
    mockQuery.mockClear();
    const allowed: Emission[] = [];
    await run(allowed, '!hound Enemy');
    const selectSql = String(
      mockQuery.mock.calls.find((call) =>
        String(call[0]).includes('SELECT class, level, name, features')
      )?.[0]
    );
    expect(selectSql).toContain('version');
    expect(selectSql).toContain('user_id');
    expect(featureFromUpdate()).toMatchObject({ usesRemaining: 2 });
    expect(room.actionEconomies.get('sorcerer-token')?.bonusAction).toBe(true);
    expect(publicMessages(allowed)[0].content).not.toMatch(/SP \d+\/\d+/);
  });
});
