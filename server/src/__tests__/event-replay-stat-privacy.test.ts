import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import type { ActionEconomy, Combatant, Token } from '@dnd-vtt/shared';

vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [{ member: 1 }] }) },
}));
vi.mock('../services/Open5eService.js', () => ({
  isCompendiumSeeded: vi.fn().mockResolvedValue(true),
  getCompendiumStats: vi.fn().mockResolvedValue({ monsters: 0, spells: 0, items: 0 }),
  reseedCompendium: vi.fn().mockResolvedValue(undefined),
}));

import sessionsRouter from '../routes/sessions.js';
import { broadcastTurnAdvanced } from '../socket/combat/turnBroadcast.js';
import { broadcastEvent } from '../utils/eventBroadcast.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

const SESSION = 'event-replay-stat-privacy';
const exactEconomy: ActionEconomy = {
  action: true,
  bonusAction: false,
  movementRemaining: 20,
  movementMax: 30,
  reaction: true,
};
const redactedEconomy: ActionEconomy = {
  action: false,
  bonusAction: false,
  movementRemaining: 0,
  movementMax: 0,
  reaction: false,
};

function token(): Token {
  return {
    id: 'current-token',
    mapId: 'map-1',
    characterId: 'character-current',
    name: 'Current Hero',
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#ffffff',
    conditions: [],
    ownerUserId: 'owner-user',
    createdAt: new Date(0).toISOString(),
  };
}

function combatant(): Combatant {
  return {
    tokenId: 'current-token',
    characterId: 'character-current',
    name: 'Current Hero',
    initiative: 18,
    initiativeBonus: 4,
    hp: 15,
    maxHp: 20,
    tempHp: 0,
    armorClass: 16,
    speed: 30,
    isNPC: false,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
  };
}

function mockIo() {
  return {
    to: () => ({ emit: () => undefined }),
  } as never;
}

function buildApp() {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = String(req.headers['x-test-user'] ?? 'bystander-user');
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/api/sessions', sessionsRouter);
  return app;
}

function seedRoom(): RoomState {
  const room = createRoom(SESSION, 'REPLAYST', 'dm-user');
  room.playerMapId = 'map-1';
  const currentToken = token();
  const currentCombatant = combatant();
  room.tokens.set(currentToken.id, currentToken);
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 2,
    currentTurnIndex: 0,
    combatants: [currentCombatant],
    startedAt: new Date(0).toISOString(),
  };
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-socket',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-socket',
    role: 'player',
    characterId: 'character-current',
  });
  addPlayerToRoom(SESSION, {
    userId: 'bystander-user',
    displayName: 'Bystander',
    socketId: 'bystander-socket',
    role: 'player',
    characterId: null,
  });

  broadcastEvent(mockIo(), room, 'combat:ended', {});
  broadcastTurnAdvanced(mockIo(), room, {
    currentTurnIndex: 0,
    currentCombatant,
    roundNumber: 2,
    actionEconomy: exactEconomy,
  });
  return room;
}

function replayEconomy(body: Record<string, unknown>): ActionEconomy {
  const events = body.events as Array<{ payload: { actionEconomy: ActionEconomy } }>;
  return events[0].payload.actionEconomy;
}

beforeEach(() => {
  getAllRooms().clear();
  seedRoom();
});

describe('GET /events exact-stat privacy', () => {
  it('redacts a turn event replay for an unshared bystander', async () => {
    const response = await supertest(buildApp())
      .get(`/api/sessions/${SESSION}/events?since=1`)
      .set('x-test-user', 'bystander-user');

    expect(response.status).toBe(200);
    expect(replayEconomy(response.body)).toEqual(redactedEconomy);
    expect(response.body.events[0]).not.toHaveProperty('redactedPayload');
    expect(response.body.events[0]).not.toHaveProperty('statTokenId');
  });

  it('returns exact replay details to the owner and DM', async () => {
    for (const userId of ['owner-user', 'dm-user']) {
      const response = await supertest(buildApp())
        .get(`/api/sessions/${SESSION}/events?since=1`)
        .set('x-test-user', userId);

      expect(response.status).toBe(200);
      expect(replayEconomy(response.body)).toEqual(exactEconomy);
    }
  });

  it('returns exact replay details to visible viewers when PC sharing is enabled', async () => {
    const room = getAllRooms().get(SESSION)!;
    room.showPlayersToPlayers = true;

    const response = await supertest(buildApp())
      .get(`/api/sessions/${SESSION}/events?since=1`)
      .set('x-test-user', 'bystander-user');

    expect(response.status).toBe(200);
    expect(replayEconomy(response.body)).toEqual(exactEconomy);
  });
});
