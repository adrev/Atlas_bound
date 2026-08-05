/**
 * `!smite` authoritative Divine Smite slot consumption.
 *
 * The handler used to consume the slot with a fire-and-forget UPDATE
 * (`.catch(console.warn)`) and then roll damage and announce success
 * even when the write failed, guarded nothing against concurrent sheet
 * edits, and `parseInt` accepted partial strings like `3abc` as a
 * level.
 *
 * Now the slot spend is optimistic (`UPDATE ... WHERE version =
 * <selected> RETURNING version`) and fails closed: a DB error, a
 * zero-row version conflict, an unusable selected version, or an
 * unusable RETURNING version produces only a private whisper — no slot
 * fanout, no damage roll, no success announcement. Pre-write failures
 * whisper a retry; a committed write whose RETURNING version is
 * unusable whispers the truth (slot spent, synchronization failed,
 * refresh before retrying). Dice are rolled only after the write
 * commits with an authoritative version, the `character:updated`
 * payload always carries that post-write version, the fanout keeps the
 * dispatcher's stat-scoped wrapper behavior, level parsing is
 * strict-integer, and no-op paths (bad level, missing feature,
 * unavailable slot) never touch the row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import '../services/chatCommands/smiteHandler.js';

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

const SESSION = 's-smite-slot';

/** DM (two tabs), owner (two tabs), and a bystander player — owner has a PC token. */
function seedRoom() {
  const room = createRoom(SESSION, 'ROOM-SMITE', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set(
    'hero',
    tok('hero', { characterId: 'char-1', ownerUserId: 'owner-user', name: 'Hero' })
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
    characterId: null,
  });
  return getAllRooms().get(SESSION)!;
}

type Slots = Record<string, { max: number; used: number }>;

function paladinRow(version: unknown, slots: Slots, overrides: Record<string, unknown> = {}) {
  return {
    class: 'Paladin',
    features: '[]',
    spell_slots: JSON.stringify(slots),
    name: 'Sir Roland',
    version,
    ...overrides,
  };
}

/** Mock the SELECT (class/features/slots/version) and the guarded UPDATE. */
function mockCharacter(
  row: Record<string, unknown> | null,
  updateResult: Array<Record<string, unknown>> | Error
): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE characters')) {
      if (updateResult instanceof Error) throw updateResult;
      return { rows: updateResult };
    }
    if (sql.includes('SELECT class, features, spell_slots, name, version FROM characters')) {
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

/** A failed/refused smite must leave zero success surface anywhere. */
function expectFailedClosed(em: Emission[]): void {
  expect(channelsFor(em, 'character:updated')).toEqual([]);
  expect(systemBroadcasts(em)).toEqual([]);
  const rolled = em.filter(
    (e) => (e.payload as { spellResult?: unknown } | null)?.spellResult !== undefined
  );
  expect(rolled).toEqual([]);
  expect(whispers(em)).toHaveLength(1);
}

const DM_AND_OWNER_TABS = ['dm-sock', 'dm-sock-2', 'owner-sock', 'owner-sock-2'];
const TWO_OF_THREE: Slots = { '2': { max: 3, used: 1 } };

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-sock')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

describe('success path', () => {
  it('consumes the slot with a version-guarded UPDATE and forwards the RETURNING version', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    const [[sql, params]] = updateCalls();
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params[1]).toBe('char-1');
    expect(params[2]).toBe(7);
    expect(JSON.parse(params[0] as string)).toEqual({ '2': { max: 3, used: 2 } });
    const { characterId, changes } = characterUpdatePayload(em);
    expect(characterId).toBe('char-1');
    expect(changes.spellSlots).toEqual({ '2': { max: 3, used: 2 } });
    expect(changes.version).toBe(8);
    const sys = systemBroadcasts(em);
    expect(sys).toHaveLength(1);
    expect(sys[0].content).toContain('Divine Smite');
    expect(sys[0].content).toContain('Slot 2: 2/3 used');
  });

  it('keeps the stat-scoped fanout: slots reach every DM and owner tab, never the bystander', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    expect(channelsFor(em, 'character:updated')).toEqual(DM_AND_OWNER_TABS);
    const roomWide = em.filter((e) => e.channelId === SESSION && e.event === 'character:updated');
    expect(roomWide).toEqual([]);
    const bystanderEvents = em.filter((e) => e.channelId === 'by-sock');
    // The bystander only ever sees the chat announcement, never the slots.
    expect(bystanderEvents.every((e) => e.event === 'chat:new-message')).toBe(true);
  });

  it('preserves the wrapper behavior when PC stat sharing is on: visible players also receive', async () => {
    getAllRooms().get(SESSION)!.showPlayersToPlayers = true;
    mockCharacter(paladinRow(7, TWO_OF_THREE), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    expect(channelsFor(em, 'character:updated')).toEqual([...DM_AND_OWNER_TABS, 'by-sock'].sort());
  });

  it('preserves the damage rules: undead + crit on a level 2 slot rolls 8d8', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2 undead crit');
    const sys = systemBroadcasts(em);
    expect(sys).toHaveLength(1);
    expect(sys[0].content).toContain('8d8');
    expect(sys[0].content).toContain('[CRIT]');
    expect(sys[0].content).toContain('[+1d8 vs undead/fiend]');
  });
});

