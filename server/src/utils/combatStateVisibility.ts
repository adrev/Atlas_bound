import type { Server } from 'socket.io';
import type { Combatant } from '@dnd-vtt/shared';
import type { RoomPlayer, RoomState } from './roomState.js';
import { tokenVisibleToPlayer } from './tokenVisibility.js';

export function combatantsVisibleTo(
  room: RoomState,
  combatants: Combatant[],
  recipient: Pick<RoomPlayer, 'userId' | 'role'>
): Combatant[] {
  if (recipient.role === 'dm') return combatants;
  return combatants.filter((combatant) => {
    const token = room.tokens.get(combatant.tokenId);
    return token ? tokenVisibleToPlayer(token, recipient.userId) : false;
  });
}

export function emitCombatStateSync(io: Server, room: RoomState): void {
  const state = room.combatState;
  if (!state?.active) return;

  const currentCombatant = state.combatants[state.currentTurnIndex] ?? null;
  const actionEconomy = currentCombatant
    ? room.actionEconomies.get(currentCombatant.tokenId)
    : undefined;
  const currentTokenId = currentCombatant?.tokenId ?? null;
  const fallbackEconomy = {
    action: false,
    bonusAction: false,
    movementRemaining: currentCombatant?.speed ?? 30,
    movementMax: currentCombatant?.speed ?? 30,
    reaction: false,
  };

  for (const player of room.players.values()) {
    const sockets = room.userSockets.get(player.userId) ?? new Set([player.socketId]);
    const combatants = combatantsVisibleTo(room, state.combatants, player);
    for (const socketId of sockets) {
      io.to(socketId).emit('combat:state-sync', {
        combatants,
        roundNumber: state.roundNumber,
        currentTurnIndex: state.currentTurnIndex,
        currentTokenId,
        actionEconomy: actionEconomy ?? fallbackEconomy,
      });
    }
  }
}
