import type { Server } from 'socket.io';
import type { RoomState } from './roomState.js';

/**
 * Private Wild Shape sheet sync. Exact form HP (and the uses pool) is
 * owner/DM material: `emitToTokenStatViewers` widens to other players
 * under the room's sharing toggles, so payloads carrying an active
 * form's numbers must NOT travel through it. This emits
 * `character:updated` to every DM tab and every tab of the owning
 * player only — bystanders never receive it, regardless of toggles.
 */
export function emitWildShapePrivate(
  io: Server,
  room: RoomState,
  characterId: string,
  changes: Record<string, unknown>
): void {
  const recipients = new Set<string>();
  const addUserSockets = (userId: string, fallbackSocketId?: string) => {
    const sockets = room.userSockets.get(userId);
    if (sockets && sockets.size > 0) for (const sid of sockets) recipients.add(sid);
    else if (fallbackSocketId) recipients.add(fallbackSocketId);
  };
  for (const player of room.players.values()) {
    if (player.role !== 'dm' && player.characterId !== characterId) continue;
    addUserSockets(player.userId, player.socketId);
  }
  // The owner of a token linked to this character also counts, even
  // when their room entry isn't linked to the sheet (DM-assigned
  // token ownership).
  for (const token of room.tokens.values()) {
    if (token.characterId === characterId && token.ownerUserId) {
      addUserSockets(token.ownerUserId);
    }
  }
  for (const sid of recipients) {
    io.to(sid).emit('character:updated', { characterId, changes });
  }
}
