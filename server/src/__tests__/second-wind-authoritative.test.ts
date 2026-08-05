import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const SESSION = 'second-wind-session';
const SECOND_WIND: Feature = {
  name: 'Second Wind',
  description: 'Heal',
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

function token(): Token {
  return {
    id: 'fighter-token',
    mapId: 'map-1',
    characterId: 'fighter-character',
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
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'WIND', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('fighter-token', token());
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
    userId: 'fighter-user',
    displayName: 'Fighter',
    socketId: 'fighter-socket-1',
    role: 'player',
    characterId: 'fighter-character',
  });
  addPlayerToRoom(SESSION, {
    userId: 'fighter-user',
    displayName: 'Fighter',
    socketId: 'fighter-socket-2',
    role: 'player',
    characterId: 'fighter-character',
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
    id: 'fighter-character',
    class: 'Fighter 3',
    level: 3,
    hit_points: 10,
    max_hit_points: 30,
    temp_hit_points: 2,
    features: JSON.stringify([SECOND_WIND]),
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
    if (sql.includes('SELECT * FROM characters')) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
}

function updateCalls(): Array<[string, unknown[]]> {
  return mockQuery.mock.calls
    .filter((call) => String(call[0]).startsWith('UPDATE characters'))
    .map((call) => [call[0] as string, call[1] as unknown[]]);
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
  expect(emissionsFor(emissions, 'combat:hp-changed')).toEqual([]);
  expect(emissionsFor(emissions, 'combat:action-used')).toEqual([]);
  expect(publicMessages(emissions)).toEqual([]);
  expect(whispers(emissions)).toHaveLength(1);
}

async function run(emissions: Emission[]): Promise<void> {
  await tryHandleChatCommand(
    fakeIo(emissions),
    getPlayerBySocketId('fighter-socket-1')!,
    '!secondwind'
  );
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

describe('authoritative Second Wind success', () => {
  it('atomically spends the feature and heals with optimistic character versioning', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    const [[sql, params]] = updateCalls();
    expect(sql).toContain('SET hit_points = $1, features = $2');
    expect(sql).toContain('WHERE id = $3 AND version = $4');
    expect(sql).toContain('RETURNING version');
    expect(params[0]).toBe(14);
    expect(params[2]).toBe('fighter-character');
    expect(params[3]).toBe(7);
    const features = JSON.parse(params[1] as string) as Feature[];
    expect(features.find((feature) => feature.name === 'Second Wind')?.usesRemaining).toBe(0);

    const update = emissionsFor(emissions, 'character:updated')[0].payload as {
      changes: Record<string, unknown>;
    };
    expect(update.changes).toMatchObject({ hitPoints: 14, version: 8 });
    expect((update.changes.features as Feature[])[0].usesRemaining).toBe(0);
  });

  it('uses Fighter level rather than total multiclass level', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockCharacter(characterRow({ class: 'Fighter (Champion) 2 / Rogue 3', level: 5 }), [
      { version: 8 },
    ]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()[0][1][0]).toBe(13);
    expect(publicMessages(emissions)[0].content as string).toContain('Fighter level 2');
  });

  it('creates a rest-resettable Second Wind feature for a manual Fighter sheet', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockCharacter(characterRow({ class: 'Fighter', features: '[]' }), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    const features = JSON.parse(updateCalls()[0][1][1] as string) as Feature[];
    expect(features).toContainEqual(
      expect.objectContaining({
        name: 'Second Wind',
        usesTotal: 1,
        usesRemaining: 0,
        resetOn: 'short',
      })
    );
  });

  it('sends exact stats to every DM and owner tab, never the bystander by default', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    const recipients = ['dm-socket-1', 'dm-socket-2', 'fighter-socket-1', 'fighter-socket-2'];
    expect(channelsFor(emissions, 'character:updated')).toEqual(recipients);
    expect(channelsFor(emissions, 'combat:hp-changed')).toEqual(recipients);
    expect(emissions.filter((emission) => emission.channelId === 'bystander-socket')).toEqual([]);
  });

  it('keeps exact current and maximum HP out of public chat and its action card', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    const [message] = publicMessages(emissions);
    expect(message.content).not.toContain('14/30');
    expect(message.content).not.toContain('10 → 14');
    expect(JSON.stringify(message.actionResult)).not.toContain('targetHpBefore');
    expect(JSON.stringify(message.actionResult)).not.toContain('targetHpAfter');
    expect(message.spellResult).toBeNull();
  });

  it('spends the combat bonus action only after the character write commits', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [{ tokenId: 'fighter-token' } as never],
      startedAt: new Date().toISOString(),
    };
    room.actionEconomies.set('fighter-token', {
      action: false,
      bonusAction: false,
      movementRemaining: 30,
      movementMax: 30,
      reaction: false,
    });
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(room.actionEconomies.get('fighter-token')?.bonusAction).toBe(true);
    expect(channelsFor(emissions, 'combat:action-used')).toEqual([
      'dm-socket-1',
      'dm-socket-2',
      'fighter-socket-1',
      'fighter-socket-2',
    ]);
  });
});

describe('fail-closed Second Wind', () => {
  it('does not roll, write, or spend a feature at maximum HP', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow({ hit_points: 30 }), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('maximum HP');
  });

  it('does not roll or write when Second Wind is already spent', async () => {
    const random = vi.spyOn(Math, 'random');
    mockCharacter(
      characterRow({ features: JSON.stringify([{ ...SECOND_WIND, usesRemaining: 0 }]) }),
      [{ version: 8 }]
    );
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('no Second Wind uses remaining');
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

  it('does not roll or write when the combat bonus action is already spent', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [{ tokenId: 'fighter-token' } as never],
      startedAt: new Date().toISOString(),
    };
    room.actionEconomies.set('fighter-token', {
      action: false,
      bonusAction: true,
      movementRemaining: 30,
      movementMax: 30,
      reaction: false,
    });
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('bonus action');
  });

  it('does not roll or write outside the fighter combat turn', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [{ tokenId: 'another-token' } as never],
      startedAt: new Date().toISOString(),
    };
    room.actionEconomies.set('fighter-token', {
      action: false,
      bonusAction: false,
      movementRemaining: 30,
      movementMax: 30,
      reaction: false,
    });
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('only on their turn');
  });

  it('fails closed when the current turn has no action-economy state', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [{ tokenId: 'fighter-token' } as never],
      startedAt: new Date().toISOString(),
    };
    const random = vi.spyOn(Math, 'random');
    mockCharacter(characterRow(), [{ version: 8 }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('action state is unavailable');
  });

  it('returns only a private failure when the database write throws', async () => {
    mockCharacter(characterRow(), new Error('database unavailable'));
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toHaveLength(1);
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('No use was spent');
  });

  it('returns only a private retry on an optimistic-version conflict', async () => {
    mockCharacter(characterRow(), []);
    const emissions: Emission[] = [];

    await run(emissions);

    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('changed while processing');
  });

  it('truthfully stops after a committed write returns an unusable version', async () => {
    mockCharacter(characterRow(), [{ version: null }]);
    const emissions: Emission[] = [];

    await run(emissions);

    expect(updateCalls()).toHaveLength(1);
    expectFailedClosed(emissions);
    expect(whispers(emissions)[0].content).toContain('heal and use were saved');
    expect(whispers(emissions)[0].content).toContain('Refresh');
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
    }
  );
});
