import { socketsForToken, type RoomState } from './roomState.js';

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

/** Resolve sockets allowed to receive a full NPC character-sheet payload. */
export function npcCharacterRecipientSocketIds(
  room: RoomState,
  characterId: string,
  showCreatureStatsToPlayers: boolean
): Set<string> {
  const recipients = new Set<string>();

  // Every DM tab receives creature updates, even while previewing a
  // different scene. This mirrors full PC-sheet fanout and keeps DM panels
  // consistent without exposing the payload to players.
  for (const player of room.players.values()) {
    if (player.role !== 'dm') continue;
    const liveSockets = room.userSockets.get(player.userId);
    if (liveSockets?.size) {
      for (const socketId of liveSockets) recipients.add(socketId);
    } else {
      recipients.add(player.socketId);
    }
  }

  if (!showCreatureStatsToPlayers) return recipients;

  // Players only receive the sheet when at least one token backed by this
  // NPC is visible on their active map. Hidden/prep-map creatures remain
  // server-side secrets even when general creature sharing is enabled.
  for (const token of room.tokens.values()) {
    if (token.characterId !== characterId) continue;
    for (const socketId of socketsForToken(room, token.mapId, token)) {
      recipients.add(socketId);
    }
  }

  return recipients;
}
