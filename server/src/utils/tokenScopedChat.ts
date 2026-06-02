import type { Server } from 'socket.io';
import type { RoomState } from './roomState.js';
import { tokenVisibleToPlayer } from './tokenVisibility.js';
import { emitToTokenViewers } from './combatBroadcast.js';

export function tokenScopedChatIsPrivate(room: RoomState, tokenId: string): boolean {
  const token = room.tokens.get(tokenId);
  if (!token) return true;

  for (const player of room.players.values()) {
    if (player.role === 'dm') continue;
    if (!tokenVisibleToPlayer(token, player.userId)) return true;
  }
  return false;
}

export function emitTokenScopedChat(
  io: Server,
  room: RoomState,
  tokenId: string,
  payload: Record<string, unknown>,
): void {
  if (tokenScopedChatIsPrivate(room, tokenId)) {
    emitToTokenViewers(io, room, tokenId, 'chat:new-message', payload, { includeOwner: true });
    return;
  }
  io.to(room.sessionId).emit('chat:new-message', payload);
}