describe('fail-closed slot spend', () => {
  it('DB write failure: private retry whisper only — no fanout, no roll, no announcement', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), new Error('db down'));
    const em: Emission[] = [];
    await run(em, '!smite 2');
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('no slot was spent');
  });

  it('zero-row version conflict: private retry whisper only', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), []);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('changed while processing');
    expect(whispers(em)[0].content).toContain('Try again');
  });

  it('unusable RETURNING version after commit: truthful sync-failure whisper only — no fanout, no roll, no announcement', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), [{ version: null }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    expect(updateCalls()).toHaveLength(1);
    expectFailedClosed(em);
    expect(whispers(em)[0].content).toContain('the slot was spent but synchronization failed');
    expect(whispers(em)[0].content).toContain('refresh your character sheet before retrying');
  });

  it('unusable selected version: fails closed without attempting the write', async () => {
    mockCharacter(paladinRow('not-a-version', TWO_OF_THREE), [{ version: 99 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  });

  it('missing version: fails closed without attempting the write', async () => {
    mockCharacter(paladinRow(undefined, TWO_OF_THREE), [{ version: 99 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  });
});

describe('no-op paths never write or roll', () => {
  async function expectNoWrite(em: Emission[]): Promise<void> {
    expect(updateCalls()).toEqual([]);
    expectFailedClosed(em);
  }

  it('no slot of the requested level remaining', async () => {
    mockCharacter(paladinRow(7, { '2': { max: 3, used: 3 } }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    await expectNoWrite(em);
    expect(whispers(em)[0].content).toContain('no level 2 slots');
  });

  it('slot level the character does not have', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 4');
    await expectNoWrite(em);
  });

  it('character without Divine Smite', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE, { class: 'Wizard', features: '[]' }), [
      { version: 8 },
    ]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    await expectNoWrite(em);
  });

  it('missing character row', async () => {
    mockCharacter(null, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 2');
    await expectNoWrite(em);
  });

  it('missing level argument', async () => {
    mockCharacter(paladinRow(7, TWO_OF_THREE), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite');
    await expectNoWrite(em);
    expect(whispers(em)[0].content).toContain('usage');
  });
});

describe('strict level parsing', () => {
  it.each(['3abc', 'abc', '2.5', '-1', '0', '6', '2e1', '+2'])(
    'rejects %s without touching the row',
    async (level) => {
      mockCharacter(paladinRow(7, { '3': { max: 3, used: 0 } }), [{ version: 8 }]);
      const em: Emission[] = [];
      await run(em, `!smite ${level}`);
      expect(updateCalls()).toEqual([]);
      expectFailedClosed(em);
      expect(whispers(em)[0].content).toContain('level must be 1-5');
    }
  );

  it('still accepts a plain integer level', async () => {
    mockCharacter(paladinRow(7, { '3': { max: 3, used: 0 } }), [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!smite 3');
    expect(updateCalls()).toHaveLength(1);
    expect(systemBroadcasts(em)).toHaveLength(1);
  });
});
