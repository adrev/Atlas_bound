import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionEconomy, Combatant, Token } from '@dnd-vtt/shared';
import { broadcastTurnAdvanced } from '../socket/combat/turnBroadcast.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

interface Emission {
  socketId: string;
  event: string;
  payload: Record<string, unknown>;
}

const exactEconomy: ActionEconomy = {
  action: true,
  bonusAction: true,
  movementRemaining: 25,
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

function token(id: string, ownerUserId: string | null, visible = true): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: `character-${id}`,
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000000',
    layer: 'token',
    visible,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#ffffff',
    conditions: [],
    ownerUserId,
    createdAt: new Date(0).toISOString(),
  };
}

function combatant(entry: Token, isNPC: boolean): Combatant {
  return {
    tokenId: entry.id,
    characterId: entry.characterId,
    name: entry.name,
    initiative: 18,
    initiativeBonus: 4,
    hp: 12,
    maxHp: 20,
    tempHp: 0,
    armorClass: 15,
    speed: 30,
    isNPC,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
  };
}

function seedRoom(currentToken: Token, isNPC: boolean): RoomState {
  const room = createRoom('turn-event-privacy', 'TURNSTAT', 'dm-user');
  room.playerMapId = 'map-1';
  room.tokens.set(currentToken.id, currentToken);
  room.combatState = {
    sessionId: room.sessionId,
    active: true,
    roundNumber: 2,
    currentTurnIndex: 0,
    combatants: [combatant(currentToken, isNPC)],
    startedAt: new Date(0).toISOString(),
  };

  addPlayerToRoom(room.sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-tab-1',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-tab-2',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-tab-1',
    role: 'player',
    characterId: 'character-current',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-tab-2',
    role: 'player',
    characterId: 'character-current',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'bystander-user',
    displayName: 'Bystander',
    socketId: 'bystander-tab',
    role: 'player',
    characterId: null,
  });
  return room;
}

function fakeIo(emissions: Emission[]) {
  return {
    to: (socketId: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emissions.push({ socketId, event, payload }),
    }),
  } as never;
}

function economyFor(emissions: Emission[], socketId: string): ActionEconomy {
  const emission = emissions.find((entry) => entry.socketId === socketId);
  return emission?.payload.actionEconomy as ActionEconomy;
}

beforeEach(() => getAllRooms().clear());

describe('combat:turn-advanced exact-stat privacy', () => {
  it('sends exact PC action economy to every DM and owner tab but redacts bystanders', () => {
    const current = token('current', 'owner-user');
    const room = seedRoom(current, false);
    const emissions: Emission[] = [];

    broadcastTurnAdvanced(fakeIo(emissions), room, {
      currentTurnIndex: 0,
      currentCombatant: room.combatState!.combatants[0],
      roundNumber: 2,
      actionEconomy: exactEconomy,
    });

    expect(emissions.map((entry) => entry.socketId).sort()).toEqual([
      'bystander-tab',
      'dm-tab-1',
      'dm-tab-2',
      'owner-tab-1',
      'owner-tab-2',
    ]);
    for (const socketId of ['dm-tab-1', 'dm-tab-2', 'owner-tab-1', 'owner-tab-2']) {
      expect(economyFor(emissions, socketId)).toEqual(exactEconomy);
    }
    expect(economyFor(emissions, 'bystander-tab')).toEqual(redactedEconomy);
    expect(emissions.every((entry) => entry.payload._eventId === 1)).toBe(true);
  });

  it('shares visible NPC action economy only when the creature toggle permits it', () => {
    const current = token('current', null);
    const room = seedRoom(current, true);
    const emissions: Emission[] = [];

    broadcastTurnAdvanced(fakeIo(emissions), room, {
      currentTurnIndex: 0,
      currentCombatant: room.combatState!.combatants[0],
      roundNumber: 2,
      actionEconomy: exactEconomy,
    });
    expect(economyFor(emissions, 'bystander-tab')).toEqual(redactedEconomy);

    room.showCreatureStatsToPlayers = true;
    emissions.length = 0;
    broadcastTurnAdvanced(fakeIo(emissions), room, {
      currentTurnIndex: 0,
      currentCombatant: room.combatState!.combatants[0],
      roundNumber: 2,
      actionEconomy: exactEconomy,
    });
    expect(economyFor(emissions, 'bystander-tab')).toEqual(exactEconomy);
  });

  it('keeps hidden NPC action economy redacted even when creature stats are shared', () => {
    const current = token('current', null, false);
    const room = seedRoom(current, true);
    room.showCreatureStatsToPlayers = true;
    const emissions: Emission[] = [];

    broadcastTurnAdvanced(fakeIo(emissions), room, {
      currentTurnIndex: 0,
      currentCombatant: room.combatState!.combatants[0],
      roundNumber: 2,
      actionEconomy: exactEconomy,
    });

    expect(economyFor(emissions, 'dm-tab-1')).toEqual(exactEconomy);
    expect(economyFor(emissions, 'bystander-tab')).toEqual(redactedEconomy);
  });

  it('stores exact and redacted variants for recipient-safe replay', () => {
    const current = token('current', 'owner-user');
    const room = seedRoom(current, false);

    broadcastTurnAdvanced(fakeIo([]), room, {
      currentTurnIndex: 0,
      currentCombatant: room.combatState!.combatants[0],
      roundNumber: 2,
      actionEconomy: exactEconomy,
    });

    expect(room.eventLog[0]).toMatchObject({
      id: 1,
      kind: 'combat:turn-advanced',
      statTokenId: 'current',
      payload: { actionEconomy: exactEconomy },
      redactedPayload: { actionEconomy: redactedEconomy },
    });
  });
});
