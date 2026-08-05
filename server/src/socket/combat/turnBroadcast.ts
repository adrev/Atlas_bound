import type { ActionEconomy, Combatant } from '@dnd-vtt/shared';
import type { Server } from 'socket.io';
import type { RoomState } from '../../utils/roomState.js';
import { broadcastEvent } from '../../utils/eventBroadcast.js';

const REDACTED_ACTION_ECONOMY: ActionEconomy = {
  action: false,
  bonusAction: false,
  movementRemaining: 0,
  movementMax: 0,
  reaction: false,
};

interface TurnAdvanceResult {
  currentTurnIndex: number;
  currentCombatant?: Combatant | null;
  roundNumber: number;
  actionEconomy: ActionEconomy;
}

/** Broadcast turn progression to everyone while keeping exact action
 * economy private to recipients allowed to see the current combatant's
 * stats. The safe payload still advances round/turn state for players. */
export function broadcastTurnAdvanced(
  io: Server,
  room: RoomState,
  result: TurnAdvanceResult
): void {
  const currentTokenId = result.currentCombatant?.tokenId ?? null;
  const payload = {
    currentTurnIndex: result.currentTurnIndex,
    currentTokenId,
    roundNumber: result.roundNumber,
    actionEconomy: result.actionEconomy,
  };

  broadcastEvent(io, room, 'combat:turn-advanced', payload, {
    statTokenId: currentTokenId,
    redactedPayload: {
      ...payload,
      actionEconomy: REDACTED_ACTION_ECONOMY,
    },
  });
}
