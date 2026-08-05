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

const SESSION = 'channel-divinity-session';
const CHARACTER = 'cleric-character';
const CHANNEL_DIVINITY: Feature = {
  name: 'Channel Divinity',
  description: 'Invoke a Channel Divinity effect.',
  source: 'Cleric',
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

function clericToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 'cleric-token',
    mapId: 'map-1',
    characterId: CHARACTER,
    name: 'Morrigan',
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
    ownerUserId: 'cleric-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'CHANNEL', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('cleric-token', clericToken());
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['dm-user', 'dm-2', 'dm', null],
    ['cleric-user', 'cleric-1', 'player', CHARACTER],
    ['cleric-user', 'cleric-2', 'player', CHARACTER],
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
  room.actionEconomies.set('cleric-token', {
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
    class: 'Cleric 2',
    level: 2,
    features: JSON.stringify([CHANNEL_DIVINITY]),
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
  expect(publicMessages(emissions)).toEqual([]);
  expect(whispers(emissions)).toHaveLength(1);
}

async function run(emissions: Emission[], command = '!channel Turn Undead'): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('cleric-1')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
  arrange();
});

describe('authoritative Channel Divinity', () => {
  it('persists a use with optimistic versioning before announcing the effect', async () => {
    const emissions: Emission[] = [];
    await run(emissions);

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('SET features = $1');
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params.slice(1)).toEqual([CHARACTER, 7]);
    const features = JSON.parse(params[0] as string) as Feature[];
    expect(features[0]).toMatchObject({ usesTotal: 1, usesRemaining: 0, resetOn: 'short' });
    expect(publicMessages(emissions)[0].content).toContain('Turn Undead');
  });

  it('seeds a missing eligible feature and marks it as a short-rest resource', async () => {
    arrange(characterRow({ features: '[]' }));
    const emissions: Emission[] = [];
    await run(emissions);

    const features = JSON.parse(updateCalls()[0][1][0] as string) as Feature[];
    expect(features.at(-1)).toMatchObject({
      name: 'Channel Divinity',
      sourceType: 'class',
      usesTotal: 1,
      usesRemaining: 0,
      resetOn: 'short',
    });
  });

  it.each([
    ['Cleric 2', 2, 1],
    ['Cleric 6', 6, 2],
    ['Cleric 18', 18, 3],
    ['Paladin (Devotion) 3', 3, 1],
    ['Rogue 3 / Cleric (Grave) 6 / Paladin 3', 12, 2],
  ])('derives the shared maximum for %s', async (className, level, maximum) => {
    arrange(
      characterRow({
        class: className,
        level,
        features: JSON.stringify([{ ...CHANNEL_DIVINITY, usesTotal: 99, usesRemaining: 99 }]),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions);

    const features = JSON.parse(updateCalls()[0][1][0] as string) as Feature[];
    expect(features[0]).toMatchObject({ usesTotal: maximum, usesRemaining: maximum - 1 });
  });

  it('reports status privately without spending or revealing it publicly', async () => {
    arrange(
      characterRow({
        class: 'Cleric 6',
        level: 6,
        features: JSON.stringify([{ ...CHANNEL_DIVINITY, usesTotal: 2, usesRemaining: 1 }]),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions, '!channel status');
    expect(updateCalls()).toEqual([]);
    expect(whispers(emissions)[0]).toContain('1/2');
    expect(publicMessages(emissions)).toEqual([]);
  });

  it('scopes exact feature state to every DM and owner tab', async () => {
    const emissions: Emission[] = [];
    await run(emissions);
    expect(channelsFor(emissions, 'character:updated')).toEqual([
      'cleric-1',
      'cleric-2',
      'dm-1',
      'dm-2',
    ]);
    expect(emissions.filter((emission) => emission.channelId === 'bystander-1')).toEqual([]);
    expect(String(publicMessages(emissions)[0].content)).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it.each([
    ['Cleric 1', 1, 'Cleric level 2'],
    ['Paladin 2', 2, 'Paladin level 3'],
    ['Wizard 20', 20, "isn't a Cleric or Paladin"],
  ])('rejects an ineligible %s', async (className, level, message) => {
    arrange(characterRow({ class: className, level }));
    const emissions: Emission[] = [];
    await run(emissions);
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0]).toContain(message);
  });

  it.each([
    { features: '{bad json' },
    { features: '[null]' },
    { features: JSON.stringify([{ ...CHANNEL_DIVINITY, usesRemaining: 'many' }]) },
    { features: JSON.stringify([{ ...CHANNEL_DIVINITY, usesRemaining: '1' }]) },
    { version: 'bad' },
    { level: 2.5 },
    { level: 21 },
    { class: 'Cleric 99 / Paladin 1', level: 20 },
    { class: 'Cleric 18 / Paladin 3', level: 20 },
  ])('fails closed for malformed character state %#', async (overrides) => {
    arrange(characterRow(overrides));
    const emissions: Emission[] = [];
    await run(emissions);
    expectFailedClosed(emissions);
  });

  it('refuses an exhausted pool', async () => {
    arrange(
      characterRow({
        features: JSON.stringify([{ ...CHANNEL_DIVINITY, usesRemaining: 0 }]),
      })
    );
    const emissions: Emission[] = [];
    await run(emissions);
    expectFailedClosed(emissions);
  });

  it('does not announce an effect when the guarded write conflicts, fails, or is unusable', async () => {
    for (const update of [[], new Error('db unavailable'), [{ version: null }]] as const) {
      arrange(characterRow(), update as Array<Record<string, unknown>> | Error);
      const emissions: Emission[] = [];
      await run(emissions);
      expect(publicMessages(emissions)).toEqual([]);
      expect(channelsFor(emissions, 'character:updated')).toEqual([]);
    }
  });

  it('rejects an off-map caller and malformed effect names without DB traffic', async () => {
    getAllRooms().get(SESSION)!.tokens.get('cleric-token')!.mapId = 'map-2';
    const offMap: Emission[] = [];
    await run(offMap);
    expect(mockQuery).not.toHaveBeenCalled();
    expectFailedClosed(offMap);

    getAllRooms().get(SESSION)!.tokens.get('cleric-token')!.mapId = 'map-1';
    const malformed: Emission[] = [];
    await run(malformed, `!channel ${'*'.repeat(65)}`);
    expect(mockQuery).not.toHaveBeenCalled();
    expectFailedClosed(malformed);
  });

  it('does not guess a generic effect action cost or mutate combat economy', async () => {
    const before = { ...getAllRooms().get(SESSION)!.actionEconomies.get('cleric-token')! };
    const emissions: Emission[] = [];
    await run(emissions, '!channel Guided Strike');
    expect(getAllRooms().get(SESSION)!.actionEconomies.get('cleric-token')).toEqual(before);
    expect(publicMessages(emissions)[0].content).toContain('DM resolves');
  });
});
