/**
 * Ordinary-character (untransformed) out-of-combat direct HP authority.
 *
 * `applyDirectHp` used to ignore `temp_hit_points` on damage and wrote
 * `hit_points` with an unguarded UPDATE — a concurrent sheet edit or a
 * second command could silently clobber pools. Now damage consumes
 * temp HP before base HP, healing tops up base HP and leaves temp HP
 * alone, and every changed pool lands in one optimistic-lock UPDATE
 * keyed on the selected `characters.version`. A stale/missing/invalid
 * version, a malformed numeric row, or a zero-row UPDATE fails closed:
 * a private whisper, no fanout, no damage side effects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery, mockApplyDamageSideEffects } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockApplyDamageSideEffects: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../services/damageEffects.js', () => ({
  applyDamageSideEffects: mockApplyDamageSideEffects,
}));
vi.mock('../services/CombatService.js', () => ({}));

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
  } as Token;
}

const SESSION = 's-direct-hp-authority';

function seedRoom(): RoomState {
  createRoom(SESSION, 'ROOM-DHA', 'dm-user');
  const room = getAllRooms().get(SESSION)!;
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.tokens.set('pc', tok('pc', { characterId: 'char-pc', ownerUserId: 'owner-user' }));
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-sock',
    role: 'player',
    characterId: null,
  });
  return room;
}

/** Selected row for `char-pc`; the guarded UPDATE resolves via `onUpdate`. */
function mockRow(
  row: Record<string, unknown>,
  onUpdate: (sql: string, params: unknown[]) => { rows: Array<Record<string, unknown>> }
): void {
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('UPDATE characters')) return onUpdate(sql, params);
    if (sql.includes('FROM characters')) return { rows: [row] };
    return { rows: [] };
  });
}

function updates(): Array<{ sql: string; params: unknown[] }> {
  return mockQuery.mock.calls
    .filter((call) => (call[0] as string).startsWith('UPDATE characters'))
    .map((call) => ({ sql: call[0] as string, params: call[1] as unknown[] }));
}

function whispersTo(emissions: Emission[], socketId: string): string[] {
  return emissions
    .filter((e) => e.event === 'chat:new-message' && e.channelId === socketId)
    .map((e) => (e.payload as { content?: string }).content ?? '');
}

function characterChanges(emissions: Emission[]): Record<string, unknown> | undefined {
  const payload = emissions.find((e) => e.event === 'character:updated')?.payload as
    | { changes?: Record<string, unknown> }
    | undefined;
  return payload?.changes;
}

const ROW = { hit_points: 10, max_hit_points: 20, wild_shape: null, version: 6 };

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockApplyDamageSideEffects.mockReset();
  mockApplyDamageSideEffects.mockResolvedValue(undefined);
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

describe('untransformed out-of-combat direct HP authority', () => {
  it('temp HP fully absorbs damage: base HP untouched, only temp written, version-guarded', async () => {
    mockRow({ ...ROW, temp_hit_points: 5 }, () => ({ rows: [{ version: 7 }] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 3 pc');
    const writes = updates();
    expect(writes.length).toBe(1);
    expect(writes[0].sql).toContain('temp_hit_points = $1');
    expect(writes[0].sql).not.toMatch(/\bhit_points = \$/);
    expect(writes[0].sql).toContain('AND version = $3');
    expect(writes[0].params).toEqual([2, 'char-pc', 6]);
    expect(characterChanges(em)).toEqual({ hitPoints: 10, tempHitPoints: 2, version: 7 });
  });

  it('temp HP partially absorbs: remainder carries into base HP in one guarded UPDATE', async () => {
    mockRow({ ...ROW, temp_hit_points: 2 }, () => ({ rows: [{ version: 7 }] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 6 pc');
    const writes = updates();
    expect(writes.length).toBe(1);
    expect(writes[0].sql).toContain('hit_points = $1, temp_hit_points = $2');
    expect(writes[0].sql).toContain('AND version = $4');
    expect(writes[0].params).toEqual([6, 0, 'char-pc', 6]);
    expect(characterChanges(em)).toEqual({ hitPoints: 6, tempHitPoints: 0, version: 7 });
  });

  it('healing raises base HP up to max and leaves temp HP unchanged', async () => {
    mockRow({ ...ROW, temp_hit_points: 3 }, () => ({ rows: [{ version: 7 }] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!heal 15 pc');
    const writes = updates();
    expect(writes.length).toBe(1);
    expect(writes[0].sql).toContain('hit_points = $1');
    expect(writes[0].sql).not.toContain('temp_hit_points');
    expect(writes[0].params).toEqual([20, 'char-pc', 6]);
    expect(characterChanges(em)).toEqual({ hitPoints: 20, tempHitPoints: 3, version: 7 });
  });

  it('signed `!hp -N` routes through the same temp-first authority', async () => {
    mockRow({ ...ROW, temp_hit_points: 4 }, () => ({ rows: [{ version: 7 }] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!hp -3 pc');
    expect(updates()[0].params).toEqual([1, 'char-pc', 6]);
    expect(characterChanges(em)).toEqual({ hitPoints: 10, tempHitPoints: 1, version: 7 });
  });

  it('version conflict (zero-row UPDATE) fails closed: whisper only, no fanout, no side effects', async () => {
    mockRow({ ...ROW, temp_hit_points: 2 }, () => ({ rows: [] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 6 pc');
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/changed mid-action/);
    expect(em.filter((e) => e.event === 'character:updated')).toEqual([]);
    expect(em.filter((e) => e.event === 'combat:hp-changed')).toEqual([]);
    expect(mockApplyDamageSideEffects).not.toHaveBeenCalled();
  });

  it('missing/invalid selected version fails closed before any UPDATE', async () => {
    mockRow({ ...ROW, temp_hit_points: 0, version: null }, () => ({ rows: [{ version: 7 }] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 4 pc');
    expect(updates()).toEqual([]);
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/nothing was changed/i);
    expect(em.filter((e) => e.event === 'character:updated')).toEqual([]);
  });

  it.each([
    ['non-numeric HP', { hit_points: 'garbage' }],
    ['negative HP', { hit_points: -1 }],
    ['HP above maximum', { hit_points: 21 }],
    ['zero maximum HP', { max_hit_points: 0 }],
    ['fractional temp HP', { temp_hit_points: 1.5 }],
    ['oversized temp HP', { temp_hit_points: 10_000 }],
  ])('%s fails closed before any UPDATE', async (_label, malformed) => {
    mockRow({ ...ROW, temp_hit_points: 0, ...malformed }, () => ({ rows: [{ version: 7 }] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!damage 4 pc');
    expect(updates()).toEqual([]);
    expect(whispersTo(em, 'owner-sock').join(' ')).toMatch(/nothing was changed/i);
    expect(em.filter((e) => e.event === 'character:updated')).toEqual([]);
  });

  it('a full no-op (heal at max HP) skips the UPDATE and reports the selected version', async () => {
    mockRow({ ...ROW, hit_points: 20, temp_hit_points: 3 }, () => ({ rows: [{ version: 7 }] }));
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('owner-sock')!, '!heal 5 pc');
    expect(updates()).toEqual([]);
    expect(characterChanges(em)).toEqual({ hitPoints: 20, tempHitPoints: 3, version: 6 });
  });
});
