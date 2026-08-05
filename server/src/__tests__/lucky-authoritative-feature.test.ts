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
import '../services/chatCommands/utilityHandlers.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'lucky-session';
const LUCKY_FEAT: Feature = {
  name: 'Lucky',
  description: 'You have 3 luck points.',
  source: 'Lucky',
  sourceType: 'feat',
  usesTotal: 3,
  usesRemaining: 3,
  resetOn: 'long',
};
const RACIAL_LUCKY: Feature = {
  name: 'Lucky',
  description: 'Reroll natural 1s on d20 rolls.',
  source: 'Halfling',
  sourceType: 'race',
};

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function token(overrides: Partial<Token> = {}): Token {
  return {
    id: 'lucky-token',
    mapId: 'map-1',
    characterId: 'lucky-character',
    name: 'Fortuna',
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
    ownerUserId: 'lucky-user',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'LUCK', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('lucky-token', token());
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-socket-1',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-socket-2',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'lucky-user',
    displayName: 'Fortuna',
    socketId: 'lucky-socket-1',
    role: 'player',
    characterId: 'lucky-character',
  });
  addPlayerToRoom(SESSION, {
    userId: 'lucky-user',
    displayName: 'Fortuna',
    socketId: 'lucky-socket-2',
    role: 'player',
    characterId: 'lucky-character',
  });
  addPlayerToRoom(SESSION, {
    userId: 'bystander-user',
    displayName: 'Bystander',
    socketId: 'bystander-socket',
    role: 'player',
    characterId: null,
  });
  return room;
}

function characterRow(overrides: Record<string, unknown> = {}) {
  return {
    features: JSON.stringify([LUCKY_FEAT]),
    version: 7,
    ...overrides,
  };
}

function mockCharacter(
  row: Record<string, unknown> | null,
  updateResult: Array<Record<string, unknown>> | Error
): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE characters')) {
      if (updateResult instanceof Error) throw updateResult;
      return { rows: updateResult };
    }
    if (sql.startsWith('SELECT features, version')) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
}

function selectCalls(): unknown[][] {
  return mockQuery.mock.calls.filter((call) => String(call[0]).startsWith('SELECT features'));
}

function updateCalls(): Array<[string, unknown[]]> {
  return mockQuery.mock.calls
    .filter((call) => String(call[0]).startsWith('UPDATE characters'))
    .map((call) => [call[0] as string, call[1] as unknown[]]);
}

function writtenFeatures(): Feature[] {
  return JSON.parse(updateCalls()[0][1][0] as string) as Feature[];
}

function emissionsFor(emissions: Emission[], event: string): Emission[] {
  return emissions.filter((emission) => emission.event === event);
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissionsFor(emissions, event)
    .map((emission) => emission.channelId)
    .sort();
}

function whispers(emissions: Emission[]): Array<{ channelId: string; content: string }> {
  return emissions
    .filter(
      (emission) =>
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'whisper'
    )
    .map((emission) => ({
      channelId: emission.channelId,
      content: (emission.payload as { content: string }).content,
    }));
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
  expect(emissionsFor(emissions, 'character:updated')).toEqual([]);
  expect(publicMessages(emissions)).toEqual([]);
  expect(whispers(emissions)).toHaveLength(1);
  expect(whispers(emissions)[0].channelId).toBe('lucky-socket-1');
}

