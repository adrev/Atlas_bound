import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Combatant, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerCombatActions } from '../socket/combat/actionEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

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

function combatant(token: Token, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId: token.id,
    characterId: token.characterId,
    name: token.name,
    initiative: 10,
    initiativeBonus: 0,
    hp: 12,
    maxHp: 12,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: !token.ownerUserId,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

const SESSION = 's-action-scope';

function seedRoom(currentToken: Token): RoomState {
  const room = createRoom(SESSION, 'ROOM-ACTION', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'combat';
  room.tokens.set(currentToken.id, currentToken);
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [combatant(currentToken)],
    startedAt: new Date().toISOString(),
  };
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
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
    userId: 'bystander-user',
    displayName: 'Bystander',
    socketId: 'bystander-sock',
    role: 'player',
    characterId: null,
  });
  return getAllRooms().get(SESSION)!;
}

type Handler = (data: unknown) => Promise<void> | void;

function handlersFor(io: never, socketId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = { id: socketId, on: (event: string, cb: Handler) => handlers.set(event, cb) };
  registerCombatActions(io, socket as never);
  return handlers;
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('combat action economy visibility scoping', () => {
  it('scopes hidden combatant action use to DM and owner only', async () => {
    const em: Emission[] = [];
    seedRoom(tok('hidden-pc', {
      visible: false,
      ownerUserId: 'owner-user',
      name: 'Hidden PC',
    }));
    const h = handlersFor(fakeIo(em), 'dm-sock');

    await h.get('combat:use-action')!({ actionType: 'action' });

    expect(channelsFor(em, 'combat:action-used')).toEqual(['dm-sock', 'owner-sock']);
  });

  it('scopes hidden combatant movement use to DM and owner only', async () => {
    const em: Emission[] = [];
    seedRoom(tok('hidden-pc', {
      visible: false,
      ownerUserId: 'owner-user',
      name: 'Hidden PC',
    }));
    const h = handlersFor(fakeIo(em), 'dm-sock');

    await h.get('combat:use-movement')!({ feet: 10 });

    expect(channelsFor(em, 'combat:movement-used')).toEqual(['dm-sock', 'owner-sock']);
  });

  it('scopes hidden combatant Dash economy and chat to DM and owner only', async () => {
    const em: Emission[] = [];
    seedRoom(tok('hidden-pc', {
      visible: false,
      ownerUserId: 'owner-user',
      name: 'Hidden PC',
    }));
    const h = handlersFor(fakeIo(em), 'dm-sock');

    await h.get('combat:dash')!({});

    expect(channelsFor(em, 'combat:action-used')).toEqual(['dm-sock', 'owner-sock']);
    expect(channelsFor(em, 'chat:new-message')).toEqual(['dm-sock', 'owner-sock']);
  });

  it('still sends visible combatant action use to everyone on the active map', async () => {
    const em: Emission[] = [];
    seedRoom(tok('visible-pc', {
      ownerUserId: 'owner-user',
      name: 'Visible PC',
    }));
    const h = handlersFor(fakeIo(em), 'dm-sock');

    await h.get('combat:use-action')!({ actionType: 'bonusAction' });

    expect(channelsFor(em, 'combat:action-used')).toEqual(['bystander-sock', 'dm-sock', 'owner-sock']);
  });
});
