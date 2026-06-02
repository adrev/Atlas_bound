import type { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import type { RoomState } from '../utils/roomState.js';
import * as ConditionService from './ConditionService.js';
import { tokenConditionChanges } from '../utils/conditionSources.js';
import pool from '../db/connection.js';
import { emitToTokenViewers } from '../utils/combatBroadcast.js';
import { tokenVisibleToPlayer } from '../utils/tokenVisibility.js';

function sideEffectChatIsPrivate(room: RoomState, tokenId: string): boolean {
  const token = room.tokens.get(tokenId);
  if (!token) return true;

  for (const player of room.players.values()) {
    if (player.role === 'dm') continue;
    if (!tokenVisibleToPlayer(token, player.userId)) return true;
  }
  return false;
}

function emitSideEffectChat(
  io: Server,
  room: RoomState,
  tokenId: string,
  payload: Record<string, unknown>,
): void {
  if (sideEffectChatIsPrivate(room, tokenId)) {
    emitToTokenViewers(io, room, tokenId, 'chat:new-message', payload, { includeOwner: true });
    return;
  }
  io.to(room.sessionId).emit('chat:new-message', payload);
}

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
      emitToTokenViewers(io, room, affectedTokenId, 'map:token-updated', {
        tokenId: affectedTokenId,
        changes: tokenConditionChanges(room, affectedTokenId),
      });
    }
  }

  if (result.droppedConcentration) {
    const t = room.tokens.get(tokenId);
    if (t?.characterId) {
      emitToTokenViewers(io, room, tokenId, 'character:updated', {
        characterId: t.characterId,
        changes: { concentratingOn: null },
      }, { includeOwner: true });
    }
  }

  // Concentration save — emit as a standalone SaveResultCard so the
  // CON save math (War Caster adv source, prof/mod decomposition,
  // drop/maintain outcome) renders transparently. The other
  // side-effect messages (Sleep ending, Hideous Laughter retry) stay
  // as plain chat lines since they're simpler.
  if (result.concentrationSave) {
    const msgId = uuidv4();
    const createdAt = new Date().toISOString();
    const concSave = result.concentrationSave;
    const hidden = sideEffectChatIsPrivate(room, tokenId);
    const content = concSave.passed
      ? `\uD83C\uDFAF ${concSave.roller.name} maintained concentration on ${concSave.concentration?.spellName ?? 'spell'} (CON save ${concSave.total} vs DC ${concSave.dc})`
      : `\u26A1 ${concSave.roller.name} lost concentration on ${concSave.concentration?.spellName ?? 'spell'} (CON save ${concSave.total} vs DC ${concSave.dc})`;
    pool.query(
      `INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, character_name, save_result, hidden, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [msgId, room.sessionId, 'system', 'System', 'system', content, null,
       JSON.stringify(concSave), hidden ? 1 : 0, createdAt],
    ).catch((e) => console.warn('[damageEffects] persist concentration save failed:', e));
    emitSideEffectChat(io, room, tokenId, {
      id: msgId,
      sessionId: room.sessionId,
      userId: 'system',
      displayName: 'System',
      type: 'system',
      content,
      characterName: null,
      whisperTo: null,
      rollData: null,
      saveResult: concSave,
      hidden,
      createdAt,
    });
  }

  // Remaining side-effect messages (Sleep wake, Hideous Laughter save
  // retry). Skip the concentration line since we already rendered it
  // as a structured card above. The original plain-text stays as a
  // fallback for the pre-card clients.
  const remainingMessages = result.concentrationSave
    ? result.messages.filter((m) =>
        !m.includes('concentration on') &&
        !m.startsWith('   \u2934'))
    : result.messages;
  if (remainingMessages.length > 0) {
    const now = new Date().toISOString();
    const hidden = sideEffectChatIsPrivate(room, tokenId);
    for (const msg of remainingMessages) {
      emitSideEffectChat(io, room, tokenId, {
        id: uuidv4(),
        sessionId: room.sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: msg,
        characterName: null,
        whisperTo: null,
        rollData: null,
        hidden,
        createdAt: now,
      });
    }
  }
}
