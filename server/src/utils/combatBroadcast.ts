import type { Server } from 'socket.io';
import { type RoomState, socketsForToken } from './roomState.js';

/** All live socket ids for the room's DMs (multi-tab aware). The safe
 *  fallback recipient set — a DM may always see everything. */
function dmSocketIds(room: RoomState): string[] {
  const out: string[] = [];
  for (const player of room.players.values()) {
    if (player.role !== 'dm') continue;
    const sockets = room.userSockets.get(player.userId);
    if (sockets && sockets.size > 0) out.push(...sockets);
    else out.push(player.socketId);
  }
  return out;
}

/**
 * Emit a token-bound combat event (HP change, condition flip, death save,
 * character sheet sync) only to clients allowed to see that token's state.
 *
 * The old code did `io.to(sessionId).emit(...)` — the whole room — which
 * leaked a HIDDEN NPC's HP / conditions / existence to every player at the
 * socket-payload level, even though the token itself and the `/state`
 * snapshot are correctly filtered. This scopes each emit:
 *   - DMs always receive it.
 *   - Players receive it only if the token is visible to them (reusing the
 *     same map + visibility rule as token move/add/update).
 *   - With `includeOwner`, the token's owning player ALSO receives it
 *     wherever they are — so a player's own PC sheet (`character:updated`)
 *     still syncs even if their token is off the viewer's map or hidden.
 *
 * If the token can't be resolved, falls back to DM-only (never leak).
 */
export function emitToTokenViewers(
  io: Server,
  room: RoomState,
  tokenId: string,
  event: string,
  payload: unknown,
  opts: { includeOwner?: boolean } = {},
): void {
  const token = room.tokens.get(tokenId);
  if (!token) {
    for (const sid of new Set(dmSocketIds(room))) io.to(sid).emit(event, payload);
    return;
  }
  const recipients = new Set(socketsForToken(room, token.mapId, token));
  if (opts.includeOwner && token.ownerUserId) {
    const ownerSockets = room.userSockets.get(token.ownerUserId);
    if (ownerSockets) for (const sid of ownerSockets) recipients.add(sid);
  }
  for (const sid of recipients) io.to(sid).emit(event, payload);
}
