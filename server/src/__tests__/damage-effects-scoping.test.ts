import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@dnd-vtt/shared';
import {
  addPlayerToRoom, createRoom, getAllRooms, type RoomState,
} from '../utils/roomState.js';
import * as ConditionService from '../services/ConditionService.js';
import { applyDamageSideEffects } from '../services/damageEffects.js';
import pool from '../db/connection.js';

vi.mock('../services/ConditionService.js', () => ({
  processDamageSideEffects: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn() },
}));

interface Emission { channelId: string; event: string; payload: unknown }

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
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
  const room = createRoom('damage-scope-session', 'ROOM-DAMAGE', 'dm-user');
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

function channels(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((e) => e.event === event)
    .map((e) => e.channelId)
    .sort();
}

beforeEach(() => {
  vi.mocked(ConditionService.processDamageSideEffects).mockReset();
  vi.mocked(pool.query).mockReset();
  vi.mocked(pool.query).mockReturnValue({ catch: vi.fn() } as never);
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('applyDamageSideEffects socket scoping', () => {
  it('does not leak hidden token side-effect updates to player sockets', async () => {
    const room = seedRoom([
      token('hidden-npc', { visible: false, ownerUserId: 'npc', conditions: ['sleep'] as never }),
    ]);
    vi.mocked(ConditionService.processDamageSideEffects).mockResolvedValue({
      affectedTokens: ['hidden-npc'],
      messages: [],
      droppedConcentration: { spellName: 'Hold Person' },
    });
    const emissions: Emission[] = [];

    await applyDamageSideEffects(fakeIo(emissions), room, 'hidden-npc', 12);

    expect(channels(emissions, 'map:token-updated')).toEqual(['dm-sock']);
    expect(channels(emissions, 'character:updated')).toEqual(['dm-sock']);
  });

  it('sends visible token side-effect updates to players on the map', async () => {
    const room = seedRoom([
      token('visible-npc', { visible: true, conditions: ['sleep'] as never }),
    ]);
    vi.mocked(ConditionService.processDamageSideEffects).mockResolvedValue({
      affectedTokens: ['visible-npc'],
      messages: [],
      droppedConcentration: { spellName: 'Bless' },
    });
    const emissions: Emission[] = [];

    await applyDamageSideEffects(fakeIo(emissions), room, 'visible-npc', 12);

    expect(channels(emissions, 'map:token-updated')).toEqual(['dm-sock', 'player-sock']);
    expect(channels(emissions, 'character:updated')).toEqual(['dm-sock', 'player-sock']);
  });

  it('scopes hidden concentration-save chat live and marks persisted history hidden', async () => {
    const room = seedRoom([
      token('hidden-caster', { visible: false, ownerUserId: 'npc' }),
    ]);
    vi.mocked(ConditionService.processDamageSideEffects).mockResolvedValue({
      affectedTokens: [],
      messages: [],
      concentrationSave: {
        roller: { name: 'Hidden Caster' },
        passed: true,
        total: 15,
        dc: 10,
        concentration: { spellName: 'Invisibility' },
      } as never,
    });
    const emissions: Emission[] = [];

    await applyDamageSideEffects(fakeIo(emissions), room, 'hidden-caster', 12);

    expect(channels(emissions, 'chat:new-message')).toEqual(['dm-sock']);
    const params = vi.mocked(pool.query).mock.calls[0]?.[1] as unknown[];
    expect(params[8]).toBe(1);
  });
});
