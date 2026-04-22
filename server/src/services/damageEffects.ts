import type { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import type { RoomState } from '../utils/roomState.js';
import * as ConditionService from './ConditionService.js';
import { tokenConditionChanges } from '../utils/conditionSources.js';

/**
 * R2 — central "damage was applied" broadcaster. Runs the side-effect
 * pipeline (concentration save, endsOnDamage conditions, saveOnDamage
 * re-rolls) and fans out the resulting token updates, character clears,
 * and system chat lines. Every code path that reduces a token's HP
 * should funnel through here so concentration breaks always happen —
 * regardless of whether damage came from combat:damage, cast resolver,
 * !damage chat command, OA reflex, etc.
 *
 * The old flow put this behind a separate `damage:side-effects` event
 * that the client had to opt into, so a DM ticking HP down directly
 * (or a chat macro) silently skipped the save. Now it runs server-side
 * the moment HP actually changes.
 */
export async function applyDamageSideEffects(
  io: Server,
  room: RoomState,
  tokenId: string,
  damageAmount: number,
): Promise<void> {
  if (!Number.isFinite(damageAmount) || damageAmount <= 0) return;

  const result = await ConditionService.processDamageSideEffects(
    room.sessionId,
    tokenId,
    damageAmount,
  );

  for (const affectedTokenId of result.affectedTokens) {
    const t = room.tokens.get(affectedTokenId);
    if (t) {
      io.to(room.sessionId).emit('map:token-updated', {
        tokenId: affectedTokenId,
        changes: tokenConditionChanges(room, affectedTokenId),
      });
    }
  }

  if (result.droppedConcentration) {
    const t = room.tokens.get(tokenId);
    if (t?.characterId) {
      io.to(room.sessionId).emit('character:updated', {
        characterId: t.characterId,
        changes: { concentratingOn: null },
      });
    }
  }

  if (result.messages.length > 0) {
    const now = new Date().toISOString();
    for (const msg of result.messages) {
      io.to(room.sessionId).emit('chat:new-message', {
        id: uuidv4(),
        sessionId: room.sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: msg,
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: now,
      });
    }
  }
}
