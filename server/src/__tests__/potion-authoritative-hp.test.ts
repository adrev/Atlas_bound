/**
 * `!potion` authoritative healing-potion HP mutation.
 *
 * The handler used to accept arbitrary dice notation (`999999d999999`
 * rolled in a loop before any validation), write HP with a
 * fire-and-forget UPDATE (`.catch(console.warn)`) and then fan out the
 * new value and announce success even when the write failed, guarded
 * nothing against concurrent sheet edits, and printed the target's
 * exact before/after/max HP into room-wide chat.
 *
 * Now the dice input is bounded to the four official potion formulas
 * (2d4+2 / 4d4+4 / 8d4+8 / 10d4+20) and any other dice-looking arg is
 * rejected before rolling or querying. The HP write is optimistic
 * (`UPDATE ... WHERE version = <selected> RETURNING version`) and fails
 * closed: a DB error, zero-row conflict, unusable selected version,
 * missing or full-HP target, or invalid command produces only a
 * private whisper — no exact-stat fanout, no public success
 * announcement. A committed write whose RETURNING version is unusable
 * whispers the truth (healing applied, synchronization failed, refresh
 * before retrying) and stops. Exact HP travels only through the
 * dispatcher's stat-scoped wrapper (every DM tab + the target owner's
 * tabs, widened only by the sharing toggles); the public flavor line
 * carries the formula and rolled healing but never sheet totals. Ally
 * administration by name still works, and nothing ever claims a potion
 * was removed from inventory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

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
import '../services/chatCommands/utilityHandlers.js';

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
  } as Token;
}

const SESSION = 's-potion-hp';

/**
 * DM (two tabs), owner (two tabs), and a bystander player. The owner
 * has a PC token; the bystander owns a second PC ("Mira") so ally
 * administration and per-owner stat scoping can both be asserted.
 */
function seedRoom() {
  const room = createRoom(SESSION, 'ROOM-POTION', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set(
    'hero',
    tok('hero', { characterId: 'char-1', ownerUserId: 'owner-user', name: 'Hero' })
  );
  room.tokens.set(
    'ally',
    tok('ally', { characterId: 'char-2', ownerUserId: 'bystander-user', name: 'Mira' })
  );
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
    characterId: 'char-1',
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-sock-2',
    role: 'player',
    characterId: 'char-1',
  });
  addPlayerToRoom(SESSION, {
    userId: 'bystander-user',
    displayName: 'Vex',
    socketId: 'by-sock',
    role: 'player',
    characterId: 'char-2',
  });
  return getAllRooms().get(SESSION)!;
}

function hpRow(version: unknown, overrides: Record<string, unknown> = {}) {
  return {
    hit_points: 19,
    max_hit_points: 37,
    temp_hit_points: 0,
    name: 'Hero',
    version,
    ...overrides,
  };
}

/** Mock the SELECT (hp/max/temp/name/version) and the guarded UPDATE. */
function mockCharacter(
  row: Record<string, unknown> | null,
  updateResult: Array<Record<string, unknown>> | Error
): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE characters')) {
      if (updateResult instanceof Error) throw updateResult;
      return { rows: updateResult };
    }
    if (
      sql.includes(
        'SELECT hit_points, max_hit_points, temp_hit_points, name, version FROM characters'
      )
    ) {
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });
}

function updateCalls(): Array<[string, unknown[]]> {
  return mockQuery.mock.calls
    .filter((call) => (call[0] as string).startsWith('UPDATE characters'))
    .map((call) => [call[0] as string, call[1] as unknown[]]);
}

function characterSelects(): unknown[][] {
  return mockQuery.mock.calls.filter((call) => (call[0] as string).includes('FROM characters'));
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((e) => e.event === event)
    .map((e) => e.channelId)
    .sort();
}

function whispers(emissions: Emission[]): Array<{ channelId: string; content: string }> {
  return emissions
    .filter(
      (e) => e.event === 'chat:new-message' && (e.payload as { type?: string }).type === 'whisper'
    )
    .map((e) => ({ channelId: e.channelId, content: (e.payload as { content: string }).content }));
}

function systemBroadcasts(emissions: Emission[]): Array<{ channelId: string; content: string }> {
  return emissions
    .filter(
      (e) => e.event === 'chat:new-message' && (e.payload as { type?: string }).type === 'system'
    )
    .map((e) => ({ channelId: e.channelId, content: (e.payload as { content: string }).content }));
}

