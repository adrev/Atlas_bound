/**
 * `!attune` / `!unattune` authoritative inventory mutations.
 *
 * These handlers used to swallow DB write failures (`.catch(warn)`) and
 * then emit success anyway, wrote the inventory with an unguarded
 * UPDATE (lost-update race against concurrent sheet edits), and fanned
 * the exact inventory out room-wide so bystander players received the
 * owner's full item list.
 *
 * Now the write is optimistic (`UPDATE ... WHERE version = <selected>
 * RETURNING version`), both commands fail closed — a DB error or a
 * zero-row version conflict produces only a private retry whisper, no
 * success emit/message — the exact inventory goes only to DM tabs and
 * the owning player's tabs with the authoritative post-write version,
 * and no-op paths (already attuned/unattuned, cap, missing item, no
 * attunement required) never touch the row.
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
import '../services/chatCommands/attuneHandlers.js';

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

const SESSION = 's-attune-sync';

/** DM (two tabs), owner (two tabs), and a bystander player — owner has a PC token. */
function seedRoom() {
  const room = createRoom(SESSION, 'ROOM-ATT', 'dm-user');
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

type Item = { name: string; attunement?: boolean; attuned?: boolean };

/** Mock the SELECT (inventory + version) and the guarded UPDATE. */
function mockCharacter(
  inventory: Item[],
  selectedVersion: unknown,
  updateResult: Array<Record<string, unknown>> | Error
): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE characters')) {
      if (updateResult instanceof Error) throw updateResult;
      return { rows: updateResult };
    }
    if (sql.includes('SELECT inventory, version FROM characters')) {
      return { rows: [{ inventory: JSON.stringify(inventory), version: selectedVersion }] };
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

const DM_AND_OWNER_TABS = ['dm-sock', 'dm-sock-2', 'owner-sock', 'owner-sock-2'];
const RING: Item = { name: 'Ring of Protection', attunement: true };
const ATTUNED_RING: Item = { ...RING, attuned: true };

async function run(emissions: Emission[], command: string): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('owner-sock')!, command);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

