import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Combatant, Token } from '@dnd-vtt/shared';

vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import {
  emitAllInitiativesReadyForRecipients,
  emitInitiativeSetForRecipients,
} from '../socket/combat/initiativeEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

interface Emission {
  socketId: string;
  event: string;
  payload: Record<string, unknown>;
}

function fakeIo(emissions: Emission[]) {
  return {
    to: (socketId: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emissions.push({ socketId, event, payload }),
    }),
  } as never;
}

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

function combatant(tokenId: string, isNPC: boolean): Combatant {
  return {
    tokenId,
    characterId: `character-${tokenId}`,
    name: tokenId,
    initiative: 19,
    initiativeBonus: 4,
    hp: 9,
    maxHp: 12,
    tempHp: 0,
    armorClass: 16,
    speed: 30,
    isNPC,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
  };
}

function seedRoom(): RoomState {
  const room = createRoom('initiative-privacy', 'INIT', 'dm-user');
  room.playerMapId = 'map-1';
  addPlayerToRoom(room.sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-socket',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'owner-user',
    displayName: 'Owner',
    socketId: 'owner-socket',
    role: 'player',
    characterId: 'character-pc',
  });
  addPlayerToRoom(room.sessionId, {
    userId: 'viewer-user',
    displayName: 'Viewer',
    socketId: 'viewer-socket',
    role: 'player',
    characterId: null,
  });
  room.tokens.set('npc', token('npc', null));
  room.tokens.set('pc', token('pc', 'owner-user'));
  room.tokens.set('hidden', token('hidden', null, false));
  return room;
}

beforeEach(() => getAllRooms().clear());

describe('initiative event privacy', () => {
  it('sends an unshared NPC roll only to DMs', () => {
    const room = seedRoom();
    const emissions: Emission[] = [];

    emitInitiativeSetForRecipients(fakeIo(emissions), room, combatant('npc', true), {
      tokenId: 'npc',
      roll: 15,
      bonus: 4,
      total: 19,
    });

    expect(emissions.map((entry) => entry.socketId)).toEqual(['dm-socket']);
  });

  it('sends a PC roll to its owner and every DM tab but not other players', () => {
    const room = seedRoom();
    addPlayerToRoom(room.sessionId, {
      userId: 'dm-user',
      displayName: 'DM',
      socketId: 'dm-socket-2',
      role: 'dm',
      characterId: null,
    });
    const emissions: Emission[] = [];

    emitInitiativeSetForRecipients(fakeIo(emissions), room, combatant('pc', false), {
      tokenId: 'pc',
      roll: 15,
      bonus: 4,
      total: 19,
    });

    expect(emissions.map((entry) => entry.socketId).sort()).toEqual([
      'dm-socket',
      'dm-socket-2',
      'owner-socket',
    ]);
  });

  it('allows exact NPC initiative only when the DM enables creature sharing', () => {
    const room = seedRoom();
    room.showCreatureStatsToPlayers = true;
    const emissions: Emission[] = [];

    emitInitiativeSetForRecipients(fakeIo(emissions), room, combatant('npc', true), {
      tokenId: 'npc',
      roll: 15,
      bonus: 4,
      total: 19,
    });

    expect(emissions.map((entry) => entry.socketId).sort()).toEqual([
      'dm-socket',
      'owner-socket',
      'viewer-socket',
    ]);
  });

  it('redacts sorted visible combatants and omits hidden ones for players', () => {
    const room = seedRoom();
    const emissions: Emission[] = [];
    emitAllInitiativesReadyForRecipients(fakeIo(emissions), room, [
      combatant('npc', true),
      combatant('pc', false),
      combatant('hidden', true),
    ]);

    const viewer = emissions.find((entry) => entry.socketId === 'viewer-socket')!;
    const viewerCombatants = viewer.payload.combatants as Combatant[];
    expect(viewerCombatants.map((entry) => entry.tokenId)).toEqual(['npc', 'pc']);
    expect(viewerCombatants[0].initiative).toBe(0);
    expect(viewerCombatants[1].initiative).toBe(0);

    const owner = emissions.find((entry) => entry.socketId === 'owner-socket')!;
    const ownerCombatants = owner.payload.combatants as Combatant[];
    expect(ownerCombatants.find((entry) => entry.tokenId === 'pc')?.initiative).toBe(19);
  });
});