async function run(emissions: Emission[], raw = '!lucky use'): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('lucky-socket-1')!, raw);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authoritative Lucky spend', () => {
  it('persists the spend with a version-guarded UPDATE and forwards the authoritative version', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('SET features = $1');
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params[1]).toBe('lucky-character');
    expect(params[2]).toBe(7);
    expect(writtenFeatures()[0]).toMatchObject({
      name: 'Lucky',
      sourceType: 'feat',
      usesTotal: 3,
      usesRemaining: 2,
      resetOn: 'long',
    });

    const update = emissionsFor(emissions, 'character:updated')[0].payload as {
      characterId: string;
      changes: Record<string, unknown>;
    };
    expect(update.characterId).toBe('lucky-character');
    expect(update.changes.version).toBe(8);
    expect((update.changes.features as Feature[])[0].usesRemaining).toBe(2);
    expect(publicMessages(emissions)[0].content as string).toContain('extra d20 = **11**');
  });

  it('accepts the `spend` alias', async () => {
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions, '!lucky spend');

    expect(updateCalls()).toHaveLength(1);
    expect(publicMessages(emissions)).toHaveLength(1);
  });

  it('seeds long-rest resource metadata on a feat entry that has none', async () => {
    mockCharacter(
      characterRow({
        features: JSON.stringify([
          { name: 'Lucky', description: 'Feat', source: 'Lucky', sourceType: 'feat' },
        ]),
      }),
      [{ version: 8 }]
    );
    const emissions: Emission[] = [];

    await run(emissions);

    expect(writtenFeatures()[0]).toMatchObject({
      usesTotal: 3,
      usesRemaining: 2,
      resetOn: 'long',
    });
  });

  it('normalizes a wrong resetOn and out-of-range remaining on the feat entry only', async () => {
    mockCharacter(
      characterRow({
        features: JSON.stringify([
          { ...RACIAL_LUCKY, resetOn: 'short' },
          { ...LUCKY_FEAT, usesRemaining: 99, resetOn: 'short' },
        ]),
      }),
      [{ version: 8 }]
    );
    const emissions: Emission[] = [];

    await run(emissions);

    const features = writtenFeatures();
    expect(features[1]).toMatchObject({ usesTotal: 3, usesRemaining: 2, resetOn: 'long' });
    expect(features[0]).toMatchObject({ sourceType: 'race', resetOn: 'short' });
  });

  it('writes metadata that RestService restores on a long rest but not a short rest', async () => {
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    const persistedRow = {
      id: 'lucky-character',
      name: 'Fortuna',
      features: writtenFeatures(),
    };
    const longRest = computeRest(persistedRow, 'long');
    expect((longRest.updates.features as Feature[])[0].usesRemaining).toBe(3);
    const shortRest = computeRest(persistedRow, 'short');
    expect(shortRest.updates.features).toBeUndefined();
  });

  it('sends the exact remaining pool to every DM and owner tab, never the bystander', async () => {
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(channelsFor(emissions, 'character:updated')).toEqual([
      'dm-socket-1',
      'dm-socket-2',
      'lucky-socket-1',
      'lucky-socket-2',
    ]);
    expect(emissions.filter((emission) => emission.channelId === 'bystander-socket')).toEqual([]);
  });

  it('keeps the remaining pool out of the public spend line', async () => {
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    const content = publicMessages(emissions)[0].content as string;
    expect(content).toContain('extra d20');
    expect(content).not.toContain('2/3');
    expect(content).not.toContain('left');
    expect(content).not.toContain('remaining');
  });

  it('reads the pool from the database on every invocation — no module memory survives', async () => {
    mockCharacter(
      characterRow({ features: JSON.stringify([{ ...LUCKY_FEAT, usesRemaining: 1 }]) }),
      [{ version: 8 }]
    );
    const first: Emission[] = [];
    await run(first);
    expect(publicMessages(first)).toHaveLength(1);
    expect(writtenFeatures()[0].usesRemaining).toBe(0);

    // Simulate a restart / external change: the DB now reports an
    // empty pool. A module-memory counter would still allow a spend.
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    mockCharacter(
      characterRow({ features: JSON.stringify([{ ...LUCKY_FEAT, usesRemaining: 0 }]), version: 9 }),
      [{ version: 10 }]
    );
    const second: Emission[] = [];
    await run(second);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(second);
    expect(whispers(second)[0].content).toContain('no luck points remaining');
  });
});

describe('feat vs Halfling racial Lucky', () => {
  it('refuses a sheet whose only Lucky entry is the racial trait', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow({ features: JSON.stringify([RACIAL_LUCKY]) }), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain("doesn't have the Lucky feat");
  });

  it('never invents the feat for an ineligible sheet', async () => {
    mockCharacter(characterRow({ features: '[]' }), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expectFailedClosed(emissions);
  });

  it('decrements only the feat entry when both racial trait and feat are present', async () => {
    mockCharacter(characterRow({ features: JSON.stringify([RACIAL_LUCKY, LUCKY_FEAT]) }), [
      { version: 8 },
    ]);
    const emissions: Emission[] = [];

    await run(emissions);

    const features = writtenFeatures();
    expect(features[0]).toEqual(RACIAL_LUCKY);
    expect(features[1]).toMatchObject({ sourceType: 'feat', usesRemaining: 2 });
  });
});

