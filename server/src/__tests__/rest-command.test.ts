import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import type { Token } from '@dnd-vtt/shared';

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

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import { createRoom, getAllRooms, type PlayerContext, type RoomPlayer } from '../utils/roomState.js';

import '../services/chatCommands/restHandlers.js';

interface Emission {
  event: string;
  payload: unknown;
  channelId: string;
}

function fakeIo(): { io: Server; emissions: Emission[] } {
  const emissions: Emission[] = [];
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ event, payload, channelId }),
    }),
  } as unknown as Server;
  return { io, emissions };
}

function makeToken(id: string, name: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
    name,
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

function makeContext(role: 'dm' | 'player' = 'dm'): PlayerContext {
  const room = createRoom('session-rest', 'REST123', 'dm-user');
  room.playerMapId = 'map-1';
  const player: RoomPlayer = {
    userId: role === 'dm' ? 'dm-user' : 'player-1',
    displayName: role === 'dm' ? 'DM' : 'Player',
    socketId: role === 'dm' ? 'sock-dm' : 'sock-player',
    role,
    characterId: role === 'dm' ? null : 'char-player',
  };
  room.players.set(player.userId, player);
  return { room, player };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockConnect.mockReset();
  mockRelease.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('!rest server-owned command', () => {
  it('applies a long rest to linked session PCs without client-side rest triggers', async () => {
    const ctx = makeContext('dm');
    const updateCalls: unknown[][] = [];
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('JOIN session_players')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            user_id: 'player-1',
            class: 'Fighter',
            hit_points: 4,
            max_hit_points: 20,
            temp_hit_points: 5,
            spell_slots: JSON.stringify({ 1: { max: 2, used: 1 } }),
            features: JSON.stringify([{ name: 'Second Wind', usesTotal: 1, usesRemaining: 0, resetOn: 'short' }]),
            hit_dice: JSON.stringify([
              { dieSize: 10, total: 3, used: 3 },
              { dieSize: 8, total: 2, used: 2 },
            ]),
            death_saves: JSON.stringify({ successes: 2, failures: 1 }),
            concentrating_on: 'Bless',
            exhaustion_level: 2,
          }],
        };
      }
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE characters')) updateCalls.push(params ?? []);
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();

    const handled = await tryHandleChatCommand(io, ctx, '!rest long');

    expect(handled).toBe(true);
    expect(emissions.some((e) => e.event === 'rest:party-trigger')).toBe(false);
    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('BEGIN');
    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('COMMIT');
    expect(mockClientQuery.mock.calls.map((call) => call[0])).not.toContain('ROLLBACK');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].at(-1)).toBe('char-1');

    const characterUpdate = emissions.find((e) => e.event === 'character:updated');
    const payload = characterUpdate?.payload as { characterId?: string; changes?: Record<string, unknown> };
    expect(payload.characterId).toBe('char-1');
    expect(payload.changes?.hitPoints).toBe(20);
    expect(payload.changes?.tempHitPoints).toBe(0);
    expect(payload.changes?.spellSlots).toEqual({ 1: { max: 2, used: 0 } });
    expect(payload.changes?.features).toEqual([{ name: 'Second Wind', usesTotal: 1, usesRemaining: 1, resetOn: 'short' }]);
    expect(payload.changes?.hitDice).toEqual([
      { dieSize: 10, total: 3, used: 0 },
      { dieSize: 8, total: 2, used: 2 },
    ]);
    expect(payload.changes?.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(payload.changes?.concentratingOn).toBeNull();
    expect(payload.changes?.exhaustionLevel).toBe(1);

    const chat = emissions.find((e) => e.event === 'chat:new-message');
    expect(String((chat?.payload as { content?: string })?.content ?? '')).toContain('Rook: HP restored');
  });

  it('applies a targeted short rest to the named token character', async () => {
    const ctx = makeContext('dm');
    ctx.room.tokens.set('t-warlock', makeToken('t-warlock', 'Nyx', { characterId: 'char-warlock' }));
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM characters')) {
        return {
          rows: [{
            id: 'char-warlock',
            name: 'Nyx',
            class: 'Warlock',
            spell_slots: { 2: { max: 2, used: 2 } },
            features: [{ name: 'Fey Step', usesTotal: 1, usesRemaining: 0, resetOn: 'short' }],
          }],
        };
      }
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();

    const handled = await tryHandleChatCommand(io, ctx, '!rest short Nyx');

    expect(handled).toBe(true);
    const payload = emissions.find((e) => e.event === 'character:updated')?.payload as {
      characterId?: string;
      changes?: Record<string, unknown>;
    };
    expect(payload.characterId).toBe('char-warlock');
    expect(payload.changes?.spellSlots).toEqual({ 2: { max: 2, used: 0 } });
    expect(payload.changes?.features).toEqual([{ name: 'Fey Step', usesTotal: 1, usesRemaining: 1, resetOn: 'short' }]);
  });

  it('rolls back and emits no character updates if a rest write fails', async () => {
    const ctx = makeContext('dm');
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('JOIN session_players')) {
        return {
          rows: [{
            id: 'char-1',
            name: 'Rook',
            class: 'Fighter',
            hit_points: 4,
            max_hit_points: 20,
          }],
        };
      }
      return { rows: [] };
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE characters')) throw new Error('write failed');
      return { rows: [] };
    });
    const { io, emissions } = fakeIo();

    const handled = await tryHandleChatCommand(io, ctx, '!rest long');

    expect(handled).toBe(true);
    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('BEGIN');
    expect(mockClientQuery.mock.calls.map((call) => call[0])).toContain('ROLLBACK');
    expect(mockClientQuery.mock.calls.map((call) => call[0])).not.toContain('COMMIT');
    expect(emissions.some((e) => e.event === 'character:updated')).toBe(false);
    expect(String((emissions[0].payload as { content?: string }).content ?? '')).toContain('write failed');
  });

  it('keeps the DM-only guard', async () => {
    const ctx = makeContext('player');
    const { io, emissions } = fakeIo();

    const handled = await tryHandleChatCommand(io, ctx, '!rest long');

    expect(handled).toBe(true);
    expect(emissions).toHaveLength(1);
    expect(emissions[0].channelId).toBe('sock-player');
    expect(String((emissions[0].payload as { content?: string }).content ?? '')).toContain('DM only');
  });
});
