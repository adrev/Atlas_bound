import type { Server } from 'socket.io';
import type { RoomState } from './roomState.js';
import { tokenVisibleToPlayer } from './tokenVisibility.js';
import { emitToTokenViewers } from './combatBroadcast.js';

function liveSocketIdsForUser(room: RoomState, userId: string, fallbackSocketId?: string): string[] {
  const liveSockets = room.userSockets.get(userId);
  if (liveSockets && liveSockets.size > 0) return [...liveSockets];
  return fallbackSocketId ? [fallbackSocketId] : [];
}

export function tokenScopedChatIsPrivate(room: RoomState, tokenId: string): boolean {
  const token = room.tokens.get(tokenId);
  if (!token) return true;

  for (const player of room.players.values()) {
    if (player.role === 'dm') continue;
    if (!tokenVisibleToPlayer(token, player.userId)) return true;
  }
  return false;
}

export function multiTokenScopedChatIsPrivate(room: RoomState, tokenIds: string[]): boolean {
  const tokens = tokenIds.map(tokenId => room.tokens.get(tokenId));
  if (tokens.some(token => !token)) return true;

  for (const player of room.players.values()) {
    if (player.role === 'dm') continue;
    if (tokens.some(token => token && !tokenVisibleToPlayer(token, player.userId))) return true;
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

export function emitMultiTokenScopedChat(
  io: Server,
  room: RoomState,
  tokenIds: string[],
  payload: Record<string, unknown>,
): void {
  const tokens = tokenIds.map(tokenId => room.tokens.get(tokenId)).filter(token => !!token);

  if (!multiTokenScopedChatIsPrivate(room, tokenIds)) {
    io.to(room.sessionId).emit('chat:new-message', payload);
    return;
  }

  const recipients = new Set<string>();
  for (const player of room.players.values()) {
    if (player.role === 'dm') {
      for (const sid of liveSocketIdsForUser(room, player.userId, player.socketId)) recipients.add(sid);
      continue;
    }

    const ownsInvolvedToken = tokens.some(token => token.ownerUserId === player.userId);
    const canSeeAllInvolvedTokens = tokens.length === tokenIds.length &&
      tokens.every(token => tokenVisibleToPlayer(token, player.userId));
    if (!ownsInvolvedToken && !canSeeAllInvolvedTokens) continue;

    for (const sid of liveSocketIdsForUser(room, player.userId, player.socketId)) recipients.add(sid);
  }

  for (const sid of recipients) io.to(sid).emit('chat:new-message', payload);
}