function characterUpdatePayload(emissions: Emission[]): {
  characterId: string;
  changes: Record<string, unknown>;
} {
  const payload = emissions.find((e) => e.event === 'character:updated')?.payload;
  expect(payload).toBeDefined();
  return payload as { characterId: string; changes: Record<string, unknown> };
}

/** A failed/refused potion must leave zero success surface anywhere. */
function expectFailedClosed(em: Emission[]): void {
  expect(channelsFor(em, 'character:updated')).toEqual([]);
  expect(channelsFor(em, 'combat:hp-changed')).toEqual([]);
  expect(systemBroadcasts(em)).toEqual([]);
  expect(whispers(em)).toHaveLength(1);
}

const DM_AND_OWNER_TABS = ['dm-sock', 'dm-sock-2', 'owner-sock', 'owner-sock-2'];

let randomSpy: ReturnType<typeof vi.spyOn>;

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-sock')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  // Every d4 rolls a 3: 2d4+2=8, 4d4+4=16, 8d4+8=32, 10d4+20=50.
  randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

afterEach(() => {
  randomSpy.mockRestore();
});

describe('success path', () => {
  it('writes HP with a version-guarded UPDATE and forwards the RETURNING version', async () => {
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    const [[sql, params]] = updateCalls();
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params).toEqual([27, 'char-1', 7]);
    const { characterId, changes } = characterUpdatePayload(em);
    expect(characterId).toBe('char-1');
    expect(changes).toEqual({ hitPoints: 27, version: 8 });
    const hpChanged = em.find((e) => e.event === 'combat:hp-changed')?.payload;
    expect(hpChanged).toEqual({ tokenId: 'hero', hp: 27, tempHp: 0, change: 8, type: 'heal' });
    const sys = systemBroadcasts(em);
    expect(sys).toHaveLength(1);
    expect(sys[0].content).toContain('Potion of Healing (2d4+2)');
    expect(sys[0].content).toContain('**8** healing');
  });

  it('caps healing at max HP without leaking the cap into public chat', async () => {
    mockCharacter(hpRow(7, { hit_points: 35 }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    const [[, params]] = updateCalls();
    expect(params[0]).toBe(37);
    const hpChanged = em.find((e) => e.event === 'combat:hp-changed')?.payload as {
      change: number;
    };
    expect(hpChanged.change).toBe(2);
    const sys = systemBroadcasts(em);
    expect(sys[0].content).toContain('**8** healing');
    expect(sys[0].content).not.toContain('35');
    expect(sys[0].content).not.toContain('37');
  });

  it('keeps exact HP totals out of the public announcement', async () => {
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    const sys = systemBroadcasts(em);
    expect(sys).toHaveLength(1);
    expect(sys[0].channelId).toBe(SESSION);
    expect(sys[0].content).not.toContain('19'); // before
    expect(sys[0].content).not.toContain('27'); // after
    expect(sys[0].content).not.toContain('37'); // max
    expect(sys[0].content).not.toMatch(/\d+\s*\/\s*\d+/); // no cur/max form
    expect(sys[0].content).not.toMatch(/hp/i);
  });

  it('scopes exact HP to every DM and owner tab, never the bystander or the room channel', async () => {
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(channelsFor(em, 'character:updated')).toEqual(DM_AND_OWNER_TABS);
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(DM_AND_OWNER_TABS);
    const roomWideStats = em.filter(
      (e) =>
        e.channelId === SESSION &&
        (e.event === 'character:updated' || e.event === 'combat:hp-changed')
    );
    expect(roomWideStats).toEqual([]);
    const bystanderEvents = em.filter((e) => e.channelId === 'by-sock');
    // The bystander only ever sees the chat flavor line, never the stats.
    expect(bystanderEvents.every((e) => e.event === 'chat:new-message')).toBe(true);
  });

  it('widens to visible players when PC stat sharing is on (wrapper behavior preserved)', async () => {
    getAllRooms().get(SESSION)!.showPlayersToPlayers = true;
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(channelsFor(em, 'character:updated')).toEqual([...DM_AND_OWNER_TABS, 'by-sock'].sort());
  });

  it('administers to an ally by name: stats go to the ALLY owner tabs and DMs, not the caller', async () => {
    mockCharacter(hpRow(7, { name: 'Mira' }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Mira');
    const { characterId } = characterUpdatePayload(em);
    expect(characterId).toBe('char-2');
    const [[, params]] = updateCalls();
    expect(params[1]).toBe('char-2');
    expect(channelsFor(em, 'character:updated')).toEqual(['by-sock', 'dm-sock', 'dm-sock-2']);
  });

  it('still heals a downed (0 HP) target — administering to an unconscious ally is valid', async () => {
    mockCharacter(hpRow(7, { hit_points: 0 }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    const [[, params]] = updateCalls();
    expect(params[0]).toBe(8);
    expect(systemBroadcasts(em)).toHaveLength(1);
  });

  it('targets the caller’s own token when only dice are given', async () => {
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion 2d4+2');
    const { characterId } = characterUpdatePayload(em);
    expect(characterId).toBe('char-1');
  });

  it.each([
    ['2d4+2', 'Potion of Healing', 8],
    ['4d4+4', 'Potion of Greater Healing', 16],
    ['8d4+8', 'Potion of Superior Healing', 32],
    ['10d4+20', 'Potion of Supreme Healing', 50],
    ['2D4+2', 'Potion of Healing', 8],
  ])('official formula %s rolls its own dice pool (%s, %i healing)', async (dice, label, heal) => {
    mockCharacter(hpRow(7, { hit_points: 1, max_hit_points: 100 }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, `!potion Hero ${dice}`);
    const [[, params]] = updateCalls();
    expect(params[0]).toBe(1 + heal);
    const sys = systemBroadcasts(em);
    expect(sys[0].content).toContain(label);
    expect(sys[0].content).toContain(`**${heal}** healing`);
  });
});

describe('fail-closed HP write', () => {
  it('DB write failure: private retry whisper only — no fanout, no announcement', async () => {
    mockCharacter(hpRow(7), new Error('db down'));
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('no HP was changed');
  });

  it('zero-row version conflict: private retry whisper only', async () => {
    mockCharacter(hpRow(7), []);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('changed while processing');
    expect(whispers(em)[0].content).toContain('Try again');
  });

  it('unusable RETURNING version after commit: truthful sync-failure whisper only', async () => {
    mockCharacter(hpRow(7), [{ version: null }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(updateCalls()).toHaveLength(1);
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('the healing was applied but synchronization failed');
    expect(whispers(em)[0].content).toContain('refresh the character sheet before retrying');
  });

  it('unusable selected version: fails closed without attempting the write', async () => {
    mockCharacter(hpRow('not-a-version'), [{ version: 99 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('could not verify');
  });

  it('missing version: fails closed without attempting the write', async () => {
    mockCharacter(hpRow(undefined), [{ version: 99 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  });
});

describe('no-op paths never write, fan out, or announce', () => {
  it('target already at full HP', async () => {
    mockCharacter(hpRow(7, { hit_points: 37 }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('already at full HP');
  });

  it('sheet without a usable max HP', async () => {
    mockCharacter(hpRow(7, { max_hit_points: 0 }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  });

  it('missing character row', async () => {
    mockCharacter(null, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  });

  it('unknown target name: whisper only, no DB traffic at all', async () => {
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Nobody');
    expect(characterSelects()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  });

  it('missing arguments: usage whisper only, no DB traffic', async () => {
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion');
    expect(characterSelects()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('usage');
  });
});

describe('target authorization (viewing map + visibility)', () => {
  it('a duplicate name on another map never shadows the viewing-map target', async () => {
    const room = getAllRooms().get(SESSION)!;
    // Newer createdAt would win under a room-wide resolver.
    room.tokens.set(
      'far-mira',
      tok('far-mira', {
        mapId: 'map-2',
        characterId: 'char-3',
        ownerUserId: 'bystander-user',
        name: 'Mira',
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      })
    );
    mockCharacter(hpRow(7, { name: 'Mira' }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Mira');
    const { characterId } = characterUpdatePayload(em);
    expect(characterId).toBe('char-2');
    const [[, params]] = updateCalls();
    expect(params[1]).toBe('char-2');
  });

  it('a target that exists only on another map is refused with zero DB traffic', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.set(
      'ghost',
      tok('ghost', { mapId: 'map-2', characterId: 'char-9', name: 'Ghost' })
    );
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Ghost');
    expect(characterSelects()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('no target with a character sheet named "Ghost"');
  });

  it('a hidden token is refused for a player exactly like a nonexistent name — no reveal', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.set(
      'shade',
      tok('shade', { mapId: 'map-1', characterId: 'char-9', name: 'Shade', visible: false })
    );
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Shade');
    expect(characterSelects()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('no target with a character sheet named "Shade"');
  });

  it("an invisible token someone else owns can't be guessed by name", async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.get('ally')!.conditions = ['invisible'];
    mockCharacter(hpRow(7, { name: 'Mira' }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Mira');
    expect(characterSelects()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  });

  it("the caller's own invisible token remains a valid target", async () => {
    const room = getAllRooms().get(SESSION)!;
    room.tokens.get('hero')!.conditions = ['invisible'];
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    const { characterId } = characterUpdatePayload(em);
    expect(characterId).toBe('char-1');
    expect(systemBroadcasts(em)).toHaveLength(1);
  });
});

describe('active-combat combatant sync', () => {
  function seedCombat(hp = 19) {
    const room = getAllRooms().get(SESSION)!;
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      startedAt: new Date().toISOString(),
      combatants: [
        {
          tokenId: 'hero',
          characterId: 'char-1',
          name: 'Hero',
          initiative: 12,
          initiativeBonus: 0,
          hp,
          maxHp: 37,
          tempHp: 0,
          armorClass: 15,
          speed: 30,
          isNPC: false,
          conditions: [],
          deathSaves: { successes: 0, failures: 0 },
          portraitUrl: null,
        },
      ],
    };
    return room.combatState;
  }

  function combatPersistCalls(): unknown[][] {
    return mockQuery.mock.calls.filter((call) =>
      (call[0] as string).startsWith('UPDATE combat_state')
    );
  }

  it('a committed, version-valid write syncs the combatant HP and persists combat state', async () => {
    const combat = seedCombat();
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(combat.combatants[0].hp).toBe(27);
    expect(combatPersistCalls()).toHaveLength(1);
  });

  it('a zero-row version conflict leaves the combatant untouched and unpersisted', async () => {
    const combat = seedCombat();
    mockCharacter(hpRow(7), []);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(combat.combatants[0].hp).toBe(19);
    expect(combatPersistCalls()).toEqual([]);
  });

  it('a DB write failure leaves the combatant untouched and unpersisted', async () => {
    const combat = seedCombat();
    mockCharacter(hpRow(7), new Error('db down'));
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(combat.combatants[0].hp).toBe(19);
    expect(combatPersistCalls()).toEqual([]);
  });

  it('an unusable RETURNING version after commit never syncs or persists combat', async () => {
    const combat = seedCombat();
    mockCharacter(hpRow(7), [{ version: null }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero');
    expect(combat.combatants[0].hp).toBe(19);
    expect(combatPersistCalls()).toEqual([]);
  });

  it('a target not in the initiative order heals without touching combat state', async () => {
    const combat = seedCombat();
    mockCharacter(hpRow(7, { name: 'Mira' }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Mira');
    expect(combat.combatants[0].hp).toBe(19);
    expect(combatPersistCalls()).toEqual([]);
    expect(systemBroadcasts(em)).toHaveLength(1);
  });
});

describe('bounded dice parsing', () => {
  it.each([
    '3d6',
    '2d4+3',
    '2d4-2',
    '2d4+2abc',
    '10d4+21',
    '100d4+2',
    'd20',
    '999999999d999999999+999999',
    `${'9'.repeat(64)}d4+2`,
  ])('rejects %s before any roll or query', async (dice) => {
    mockCharacter(hpRow(7), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, `!potion Hero ${dice}`);
    expect(characterSelects()).toEqual([]);
    expect(updateCalls()).toEqual([]);
    expect(randomSpy).not.toHaveBeenCalled();
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('official potion formula');
  });

  it('never rolls dice before the sheet is validated (full-HP target rolls nothing)', async () => {
    mockCharacter(hpRow(7, { hit_points: 37 }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!potion Hero 10d4+20');
    expect(randomSpy).not.toHaveBeenCalled();
  });
});
