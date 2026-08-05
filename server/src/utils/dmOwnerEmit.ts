import type { Server } from 'socket.io';
import type { RoomState } from './roomState.js';

/**
 * DM + owning-player-only fanout for full-fidelity character payloads
 * (exact inventory / attunement state). Unlike the stat-sharing helpers,
 * this policy is fixed: every live DM tab and every live tab of the
 * owning player receive the payload; other players never do, regardless
 * of the room's sharing toggles.
 */
export function dmAndOwnerSocketIds(room: RoomState, ownerUserId: string | null): Set<string> {
  const recipients = new Set<string>();
  for (const player of room.players.values()) {
    if (player.role !== 'dm' && player.userId !== ownerUserId) continue;
    const liveSockets = room.userSockets.get(player.userId);
    if (liveSockets?.size) {
      for (const socketId of liveSockets) recipients.add(socketId);
    } else {
      recipients.add(player.socketId);
    }
  }
  return recipients;
}

export function emitToDmAndOwner(
  io: Server,
  room: RoomState,
  ownerUserId: string | null,
  event: string,
  payload: Record<string, unknown>
): void {
  for (const socketId of dmAndOwnerSocketIds(room, ownerUserId)) {
    io.to(socketId).emit(event, payload);
  }
}
