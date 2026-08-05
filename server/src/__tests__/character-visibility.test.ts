import { afterEach, describe, expect, it } from 'vitest';
import {
  canReceiveFullCharacter,
  fullCharacterRecipientSocketIds,
} from '../utils/characterVisibility.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';

afterEach(() => {
  getAllRooms().clear();
});

describe('full character visibility', () => {
  it('allows DMs and the owner while hiding the sheet from other players by default', () => {
    expect(
      canReceiveFullCharacter({
        recipientUserId: 'dm',
        recipientRole: 'dm',
        characterOwnerUserId: 'owner',
        showPlayersToPlayers: false,
      })
    ).toBe(true);
    expect(
      canReceiveFullCharacter({
        recipientUserId: 'owner',
        recipientRole: 'player',
        characterOwnerUserId: 'owner',
        showPlayersToPlayers: false,
      })
    ).toBe(true);
    expect(
      canReceiveFullCharacter({
        recipientUserId: 'other',
        recipientRole: 'player',
        characterOwnerUserId: 'owner',
        showPlayersToPlayers: false,
      })
    ).toBe(false);
  });

  it('fans full-sheet sync to every allowed live tab without room-wide leakage', () => {
    const room = createRoom('character-visibility', 'CHARVIS', 'dm');
    addPlayerToRoom(room.sessionId, {
      userId: 'dm',
      displayName: 'DM',
      socketId: 'dm-1',
      role: 'dm',
      characterId: null,
    });
    addPlayerToRoom(room.sessionId, {
      userId: 'dm',
      displayName: 'DM',
      socketId: 'dm-2',
      role: 'dm',
      characterId: null,
    });
    addPlayerToRoom(room.sessionId, {
      userId: 'owner',
      displayName: 'Owner',
      socketId: 'owner-1',
      role: 'player',
      characterId: 'char-1',
    });
    addPlayerToRoom(room.sessionId, {
      userId: 'other',
      displayName: 'Other',
      socketId: 'other-1',
      role: 'player',
      characterId: 'char-2',
    });

    expect(Array.from(fullCharacterRecipientSocketIds(room, 'owner', false)).sort()).toEqual([
      'dm-1',
      'dm-2',
      'owner-1',
    ]);
    expect(Array.from(fullCharacterRecipientSocketIds(room, 'owner', true)).sort()).toEqual([
      'dm-1',
      'dm-2',
      'other-1',
      'owner-1',
    ]);
  });
});
