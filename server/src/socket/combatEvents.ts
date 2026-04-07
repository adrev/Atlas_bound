import type { Server, Socket } from 'socket.io';
import { getPlayerBySocketId } from '../utils/roomState.js';
import * as CombatService from '../services/CombatService.js';
import * as DiceService from '../services/DiceService.js';
import * as ConditionService from '../services/ConditionService.js';
import { getSpellAnimation } from '@dnd-vtt/shared';
import {
  combatStartSchema, combatRollInitiativeSchema, combatSetInitiativeSchema,
  combatDamageSchema, combatHealSchema, combatConditionSchema,
  combatDeathSaveSchema, combatUseActionSchema, combatUseMovementSchema,
  combatCastSpellSchema,
} from '../utils/validation.js';

export function registerCombatEvents(io: Server, socket: Socket): void {

  socket.on('combat:start', (data) => {
    const parsed = combatStartSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    try {
      const combatState = CombatService.startCombat(ctx.room.sessionId, parsed.data.tokenIds);
      io.to(ctx.room.sessionId).emit('combat:started', {
        combatants: combatState.combatants,
        roundNumber: combatState.roundNumber,
      });

      // Announce the initiative order in chat as a system message so
      // players can see the rolls and the resulting order at a glance.
      const lines: string[] = ['⚔️ Combat begins! Initiative order:'];
      combatState.combatants.forEach((c, idx) => {
        const marker = idx === 0 ? '▶' : ' ';
        const tag = c.isNPC ? '' : ' (PC)';
        lines.push(`   ${marker} ${idx + 1}. ${c.name}${tag} — ${c.initiative}`);
      });
      lines.push(`   Round 1 — ${combatState.combatants[0]?.name ?? '?'}'s turn`);

      const startMsgId = (Math.random() + 1).toString(36).substring(2);
      io.to(ctx.room.sessionId).emit('chat:new-message', {
        id: startMsgId,
        sessionId: ctx.room.sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: lines.join('\n'),
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: new Date().toISOString(),
      });

      // NPC initiatives are pre-rolled (grouped by name) in startCombat.
      // Broadcast NPC initiative results immediately so all clients see them.
      for (const combatant of combatState.combatants) {
        if (combatant.isNPC && combatant.initiative !== 0) {
          io.to(ctx.room.sessionId).emit('combat:initiative-set', {
            tokenId: combatant.tokenId,
            roll: combatant.initiative - combatant.initiativeBonus,
            bonus: combatant.initiativeBonus,
            total: combatant.initiative,
          });
        }
      }

      // Prompt player-owned combatants to roll initiative
      for (const combatant of combatState.combatants) {
        if (combatant.isNPC) continue;
        const token = ctx.room.tokens.get(combatant.tokenId);
        if (token?.ownerUserId) {
          const ownerPlayer = ctx.room.players.get(token.ownerUserId);
          if (ownerPlayer) {
            io.to(ownerPlayer.socketId).emit('combat:initiative-prompt', {
              tokenId: combatant.tokenId,
              bonus: combatant.initiativeBonus,
            });
          }
        }
      }

      // Check if all initiatives are already rolled (e.g., only NPCs in combat)
      if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
        const sorted = CombatService.sortInitiative(ctx.room.sessionId);
        io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
      }
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to start combat',
      });
    }
  });

  socket.on('combat:end', () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    try {
      CombatService.endCombat(ctx.room.sessionId);
      io.to(ctx.room.sessionId).emit('combat:ended', {});
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to end combat',
      });
    }
  });

  socket.on('combat:roll-initiative', (data) => {
    const parsed = combatRollInitiativeSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { tokenId, bonus } = parsed.data;

    // Roll initiative
    const { roll, total } = DiceService.rollInitiative(bonus);
    CombatService.setInitiative(ctx.room.sessionId, tokenId, total);

    const result = {
      tokenId,
      roll,
      bonus,
      total,
    };

    io.to(ctx.room.sessionId).emit('combat:initiative-set', result);

    // Check if all initiatives are rolled
    if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
      const sorted = CombatService.sortInitiative(ctx.room.sessionId);
      io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
    }
  });

  socket.on('combat:set-initiative', (data) => {
    const parsed = combatSetInitiativeSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { tokenId, total } = parsed.data;
    const combatant = CombatService.setInitiative(ctx.room.sessionId, tokenId, total);
    if (!combatant) return;

    io.to(ctx.room.sessionId).emit('combat:initiative-set', {
      tokenId,
      roll: total - combatant.initiativeBonus,
      bonus: combatant.initiativeBonus,
      total,
    });

    if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
      const sorted = CombatService.sortInitiative(ctx.room.sessionId);
      io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
    }
  });

  socket.on('combat:next-turn', () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Allow either the DM OR the current turn's owner to advance.
    // Without this restriction every player has to ask the DM to click
    // End Turn for them, which is annoying.
    const room = ctx.room;
    const state = room.combatState;
    if (!state) return;
    const currentCombatant = state.combatants[state.currentTurnIndex];
    const isCurrentOwner = currentCombatant?.characterId &&
      room.tokens.get(currentCombatant.tokenId)?.ownerUserId === ctx.player.userId;
    const isDM = ctx.player.role === 'dm';
    if (!isDM && !isCurrentOwner) return;

    try {
      // BEFORE advancing, tick the conditions on the combatant whose
      // turn is ENDING — that's the right time to roll save retries
      // for Hold Person etc. and to expire 1-round buffs.
      const endingCombatant = state.combatants[state.currentTurnIndex];
      const tickResult = endingCombatant
        ? ConditionService.tickConditionsForToken(
            ctx.room.sessionId,
            endingCombatant.tokenId,
            state.roundNumber,
          )
        : { removed: [], messages: [] };

      const result = CombatService.nextTurn(ctx.room.sessionId);
      io.to(ctx.room.sessionId).emit('combat:turn-advanced', {
        currentTurnIndex: result.currentTurnIndex,
        roundNumber: result.roundNumber,
        actionEconomy: result.actionEconomy,
      });

      // If conditions were removed during the tick, broadcast the new
      // condition list for the ending combatant's token.
      if (endingCombatant && tickResult.removed.length > 0) {
        const updatedToken = ctx.room.tokens.get(endingCombatant.tokenId);
        if (updatedToken) {
          io.to(ctx.room.sessionId).emit('map:token-updated', {
            tokenId: endingCombatant.tokenId,
            changes: { conditions: updatedToken.conditions },
          });
        }
      }

      // Announce the new turn in chat as a system message so the round
      // count and current combatant are visible without looking at the
      // initiative tracker. Includes any condition tick messages from
      // the previous combatant's turn end (Hold Person save retries,
      // expiring buffs, etc.).
      const lines: string[] = [];
      for (const m of tickResult.messages) lines.push(m);
      lines.push(result.skippedTokenIds.length > 0
        ? `⚔️ Round ${result.roundNumber} — ${result.currentCombatant.name}'s turn (skipped ${result.skippedTokenIds.length} downed)`
        : `⚔️ Round ${result.roundNumber} — ${result.currentCombatant.name}'s turn`);
      const announcement = lines.join('\n');

      // Emit as a system chat message that gets persisted + broadcast.
      // Inline the message construction to avoid pulling in another import.
      const msgId = (Math.random() + 1).toString(36).substring(2);
      const now = new Date().toISOString();
      io.to(ctx.room.sessionId).emit('chat:new-message', {
        id: msgId,
        sessionId: ctx.room.sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: announcement,
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: now,
      });
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to advance turn',
      });
    }
  });

  socket.on('combat:damage', (data) => {
    const parsed = combatDamageSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    try {
      const result = CombatService.applyDamage(ctx.room.sessionId, parsed.data.tokenId, parsed.data.amount);
      io.to(ctx.room.sessionId).emit('combat:hp-changed', {
        tokenId: parsed.data.tokenId,
        hp: result.hp,
        tempHp: result.tempHp,
        change: result.change,
        type: 'damage',
      });
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to apply damage',
      });
    }
  });

  socket.on('combat:heal', (data) => {
    const parsed = combatHealSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    try {
      const result = CombatService.applyHeal(ctx.room.sessionId, parsed.data.tokenId, parsed.data.amount);
      io.to(ctx.room.sessionId).emit('combat:hp-changed', {
        tokenId: parsed.data.tokenId,
        hp: result.hp,
        tempHp: result.tempHp,
        change: result.change,
        type: 'heal',
      });
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to apply healing',
      });
    }
  });

  socket.on('combat:condition-add', (data) => {
    const parsed = combatConditionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

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
  });

  socket.on('combat:condition-remove', (data) => {
    const parsed = combatConditionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

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
  });

  socket.on('combat:death-save', (data) => {
    const parsed = combatDeathSaveSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { tokenId } = parsed.data;
    const combatant = CombatService.getCombatant(ctx.room.sessionId, tokenId);
    if (!combatant) return;

    const result = DiceService.rollDeathSave();

    // Apply death save result
    if (result.isCritSuccess) {
      // Nat 20: regain 1 HP
      CombatService.applyHeal(ctx.room.sessionId, tokenId, 1);
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
  });

  socket.on('combat:use-action', (data) => {
    const parsed = combatUseActionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const economy = CombatService.useAction(ctx.room.sessionId, parsed.data.actionType);
    if (!economy) return;

    const combatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
    if (!combatant) return;

    io.to(ctx.room.sessionId).emit('combat:action-used', {
      tokenId: combatant.tokenId,
      actionType: parsed.data.actionType,
      economy,
    });
  });

  socket.on('combat:use-movement', (data) => {
    const parsed = combatUseMovementSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const remaining = CombatService.useMovement(ctx.room.sessionId, parsed.data.feet);

    const combatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
    if (!combatant) return;

    io.to(ctx.room.sessionId).emit('combat:movement-used', {
      tokenId: combatant.tokenId,
      remaining,
    });
  });

  socket.on('combat:cast-spell', (data) => {
    const parsed = combatCastSpellSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const spellEvent = parsed.data;

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
  });
}
