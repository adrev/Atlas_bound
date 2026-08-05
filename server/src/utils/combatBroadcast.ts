import type { Server } from 'socket.io';
import type { Token } from '@dnd-vtt/shared';
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

/** NPC-ness for stat privacy. During combat the combatant's `isNPC` is
 *  authoritative (it folds in the character row's `user_id === 'npc'`);
 *  outside combat an ownerless token is a creature. */
function tokenIsNpc(room: RoomState, token: Token): boolean {
  const combatant = room.combatState?.combatants.find((c) => c.tokenId === token.id);
  if (combatant) return combatant.isNPC;
  return !token.ownerUserId;
}

/** Whether the room's sharing settings let non-owner players see this
 *  token's exact numbers. Mirrors `canReceiveCombatantStats` for the
 *  live-event layer: creatures gate on `showCreatureStatsToPlayers`,
 *  player characters on `showPlayersToPlayers`. */
export function tokenStatsSharedWithPlayers(room: RoomState, token: Token): boolean {
  return tokenIsNpc(room, token) ? room.showCreatureStatsToPlayers : room.showPlayersToPlayers;
}

/**
 * Emit an EXACT-stat combat payload (precise HP/temp HP, character sheet
 * HP/death-saves/version, death-save counters, action economy, movement)
 * only to clients allowed to see those numbers:
 *   - every DM tab, always;
 *   - every tab of the token's owning player, wherever they are;
 *   - other players only if the token is visible to them AND the relevant
 *     sharing toggle (`showCreatureStatsToPlayers` for creatures,
 *     `showPlayersToPlayers` for PCs) permits it.
 *
 * `emitToTokenViewers` scopes by token VISIBILITY only, which is right for
 * condition badges and token visuals but still leaks exact numbers the
 * `/state` snapshot and `combat:state-sync` deliberately redact. Route
 * numeric payloads through here instead so the socket layer matches the
 * snapshot privacy. Unresolved token → DM-only (never leak).
 */
export function emitToTokenStatViewers(
  io: Server,
  room: RoomState,
  tokenId: string,
  event: string,
  payload: unknown,
): void {
  const recipients = new Set(dmSocketIds(room));
  const token = room.tokens.get(tokenId);
  if (token) {
    if (token.ownerUserId) {
      const ownerSockets = room.userSockets.get(token.ownerUserId);
      if (ownerSockets) for (const sid of ownerSockets) recipients.add(sid);
    }
    if (tokenStatsSharedWithPlayers(room, token)) {
      for (const sid of socketsForToken(room, token.mapId, token)) recipients.add(sid);
    }
  }
  for (const sid of recipients) io.to(sid).emit(event, payload);
}
