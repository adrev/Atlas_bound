import { beforeEach, describe, expect, it } from 'vitest';
import type { Token } from '@dnd-vtt/shared';
import {
  createRoom,
  addPlayerToRoom,
  deleteRoom,
  getAllRooms,
  type RoomState,
} from '../utils/roomState.js';
import {
  emitMultiTokenScopedChat,
  emitTokenScopedChat,
  multiTokenScopedChatIsPrivate,
  tokenScopedChatIsPrivate,
} from '../utils/tokenScopedChat.js';

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

function channelsFor(emissions: Emission[], event = 'chat:new-message'): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}

const SESSION = 's-token-chat';

function seedRoom(tokens: Token[]): RoomState {
  const room = createRoom(SESSION, 'ROOM-TC', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  for (const token of tokens) room.tokens.set(token.id, token);
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
  return room;
}

beforeEach(() => {
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

describe('token-scoped chat map/visibility privacy', () => {
  it('keeps visible ribbon-token chat room-wide', () => {
    const room = seedRoom([tok('npc')]);
    const emissions: Emission[] = [];

    expect(tokenScopedChatIsPrivate(room, 'npc')).toBe(false);
    emitTokenScopedChat(fakeIo(emissions), room, 'npc', { content: 'visible action' });

    expect(channelsFor(emissions)).toEqual([SESSION]);
  });

  it('keeps hidden ribbon-token chat scoped to DMs and owners', () => {
    const room = seedRoom([tok('pc', { visible: false, ownerUserId: 'owner-user' })]);
    const emissions: Emission[] = [];

    expect(tokenScopedChatIsPrivate(room, 'pc')).toBe(true);
    emitTokenScopedChat(fakeIo(emissions), room, 'pc', { content: 'hidden action' });

    expect(channelsFor(emissions)).toEqual(['dm-sock', 'owner-sock']);
  });

  it('does not leak visible DM-preview token chat to players on the ribbon', () => {
    const room = seedRoom([tok('prep-npc', { mapId: 'map-2', ownerUserId: 'owner-user' })]);
    room.dmViewingMap.set('dm-user', 'map-2');
    const emissions: Emission[] = [];

    expect(tokenScopedChatIsPrivate(room, 'prep-npc')).toBe(true);
    emitTokenScopedChat(fakeIo(emissions), room, 'prep-npc', { content: 'prep action' });

    expect(channelsFor(emissions)).toEqual(['dm-sock']);
  });

  it('keeps visible multi-token ribbon chat room-wide', () => {
    const room = seedRoom([tok('attacker'), tok('target')]);
    const emissions: Emission[] = [];

    expect(multiTokenScopedChatIsPrivate(room, ['attacker', 'target'])).toBe(false);
    emitMultiTokenScopedChat(fakeIo(emissions), room, ['attacker', 'target'], {
      content: 'public attack',
    });

    expect(channelsFor(emissions)).toEqual([SESSION]);
  });

  it('does not leak visible multi-token DM-preview chat to players on the ribbon', () => {
    const room = seedRoom([
      tok('attacker', { mapId: 'map-2', ownerUserId: 'owner-user' }),
      tok('target', { mapId: 'map-2' }),
    ]);
    room.dmViewingMap.set('dm-user', 'map-2');
    const emissions: Emission[] = [];

    expect(multiTokenScopedChatIsPrivate(room, ['attacker', 'target'])).toBe(true);
    emitMultiTokenScopedChat(fakeIo(emissions), room, ['attacker', 'target'], {
      content: 'prep attack',
    });

    expect(channelsFor(emissions)).toEqual(['dm-sock']);
  });

  it('keeps hidden multi-token ribbon chat scoped to DMs and involved owners', () => {
    const room = seedRoom([
      tok('attacker', { ownerUserId: 'owner-user', conditions: ['invisible'] }),
      tok('target'),
    ]);
    const emissions: Emission[] = [];

    expect(multiTokenScopedChatIsPrivate(room, ['attacker', 'target'])).toBe(true);
    emitMultiTokenScopedChat(fakeIo(emissions), room, ['attacker', 'target'], {
      content: 'hidden attack',
    });

    expect(channelsFor(emissions)).toEqual(['dm-sock', 'owner-sock']);
  });
});
