import { v4 as uuidv4 } from 'uuid';
import type { Server, Socket } from 'socket.io';
import {
  getPlayerBySocketId, isCurrentTurnOwnerOrDM, isTokenActionable,
} from '../../utils/roomState.js';
import * as CombatService from '../../services/CombatService.js';
import {
  combatUseActionSchema, combatUseMovementSchema,
} from '../../utils/validation.js';
import { safeHandler } from '../../utils/socketHelpers.js';

/**
 * Action-economy events: use-action / use-movement / dash.
 * Gate: only the current turn's owner (or DM) can consume these,
 * and the current combatant must be actionable (not stunned etc.).
 */
export function registerCombatActions(io: Server, socket: Socket): void {
  socket.on('combat:use-action', safeHandler(socket, async (data) => {
    const parsed = combatUseActionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

    // Block downed tokens from consuming action economy. DMs bypass \u2014
    // they may tick action/bonus on an NPC in edge cases.
    if (ctx.player.role !== 'dm') {
      const currentCombatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
      if (currentCombatant && !isTokenActionable(ctx, currentCombatant.tokenId)) return;
    }

    const economy = CombatService.useAction(ctx.room.sessionId, parsed.data.actionType);
    if (!economy) return;

    const combatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
    if (!combatant) return;

    io.to(ctx.room.sessionId).emit('combat:action-used', {
      tokenId: combatant.tokenId,
      actionType: parsed.data.actionType,
      economy,
    });
  }));

  socket.on('combat:use-movement', safeHandler(socket, async (data) => {
    const parsed = combatUseMovementSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

    if (ctx.player.role !== 'dm') {
      const currentCombatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
      if (currentCombatant && !isTokenActionable(ctx, currentCombatant.tokenId)) return;
    }

    const remaining = CombatService.useMovement(ctx.room.sessionId, parsed.data.feet);

    const combatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
    if (!combatant) return;

    io.to(ctx.room.sessionId).emit('combat:movement-used', {
      tokenId: combatant.tokenId,
      remaining,
    });
  }));

  // ----------------------------------------------------------------------
  // combat:dash \u2014 take the Dash action: consume Action slot AND double
  // the current combatant's movement pool for the turn. We broadcast
  // combat:action-used with the updated economy (the client picks up
  // the new movementMax + movementRemaining from the same payload).
  // ----------------------------------------------------------------------
  socket.on('combat:dash', safeHandler(socket, async () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

    if (ctx.player.role !== 'dm') {
      const currentCombatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
      if (currentCombatant && !isTokenActionable(ctx, currentCombatant.tokenId)) return;
    }

    const economy = CombatService.useDash(ctx.room.sessionId);
    if (!economy) return;

    const combatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
    if (!combatant) return;

    io.to(ctx.room.sessionId).emit('combat:action-used', {
      tokenId: combatant.tokenId,
      actionType: 'action',
      economy,
    });

    io.to(ctx.room.sessionId).emit('chat:new-message', {
      id: uuidv4(),
      sessionId: ctx.room.sessionId,
      userId: 'system',
      displayName: 'System',
      type: 'system',
      content: `\uD83C\uDFC3 ${combatant.name} takes the Dash action (+${combatant.speed} ft movement)`,
      characterName: null,
      whisperTo: null,
      rollData: null,
      createdAt: new Date().toISOString(),
    });
  }));
}
