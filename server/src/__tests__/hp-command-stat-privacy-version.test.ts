/**
 * `!damage` / `!heal` / `!hp` / `!thp` / `!setattr` exact-stat privacy
 * and authoritative version propagation.
 *
 * These handlers used to fan out precise HP / sheet payloads through
 * `emitToTokenViewers` (token visibility only) and never carried the
 * post-write `characters.version`. That leaked exact numbers the
 * snapshots redact, and left owners with a stale expectedVersion so
 * their next sheet edit hit a false `character:update-conflict`.
 *
 * Now every exact-stat payload routes through `emitToTokenStatViewers`
 * (DM tabs always, owner tabs always, other players only via the
 * sharing toggles), every successful direct `characters` write uses
 * `UPDATE ... RETURNING version` guarded by integer >= 1, in-combat
 * paths forward `CombatService.applyDamage/applyHeal().version`, and a
 * no-op temp-HP write neither touches the row nor invents a version.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CombatState, Combatant, Token } from '@dnd-vtt/shared';

const {
  mockQuery,
  mockApplyDamageSideEffects,
  mockApplyDamage,
  mockApplyHeal,
  mockPersistSessionCombatState,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockApplyDamageSideEffects: vi.fn(),
  mockApplyDamage: vi.fn(),
  mockApplyHeal: vi.fn(),
  mockPersistSessionCombatState: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../services/damageEffects.js', () => ({
  applyDamageSideEffects: mockApplyDamageSideEffects,
}));
vi.mock('../services/CombatService.js', () => ({
  applyDamage: mockApplyDamage,
  applyHeal: mockApplyHeal,
  persistSessionCombatState: mockPersistSessionCombatState,
}));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
  type RoomState,
} from '../utils/roomState.js';
import '../services/chatCommands/hpHandlers.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function tok(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
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
    ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function combatant(tokenId: string, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId,
    characterId: null,
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 8,
    maxHp: 12,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: true,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

const SESSION = 's-hp-cmd-privacy';

/** DM (two tabs), token owner (two tabs), and a bystander player — all on map-1. */
function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom(SESSION, 'ROOM-HPC', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  for (const t of tokens) room.tokens.set(t.id, t);
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock-2',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-sock',
    role: 'player',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-sock-2',
    role: 'player',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'bystander-user',
    displayName: 'Vex',
    socketId: 'by-sock',
    role: 'player',
    characterId: null,
  });
  return getAllRooms().get(SESSION)!;
}

function activeCombat(combatants: Combatant[]): CombatState {
  return {
    sessionId: SESSION,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants,
    startedAt: new Date().toISOString(),
  };
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((e) => e.event === event)
    .map((e) => e.channelId)
    .sort();
}

function whispersTo(emissions: Emission[], socketId: string): string[] {
  return emissions
    .filter((e) => e.event === 'chat:new-message' && e.channelId === socketId)
    .map((e) => (e.payload as { content?: string }).content ?? '');
}

function characterChanges(emissions: Emission[]): Record<string, unknown> {
  const payload = emissions.find((e) => e.event === 'character:updated')?.payload as
    | { changes?: Record<string, unknown> }
    | undefined;
  expect(payload).toBeDefined();
  return payload!.changes ?? {};
}

/** Mock the SELECT reads used by the direct HP/temp-HP helpers, plus the
 *  `UPDATE ... RETURNING version` write. `versionRow` is what the UPDATE
 *  returns ([] simulates a conflicted/zero-row write). The direct
 *  selected row gets valid defaults so each write path can verify its
 *  optimistic-lock and existing state before changing anything. */
function mockCharacterRow(
  row: Record<string, unknown>,
  versionRow: Array<Record<string, unknown>>
): void {
  const selectedRow = {
    hit_points: 10,
    max_hit_points: 20,
    temp_hit_points: 0,
    armor_class: 12,
    ability_scores: null,
    wild_shape: null,
    version: 1,
    ...row,
  };
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE characters')) {
      return { rows: versionRow };
    }
    if (sql.includes('FROM characters')) {
      return { rows: [selectedRow] };
    }
    return { rows: [] };
  });
}

function updateCalls(fragment: string): string[] {
  return mockQuery.mock.calls
    .map((call) => call[0] as string)
    .filter((sql) => sql.includes(fragment));
}

