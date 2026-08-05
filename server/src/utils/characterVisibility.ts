import type { RoomState } from './roomState.js';

interface CharacterVisibilityInput {
  recipientUserId: string;
  recipientRole: 'dm' | 'player';
  characterOwnerUserId: string;
  showPlayersToPlayers: boolean;
}

/** Full character sheets contain private notes, inventory, and spell data. */
export function canReceiveFullCharacter({
  recipientUserId,
  recipientRole,
  characterOwnerUserId,
  showPlayersToPlayers,
}: CharacterVisibilityInput): boolean {
  return recipientRole === 'dm' || recipientUserId === characterOwnerUserId || showPlayersToPlayers;
}

/** Resolve every live tab allowed to receive a full character-sheet payload. */
export function fullCharacterRecipientSocketIds(
  room: RoomState,
  characterOwnerUserId: string,
  showPlayersToPlayers: boolean
): Set<string> {
  const recipients = new Set<string>();
  for (const player of room.players.values()) {
    if (
      !canReceiveFullCharacter({
        recipientUserId: player.userId,
        recipientRole: player.role,
        characterOwnerUserId,
        showPlayersToPlayers,
      })
    ) {
      continue;
    }

    const liveSockets = room.userSockets.get(player.userId);
    if (liveSockets?.size) {
      for (const socketId of liveSockets) recipients.add(socketId);
    } else {
      recipients.add(player.socketId);
    }
  }
  return recipients;
}
