import type { Server } from 'socket.io';
import type { ActionEconomy, Combatant } from '@dnd-vtt/shared';
import type { RoomPlayer, RoomState } from './roomState.js';
import { tokenVisibleToPlayer } from './tokenVisibility.js';

export function canReceiveCombatantStats(
  room: RoomState,
  combatant: Combatant,
  recipient: Pick<RoomPlayer, 'userId' | 'role'>
): boolean {
  if (recipient.role === 'dm') return true;
  const token = room.tokens.get(combatant.tokenId);
  if (token?.ownerUserId === recipient.userId) return true;
  return combatant.isNPC ? room.showCreatureStatsToPlayers : room.showPlayersToPlayers;
}

/** Preserve only the coarse health narration shown by the player tracker. */
function redactedHealth(hp: number, maxHp: number): { hp: number; maxHp: number } {
  if (hp <= 0) return { hp: 0, maxHp: 4 };
  const ratio = maxHp > 0 ? hp / maxHp : 1;
  if (ratio <= 0.25) return { hp: 1, maxHp: 4 };
  if (ratio <= 0.5) return { hp: 2, maxHp: 4 };
  return { hp: 4, maxHp: 4 };
}

function redactCombatantStats(combatant: Combatant): Combatant {
  const health = redactedHealth(combatant.hp, combatant.maxHp);
  return {
    ...combatant,
    initiative: 0,
    initiativeBonus: 0,
    hp: health.hp,
    maxHp: health.maxHp,
    tempHp: 0,
    armorClass: 0,
    speed: 0,
    deathSaves: { successes: 0, failures: 0 },
    deathSaveRolledRound: undefined,
    exhaustionLevel: undefined,
    hasAlert: undefined,
    surprised: undefined,
    initiativeBreakdown: undefined,
  };
}

export function combatantsVisibleTo(
  room: RoomState,
  combatants: Combatant[],
  recipient: Pick<RoomPlayer, 'userId' | 'role'>
): Combatant[] {
  if (recipient.role === 'dm') return combatants;
  return combatants
    .filter((combatant) => {
      const token = room.tokens.get(combatant.tokenId);
      return token ? tokenVisibleToPlayer(token, recipient.userId) : false;
    })
    .map((combatant) =>
      canReceiveCombatantStats(room, combatant, recipient)
        ? combatant
        : redactCombatantStats(combatant)
    );
}

export function actionEconomyVisibleTo(
  room: RoomState,
  currentCombatant: Combatant | null,
  actionEconomy: ActionEconomy,
  recipient: Pick<RoomPlayer, 'userId' | 'role'>
): ActionEconomy {
  if (currentCombatant && canReceiveCombatantStats(room, currentCombatant, recipient)) {
    return actionEconomy;
  }
  return {
    action: false,
    bonusAction: false,
    movementRemaining: 0,
    movementMax: 0,
    reaction: false,
  };
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
        actionEconomy: actionEconomyVisibleTo(
          room,
          currentCombatant,
          actionEconomy ?? fallbackEconomy,
          player
        ),
      });
    }
  }
}