const DM_TABS = ['dm-sock', 'dm-sock-2'];
const OWNER_TABS = ['owner-sock', 'owner-sock-2'];

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockApplyDamageSideEffects.mockReset();
  mockApplyDamageSideEffects.mockResolvedValue(undefined);
  mockApplyDamage.mockReset();
  mockApplyHeal.mockReset();
  mockPersistSessionCombatState.mockReset();
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('hp command exact-stat scoping', () => {
  it('keeps a hidden NPC !damage exact payload DM-only', async () => {
    seedRoom([tok('goblin', { characterId: 'char-npc', visible: false })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 0, version: 3 }, [
      { version: 4 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!damage 5 goblin');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);
    expect(channelsFor(em, 'character:updated')).toEqual(DM_TABS);
  });

  it('withholds a VISIBLE NPC !damage exact payload from players while creature sharing is off', async () => {
    seedRoom([tok('goblin', { characterId: 'char-npc' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 0, version: 3 }, [
      { version: 4 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!damage 5 goblin');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_TABS);
    expect(channelsFor(em, 'character:updated')).toEqual(DM_TABS);
  });

  it('shares a visible NPC !damage payload with map players when showCreatureStatsToPlayers is on', async () => {
    const room = seedRoom([tok('goblin', { characterId: 'char-npc' })]);
    room.showCreatureStatsToPlayers = true;
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 0, version: 3 }, [
      { version: 4 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!damage 5 goblin');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('delivers an owned PC !heal payload to every DM and owner tab but not bystanders', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 5, max_hit_points: 20, temp_hit_points: 0, version: 5 }, [
      { version: 6 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!heal 5 pc');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual([...DM_TABS, ...OWNER_TABS]);
    expect(channelsFor(em, 'character:updated')).toEqual([...DM_TABS, ...OWNER_TABS]);
  });

  it('includes bystanders for a PC payload only when showPlayersToPlayers is on', async () => {
    const room = seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    room.showPlayersToPlayers = true;
    mockCharacterRow({ hit_points: 5, max_hit_points: 20, temp_hit_points: 0, version: 5 }, [
      { version: 6 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!heal 5 pc');
    expect(channelsFor(em, 'character:updated')).toEqual(['by-sock', ...DM_TABS, ...OWNER_TABS]);
  });

  it('scopes !setattr sheet edits on a hidden NPC to DM tabs only', async () => {
    seedRoom([tok('goblin', { characterId: 'char-npc', visible: false })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 0 }, [{ version: 9 }]);
    const em: Emission[] = [];
    await tryHandleChatCommand(
      fakeIo(em),
      getPlayerBySocketId('dm-sock')!,
      '!setattr goblin ac 15'
    );
    expect(channelsFor(em, 'character:updated')).toEqual(DM_TABS);
    expect(characterChanges(em)).toEqual({ armorClass: 15, version: 9 });
  });
});

describe('hp command version propagation', () => {
  it('carries the RETURNING version on an out-of-combat !damage character update', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 2, version: 6 }, [
      { version: 7 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 4 pc');
    expect(updateCalls('RETURNING version').length).toBe(1);
    // Temp HP soaks first: 2 temp absorb, the remaining 2 hit base HP.
    expect(characterChanges(em)).toEqual({ hitPoints: 8, tempHitPoints: 0, version: 7 });
  });

  it('fails closed (whisper, no fanout) when the !damage UPDATE returns no valid version', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 0, version: 6 }, [
      { version: 0 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 4 pc');
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(channelsFor(em, 'combat:hp-changed')).toEqual([]);
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/changed mid-action/);
  });

  it('fails closed when the !heal UPDATE returns no row at all (version conflict)', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 0, version: 6 }, []);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!heal 4 pc');
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(channelsFor(em, 'combat:hp-changed')).toEqual([]);
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/changed mid-action/);
  });

  it('forwards CombatService.applyDamage().version on the in-combat !damage path', async () => {
    const room = seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    room.combatState = activeCombat([combatant('pc', { characterId: 'char-pc', isNPC: false })]);
    mockApplyDamage.mockResolvedValue({
      hp: 3,
      tempHp: 0,
      change: -5,
      characterId: 'char-pc',
      version: 12,
    });
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 5 pc');
    expect(mockApplyDamage).toHaveBeenCalledWith(SESSION, 'pc', 5);
    expect(characterChanges(em)).toEqual({ hitPoints: 3, tempHitPoints: 0, version: 12 });
  });

  it('forwards CombatService.applyHeal().version on the in-combat signed !hp path', async () => {
    const room = seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    room.combatState = activeCombat([combatant('pc', { characterId: 'char-pc', isNPC: false })]);
    mockApplyHeal.mockResolvedValue({
      hp: 10,
      tempHp: 0,
      change: 2,
      characterId: 'char-pc',
      version: 13,
    });
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp +2 pc');
    expect(mockApplyHeal).toHaveBeenCalledWith(SESSION, 'pc', 2);
    expect(characterChanges(em)).toEqual({ hitPoints: 10, tempHitPoints: 0, version: 13 });
  });

  it('omits version when CombatService returns none (no backing character write)', async () => {
    const room = seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    room.combatState = activeCombat([combatant('pc', { characterId: 'char-pc', isNPC: false })]);
    mockApplyDamage.mockResolvedValue({ hp: 3, tempHp: 0, change: -5, characterId: 'char-pc' });
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 5 pc');
    const changes = characterChanges(em);
    expect('version' in changes).toBe(false);
  });

  it('carries the RETURNING version on an absolute out-of-combat !hp set', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 1 }, [{ version: 21 }]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp 15 pc');
    expect(characterChanges(em)).toEqual({ hitPoints: 15, tempHitPoints: 1, version: 21 });
  });

  it('carries the RETURNING version on a !setattr ability write', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE characters')) return { rows: [{ version: 30 }] };
      if (sql.includes('ability_scores')) {
        return {
          rows: [
            {
              ability_scores: '{"str":14}',
              hit_points: 10,
              max_hit_points: 20,
              armor_class: 12,
              wild_shape: null,
              version: 29,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!setattr pc str 18');
    const changes = characterChanges(em);
    expect(changes.version).toBe(30);
    expect((changes.abilityScores as Record<string, number>).str).toBe(18);
  });
});

describe('!thp no-op behavior', () => {
  it('does not UPDATE or invent a version when the out-of-combat request keeps the higher existing temp HP', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 5 }, [{ version: 99 }]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!thp 3 pc');
    expect(updateCalls('UPDATE characters').length).toBe(0);
    const changes = characterChanges(em);
    expect(changes.tempHitPoints).toBe(5);
    expect('version' in changes).toBe(false);
  });

  it('writes with RETURNING version when the out-of-combat temp HP actually replaces', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 2 }, [{ version: 8 }]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!thp 6 pc');
    expect(
      updateCalls('temp_hit_points = $1 WHERE id = $2 AND version = $3 RETURNING version').length
    ).toBe(1);
    expect(characterChanges(em)).toEqual({ hitPoints: 10, tempHitPoints: 6, version: 8 });
  });

  it('does not UPDATE or invent a version for an in-combat temp HP no-op', async () => {
    const room = seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    room.combatState = activeCombat([
      combatant('pc', { characterId: 'char-pc', isNPC: false, tempHp: 5 }),
    ]);
    mockCharacterRow({ hit_points: 8, temp_hit_points: 5, version: 10 }, [{ version: 99 }]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!thp 3 pc');
    expect(updateCalls('UPDATE characters').length).toBe(0);
    const changes = characterChanges(em);
    expect(changes.tempHitPoints).toBe(5);
    expect('version' in changes).toBe(false);
    expect(room.combatState!.combatants[0].tempHp).toBe(5);
  });

  it('persists and forwards the version for an in-combat temp HP replace', async () => {
    const room = seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    room.combatState = activeCombat([
      combatant('pc', { characterId: 'char-pc', isNPC: false, tempHp: 2, hp: 9 }),
    ]);
    mockCharacterRow({ hit_points: 9, temp_hit_points: 2, version: 10 }, [{ version: 11 }]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!thp 6 pc');
    expect(
      updateCalls('temp_hit_points = $1 WHERE id = $2 AND version = $3 RETURNING version').length
    ).toBe(1);
    expect(characterChanges(em)).toEqual({ hitPoints: 9, tempHitPoints: 6, version: 11 });
    expect(room.combatState!.combatants[0].tempHp).toBe(6);
    expect(mockPersistSessionCombatState).toHaveBeenCalledWith(SESSION);
  });

  it('leaves combat state and clients untouched when an in-combat temp HP write conflicts', async () => {
    const room = seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    room.combatState = activeCombat([
      combatant('pc', { characterId: 'char-pc', isNPC: false, tempHp: 2, hp: 9 }),
    ]);
    mockCharacterRow({ hit_points: 9, temp_hit_points: 2, version: 10 }, []);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!thp 6 pc');
    expect(room.combatState!.combatants[0].tempHp).toBe(2);
    expect(channelsFor(em, 'combat:hp-changed')).toEqual([]);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(mockPersistSessionCombatState).not.toHaveBeenCalled();
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/changed mid-action/);
  });
});

describe('direct character mutation authority', () => {
  it('optimistically locks an absolute !hp write with the selected version', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 1, version: 6 }, [
      { version: 7 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp 15 pc');
    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('SET hit_points = $1 WHERE id = $2 AND version = $3')
    );
    expect(update?.[1]).toEqual([15, 'char-pc', 6]);
    expect(characterChanges(em)).toEqual({ hitPoints: 15, tempHitPoints: 1, version: 7 });
  });

  it('fails an absolute !hp conflict without a stat fanout', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 1, version: 6 }, []);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp 15 pc');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual([]);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/changed mid-action/);
  });

  it('does not update an absolute !hp no-op and emits the selected version', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 1, version: 6 }, []);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp 10 pc');
    expect(updateCalls('UPDATE characters').length).toBe(0);
    expect(characterChanges(em)).toEqual({ hitPoints: 10, tempHitPoints: 1, version: 6 });
  });

  it('rejects malformed numeric command values before querying', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp 12junk pc');
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!thp 6junk pc');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/value must be a number|usage/);
  });

  it('fails closed when the selected character version is missing', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 10, max_hit_points: 20, temp_hit_points: 1, version: null }, [
      { version: 7 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp 15 pc');
    expect(updateCalls('UPDATE characters').length).toBe(0);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/could not verify/);
  });

  it('atomically clamps current HP when !setattr lowers max HP', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ hit_points: 18, max_hit_points: 20, temp_hit_points: 0, version: 8 }, [
      { version: 9, hit_points: 12 },
    ]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!setattr pc maxhp 12');
    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('SET max_hit_points = $1, hit_points = LEAST(hit_points, $1)')
    );
    expect(update?.[1]).toEqual([12, 'char-pc', 8]);
    expect(characterChanges(em)).toEqual({ hitPoints: 12, maxHitPoints: 12, version: 9 });
  });

  it('blocks !setattr hp while the target is wild-shaped', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow(
      {
        hit_points: 10,
        max_hit_points: 20,
        version: 8,
        wild_shape: JSON.stringify({
          formSlug: 'wolf',
          formName: 'Wolf',
          formHp: 11,
          formMaxHp: 11,
          formAc: 13,
          formSpeed: { walk: 40 },
          formCr: 0.25,
          moon: false,
        }),
      },
      [{ version: 9 }]
    );
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!setattr pc hp 5');
    expect(updateCalls('UPDATE characters').length).toBe(0);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(whispersTo(em, 'dm-sock').join(' ')).toMatch(/wild-shaped/);
  });

  it('fails malformed stored ability scores without overwriting them', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ ability_scores: '{bad-json', version: 8 }, [{ version: 9 }]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!setattr pc str 18');
    expect(updateCalls('UPDATE characters').length).toBe(0);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(whispersTo(em, 'dm-sock').join(' ')).toMatch(/unreadable/);
  });

  it('fails a !setattr version conflict without broadcasting stale sheet data', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ armor_class: 12, version: 8 }, []);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!setattr pc ac 15');
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(whispersTo(em, 'dm-sock').join(' ')).toMatch(/changed mid-action/);
  });

  it('does not write a !setattr no-op and keeps the selected version', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' })]);
    mockCharacterRow({ armor_class: 12, version: 8 }, []);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!setattr pc ac 12');
    expect(updateCalls('UPDATE characters').length).toBe(0);
    expect(characterChanges(em)).toEqual({ armorClass: 12, version: 8 });
  });
});
