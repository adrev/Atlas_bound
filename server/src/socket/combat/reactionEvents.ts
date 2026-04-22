import { v4 as uuidv4 } from 'uuid';
import type { Server, Socket } from 'socket.io';
import {
  getPlayerBySocketId, isTokenActionable,
} from '../../utils/roomState.js';
import * as OpportunityAttackService from '../../services/OpportunityAttackService.js';
import { getSpellAnimation } from '@dnd-vtt/shared';
import {
  combatCastSpellSchema, combatOaExecuteSchema,
  combatSpellCastAttemptSchema, combatSpellCounterspelledSchema,
  combatAttackHitAttemptSchema, combatShieldCastSchema,
  combatMobileAttackedSchema,
} from '../../utils/validation.js';
import { safeHandler } from '../../utils/socketHelpers.js';

/**
 * Reaction events: opportunity attacks, counterspell / Shield prompts,
 * mobile-feat melee tracking, and the spell-cast broadcaster that
 * drives the client-side animation layer. The server mostly relays
 * here \u2014 damage math + save DCs run on the client side. Server's
 * job is ownership gating + fan-out.
 */
export function registerCombatReactions(io: Server, socket: Socket): void {
  // ----------------------------------------------------------------------
  // combat:oa-execute \u2014 the player/DM clicked "Attack" on an
  // Opportunity Attack prompt. Server rolls the attack, applies
  // damage, consumes the attacker's reaction, and broadcasts the
  // result to everyone.
  //
  // combat:oa-decline \u2014 player dismissed the prompt; we just swallow
  // it silently. (Present for symmetry \u2014 the client can emit it so
  // the server can audit-log in the future.)
  // ----------------------------------------------------------------------
  socket.on('combat:oa-execute', safeHandler(socket, async (data: unknown) => {
    const parsed = combatOaExecuteSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Permission: must be the attacker's owner OR the DM.
    const attacker = ctx.room.tokens.get(parsed.data.attackerTokenId);
    if (!attacker) return;
    const isDM = ctx.player.role === 'dm';
    const isOwner = attacker.ownerUserId === ctx.player.userId;
    if (!isDM && !isOwner) return;

    // Combat must be active \u2014 OA only happens during combat.
    if (!ctx.room.combatState?.active) return;

    // The mover must exist and be hostile to the attacker. Without
    // this, a player could manufacture a free attack against any
    // token in the room by crafting an oa-execute payload.
    const mover = ctx.room.tokens.get(parsed.data.moverTokenId);
    if (!mover) return;
    const attackerFaction = attacker.faction ?? 'neutral';
    const moverFaction = mover.faction ?? 'neutral';
    if (attackerFaction === moverFaction) return; // same faction, no OA

    const result = await OpportunityAttackService.executeOpportunityAttack(
      ctx.room.sessionId,
      parsed.data.attackerTokenId,
      parsed.data.moverTokenId,
    );

    // Broadcast every result line as a single system chat message
    // so the combat log shows the attack on one contiguous card.
    if (result.messages.length > 0) {
      io.to(ctx.room.sessionId).emit('chat:new-message', {
        id: uuidv4(),
        sessionId: ctx.room.sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: result.messages.join('\n'),
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: new Date().toISOString(),
      });
    }

    // If HP changed, broadcast both the combat HP change AND the
    // character row update so the HP bar re-renders everywhere.
    if (result.hpChange) {
      io.to(ctx.room.sessionId).emit('combat:hp-changed', {
        tokenId: result.hpChange.tokenId,
        hp: result.hpChange.hp,
        tempHp: result.hpChange.tempHp,
        change: 0, // absolute value already reflected in hp
        type: 'damage',
      });
    }
    if (result.characterHpUpdated) {
      io.to(ctx.room.sessionId).emit('character:updated', {
        characterId: result.characterHpUpdated.characterId,
        changes: { hitPoints: result.characterHpUpdated.hp },
      });
    }

    // Broadcast the updated reaction state for the attacker. We use
    // combat:action-used with the real economy from room state.
    const attackerEconomy = ctx.room.actionEconomies.get(parsed.data.attackerTokenId);
    if (attackerEconomy) {
      io.to(ctx.room.sessionId).emit('combat:action-used', {
        tokenId: parsed.data.attackerTokenId,
        actionType: 'reaction',
        economy: attackerEconomy,
      });
    }
  }));

  socket.on('combat:oa-decline', safeHandler(socket, async (_data) => {
    // Intentional no-op \u2014 reserved for future audit logging.
  }));

  // ----------------------------------------------------------------------
  // combat:spell-cast-attempt \u2014 broadcast a leveled spell cast intent
  // to every client so eligible counterspellers can show their
  // prompt. The original cast resolver waits ~2s for a counterspell
  // response before committing the spell's effects.
  //
  // combat:spell-counterspelled \u2014 sent by a counterspeller's client
  // when they confirm they're spending their reaction. Broadcast back
  // to everyone so the original caster's client aborts the cast.
  // ----------------------------------------------------------------------
  socket.on('combat:spell-cast-attempt', safeHandler(socket, async (data: unknown) => {
    const parsed = combatSpellCastAttemptSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Ownership check: DM is always allowed. Players must own the
    // caster token they claim to be casting from AND it must be alive.
    // (If no caster token id is supplied, only DMs may emit this.)
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const casterTokenId = parsed.data.casterTokenId;
      if (!casterTokenId) return;
      const casterToken = ctx.room.tokens.get(casterTokenId);
      if (!casterToken) return;
      if (casterToken.ownerUserId !== ctx.player.userId) return;
      if (!isTokenActionable(ctx, casterTokenId)) return;
    }

    io.to(ctx.room.sessionId).emit('combat:spell-cast-attempt', parsed.data);
  }));

  socket.on('combat:spell-counterspelled', safeHandler(socket, async (data: unknown) => {
    const parsed = combatSpellCounterspelledSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Ownership: DM always allowed. Players MUST provide their own
    // counterCasterTokenId \u2014 the old "owns any token" fallback let a
    // bystander spoof counterspells against any cast by knowing the
    // broadcast castId.
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const counterTokenId = parsed.data.counterCasterTokenId;
      if (!counterTokenId) return;
      const t = ctx.room.tokens.get(counterTokenId);
      if (!t || t.ownerUserId !== ctx.player.userId) return;
    }

    io.to(ctx.room.sessionId).emit('combat:spell-counterspelled', parsed.data);
  }));

  // ----------------------------------------------------------------------
  // combat:attack-hit-attempt \u2014 broadcast when an attack rolls a value
  // that would hit. The target's owner gets a Shield prompt if their
  // character has Shield prepared. Server is just a relay; the
  // attack resolver waits ~1.4 s for a response.
  //
  // combat:shield-cast \u2014 fired by the target's client when they
  // confirm they're spending the slot+reaction on Shield. Broadcast
  // back so the original attacker's resolver can recompute the hit.
  // ----------------------------------------------------------------------
  socket.on('combat:attack-hit-attempt', safeHandler(socket, async (data: unknown) => {
    const parsed = combatAttackHitAttemptSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Target token must exist in this room.
    if (!ctx.room.tokens.get(parsed.data.targetTokenId)) return;

    // Ownership check: DM is always allowed. Players must be the
    // current-turn combatant (i.e. own the attacker token making the
    // attack) and that token must be alive. Prevents bystanders from
    // spoofing fake "attack hit" events that would pop Shield prompts
    // on other players.
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const combatState = ctx.room.combatState;
      if (!combatState?.active) return;
      const currentCombatant = combatState.combatants[combatState.currentTurnIndex];
      if (!currentCombatant) return;
      const turnToken = ctx.room.tokens.get(currentCombatant.tokenId);
      if (!turnToken || turnToken.ownerUserId !== ctx.player.userId) return;
      if (!isTokenActionable(ctx, currentCombatant.tokenId)) return;
    }

    io.to(ctx.room.sessionId).emit('combat:attack-hit-attempt', parsed.data);
  }));

  socket.on('combat:shield-cast', safeHandler(socket, async (data: unknown) => {
    const parsed = combatShieldCastSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Ownership: DM always allowed. Players MUST provide their own
    // defenderTokenId \u2014 the old "owns any token" fallback let a
    // bystander forge a Shield response for another player's
    // incoming attack.
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const defenderTokenId = parsed.data.defenderTokenId;
      if (!defenderTokenId) return;
      const t = ctx.room.tokens.get(defenderTokenId);
      if (!t || t.ownerUserId !== ctx.player.userId) return;
    }

    io.to(ctx.room.sessionId).emit('combat:shield-cast', parsed.data);
  }));

  // combat:mobile-attacked \u2014 the attacker's client fires this when a
  // Mobile-feat PC makes a melee attack, so detectOpportunityAttacks
  // can suppress the OA from this particular target for the rest of
  // the turn. No broadcast needed \u2014 state change lives server-side.
  socket.on('combat:mobile-attacked', safeHandler(socket, async (data: unknown) => {
    const parsed = combatMobileAttackedSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Ownership: attacker must be owned by the caller (or DM). Stops
    // a bystander from neutering someone else's OA.
    const attackerTok = ctx.room.tokens.get(parsed.data.attackerTokenId);
    if (!attackerTok) return;
    const isDM = ctx.player.role === 'dm';
    if (!isDM && attackerTok.ownerUserId !== ctx.player.userId) return;

    let set = ctx.room.mobileMeleeTargets.get(parsed.data.attackerTokenId);
    if (!set) {
      set = new Set();
      ctx.room.mobileMeleeTargets.set(parsed.data.attackerTokenId, set);
    }
    set.add(parsed.data.targetTokenId);
  }));

  socket.on('combat:cast-spell', safeHandler(socket, async (data) => {
    const parsed = combatCastSpellSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const spellEvent = parsed.data;

    // Ownership check for players: must own the caster token AND it
    // must be alive. DMs may cast for any token (NPCs etc.).
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const casterToken = ctx.room.tokens.get(spellEvent.casterId);
      if (!casterToken) return;
      if (casterToken.ownerUserId !== ctx.player.userId) return;
      if (!isTokenActionable(ctx, spellEvent.casterId)) return;
    }

    // Get animation config for the spell
    const animConfig = getSpellAnimation(spellEvent.spellName);

    // Broadcast the spell cast event with animation data
    io.to(ctx.room.sessionId).emit('combat:spell-cast', {
      casterId: spellEvent.casterId,
      spellName: spellEvent.spellName,
      targetIds: spellEvent.targetIds,
      targetPosition: spellEvent.targetPosition,
      animationType: animConfig.type,
      animationColor: animConfig.color,
      aoeType: spellEvent.aoeType,
      aoeSize: spellEvent.aoeSize,
      aoeDirection: spellEvent.aoeDirection,
    });

    // Bug fix: casting a spell in melee range of a hostile provokes an
    // opportunity attack (same mechanism as movement-triggered OA).
    // We don't filter by component type here \u2014 the DM can rule
    // per-spell in chat. Future work: respect War Caster / Subtle Spell
    // / component-less spells via a per-spell "triggers OA" flag.
    if (ctx.room.combatState?.active) {
      const opportunities = OpportunityAttackService.detectSpellCastingOA(
        ctx.room.sessionId, spellEvent.casterId,
      );
      for (const opp of opportunities) {
        const targetOwnerId = opp.attackerOwnerUserId;
        const sentToSocketIds = new Set<string>();
        for (const player of ctx.room.players.values()) {
          const isRecipientDM = player.role === 'dm';
          const isAttackerOwner = targetOwnerId && player.userId === targetOwnerId;
          let shouldSend = false;
          if (targetOwnerId) { if (isAttackerOwner || isRecipientDM) shouldSend = true; }
          else { if (isRecipientDM) shouldSend = true; }
          if (shouldSend && !sentToSocketIds.has(player.socketId)) {
            io.to(player.socketId).emit('combat:oa-opportunity', opp);
            sentToSocketIds.add(player.socketId);
          }
        }
      }
    }
  }));
}
