import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockApplyDamageSideEffects } = vi.hoisted(() => ({
  mockApplyDamageSideEffects: vi.fn(),
}));

vi.mock('../services/damageEffects.js', () => ({
  applyDamageSideEffects: mockApplyDamageSideEffects,
}));

vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn() },
}));

import { registerCombatConditions } from '../socket/combat/conditionEvents.js';
import {
  addPlayerToRoom, createRoom, getAllRooms, type RoomState,
} from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }

function makeHarness(actorSocketId: string) {
  const handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const emissions: Emission[] = [];
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
  const socket = {
    id: actorSocketId,
    on: (event: string, handler: (data: unknown) => Promise<void> | void) => {
      handlers[event] = handler;
    },
    emit: (event: string, payload: unknown) => emissions.push({ channelId: actorSocketId, event, payload }),
  } as never;
  return { io, socket, handlers, emissions };
}

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: `char-${id}`,
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

function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom('legacy-damage-session', 'ROOM-LEGACY-DAMAGE', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  for (const t of tokens) room.tokens.set(t.id, t);
  addPlayerToRoom(room.sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'player-user',
    displayName: 'Pip',
    socketId: 'player-sock',
    role: 'player',
    characterId: null,
  });
  return getAllRooms().get(room.sessionId)!;
}

beforeEach(() => {
  mockApplyDamageSideEffects.mockReset();
  mockApplyDamageSideEffects.mockResolvedValue(undefined);
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('legacy damage:side-effects socket handler', () => {
  it('delegates broadcasts to the scoped central damage side-effect service', async () => {
    const room = seedRoom([
      token('hidden-caster', { visible: false, ownerUserId: 'npc' }),
    ]);
    const { io, socket, handlers, emissions } = makeHarness('dm-sock');
    registerCombatConditions(io, socket);

    await handlers['damage:side-effects']!({ tokenId: 'hidden-caster', damageAmount: 12 });

    expect(mockApplyDamageSideEffects).toHaveBeenCalledWith(io, room, 'hidden-caster', 12);
    expect(emissions.filter((e) => e.event === 'chat:new-message')).toEqual([]);
    expect(emissions.filter((e) => e.event === 'map:token-updated')).toEqual([]);
    expect(emissions.filter((e) => e.event === 'character:updated')).toEqual([]);
  });
});
