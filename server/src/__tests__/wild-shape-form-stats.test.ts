import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Combatant, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery, connect: vi.fn() } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import * as CombatService from '../services/CombatService.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getPlayerBySocketId,
  getRoom,
} from '../utils/roomState.js';
import '../services/chatCommands/xpAndWildShapeHandler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'ws-stats-session';
const DRUID = 'druid-character';

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
    conditions: [],
    ownerUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Token;
}

function seedRoom() {
  const room = createRoom(SESSION, 'WILD', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set(
    'druid-token',
    token('druid-token', { characterId: DRUID, ownerUserId: 'druid-user', name: 'Mielikki' })
  );
  for (const player of [
    ['dm-user', 'dm-1', 'dm', null],
    ['druid-user', 'druid-1', 'player', DRUID],
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

const ACTIVE_WOLF = JSON.stringify({
  formSlug: 'wolf',
  formName: 'Wolf',
  formHp: 11,
  formMaxHp: 11,
  formAc: 13,
  formSpeed: { walk: 40 },
  formCr: 0.25,
  moon: false,
});

const WOLF_ROW = {
  slug: 'wolf',
  name: 'Wolf',
  type: 'Beast',
  armor_class: 13,
  hit_points: 11,
  speed: '{"walk":40}',
  cr_numeric: 0.25,
};

function druidRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Mielikki',
    class: 'Druid',
    level: 2,
    hit_points: 18,
    max_hit_points: 18,
    temp_hit_points: 0,
    armor_class: 16,
    speed: 30,
    features: '[]',
    wild_shape: null,
    version: 5,
    ...overrides,
  };
}

/**
 * Query router: `row` answers every character SELECT (all paths read
 * the full row once, BEFORE the guarded write — there is no post-write
 * re-read by design), `update` the guarded UPDATE.
 * `failPostCommitCharacterRead` recreates the old failure mode: a
 * character re-read after a successful write fails. Correct stat
 * transitions use the guarded pre-write row and never make that read.
 */
function arrange(options: {
  row?: Record<string, unknown> | null;
  beast?: Record<string, unknown> | null;
  update?: Array<Record<string, unknown>> | Error;
  failPostCommitCharacterRead?: boolean;
}) {
  let committed = false;
  mockQuery.mockImplementation(async (sql: string) => {
    if (
      committed &&
      options.failPostCommitCharacterRead &&
      sql.startsWith('SELECT') &&
      sql.includes('FROM characters')
    ) {
      throw new Error('db unavailable after commit');
    }
    if (sql.includes('FROM compendium_monsters')) {
      return { rows: options.beast ? [options.beast] : [] };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM characters')) {
      return { rows: options.row ? [options.row] : [] };
    }
    if (sql.startsWith('UPDATE characters')) {
      if (options.update instanceof Error) throw options.update;
      committed = true;
      return { rows: options.update ?? [{ version: 6 }] };
    }
    return { rows: [] };
  });
}

function seedCombat(
  room: ReturnType<typeof seedRoom>,
  combatantOverrides: Partial<Combatant> = {}
) {
  const combatant: Combatant = {
    tokenId: 'druid-token',
    characterId: DRUID,
    name: 'Mielikki',
    initiative: 15,
    initiativeBonus: 2,
    hp: 18,
    maxHp: 18,
    tempHp: 0,
    armorClass: 16,
    speed: 30,
    isNPC: false,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    exhaustionLevel: 0,
    ...combatantOverrides,
  } as Combatant;
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [combatant],
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  return combatant;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  deleteRoom(SESSION);
  seedRoom();
});

describe('combat hydration of active Wild Shape forms', () => {
  it('starting combat while transformed uses the form AC and walking speed', async () => {
    arrange({ row: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const state = await CombatService.startCombatAsync(SESSION, ['druid-token']);
    const druid = state.combatants.find((c) => c.characterId === DRUID)!;
    expect(druid.armorClass).toBe(13);
    expect(druid.speed).toBe(40);
    // Character pools are untouched by hydration — form HP is separate.
    expect(druid.hp).toBe(18);
  });

  it('an unreadable wild_shape column contributes nothing: baseline stats are used', async () => {
    arrange({ row: druidRow({ wild_shape: '{"formAc":99,' }) });
    const state = await CombatService.startCombatAsync(SESSION, ['druid-token']);
    const druid = state.combatants.find((c) => c.characterId === DRUID)!;
    expect(druid.armorClass).toBe(16);
    expect(druid.speed).toBe(30);
  });

  it('rejoining mid-combat while transformed hydrates form values too', async () => {
    const room = getRoom(SESSION)!;
    seedCombat(room, { tokenId: 'other-token', characterId: null, name: 'Goblin' });
    room.tokens.set(
      'druid-2',
      token('druid-2', { characterId: DRUID, ownerUserId: 'druid-user', name: 'Mielikki' })
    );
    arrange({ row: druidRow({ wild_shape: ACTIVE_WOLF }) });
    const added = await CombatService.addCombatantAsync(SESSION, 'druid-2');
    expect(added?.armorClass).toBe(13);
    expect(added?.speed).toBe(40);
  });

  it('a form without a walking speed moves 0 ft on the grid', async () => {
    const shark = JSON.parse(ACTIVE_WOLF);
    shark.formSpeed = { swim: 40 };
    arrange({ row: druidRow({ wild_shape: JSON.stringify(shark) }) });
    const state = await CombatService.startCombatAsync(SESSION, ['druid-token']);
    expect(state.combatants.find((c) => c.characterId === DRUID)!.speed).toBe(0);
  });
});

describe('transforming and reverting during combat', () => {
  it('!wildshape swaps the live combatant to form AC/speed and extends remaining movement by the cap delta', async () => {
    const room = getRoom(SESSION)!;
    const combatant = seedCombat(room);
    room.actionEconomies.set('druid-token', {
      action: false,
      bonusAction: false,
      movementRemaining: 20,
      movementMax: 30,
      reaction: false,
    });
    arrange({
      row: druidRow(),
      beast: WOLF_ROW,
      failPostCommitCharacterRead: true,
    });
    const emissions: Emission[] = [];
    await tryHandleChatCommand(
      fakeIo(emissions),
      getPlayerBySocketId('druid-1')!,
      '!wildshape wolf'
    );

    expect(combatant.armorClass).toBe(13);
    expect(combatant.speed).toBe(40);
    // PHB "using different speeds": 10 ft already spent stays spent.
    const economy = room.actionEconomies.get('druid-token')!;
    expect(economy.movementRemaining).toBe(30);
    expect(economy.movementMax).toBe(40);

    // Redaction: the DM sync carries real numbers, the bystander's zeroes.
    const syncFor = (socketId: string) =>
      emissions.filter((e) => e.channelId === socketId && e.event === 'combat:state-sync').pop();
    const dmSync = syncFor('dm-1')!.payload as { combatants: Combatant[] };
    expect(dmSync.combatants[0].armorClass).toBe(13);
    expect(dmSync.combatants[0].speed).toBe(40);
    const bystanderSync = syncFor('bystander-1')!.payload as { combatants: Combatant[] };
    expect(bystanderSync.combatants[0].armorClass).toBe(0);
    expect(bystanderSync.combatants[0].speed).toBe(0);
  });

  it('!revert restores the character baseline AC/speed and shrinks the movement budget', async () => {
    const room = getRoom(SESSION)!;
    const combatant = seedCombat(room, { armorClass: 13, speed: 40 });
    room.actionEconomies.set('druid-token', {
      action: false,
      bonusAction: false,
      movementRemaining: 40,
      movementMax: 40,
      reaction: false,
    });
    arrange({
      row: druidRow({ wild_shape: ACTIVE_WOLF }),
      failPostCommitCharacterRead: true,
    });
    const emissions: Emission[] = [];
    await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('druid-1')!, '!revert');

    expect(combatant.armorClass).toBe(16);
    expect(combatant.speed).toBe(30);
    const economy = room.actionEconomies.get('druid-token')!;
    expect(economy.movementRemaining).toBe(30);
    expect(economy.movementMax).toBe(30);
  });
});

describe('damage-forced revert and fail-closed conflicts', () => {
  it('combat damage past the form restores baseline AC/speed atomically with the carryover', async () => {
    const room = getRoom(SESSION)!;
    const combatant = seedCombat(room, { armorClass: 13, speed: 40 });
    arrange({
      row: druidRow({ wild_shape: ACTIVE_WOLF }),
      failPostCommitCharacterRead: true,
    });
    const result = await CombatService.applyDamage(SESSION, 'druid-token', 20);
    // 11 absorbed by the form, 9 carried into the druid.
    expect(result.wildShape).toMatchObject({ ended: true, state: null });
    expect(combatant.hp).toBe(9);
    expect(combatant.armorClass).toBe(16);
    expect(combatant.speed).toBe(30);
  });

  it('a version conflict refuses the damage and leaves form stats untouched', async () => {
    const room = getRoom(SESSION)!;
    const combatant = seedCombat(room, { armorClass: 13, speed: 40 });
    arrange({ row: druidRow({ wild_shape: ACTIVE_WOLF }), update: [] });
    await expect(CombatService.applyDamage(SESSION, 'druid-token', 20)).rejects.toThrow(
      /changed mid-action/
    );
    expect(combatant.hp).toBe(18);
    expect(combatant.armorClass).toBe(13);
    expect(combatant.speed).toBe(40);
  });
});
