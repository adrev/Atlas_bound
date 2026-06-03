/**
 * Regression coverage for legacy chat-command token update fanout.
 *
 * Many slash-command handlers still emit token diffs as:
 * `c.io.to(sessionId).emit('map:token-updated', ...)`.
 * The dispatcher wraps `c.io` so those old room-wide emits are scoped
 * through the same token visibility rule as map/combat socket updates.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerChatCommand, tryHandleChatCommand } from '../services/ChatCommands.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
  type RoomState,
} from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function tok(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id, mapId: 'map-1', characterId: null, name: id,
    x: 0, y: 0, size: 1, imageUrl: null, color: '#000',
    layer: 'token', visible: true, hasLight: false,
    lightRadius: 0, lightDimRadius: 0, lightColor: '#fff',
    conditions: [], ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}

const SESSION = 's-chat-token-fanout';

function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom(SESSION, 'ROOM-CTF', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  for (const t of tokens) room.tokens.set(t.id, t);
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock', role: 'player', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'other-user', displayName: 'Vex', socketId: 'other-sock', role: 'player', characterId: null });
  return room;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  registerChatCommand('codex-token-fanout', (c) => {
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: c.rest,
      changes: { conditions: ['invisible'] },
    });
    return true;
  });
  registerChatCommand('codex-hp-fanout', (c) => {
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: c.rest,
      hp: 3,
      tempHp: 0,
      change: -5,
      type: 'damage',
    });
    return true;
  });
  registerChatCommand('codex-character-fanout', (c) => {
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: c.rest,
      changes: { hitPoints: 3 },
    });
    return true;
  });
});

describe('chat command token fanout wrapper', () => {
  it('keeps legacy room-wide token diffs DM-only for invisible unoutlined NPCs', async () => {
    seedRoom([tok('npc', { conditions: ['invisible'] })]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!codex-token-fanout npc');
    expect(channelsFor(em, 'map:token-updated')).toEqual(['dm-sock']);
  });

  it('still broadcasts visible token diffs to every player on the active map', async () => {
    seedRoom([tok('npc')]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!codex-token-fanout npc');
    expect(channelsFor(em, 'map:token-updated')).toEqual(['dm-sock', 'other-sock', 'player-sock']);
  });

  it('allows an invisible owned token diff to reach its owner and DMs, not bystanders', async () => {
    seedRoom([tok('pc', { ownerUserId: 'player-user', conditions: ['invisible'] })]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!codex-token-fanout pc');
    expect(channelsFor(em, 'map:token-updated')).toEqual(['dm-sock', 'player-sock']);
  });

  it('scopes legacy room-wide HP changes for hidden tokens', async () => {
    seedRoom([tok('npc', { visible: false })]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!codex-hp-fanout npc');
    expect(channelsFor(em, 'combat:hp-changed')).toEqual(['dm-sock']);
  });

  it('scopes resolvable character updates through the owning token and owner', async () => {
    seedRoom([tok('pc', { characterId: 'char-pc', ownerUserId: 'player-user', visible: false })]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!codex-character-fanout char-pc');
    expect(channelsFor(em, 'character:updated')).toEqual(['dm-sock', 'player-sock']);
  });

  it('leaves non-token character updates on the original room-wide path', async () => {
    seedRoom([]);
    const em: Emission[] = [];
    await tryHandleChatCommand(fakeIo(em), getPlayerBySocketId('dm-sock')!, '!codex-character-fanout unplaced-char');
    expect(channelsFor(em, 'character:updated')).toEqual([SESSION]);
  });
});
