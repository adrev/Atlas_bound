import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import type { Combatant, CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery, mockClientQuery, mockConnect, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockRelease: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({
  default: {
    query: mockQuery,
    connect: mockConnect,
  },
}));

import { registerCombatHp } from '../socket/combat/hpEvents.js';
import { registerCharacterEvents } from '../socket/characterEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';
import * as DiceService from '../services/DiceService.js';
import * as DiscordService from '../services/DiscordService.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function fakeIo(emissions: Emission[]): Server {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as unknown as Server;
}

function fakeSocket(socketId: string) {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const socketEmissions: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    id: socketId,
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(event, handler);
      return socket;
    },
    emit: (event: string, payload: unknown) => {
      socketEmissions.push({ event, payload });
      return true;
    },
  } as unknown as Socket;
  return { socket, handlers, socketEmissions };
}

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: 'char-1',
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    conditions: [],
    ownerUserId: 'player-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function combatant(tokenId: string, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId,
    characterId: 'char-1',
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 10,
    maxHp: 12,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: false,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

function seedCombatRoom(sessionId: string, combatantOverrides: Partial<Combatant> = {}) {
  const room = createRoom(sessionId, 'VERS', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  const pcToken = token('pc-token');
  room.tokens.set(pcToken.id, pcToken);
  const state: CombatState = {
    sessionId,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [combatant(pcToken.id, combatantOverrides)],
    startedAt: new Date().toISOString(),
  };
  room.combatState = state;
  addPlayerToRoom(sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(sessionId, {
    userId: 'player-user',
    displayName: 'Pip',
    socketId: 'player-sock',
    role: 'player',
    characterId: 'char-1',
  });
  return { room, pcToken };
}

function characterUpdatePayload(emissions: Emission[]) {
  return emissions.find((e) => e.event === 'character:updated')?.payload as
    | { characterId?: string; changes?: Record<string, unknown> }
    | undefined;
}

function characterHpAuthorityResult(sql: string, version: number) {
  if (!sql.includes('SELECT wild_shape, version') || !sql.includes('FROM characters')) {
    return undefined;
  }
  return {
    rows: [
      {
        wild_shape: null,
        version,
        armor_class: 12,
        speed: 30,
        dndbeyond_id: null,
        ability_scores: {},
        inventory: [],
        class: 'Fighter',
        features: [],
      },
    ],
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockConnect.mockReset();
  mockRelease.mockReset();
  mockQuery.mockImplementation(
    async (sql: string) => characterHpAuthorityResult(sql, 4) ?? { rows: [] }
  );
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('combat HP version propagation', () => {
  it('includes the RETURNING version in the damage character:updated fanout', async () => {
    seedCombatRoom('vers-damage-session');
    mockQuery.mockImplementation(async (sql: string) => {
      const authority = characterHpAuthorityResult(sql, 6);
      if (authority) return authority;
      if (String(sql).includes('UPDATE characters SET hit_points')) {
        expect(String(sql)).toContain('RETURNING version');
        expect(String(sql)).toContain('AND version = $5');
        return { rows: [{ version: 7 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:damage')?.({ tokenId: 'pc-token', amount: 3 });

    const update = characterUpdatePayload(emissions);
    expect(update?.characterId).toBe('char-1');
    expect(update?.changes?.hitPoints).toBe(7);
    expect(update?.changes?.version).toBe(7);
    // No concentration cleanup happened, so no extra re-read is needed.
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('SELECT version FROM characters'))
    ).toBe(false);
  });

  it('exposes the FINAL version after concentration cleanup when damage drops a PC to 0', async () => {
    seedCombatRoom('vers-conc-session', { hp: 3 });
    mockQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      const authority = characterHpAuthorityResult(text, 6);
      if (authority) return authority;
      if (text.includes('UPDATE characters SET hit_points')) {
        // HP persist bumps the trigger to 7...
        return { rows: [{ version: 7 }] };
      }
      if (text.includes('SELECT version FROM characters')) {
        // ...then the concentration cleanup UPDATE bumps it again to 8.
        return { rows: [{ version: 8 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:damage')?.({ tokenId: 'pc-token', amount: 5 });

    const update = characterUpdatePayload(emissions);
    expect(update?.characterId).toBe('char-1');
    expect(update?.changes?.hitPoints).toBe(0);
    expect(update?.changes?.concentratingOn).toBeNull();
    // The fanout must carry the post-cleanup version, not the
    // intermediate one from the HP write.
    expect(update?.changes?.version).toBe(8);
    // The re-read runs only after the concentration write settled.
    const sqlLog = mockQuery.mock.calls.map(([sql]) => String(sql));
    const concentrationIdx = sqlLog.findIndex((sql) => sql.includes('concentrating_on = NULL'));
    const reReadIdx = sqlLog.findIndex((sql) => sql.includes('SELECT version FROM characters'));
    expect(concentrationIdx).toBeGreaterThanOrEqual(0);
    expect(reReadIdx).toBeGreaterThan(concentrationIdx);
  });

  it('includes the RETURNING version in the heal character:updated fanout', async () => {
    seedCombatRoom('vers-heal-session', { hp: 2 });
    mockQuery.mockImplementation(async (sql: string) => {
      const authority = characterHpAuthorityResult(sql, 4);
      if (authority) return authority;
      if (String(sql).includes('UPDATE characters SET hit_points')) {
        expect(String(sql)).toContain('RETURNING version');
        expect(String(sql)).toContain('AND version = $4');
        return { rows: [{ version: 5 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:heal')?.({ tokenId: 'pc-token', amount: 4 });

    const update = characterUpdatePayload(emissions);
    expect(update?.characterId).toBe('char-1');
    expect(update?.changes?.hitPoints).toBe(6);
    expect(update?.changes?.version).toBe(5);
  });

  it('fails closed before damage when the authoritative character row is missing', async () => {
    const { room } = seedCombatRoom('vers-missing-session', { hp: 8 });
    mockQuery.mockResolvedValue({ rows: [] });
    const emissions: Emission[] = [];
    const { socket, handlers, socketEmissions } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:damage')?.({ tokenId: 'pc-token', amount: 2 });

    expect(characterUpdatePayload(emissions)).toBeUndefined();
    expect(emissions.some((entry) => entry.event === 'combat:hp-changed')).toBe(false);
    expect(room.combatState?.combatants[0].hp).toBe(8);
    expect(socketEmissions).toContainEqual({
      event: 'session:error',
      payload: {
        message: 'Character state is unavailable — nothing was changed. Refresh and retry.',
      },
    });
  });

  it('rolls back live damage state when the guarded write returns no valid version', async () => {
    const { room } = seedCombatRoom('vers-null-session', { hp: 8 });
    mockQuery.mockImplementation(async (sql: string) => {
      const authority = characterHpAuthorityResult(sql, 4);
      if (authority) return authority;
      if (String(sql).includes('UPDATE characters SET hit_points')) {
        return { rows: [{ version: null }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers, socketEmissions } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:damage')?.({ tokenId: 'pc-token', amount: 2 });

    expect(characterUpdatePayload(emissions)).toBeUndefined();
    expect(emissions.some((entry) => entry.event === 'combat:hp-changed')).toBe(false);
    expect(room.combatState?.combatants[0].hp).toBe(8);
    expect(socketEmissions).toContainEqual({
      event: 'session:error',
      payload: { message: 'Damage was not applied: the character changed mid-action. Retry.' },
    });
  });
});

describe('death-save version propagation', () => {
  it('persists an ordinary death-save result and fans out its authoritative version', async () => {
    seedCombatRoom('vers-death-failure', {
      hp: 0,
      deathSaves: { successes: 0, failures: 0 },
    });
    vi.spyOn(DiceService, 'rollDeathSave').mockReturnValue({
      roll: 5,
      isSuccess: false,
      isCritSuccess: false,
      isCritFail: false,
    });
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('UPDATE characters SET death_saves')) {
        expect(String(sql)).toContain('RETURNING version');
        return { rows: [{ version: 9 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:death-save')?.({ tokenId: 'pc-token' });

    const update = characterUpdatePayload(emissions);
    expect(update?.changes?.deathSaves).toEqual({ successes: 0, failures: 1 });
    expect(update?.changes?.version).toBe(9);
  });

  it('broadcasts the HP and version returned by a natural-20 death-save heal', async () => {
    seedCombatRoom('vers-death-nat20', {
      hp: 0,
      deathSaves: { successes: 1, failures: 1 },
    });
    vi.spyOn(DiceService, 'rollDeathSave').mockReturnValue({
      roll: 20,
      isSuccess: true,
      isCritSuccess: true,
      isCritFail: false,
    });
    vi.spyOn(DiscordService, 'notifySession').mockResolvedValue(undefined);
    mockQuery.mockImplementation(async (sql: string) => {
      const authority = characterHpAuthorityResult(sql, 9);
      if (authority) return authority;
      if (String(sql).includes('UPDATE characters SET hit_points')) {
        return { rows: [{ version: 10 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:death-save')?.({ tokenId: 'pc-token' });

    const hpChange = emissions.find((entry) => entry.event === 'combat:hp-changed')?.payload as
      | Record<string, unknown>
      | undefined;
    expect(hpChange).toMatchObject({ tokenId: 'pc-token', hp: 1, type: 'heal' });
    const update = characterUpdatePayload(emissions);
    expect(update?.changes).toMatchObject({
      hitPoints: 1,
      tempHitPoints: 0,
      deathSaves: { successes: 0, failures: 0 },
      version: 10,
    });
  });

  it('awaits the stable write and emits its version on a third success', async () => {
    const { pcToken } = seedCombatRoom('vers-death-stable', {
      hp: 0,
      deathSaves: { successes: 2, failures: 0 },
    });
    pcToken.conditions = ['unconscious'] as never;
    vi.spyOn(DiceService, 'rollDeathSave').mockReturnValue({
      roll: 12,
      isSuccess: true,
      isCritSuccess: false,
      isCritFail: false,
    });
    mockQuery.mockImplementation(async (sql: string) => {
      const authority = characterHpAuthorityResult(sql, 10);
      if (authority) return authority;
      if (String(sql).includes('UPDATE characters SET hit_points = 0')) {
        expect(String(sql)).toContain('RETURNING version');
        return { rows: [{ version: 11 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:death-save')?.({ tokenId: 'pc-token' });

    const update = characterUpdatePayload(emissions);
    expect(update?.changes?.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(update?.changes?.version).toBe(11);
    expect(pcToken.conditions).toContain('stable');
  });

  it('omits an invalid version while still syncing death-save counters', async () => {
    seedCombatRoom('vers-death-invalid', {
      hp: 0,
      deathSaves: { successes: 0, failures: 0 },
    });
    vi.spyOn(DiceService, 'rollDeathSave').mockReturnValue({
      roll: 15,
      isSuccess: true,
      isCritSuccess: false,
      isCritFail: false,
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:death-save')?.({ tokenId: 'pc-token' });

    const update = characterUpdatePayload(emissions);
    expect(update?.changes?.deathSaves).toEqual({ successes: 1, failures: 0 });
    expect(update?.changes).not.toHaveProperty('version');
  });
});

describe('rest-resource version propagation', () => {
  function seedRestRoom(sessionId: string) {
    const room = createRoom(sessionId, 'REST', 'dm-user');
    addPlayerToRoom(sessionId, {
      userId: 'player-1',
      displayName: 'Player',
      socketId: 'sock-player',
      role: 'player',
      characterId: 'char-1',
    });
    return room;
  }

  it('long rest fanout carries the post-write version alongside the updates', async () => {
    seedRestRoom('vers-long-rest');
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT * FROM characters')) {
        return {
          rows: [
            {
              id: 'char-1',
              name: 'Rook',
              user_id: 'player-1',
              class: 'Fighter',
              hit_points: 4,
              max_hit_points: 20,
              temp_hit_points: 0,
              spell_slots: {},
              features: [],
              hit_dice: [],
              death_saves: { successes: 0, failures: 0 },
              concentrating_on: null,
              exhaustion_level: 0,
            },
          ],
        };
      }
      if (String(sql).includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('UPDATE characters')) {
        expect(String(sql)).toContain('RETURNING version');
        return { rows: [{ version: 12 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers, socketEmissions } = fakeSocket('sock-player');
    registerCharacterEvents(fakeIo(emissions), socket);

    await handlers.get('character:rest')?.({ characterId: 'char-1', kind: 'long' });

    const update = characterUpdatePayload(emissions);
    expect(update?.characterId).toBe('char-1');
    expect(update?.changes?.hitPoints).toBe(20);
    expect(update?.changes?.version).toBe(12);
    // The requester echo stays a pure rest summary — no version leak
    // into the toast payload.
    const rested = socketEmissions.find((e) => e.event === 'character:rested')?.payload as {
      updates?: Record<string, unknown>;
    };
    expect(rested.updates).not.toHaveProperty('version');
  });

  it('short rest fanout carries the post-write version for warlock slot recovery', async () => {
    seedRestRoom('vers-short-rest');
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT * FROM characters')) {
        return {
          rows: [
            {
              id: 'char-1',
              name: 'Hex',
              user_id: 'player-1',
              class: 'Warlock',
              hit_points: 10,
              max_hit_points: 10,
              temp_hit_points: 0,
              spell_slots: { '2': { max: 2, used: 2 } },
              features: [],
              hit_dice: [],
              death_saves: { successes: 0, failures: 0 },
              concentrating_on: null,
              exhaustion_level: 0,
            },
          ],
        };
      }
      if (String(sql).includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('UPDATE characters')) return { rows: [{ version: 3 }] };
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('sock-player');
    registerCharacterEvents(fakeIo(emissions), socket);

    await handlers.get('character:rest')?.({ characterId: 'char-1', kind: 'short' });

    const update = characterUpdatePayload(emissions);
    expect(update?.characterId).toBe('char-1');
    expect(update?.changes?.spellSlots).toEqual({ '2': { max: 2, used: 0 } });
    expect(update?.changes?.version).toBe(3);
  });

  it('spend-hit-die fanout carries the post-write version', async () => {
    seedRestRoom('vers-hit-die');
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT * FROM characters')) {
        return {
          rows: [
            {
              id: 'char-1',
              name: 'Rook',
              user_id: 'player-1',
              class: 'Fighter',
              hit_points: 5,
              max_hit_points: 20,
              ability_scores: { con: 14 },
              hit_dice: [{ dieSize: 10, total: 2, used: 0 }],
            },
          ],
        };
      }
      if (String(sql).startsWith('UPDATE characters')) {
        expect(String(sql)).toContain('RETURNING version');
        return { rows: [{ version: 6 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers, socketEmissions } = fakeSocket('sock-player');
    registerCharacterEvents(fakeIo(emissions), socket);

    const originalRandom = Math.random;
    Math.random = () => 0.4; // d10 roll = 5
    try {
      await handlers.get('character:spend-hit-die')?.({ characterId: 'char-1', dieSize: 10 });
    } finally {
      Math.random = originalRandom;
    }

    const update = characterUpdatePayload(emissions);
    expect(update?.characterId).toBe('char-1');
    expect(update?.changes?.hitPoints).toBe(12);
    expect(update?.changes?.version).toBe(6);
    const spent = socketEmissions.find((e) => e.event === 'character:hit-die-spent')?.payload as {
      updates?: Record<string, unknown>;
    };
    expect(spent.updates).not.toHaveProperty('version');
  });

  it('spell-slot-adjust fanout carries the post-write version', async () => {
    seedRestRoom('vers-spell-slot');
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT * FROM characters')) {
        return {
          rows: [
            {
              id: 'char-1',
              name: 'Rook',
              user_id: 'player-1',
              spell_slots: { '1': { max: 2, used: 0 } },
            },
          ],
        };
      }
      if (String(sql).startsWith('UPDATE characters')) {
        expect(String(sql)).toContain('RETURNING version');
        return { rows: [{ version: 9 }] };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers, socketEmissions } = fakeSocket('sock-player');
    registerCharacterEvents(fakeIo(emissions), socket);

    await handlers.get('character:spell-slot-adjust')?.({
      characterId: 'char-1',
      level: 1,
      delta: 1,
    });

    const update = characterUpdatePayload(emissions);
    expect(update?.characterId).toBe('char-1');
    expect(update?.changes?.spellSlots).toEqual({ '1': { max: 2, used: 1 } });
    expect(update?.changes?.version).toBe(9);
    const adjusted = socketEmissions.find((e) => e.event === 'character:spell-slot-adjusted')
      ?.payload as { updates?: Record<string, unknown> };
    expect(adjusted.updates).not.toHaveProperty('version');
  });

  it('never propagates a null rest-write version row as version 0', async () => {
    seedRestRoom('vers-null-rest');
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            class: 'Fighter',
            hit_points: 4,
            max_hit_points: 20,
            temp_hit_points: 0,
            spell_slots: {},
            features: [],
            hit_dice: [],
            death_saves: { successes: 0, failures: 0 },
            concentrating_on: null,
            exhaustion_level: 0,
          }],
        };
      }
      if (String(sql).includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('UPDATE characters')) return { rows: [{ version: null }] };
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('sock-player');
    registerCharacterEvents(fakeIo(emissions), socket);

    await handlers.get('character:rest')?.({ characterId: 'char-1', kind: 'long' });

    const update = characterUpdatePayload(emissions);
    expect(update?.changes?.hitPoints).toBe(20);
    expect(update?.changes).not.toHaveProperty('version');
  });

  it('no-op spell-slot adjust neither writes nor fans out a version', async () => {
    seedRestRoom('vers-noop-slot');
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM session_players')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT * FROM characters')) {
        return {
          rows: [
            {
              id: 'char-1',
              name: 'Rook',
              user_id: 'player-1',
              spell_slots: { '1': { max: 1, used: 1 } },
            },
          ],
        };
      }
      return { rows: [] };
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('sock-player');
    registerCharacterEvents(fakeIo(emissions), socket);

    await handlers.get('character:spell-slot-adjust')?.({
      characterId: 'char-1',
      level: 1,
      delta: 1,
    });

    expect(emissions.some((e) => e.event === 'character:updated')).toBe(false);
    expect(
      mockClientQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE characters'))
    ).toBe(false);
  });
});
