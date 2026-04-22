import { v4 as uuidv4 } from 'uuid';
import type { Server, Socket } from 'socket.io';
import {
  getPlayerBySocketId, playerIsDM, isTokenOwnerOrDM,
} from '../../utils/roomState.js';
import * as CombatService from '../../services/CombatService.js';
import * as ConditionService from '../../services/ConditionService.js';
import {
  combatConditionSchema, conditionWithMetaSchema,
  damageSideEffectsSchema, concentrationDroppedSchema,
} from '../../utils/validation.js';
import { safeHandler } from '../../utils/socketHelpers.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Condition + damage-side-effect events:
 *   \u2022 combat:condition-add / combat:condition-remove \u2014 simple flag set
 *   \u2022 condition:apply-with-meta \u2014 duration-tracked variant with
 *     save-at-end-of-turn, endsOnDamage, casterTokenId plumbing
 *   \u2022 damage:side-effects \u2014 concentration save + Sleep break +
 *     Hideous Laughter save retry pipeline
 *   \u2022 concentration:dropped \u2014 clear all conditions sourced from a
 *     caster's concentration spell
 */
export function registerCombatConditions(io: Server, socket: Socket): void {
  socket.on('combat:condition-add', safeHandler(socket, async (data) => {
    const parsed = combatConditionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!playerIsDM(ctx)) return;

    try {
      const conditions = CombatService.addCondition(
        ctx.room.sessionId, parsed.data.tokenId, parsed.data.condition,
      );
      io.to(ctx.room.sessionId).emit('combat:condition-changed', {
        tokenId: parsed.data.tokenId,
        conditions,
      });
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to add condition',
      });
    }
  }));

  socket.on('combat:condition-remove', safeHandler(socket, async (data) => {
    const parsed = combatConditionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

    // Non-DMs can only drop conditions that are voluntarily ended
    // (concentration, dodge) \u2014 not save-or-suck effects that should
    // expire through the combat duration system or DM override.
    // Without this, a player could strip paralyzed/restrained/stunned
    // from their own token instantly.
    if (ctx.player.role !== 'dm') {
      const VOLUNTARY_CONDITIONS = new Set([
        'concentrating', 'dodging', 'raging', 'hiding',
      ]);
      if (!VOLUNTARY_CONDITIONS.has(parsed.data.condition.toLowerCase())) return;
    }

    try {
      const conditions = CombatService.removeCondition(
        ctx.room.sessionId, parsed.data.tokenId, parsed.data.condition,
      );
      io.to(ctx.room.sessionId).emit('combat:condition-changed', {
        tokenId: parsed.data.tokenId,
        conditions,
      });
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to remove condition',
      });
    }
  }));

  // ----------------------------------------------------------------------
  // condition:apply-with-meta \u2014 register a duration-tracked condition
  // ----------------------------------------------------------------------
  socket.on('condition:apply-with-meta', safeHandler(socket, async (data) => {
    const parsed = conditionWithMetaSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const room = ctx.room;
    const targetToken = room.tokens.get(parsed.data.targetTokenId);
    if (!targetToken) return;

    // Ownership: DM, or the caster (caller) must own the claimed
    // casterTokenId. Prevents players from spoofing arbitrary
    // conditions on each others' tokens.
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const casterTokenId = parsed.data.casterTokenId;
      if (!casterTokenId) return;
      const casterToken = room.tokens.get(casterTokenId);
      if (!casterToken || casterToken.ownerUserId !== ctx.player.userId) return;

      // Block conditions that are game-state-destructive when applied
      // by players. "dead" / "unconscious" / "petrified" are outcomes
      // of HP reduction or powerful save-or-suck effects \u2014 they should
      // only come from the server-side damage pipeline or the DM.
      // Standard saveable conditions (frightened, charmed, stunned,
      // restrained, etc.) are fine for players to apply from their
      // spells \u2014 the DM can always undo them.
      const DESTRUCTIVE_CONDITIONS = new Set([
        'dead', 'unconscious', 'petrified', 'stable',
      ]);
      if (DESTRUCTIVE_CONDITIONS.has(parsed.data.conditionName.toLowerCase())) return;

      // Players can only target unowned NPCs or their own tokens \u2014
      // not other players' PCs (anti-grief: can't "charm" a teammate
      // to troll them).
      if (targetToken.ownerUserId && targetToken.ownerUserId !== ctx.player.userId) return;
    }

    // Apply via the service which handles both the conditions array AND
    // the metadata map. Returns any tokens whose grapple auto-released
    // because the grappler became incapacitated \u2014 broadcast those too.
    const freedTokenIds = ConditionService.applyConditionWithMeta(
      ctx.room.sessionId, parsed.data.targetTokenId, {
      name: parsed.data.conditionName.toLowerCase(),
      source: parsed.data.source,
      casterTokenId: parsed.data.casterTokenId,
      appliedRound: room.combatState?.roundNumber ?? 1,
      expiresAfterRound: parsed.data.expiresAfterRound,
      saveAtEndOfTurn: parsed.data.saveAtEndOfTurn,
      endsOnDamage: parsed.data.endsOnDamage,
    });

    // Broadcast the updated conditions array so clients see the badge
    io.to(ctx.room.sessionId).emit('map:token-updated', {
      tokenId: parsed.data.targetTokenId,
      changes: tokenConditionChanges(ctx.room, parsed.data.targetTokenId),
    });
    for (const freed of freedTokenIds) {
      const freedToken = ctx.room.tokens.get(freed);
      if (!freedToken) continue;
      io.to(ctx.room.sessionId).emit('map:token-updated', {
        tokenId: freed,
        changes: tokenConditionChanges(ctx.room, freed),
      });
    }
  }));

  // ----------------------------------------------------------------------
  // damage:side-effects \u2014 server processes the side effects of a token
  // taking damage:
  //   1. CON save to maintain concentration on a spell
  //   2. Clear conditions with endsOnDamage = true (Sleep)
  //   3. Re-roll save with advantage for saveOnDamage spells (Hideous Laughter)
  // The caller (cast resolver) provides tokenId + final damage amount.
  // ----------------------------------------------------------------------
  socket.on('damage:side-effects', safeHandler(socket, async (data: unknown) => {
    const parsed = damageSideEffectsSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Target token must exist in this room.
    const targetToken = ctx.room.tokens.get(parsed.data.tokenId);
    if (!targetToken) return;

    // Damage amount cap defense-in-depth.
    if (!Number.isFinite(parsed.data.damageAmount) || parsed.data.damageAmount < 0 || parsed.data.damageAmount > 9999) return;

    // Ownership: DM, OR the token's owner (concentration / Sleep
    // side-effects on their own token), OR the current-turn attacker
    // targeting an unowned NPC. The old rule let the current attacker
    // trigger side-effects on ANY token \u2014 which meant a player could
    // force concentration saves on enemy casters without actually
    // dealing damage. Now non-DM attackers can only trigger side-
    // effects on unowned NPCs (the standard "I hit the goblin" case).
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const ownsTarget = targetToken.ownerUserId === ctx.player.userId;
      let isAttackingNPC = false;
      if (!targetToken.ownerUserId) {
        // Target is an unowned NPC \u2014 check current-turn ownership
        const combatState = ctx.room.combatState;
        if (combatState?.active) {
          const currentCombatant = combatState.combatants[combatState.currentTurnIndex];
          if (currentCombatant) {
            const turnToken = ctx.room.tokens.get(currentCombatant.tokenId);
            if (turnToken?.ownerUserId === ctx.player.userId) isAttackingNPC = true;
          }
        }
      }
      if (!ownsTarget && !isAttackingNPC) return;
    }

    const result = await ConditionService.processDamageSideEffects(
      ctx.room.sessionId, parsed.data.tokenId, parsed.data.damageAmount,
    );

    // Broadcast updated tokens for any whose conditions changed
    for (const tokenId of result.affectedTokens) {
      const t = ctx.room.tokens.get(tokenId);
      if (t) {
        io.to(ctx.room.sessionId).emit('map:token-updated', {
          tokenId, changes: tokenConditionChanges(ctx.room, tokenId),
        });
      }
    }

    // If the target dropped concentration, also broadcast the cleared
    // concentratingOn field on their character
    if (result.droppedConcentration) {
      const t = ctx.room.tokens.get(parsed.data.tokenId);
      if (t?.characterId) {
        io.to(ctx.room.sessionId).emit('character:updated', {
          characterId: t.characterId,
          changes: { concentratingOn: null },
        });
      }
    }

    // Broadcast all the chat messages from the side effects (CON save
    // result, Sleep ending, Laughter save retry, etc.)
    const now = new Date().toISOString();
    for (const msg of result.messages) {
      io.to(ctx.room.sessionId).emit('chat:new-message', {
        id: uuidv4(),
        sessionId: ctx.room.sessionId,
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
  }));

  // ----------------------------------------------------------------------
  // concentration:dropped \u2014 clear all conditions sourced from a caster's
  // concentration spell. Called when the caster takes damage and fails
  // the CON save, OR voluntarily switches concentration.
  // ----------------------------------------------------------------------
  socket.on('concentration:dropped', safeHandler(socket, async (data: unknown) => {
    const parsed = concentrationDroppedSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Caster token must exist in this room.
    const casterToken = ctx.room.tokens.get(parsed.data.casterTokenId);
    if (!casterToken) return;

    // Ownership: DM, or the caster token's owner. Prevents another
    // player from forcing someone else to drop concentration.
    const isDM = ctx.player.role === 'dm';
    if (!isDM && casterToken.ownerUserId !== ctx.player.userId) return;

    const cleared = ConditionService.clearConcentrationConditions(
      ctx.room.sessionId, parsed.data.casterTokenId, parsed.data.spellName,
    );

    // Broadcast the updated conditions for each affected token
    for (const { tokenId } of cleared) {
      const t = ctx.room.tokens.get(tokenId);
      if (t) {
        io.to(ctx.room.sessionId).emit('map:token-updated', {
          tokenId, changes: tokenConditionChanges(ctx.room, tokenId),
        });
      }
    }

    if (cleared.length > 0) {
      const now = new Date().toISOString();
      io.to(ctx.room.sessionId).emit('chat:new-message', {
        id: uuidv4(),
        sessionId: ctx.room.sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: `\u26A1 Concentration on ${parsed.data.spellName} dropped \u2014 ${cleared.length} affected creature${cleared.length !== 1 ? 's' : ''} freed`,
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: now,
      });
    }
  }));
}