describe('private status and removed reset', () => {
  it('whispers status only to the invoking tab without writing or rolling', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(
      characterRow({ features: JSON.stringify([{ ...LUCKY_FEAT, usesRemaining: 2 }]) }),
      [{ version: 8 }]
    );
    const emissions: Emission[] = [];

    await run(emissions, '!lucky status');

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expect(publicMessages(emissions)).toEqual([]);
    expect(whispers(emissions)).toEqual([
      { channelId: 'lucky-socket-1', content: expect.stringContaining('2/3') },
    ]);
  });

  it('treats bare `!lucky` as private status', async () => {
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions, '!lucky');

    expect(updateCalls()).toEqual([]);
    expect(publicMessages(emissions)).toEqual([]);
    expect(whispers(emissions)[0].content).toContain('3/3');
  });

  it('answers `reset` with a private long-rest redirect and no write or broadcast', async () => {
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions, '!lucky reset');

    expect(selectCalls()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('!rest long');
  });
});

describe('strict parsing and caller scoping', () => {
  it.each(['use now', 'usex', 'all', 'use 2'])(
    'rejects malformed subcommand "%s" with zero DB traffic',
    async (rest) => {
      const random = vi.spyOn(Math, 'random');
      mockCharacter(characterRow(), [{ version: 8 }]);
      const emissions: Emission[] = [];

      await run(emissions, `!lucky ${rest}`);

      expect(selectCalls()).toEqual([]);
      expect(updateCalls()).toEqual([]);
      expect(random).not.toHaveBeenCalled();
      expectFailedClosed(emissions);
      expect(whispers(emissions)[0].content).toContain('usage');
    }
  );

  it('refuses when the caller token sits on another map, with zero DB traffic', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.get('lucky-token')!.mapId = 'map-2';
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(selectCalls()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('on this map');
  });

  it('a newer owned token on another map never shadows the viewing-map token', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.set(
      'offmap-token',
      token({
        id: 'offmap-token',
        mapId: 'map-2',
        characterId: 'offmap-character',
        createdAt: '2026-02-01T00:00:00.000Z',
      })
    );
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(selectCalls()[0][1]).toEqual(['lucky-character']);
  });
});

describe('fail-closed Lucky spend', () => {
  it('does not roll or write on an exhausted pool', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(
      characterRow({ features: JSON.stringify([{ ...LUCKY_FEAT, usesRemaining: 0 }]) }),
      [{ version: 8 }]
    );
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('no luck points remaining');
  });

  it('does not overwrite malformed feature data', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow({ features: '{not-json' }), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('feature data is invalid');
  });

  it('fails closed when the character row is missing', async () => {
    mockCharacter(null, [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('character not found');
  });

  it.each([undefined, null, 0, 'not-a-version'])(
    'refuses unusable selected version %s before rolling or writing',
    async (version) => {
      const random = vi.spyOn(Math, 'random');
      mockCharacter(characterRow({ version }), [{ version: 8 }]);
      const emissions: Emission[] = [];

      await run(emissions);

      expect(updateCalls()).toEqual([]);
      expect(random).not.toHaveBeenCalled();
      expectFailedClosed(emissions);
      expect(whispers(emissions)[0].content).toContain('could not verify');
    }
  );

  it('returns only a private failure and no roll when the database write throws', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow(), new Error('database unavailable'));
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toHaveLength(1);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('no luck point was spent');
  });

  it('returns only a private retry and no roll on an optimistic-version conflict', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow(), []);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('changed while processing');
  });

  it('truthfully stops without rolling after a committed write returns an unusable version', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow(), [{ version: null }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toHaveLength(1);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('was spent, but synchronization failed');
  });
});