describe('!attune fanout scoping', () => {
  it('sends the exact inventory to every DM tab and owner tab, never the bystander', async () => {
    mockCharacter([RING], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!attune ring of protection');
    expect(channelsFor(em, 'character:updated')).toEqual(DM_AND_OWNER_TABS);
    const { characterId, changes } = characterUpdatePayload(em);
    expect(characterId).toBe('char-1');
    expect(changes.inventory).toEqual([{ ...RING, attuned: true }]);
    const bystanderEvents = em.filter((e) => e.channelId === 'by-sock');
    // The bystander only ever sees the room-wide flavor line, never inventory.
    expect(bystanderEvents.every((e) => e.event === 'chat:new-message')).toBe(true);
  });

  it('never emits the inventory room-wide on the session channel', async () => {
    mockCharacter([RING], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!attune ring');
    const roomWide = em.filter((e) => e.channelId === SESSION && e.event === 'character:updated');
    expect(roomWide).toEqual([]);
  });
});

describe('optimistic concurrency', () => {
  it('guards the UPDATE with the selected version and forwards the RETURNING version', async () => {
    mockCharacter([RING], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!attune ring');
    const [[sql, params]] = updateCalls();
    expect(sql).toContain('WHERE id = $2 AND version = $3');
    expect(sql).toContain('RETURNING version');
    expect(params[1]).toBe('char-1');
    expect(params[2]).toBe(7);
    expect(characterUpdatePayload(em).changes.version).toBe(8);
    expect(systemBroadcasts(em)).toHaveLength(1);
  });

  it('treats a zero-row conflict as failure: private retry whisper, no emit, no announcement', async () => {
    mockCharacter([RING], 7, []);
    const em: Emission[] = [];
    await run(em, '!attune ring');
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(systemBroadcasts(em)).toEqual([]);
    const w = whispers(em);
    expect(w).toHaveLength(1);
    expect(w[0].content).toContain('changed while processing');
    expect(w[0].content).toContain('Try again');
  });

  it('fails closed without attempting a write when the selected version is unusable', async () => {
    mockCharacter([RING], 'not-a-version', [{ version: 99 }]);
    const em: Emission[] = [];
    await run(em, '!attune ring');
    expect(updateCalls()).toEqual([]);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(systemBroadcasts(em)).toEqual([]);
    expect(whispers(em)).toHaveLength(1);
  });

  it('omits changes.version (never fabricates) when RETURNING yields no usable value', async () => {
    mockCharacter([RING], 7, [{ version: null }]);
    const em: Emission[] = [];
    await run(em, '!attune ring');
    const { changes } = characterUpdatePayload(em);
    expect(changes.inventory).toEqual([{ ...RING, attuned: true }]);
    expect('version' in changes).toBe(false);
    expect(systemBroadcasts(em)).toHaveLength(1);
  });
});

describe('fail-closed write errors', () => {
  it('!attune: DB failure produces only a private whisper — no success emit/message', async () => {
    mockCharacter([RING], 7, new Error('db down'));
    const em: Emission[] = [];
    await run(em, '!attune ring');
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(systemBroadcasts(em)).toEqual([]);
    const w = whispers(em);
    expect(w).toHaveLength(1);
    expect(w[0].content).toContain('nothing was modified');
  });

  it('!unattune: DB failure produces only a private whisper — no success emit/message', async () => {
    mockCharacter([ATTUNED_RING], 7, new Error('db down'));
    const em: Emission[] = [];
    await run(em, '!unattune ring');
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(systemBroadcasts(em)).toEqual([]);
    expect(whispers(em)).toHaveLength(1);
  });
});

describe('!unattune success path', () => {
  it('scopes the fanout to DM+owner tabs and carries the authoritative version', async () => {
    mockCharacter([ATTUNED_RING], 4, [{ version: 5 }]);
    const em: Emission[] = [];
    await run(em, '!unattune ring');
    expect(channelsFor(em, 'character:updated')).toEqual(DM_AND_OWNER_TABS);
    const { changes } = characterUpdatePayload(em);
    expect(changes.inventory).toEqual([{ ...RING, attuned: false }]);
    expect(changes.version).toBe(5);
    const [[, params]] = updateCalls();
    expect(params[2]).toBe(4);
    expect(systemBroadcasts(em)).toHaveLength(1);
  });
});

describe('no-op paths never write or bump', () => {
  async function expectNoWrite(em: Emission[]): Promise<void> {
    expect(updateCalls()).toEqual([]);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    expect(systemBroadcasts(em)).toEqual([]);
    expect(whispers(em)).toHaveLength(1);
  }

  it('already-attuned item', async () => {
    mockCharacter([ATTUNED_RING], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!attune ring');
    await expectNoWrite(em);
  });

  it('already-unattuned item', async () => {
    mockCharacter([RING], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!unattune ring');
    await expectNoWrite(em);
  });

  it('attunement cap reached', async () => {
    mockCharacter(
      [
        { name: 'Ring One', attunement: true, attuned: true },
        { name: 'Ring Two', attunement: true, attuned: true },
        { name: 'Ring Three', attunement: true, attuned: true },
        { name: 'Ring Four', attunement: true },
      ],
      7,
      [{ version: 8 }]
    );
    const em: Emission[] = [];
    await run(em, '!attune ring four');
    await expectNoWrite(em);
  });

  it('missing item', async () => {
    mockCharacter([RING], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!attune wand of wonder');
    await expectNoWrite(em);
  });

  it('item that does not require attunement', async () => {
    mockCharacter([{ name: 'Rope' }], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!attune rope');
    await expectNoWrite(em);
  });

  it('!attune list stays a read-only whisper', async () => {
    mockCharacter([ATTUNED_RING], 7, [{ version: 8 }]);
    const em: Emission[] = [];
    await run(em, '!attune list');
    expect(updateCalls()).toEqual([]);
    expect(channelsFor(em, 'character:updated')).toEqual([]);
    const w = whispers(em);
    expect(w).toHaveLength(1);
    expect(w[0].content).toContain('Ring of Protection');
  });
});
