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
import '../services/chatCommands/racialSpellsHandler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'racial-spell-authority';
const CHARACTER = 'racial-character';

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function callerToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 'racial-token',
    mapId: 'map-1',
    characterId: CHARACTER,
    name: 'Zariel',
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
    ownerUserId: 'racial-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'RACIAL', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('racial-token', callerToken());
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['racial-user', 'racial-1', 'player', CHARACTER],
    ['racial-user', 'racial-2', 'player', CHARACTER],
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

function racialFeature(
  spellName: string,
  remaining: number,
  resetOn: 'short' | 'long' = 'long'
): Feature {
  return {
    name: `Racial Spell: ${spellName}`,
    description: `${spellName} innate racial spell charge.`,
    source: 'Tiefling',
    sourceType: 'race',
    usesTotal: 1,
    usesRemaining: remaining,
    resetOn,
  };
}

function characterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHARACTER,
    name: 'Zariel',
    level: 5,
    race: 'Tiefling',
    features: '[]',
    version: 7,
    user_id: 'racial-user',
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
    if (sql.includes('SELECT name, level, race, features, version, user_id')) {
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

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('racial-1')!, command);
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

describe('authoritative innate racial spell charges', () => {
  it('lists persisted/default charges without seeding the legacy room pool', async () => {
    const room = getAllRooms().get(SESSION)!;
    const emissions: Emission[] = [];
    await run(emissions, '!racial list');

    expect(updateCalls()).toEqual([]);
    expect(room.pointPools.size).toBe(0);
    expect(whispers(emissions).join('\n')).toContain('Hellish Rebuke');
    expect(whispers(emissions).join('\n')).toContain('(1/1)');
  });

  it('persists a per-rest cast with a version guard and private exact totals', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!racial cast Hellish Rebuke');

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params.slice(1)).toEqual([CHARACTER, 7]);
    const features = JSON.parse(params[0] as string) as Feature[];
    expect(features.find((feature) => feature.name === 'Racial Spell: Hellish Rebuke')).toMatchObject({
      sourceType: 'race',
      usesTotal: 1,
      usesRemaining: 0,
      resetOn: 'long',
    });
    expect(channelsFor(emissions, 'character:updated')).toEqual([
      'dm-1',
      'dm-2',
      'racial-1',
      'racial-2',
    ]);
    expect(whispers(emissions).join('\n')).toContain('0/1 charge remaining');
    expect(publicMessages(emissions)).toHaveLength(1);
    expect(publicMessages(emissions)[0].content).not.toMatch(/charge|0\s*\/\s*1/i);
  });

  it('rejects an exhausted charge without writing or announcing a cast', async () => {
    arrange(
      characterRow({ features: JSON.stringify([racialFeature('Hellish Rebuke', 0)]) })
    );
    const emissions: Emission[] = [];
    await run(emissions, '!racial Hellish Rebuke');

    expect(updateCalls()).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
    expect(whispers(emissions)[0]).toContain('already used');
  });

  it('keeps at-will racial spells free of resource writes', async () => {
    const emissions: Emission[] = [];
    await run(emissions, '!racial Thaumaturgy');

    expect(updateCalls()).toEqual([]);
    expect(publicMessages(emissions)).toHaveLength(1);
    expect(publicMessages(emissions)[0].content).toContain('at-will');
  });

  it.each([
    ['version conflict', []],
    ['database failure', new Error('database unavailable')],
  ])('fails closed on %s', async (_label, update) => {
    arrange(characterRow(), update);
    const emissions: Emission[] = [];
    await run(emissions, '!racial Darkness');

    expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
    expect(whispers(emissions)).toHaveLength(1);
  });

  it('allows only one of two concurrent casts against the same character version', async () => {
    let updateCount = 0;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE characters')) {
        updateCount += 1;
        return { rows: updateCount === 1 ? [{ version: 8 }] : [] };
      }
      if (sql.includes('SELECT name, level, race, features, version, user_id')) {
        return { rows: [characterRow()] };
      }
      return { rows: [] };
    });
    const first: Emission[] = [];
    const second: Emission[] = [];
    await Promise.all([
      run(first, '!racial Hellish Rebuke'),
      run(second, '!racial Hellish Rebuke'),
    ]);

    expect(updateCalls()).toHaveLength(2);
    expect([...publicMessages(first), ...publicMessages(second)]).toHaveLength(1);
    expect([
      ...channelsFor(first, 'character:updated'),
      ...channelsFor(second, 'character:updated'),
    ]).toHaveLength(4);
  });

  it.each([
    { features: '{bad json' },
    { features: '[null]' },
    { features: JSON.stringify([racialFeature('Darkness', 2)]) },
    { version: 'invalid' },
  ])('fails closed for malformed resource state %#', async (overrides) => {
    arrange(characterRow(overrides));
    const emissions: Emission[] = [];
    await run(emissions, '!racial Darkness');

    expect(updateCalls()).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('does not resolve a caller token from another map', async () => {
    getAllRooms().get(SESSION)!.tokens.get('racial-token')!.mapId = 'map-2';
    const emissions: Emission[] = [];
    await run(emissions, '!racial list');

    expect(mockQuery).not.toHaveBeenCalled();
    expect(whispers(emissions)[0]).toContain('on this map');
  });

  it('routes legacy reset commands to the normal rest flows', async () => {
    const longRest: Emission[] = [];
    await run(longRest, '!racial reset');
    expect(updateCalls()).toEqual([]);
    expect(whispers(longRest)[0]).toContain('Long Rest');

    mockQuery.mockClear();
    const shortRest: Emission[] = [];
    await run(shortRest, '!racial resetshort');
    expect(updateCalls()).toEqual([]);
    expect(whispers(shortRest)[0]).toContain('Short Rest');
  });

  it('refreshes long- and short-rest racial features through RestService', () => {
    const longResult = computeRest(
      {
        id: CHARACTER,
        name: 'Zariel',
        features: [racialFeature('Hellish Rebuke', 0, 'long')],
      },
      'long'
    );
    expect((longResult.updates.features as Feature[])[0].usesRemaining).toBe(1);

    const shortResult = computeRest(
      {
        id: CHARACTER,
        name: 'Firbolg',
        features: [racialFeature('Detect Magic', 0, 'short')],
      },
      'short'
    );
    expect((shortResult.updates.features as Feature[])[0].usesRemaining).toBe(1);
  });
});
