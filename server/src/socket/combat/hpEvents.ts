import type { Server, Socket } from 'socket.io';
import {
  getPlayerBySocketId, canTargetToken, isTokenOwnerOrDM,
  isTokenActionable,
} from '../../utils/roomState.js';
import * as CombatService from '../../services/CombatService.js';
import * as DiscordService from '../../services/DiscordService.js';
import * as DiceService from '../../services/DiceService.js';
import { applyDamageSideEffects } from '../../services/damageEffects.js';
import {
  combatDamageSchema, combatHealSchema, combatDeathSaveSchema,
} from '../../utils/validation.js';
import { safeHandler } from '../../utils/socketHelpers.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection.js';
import type { SaveBreakdown } from '@dnd-vtt/shared';

/**
 * HP-change events: damage, heal, and death saves. The damage path
 * also triggers the damage-side-effects pipeline (concentration save,
 * Sleep break, etc.) via applyDamageSideEffects so every damage source
 * runs the same post-HP-change rules.
 */
export function registerCombatHp(io: Server, socket: Socket): void {
  socket.on('combat:damage', safeHandler(socket, async (data) => {
    const parsed = combatDamageSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Target token must exist in this room.
    const targetToken = ctx.room.tokens.get(parsed.data.tokenId);
    if (!targetToken) return;

    // Defense in depth beyond the Zod cap \u2014 reject any non-finite or
    // implausibly large amount even if the schema is relaxed later.
    const amount = parsed.data.amount;
    if (!Number.isFinite(amount) || amount < 0 || amount > 9999) return;

    // Existing targeting rule (players \u2192 NPCs or self-tokens only; DM can
    // hit anyone). Kept as the primary cross-player anti-grief check.
    if (!canTargetToken(ctx, parsed.data.tokenId)) return;

    // Additional combat-turn restriction: during active combat, a player
    // may only apply damage while their own token is the current turn,
    // AND that token must be alive (HP > 0, not unconscious/dead).
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const combatState = ctx.room.combatState;
      if (combatState?.active) {
        const currentCombatant = combatState.combatants[combatState.currentTurnIndex];
        if (!currentCombatant) return;
        const turnToken = ctx.room.tokens.get(currentCombatant.tokenId);
        if (!turnToken || turnToken.ownerUserId !== ctx.player.userId) return;
        if (!isTokenActionable(ctx, currentCombatant.tokenId)) return;
      }
    }

    try {
      const result = await CombatService.applyDamage(ctx.room.sessionId, parsed.data.tokenId, parsed.data.amount);
      io.to(ctx.room.sessionId).emit('combat:hp-changed', {
        tokenId: parsed.data.tokenId,
        hp: result.hp,
        tempHp: result.tempHp,
        change: result.change,
        type: 'damage',
      });
      // Fan out a character update so sheet views stay in sync with the
      // combat tracker. Without this the character store keeps the old
      // HP and the owning player sees themselves alive even after the
      // combatant is at 0.
      if (result.characterId) {
        io.to(ctx.room.sessionId).emit('character:updated', {
          characterId: result.characterId,
          changes: { hitPoints: result.hp, tempHitPoints: result.tempHp },
        });
      }
      // 5e: damage while at 0 HP = automatic death-save failure.
      // CombatService.applyDamage increments the failure tally if the
      // combatant was already down; fan out the updated tracker so
      // every client sees the \u2717 land without the player having to
      // re-roll manually.
      if (result.autoDeathSaveFailure) {
        io.to(ctx.room.sessionId).emit('combat:death-save-updated', {
          tokenId: parsed.data.tokenId,
          deathSaves: result.autoDeathSaveFailure,
          roll: 0,
        });
      }
      // PC dropped to 0 HP \u2192 unconscious auto-applied. Broadcast the
      // token's new condition list so every client's badge tray
      // reflects the new state.
      if (result.autoAppliedConditions) {
        // Pulls fresh conditions from the live token (CombatService
        // has already mutated the token's conditions array in-place),
        // so we don't need to pass the string[] from the result \u2014 the
        // helper reads the room's Condition[]-typed array directly.
        io.to(ctx.room.sessionId).emit('map:token-updated', {
          tokenId: parsed.data.tokenId,
          changes: tokenConditionChanges(ctx.room, parsed.data.tokenId),
        });
      }
      // Any creatures this PC was grappling now go free \u2014 broadcast
      // their updated condition arrays so badges clear on every client.
      if (result.releasedGrappleTokenIds) {
        for (const freedId of result.releasedGrappleTokenIds) {
          const freedToken = ctx.room.tokens.get(freedId);
          if (!freedToken) continue;
          io.to(ctx.room.sessionId).emit('map:token-updated', {
            tokenId: freedId,
            changes: tokenConditionChanges(ctx.room, freedId),
          });
        }
      }
      // R2: auto-run damage side effects (concentration save, Sleep
      // break, etc.). Used to require the client to emit a separate
      // `damage:side-effects` event; now it runs server-side the moment
      // HP actually changes so a DM-initiated damage or a macro
      // bypasses no longer skip concentration.
      await applyDamageSideEffects(io, ctx.room, parsed.data.tokenId, parsed.data.amount);
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to apply damage',
      });
    }
  }));

  socket.on('combat:heal', safeHandler(socket, async (data) => {
    const parsed = combatHealSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Target token must exist in this room.
    if (!ctx.room.tokens.get(parsed.data.tokenId)) return;

    // Defense in depth for the heal amount.
    const amount = parsed.data.amount;
    if (!Number.isFinite(amount) || amount < 0 || amount > 9999) return;

    if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

    // During active combat, non-DMs can only heal on their own turn
    // (same restriction as damage). Outside combat, healing is
    // unrestricted (potions, short/long rest, etc.).
    const isDMHeal = ctx.player.role === 'dm';
    if (!isDMHeal) {
      const combatState = ctx.room.combatState;
      if (combatState?.active) {
        const currentCombatant = combatState.combatants[combatState.currentTurnIndex];
        if (!currentCombatant) return;
        const turnToken = ctx.room.tokens.get(currentCombatant.tokenId);
        if (!turnToken || turnToken.ownerUserId !== ctx.player.userId) return;
      }
    }

    try {
      const result = await CombatService.applyHeal(ctx.room.sessionId, parsed.data.tokenId, parsed.data.amount);
      io.to(ctx.room.sessionId).emit('combat:hp-changed', {
        tokenId: parsed.data.tokenId,
        hp: result.hp,
        tempHp: result.tempHp,
        change: result.change,
        type: 'heal',
      });
      if (result.characterId) {
        io.to(ctx.room.sessionId).emit('character:updated', {
          characterId: result.characterId,
          changes: { hitPoints: result.hp, tempHitPoints: result.tempHp },
        });
      }
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to apply healing',
      });
    }
  }));

  socket.on('combat:death-save', safeHandler(socket, async (data) => {
    const parsed = combatDeathSaveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

    const { tokenId } = parsed.data;
    const combatant = CombatService.getCombatant(ctx.room.sessionId, tokenId);
    if (!combatant) return;

    // Only tokens at 0 HP can roll death saves. Without this check,
    // a player could spam death saves on a conscious token until they
    // hit a nat 20 (which heals 1 HP) or manipulate the death save
    // counters outside the intended game state.
    if (combatant.hp > 0) return;

    const result = DiceService.rollDeathSave();

    // Apply death save result
    if (result.isCritSuccess) {
      // Nat 20: regain 1 HP
      await CombatService.applyHeal(ctx.room.sessionId, tokenId, 1);
      combatant.deathSaves = { successes: 0, failures: 0 };
    } else if (result.isCritFail) {
      // Nat 1: two failures
      combatant.deathSaves.failures = Math.min(3, combatant.deathSaves.failures + 2);
    } else if (result.isSuccess) {
      combatant.deathSaves.successes = Math.min(3, combatant.deathSaves.successes + 1);
    } else {
      combatant.deathSaves.failures = Math.min(3, combatant.deathSaves.failures + 1);
    }

    // Stabilize on 3 successes
    if (combatant.deathSaves.successes >= 3) {
      combatant.deathSaves = { successes: 0, failures: 0 };
      // Remove unconscious condition
      CombatService.removeCondition(ctx.room.sessionId, tokenId, 'unconscious');
    }

    io.to(ctx.room.sessionId).emit('combat:death-save-updated', {
      tokenId,
      deathSaves: combatant.deathSaves,
      roll: result.roll,
    });

    // Structured SaveResultCard alongside the tracker update so
    // chat shows every death-save roll with its counter, not just
    // the dramatic outcomes. DC 10 is implied for death saves.
    const dead = combatant.deathSaves.failures >= 3;
    const stabilized = combatant.hp > 0; // nat 20 heals → hp becomes 1
    const deathSaveBreakdown: SaveBreakdown = {
      roller: {
        name: combatant.name,
        tokenId,
        characterId: combatant.characterId ?? undefined,
      },
      context: 'Death Save',
      ability: 'death',
      d20: result.roll,
      advantage: 'normal',
      modifiers: [],
      total: result.roll,
      dc: 10,
      passed: result.isSuccess || result.isCritSuccess,
      deathSave: {
        successes: combatant.deathSaves.successes,
        failures: combatant.deathSaves.failures,
        stabilized: stabilized || undefined,
        dead: dead || undefined,
        critSuccess: result.isCritSuccess || undefined,
        critFailure: result.isCritFail || undefined,
      },
    };
    const chatContent = result.isCritSuccess
      ? `\u2728 ${combatant.name} rolled a NAT 20 on their death save — regains 1 HP!`
      : result.isCritFail
        ? `\u2620\uFE0F ${combatant.name} rolled a NAT 1 on their death save — counts as 2 failures.`
        : result.isSuccess
          ? `\u2713 ${combatant.name} succeeded a death save (d20=${result.roll}).`
          : `\u2717 ${combatant.name} failed a death save (d20=${result.roll}).`;
    const msgId = uuidv4();
    const createdAt = new Date().toISOString();
    pool.query(
      `INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, character_name, save_result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [msgId, ctx.room.sessionId, 'system', 'System', 'system', chatContent, null,
       JSON.stringify(deathSaveBreakdown), createdAt],
    ).catch((e) => console.warn('[death-save] persist failed:', e));
    io.to(ctx.room.sessionId).emit('chat:new-message', {
      id: msgId,
      sessionId: ctx.room.sessionId,
      userId: 'system',
      displayName: 'System',
      type: 'system',
      content: chatContent,
      characterName: null,
      whisperTo: null,
      rollData: null,
      saveResult: deathSaveBreakdown,
      createdAt,
    });

    // Only notify Discord on the dramatic outcomes \u2014 a successful
    // save every round would spam the channel. Nat-20 stabilises,
    // nat-1 is 2 failures, 3 failures = dead.
    if (result.isCritSuccess || result.isCritFail || dead) {
      const title = dead
        ? `\uD83D\uDC80 ${combatant.name} has died`
        : result.isCritSuccess
          ? `\u2728 ${combatant.name} stabilised on a Nat 20`
          : `\u2620\uFE0F ${combatant.name} rolled a Nat 1 on a Death Save`;
      const color = dead ? 0x6b1d1d : result.isCritSuccess ? 0x27ae60 : 0xc0392b;
      void DiscordService.notifySession(ctx.room.sessionId, {
        title,
        description: `Death saves: ${combatant.deathSaves.successes}\u2713 / ${combatant.deathSaves.failures}\u2717`,
        color,
      });
    }
  }));
}
