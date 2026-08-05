import { beforeEach, describe, expect, it } from 'vitest';
import type { Token } from '@dnd-vtt/shared';
import { broadcastEvent } from '../utils/eventBroadcast.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

interface Emission {
  socketId: string;
  payload: Record<string, unknown>;
}

const exactPayload = {
  characterId: 'character-owner',
  changes: { hitPoints: 20, spellSlots: { 1: { max: 2, used: 0 } }, version: 7 },
};
const redactedPayload = { characterId: 'character-owner', changes: {} };

function seedRoom(): RoomState {
  const room = createRoom('character-event-privacy', 'CHARSTAT', 'dm-user');
  room.playerMapId = 'map-1';
  for (const [userId, socketId, role, characterId] of [
    ['dm-user', 'dm-tab-1', 'dm', null],
    ['dm-user', 'dm-tab-2', 'dm', null],
    ['owner-user', 'owner-tab-1', 'player', 'character-owner'],
    ['owner-user', 'owner-tab-2', 'player', 'character-owner'],
    ['bystander-user', 'bystander-tab', 'player', null],
  ] as const) {
    addPlayerToRoom(room.sessionId, {
      userId,
      displayName: userId,
      socketId,
      role,
      characterId,
    });
  }
  return room;
}

function fakeIo(emissions: Emission[]) {
  return {
    to: (socketId: string) => ({
      emit: (_event: string, payload: Record<string, unknown>) =>
        emissions.push({ socketId, payload }),
    }),
  } as never;
}

function payloadFor(emissions: Emission[], socketId: string): Record<string, unknown> {
  return emissions.find((entry) => entry.socketId === socketId)!.payload;
}

function token(ownerUserId: string | null): Token {
  return {
    id: 'token-current',
    mapId: 'map-1',
    characterId: 'character-owner',
    name: 'Current',
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
    ownerUserId,
    createdAt: new Date(0).toISOString(),
  };
}

beforeEach(() => getAllRooms().clear());

describe('character event exact-stat privacy', () => {
  it('fans tokenless updates to every DM and owner tab while redacting bystanders', () => {
    const room = seedRoom();
    const emissions: Emission[] = [];

    broadcastEvent(fakeIo(emissions), room, 'character:updated', exactPayload, {
      statCharacterId: 'character-owner',
      redactedPayload,
    });

    expect(emissions.map((entry) => entry.socketId).sort()).toEqual([
      'bystander-tab',
      'dm-tab-1',
      'dm-tab-2',
      'owner-tab-1',
      'owner-tab-2',
    ]);
    for (const socketId of ['dm-tab-1', 'dm-tab-2', 'owner-tab-1', 'owner-tab-2']) {
      expect(payloadFor(emissions, socketId)).toMatchObject(exactPayload);
    }
    expect(payloadFor(emissions, 'bystander-tab')).toMatchObject(redactedPayload);
  });

  it('shares a linked PC update with bystanders only when party sheets are enabled', () => {
    const room = seedRoom();
    room.showPlayersToPlayers = true;
    const emissions: Emission[] = [];

    broadcastEvent(fakeIo(emissions), room, 'character:updated', exactPayload, {
      statCharacterId: 'character-owner',
      redactedPayload,
    });

    expect(payloadFor(emissions, 'bystander-tab')).toMatchObject(exactPayload);
  });

  it('fails an unlinked character closed to DMs even when party sharing is enabled', () => {
    const room = seedRoom();
    room.showPlayersToPlayers = true;
    const emissions: Emission[] = [];

    broadcastEvent(fakeIo(emissions), room, 'character:updated', exactPayload, {
      statCharacterId: 'unknown-character',
      redactedPayload,
    });

    expect(payloadFor(emissions, 'dm-tab-1')).toMatchObject(exactPayload);
    expect(payloadFor(emissions, 'owner-tab-1')).toMatchObject(redactedPayload);
    expect(payloadFor(emissions, 'bystander-tab')).toMatchObject(redactedPayload);
  });

  it('uses token sharing outside combat when a protected token exists', () => {
    const room = seedRoom();
    room.tokens.set('token-current', token(null));
    room.showCreatureStatsToPlayers = true;
    const emissions: Emission[] = [];

    broadcastEvent(fakeIo(emissions), room, 'character:updated', exactPayload, {
      statTokenId: 'token-current',
      statCharacterId: 'character-owner',
      redactedPayload,
    });

    expect(payloadFor(emissions, 'bystander-tab')).toMatchObject(exactPayload);
    expect(room.eventLog[0]).toMatchObject({
      statTokenId: 'token-current',
      statCharacterId: 'character-owner',
      redactedPayload,
    });
  });
});
