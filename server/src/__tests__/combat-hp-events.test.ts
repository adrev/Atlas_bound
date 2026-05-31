import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import type { Combatant, CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import { registerCombatHp } from '../socket/combat/hpEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function fakeIo(emissions: Emission[]): Server {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as unknown as Server;
}

function fakeSocket(socketId: string) {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const socket = {
    id: socketId,
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(event, handler);
      return socket;
    },
    emit: () => true,
  } as unknown as Socket;
  return { socket, handlers };
}

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: 'char-1',
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
    ownerUserId: 'player-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function combatant(tokenId: string, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId,
    characterId: 'char-1',
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 0,
    maxHp: 12,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: false,
    conditions: [],
    deathSaves: { successes: 1, failures: 1 },
    portraitUrl: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('combat HP socket events', () => {
  it('broadcasts token condition cleanup when healing a stable unconscious PC above 0 HP', async () => {
    const sessionId = 'heal-condition-session';
    const room = createRoom(sessionId, 'HEAL', 'dm-user');
    room.currentMapId = 'map-1';
    room.playerMapId = 'map-1';
    const downedToken = token('pc-token', { conditions: ['unconscious', 'stable'] as Token['conditions'] });
    room.tokens.set(downedToken.id, downedToken);
    const state: CombatState = {
      sessionId,
      active: true,
      roundNumber: 1,
      currentTurnIndex: 0,
      combatants: [
        combatant(downedToken.id, { conditions: ['unconscious', 'stable'] as Combatant['conditions'] }),
      ],
      startedAt: new Date().toISOString(),
    };
    room.combatState = state;
    addPlayerToRoom(sessionId, {
      userId: 'dm-user',
      displayName: 'DM',
      socketId: 'dm-sock',
      role: 'dm',
      characterId: null,
    });
    addPlayerToRoom(sessionId, {
      userId: 'player-user',
      displayName: 'Pip',
      socketId: 'player-sock',
      role: 'player',
      characterId: 'char-1',
    });

    const emissions: Emission[] = [];
    const { socket, handlers } = fakeSocket('dm-sock');
    registerCombatHp(fakeIo(emissions), socket);

    await handlers.get('combat:heal')?.({ tokenId: downedToken.id, amount: 5 });

    const conditionEvents = emissions.filter((e) => e.event === 'map:token-updated');
    expect(conditionEvents.map((e) => e.channelId).sort()).toEqual(['dm-sock', 'player-sock']);
    for (const event of conditionEvents) {
      const payload = event.payload as { tokenId: string; changes: { conditions: string[] } };
      expect(payload.tokenId).toBe(downedToken.id);
      expect(payload.changes.conditions).toEqual([]);
    }
    const characterUpdate = emissions.find((e) => e.event === 'character:updated')?.payload as {
      characterId?: string;
      changes?: Record<string, unknown>;
    };
    expect(characterUpdate.characterId).toBe('char-1');
    expect(characterUpdate.changes?.deathSaves).toEqual({ successes: 0, failures: 0 });
  });
});
