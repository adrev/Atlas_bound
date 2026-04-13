import type { Server, Socket } from 'socket.io';
import {
  getPlayerBySocketId, playerIsDM, isTokenOwnerOrDM,
  canTargetToken, isCurrentTurnOwnerOrDM,
} from '../utils/roomState.js';
import * as CombatService from '../services/CombatService.js';
import * as DiceService from '../services/DiceService.js';
import * as ConditionService from '../services/ConditionService.js';
import * as OpportunityAttackService from '../services/OpportunityAttackService.js';
import { getSpellAnimation } from '@dnd-vtt/shared';
import {
  combatStartSchema, combatRollInitiativeSchema, combatSetInitiativeSchema,
  combatDamageSchema, combatHealSchema, combatConditionSchema,
  combatDeathSaveSchema, combatUseActionSchema, combatUseMovementSchema,
  combatCastSpellSchema, conditionWithMetaSchema,
} from '../utils/validation.js';

export function registerCombatEvents(io: Server, socket: Socket): void {

  socket.on('combat:start', (data) => {
    console.log('[COMBAT START] received from socket', socket.id, 'data:', data);
    const parsed = combatStartSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('[COMBAT START] schema parse failed:', parsed.error.issues);
      return;
    }

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) {
      console.warn('[COMBAT START] no player context for socket', socket.id);
      return;
    }
    if (ctx.player.role !== 'dm') {
      console.warn('[COMBAT START] non-DM tried to start combat:', ctx.player.userId, ctx.player.role);
      return;
    }
    console.log('[COMBAT START] DM', ctx.player.userId, 'starting with', parsed.data.tokenIds.length, 'tokens');

    try {
      const combatState = CombatService.startCombat(ctx.room.sessionId, parsed.data.tokenIds);
      console.log('[COMBAT START] combat state created with', combatState.combatants.length, 'combatants');
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

      // ALL initiatives are pre-rolled by CombatService.startCombat (NPCs
      // grouped by name, players individually). Broadcast each result so
      // every client sees the rolls and not just the DM's initial snapshot.
      // This covers both creatures AND player-owned combatants — the
      // previous flow left players stuck at their server-rolled value with
      // no confirmation event on the wire, and the orphaned "initiative
      // prompt" path never rendered a UI.
      for (const combatant of combatState.combatants) {
        if (combatant.initiative === 0) continue;
        io.to(ctx.room.sessionId).emit('combat:initiative-set', {
          tokenId: combatant.tokenId,
          roll: combatant.initiative - combatant.initiativeBonus,
          bonus: combatant.initiativeBonus,
          total: combatant.initiative,
        });
      }

      // All initiatives should be rolled at this point. Emit the sorted
      // combatants so every client's combatStore.combatants array is
      // guaranteed to be in the correct order with the final values.
      if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
        const sorted = CombatService.sortInitiative(ctx.room.sessionId);
        io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
      }
    } catch (err) {
      console.error('[COMBAT START] error:', err);
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to start combat',
      });
    }
  });

  // ------------------------------------------------------------------
  // Ready Check — DM sends a ready check before starting combat.
  // Players respond, and once all are ready (or 15s timeout) combat
  // starts automatically with the stored tokenIds.
  // ------------------------------------------------------------------

  socket.on('combat:ready-check', (data: { tokenIds: string[] }) => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    // Gather player userIds who need to respond
    const playerIds: string[] = [];
    for (const [, p] of ctx.room.players) {
      if (p.role === 'player') playerIds.push(p.userId);
    }

    // Clear any existing ready check
    if (ctx.room.readyCheck?.timeout) {
      clearTimeout(ctx.room.readyCheck.timeout);
    }

    const deadline = Date.now() + 15000;
    const tokenIds = data.tokenIds;

    ctx.room.readyCheck = {
      tokenIds,
      responses: new Map(),
      timeout: setTimeout(() => {
        // Auto-start after 15 seconds
        if (!ctx.room.readyCheck) return;
        ctx.room.readyCheck = null;

        io.to(ctx.room.sessionId).emit('combat:ready-check-complete', {});

        // Start combat with the stored tokenIds (mirrors combat:start logic)
        try {
          const combatState = CombatService.startCombat(ctx.room.sessionId, tokenIds);
          io.to(ctx.room.sessionId).emit('combat:started', {
            combatants: combatState.combatants,
            roundNumber: combatState.roundNumber,
          });

          const lines: string[] = ['⚔️ Combat begins! Initiative order:'];
          combatState.combatants.forEach((c, idx) => {
            const marker = idx === 0 ? '▶' : ' ';
            const tag = c.isNPC ? '' : ' (PC)';
            lines.push(`   ${marker} ${idx + 1}. ${c.name}${tag} — ${c.initiative}`);
          });
          lines.push(`   Round 1 — ${combatState.combatants[0]?.name ?? '?'}'s turn`);

          io.to(ctx.room.sessionId).emit('chat:new-message', {
            id: (Math.random() + 1).toString(36).substring(2),
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

          for (const combatant of combatState.combatants) {
            if (combatant.initiative === 0) continue;
            io.to(ctx.room.sessionId).emit('combat:initiative-set', {
              tokenId: combatant.tokenId,
              roll: combatant.initiative - combatant.initiativeBonus,
              bonus: combatant.initiativeBonus,
              total: combatant.initiative,
            });
          }

          if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
            const sorted = CombatService.sortInitiative(ctx.room.sessionId);
            io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
          }
        } catch (err) {
          console.error('[READY CHECK] auto-start combat error:', err);
        }
      }, 15000),
    };

    io.to(ctx.room.sessionId).emit('combat:ready-check-started', {
      playerIds,
      deadline,
    });
  });

  socket.on('combat:ready-response', (data: { ready: boolean }) => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || !ctx.room.readyCheck) return;

    ctx.room.readyCheck.responses.set(ctx.player.userId, data.ready);

    // Broadcast update
    const responses: Record<string, boolean> = {};
    for (const [k, v] of ctx.room.readyCheck.responses) responses[k] = v;
    io.to(ctx.room.sessionId).emit('combat:ready-update', { responses });

    // Check if all players responded
    let allReady = true;
    for (const [, p] of ctx.room.players) {
      if (p.role === 'player' && !ctx.room.readyCheck.responses.get(p.userId)) {
        allReady = false;
        break;
      }
    }

    if (allReady) {
      clearTimeout(ctx.room.readyCheck.timeout!);
      const tokenIds = ctx.room.readyCheck.tokenIds;
      ctx.room.readyCheck = null;

      io.to(ctx.room.sessionId).emit('combat:ready-check-complete', {});

      // Start combat (mirrors combat:start logic)
      try {
        const combatState = CombatService.startCombat(ctx.room.sessionId, tokenIds);
        io.to(ctx.room.sessionId).emit('combat:started', {
          combatants: combatState.combatants,
          roundNumber: combatState.roundNumber,
        });

        const lines: string[] = ['⚔️ Combat begins! Initiative order:'];
        combatState.combatants.forEach((c, idx) => {
          const marker = idx === 0 ? '▶' : ' ';
          const tag = c.isNPC ? '' : ' (PC)';
          lines.push(`   ${marker} ${idx + 1}. ${c.name}${tag} — ${c.initiative}`);
        });
        lines.push(`   Round 1 — ${combatState.combatants[0]?.name ?? '?'}'s turn`);

        io.to(ctx.room.sessionId).emit('chat:new-message', {
          id: (Math.random() + 1).toString(36).substring(2),
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

        for (const combatant of combatState.combatants) {
          if (combatant.initiative === 0) continue;
          io.to(ctx.room.sessionId).emit('combat:initiative-set', {
            tokenId: combatant.tokenId,
            roll: combatant.initiative - combatant.initiativeBonus,
            bonus: combatant.initiativeBonus,
            total: combatant.initiative,
          });
        }

        if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
          const sorted = CombatService.sortInitiative(ctx.room.sessionId);
          io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
        }
      } catch (err) {
        console.error('[READY CHECK] all-ready combat start error:', err);
      }
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
    if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

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
    if (!playerIsDM(ctx)) return;

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
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

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
      // ── Phase 1: END-of-turn tick on the combatant whose turn is
      // ENDING. This is when save-retries (Hold Person, Hideous
      // Laughter, Dominate Person, etc.) get rolled per RAW ("at the
      // end of each of its turns").
      const endingCombatant = state.combatants[state.currentTurnIndex];
      const endTickResult = endingCombatant
        ? ConditionService.tickEndOfTurnConditions(
            ctx.room.sessionId,
            endingCombatant.tokenId,
          )
        : { removed: [], messages: [] };

      // ── Phase 2: advance the turn order
      const result = CombatService.nextTurn(ctx.room.sessionId);
      io.to(ctx.room.sessionId).emit('combat:turn-advanced', {
        currentTurnIndex: result.currentTurnIndex,
        roundNumber: result.roundNumber,
        actionEconomy: result.actionEconomy,
      });

      // ── Phase 3: START-of-turn tick on the NEW combatant. Expires
      // any of their conditions whose duration has run out (Bless
      // after 10 rounds, etc.). Doing this AFTER nextTurn means
      // `result.roundNumber` is the new round, so a 10-round spell
      // cast in round 1 expires at the start of the FIRST turn of
      // round 11 — exactly 10 rounds of effect, matching D&D 5e.
      const startingCombatant = result.currentCombatant;
      const startTickResult = startingCombatant
        ? ConditionService.tickStartOfTurnConditions(
            ctx.room.sessionId,
            startingCombatant.tokenId,
            result.roundNumber,
          )
        : { removed: [], messages: [] };

      // Broadcast updated conditions if anything changed for the
      // ending combatant (save retries removed something).
      if (endingCombatant && endTickResult.removed.length > 0) {
        const updatedToken = ctx.room.tokens.get(endingCombatant.tokenId);
        if (updatedToken) {
          io.to(ctx.room.sessionId).emit('map:token-updated', {
            tokenId: endingCombatant.tokenId,
            changes: { conditions: updatedToken.conditions },
          });
        }
      }

      // Clear "until your next turn" flags on the combatant whose
      // turn is now STARTING. Dodge, Disengage, and the Shield
      // spell are 5e effects that expire at the start of your own
      // next turn. ALSO broadcast the start-of-turn expiration
      // removals from Phase 3 above.
      if (startingCombatant) {
        const startingToken = ctx.room.tokens.get(startingCombatant.tokenId);
        if (startingToken) {
          const before = startingToken.conditions;
          const after = before.filter(
            (c) => !(['dodging', 'disengaged', 'shield-spell'] as string[]).includes(c),
          );
          const cleanupChanged = after.length !== before.length;
          if (cleanupChanged) startingToken.conditions = after;

          // If either the cleanup OR the start-of-turn expiry tick
          // changed the conditions array, broadcast once.
          if (cleanupChanged || startTickResult.removed.length > 0) {
            io.to(ctx.room.sessionId).emit('map:token-updated', {
              tokenId: startingCombatant.tokenId,
              changes: { conditions: startingToken.conditions },
            });
          }
        }
      }

      // Announce the new turn in chat as a system message so the round
      // count and current combatant are visible without looking at the
      // initiative tracker. Includes any condition tick messages from
      // BOTH the previous combatant's end-of-turn saves AND the new
      // combatant's start-of-turn expirations.
      const lines: string[] = [];
      for (const m of endTickResult.messages) lines.push(m);
      for (const m of startTickResult.messages) lines.push(m);
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
    if (!canTargetToken(ctx, parsed.data.tokenId)) return;

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
    if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

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
  });

  socket.on('combat:condition-remove', (data) => {
    const parsed = combatConditionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

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
    if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

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
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

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
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

    const remaining = CombatService.useMovement(ctx.room.sessionId, parsed.data.feet);

    const combatant = ctx.room.combatState?.combatants[ctx.room.combatState.currentTurnIndex];
    if (!combatant) return;

    io.to(ctx.room.sessionId).emit('combat:movement-used', {
      tokenId: combatant.tokenId,
      remaining,
    });
  });

  // ----------------------------------------------------------------------
  // combat:dash — take the Dash action: consume Action slot AND double
  // the current combatant's movement pool for the turn. We broadcast
  // combat:action-used with the updated economy (the client picks up
  // the new movementMax + movementRemaining from the same payload).
  // ----------------------------------------------------------------------
  socket.on('combat:dash', () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

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
      id: (Math.random() + 1).toString(36).substring(2),
      sessionId: ctx.room.sessionId,
      userId: 'system',
      displayName: 'System',
      type: 'system',
      content: `🏃 ${combatant.name} takes the Dash action (+${combatant.speed} ft movement)`,
      characterName: null,
      whisperTo: null,
      rollData: null,
      createdAt: new Date().toISOString(),
    });
  });

  // ----------------------------------------------------------------------
  // combat:oa-execute — the player/DM clicked "Attack" on an
  // Opportunity Attack prompt. Server rolls the attack, applies
  // damage, consumes the attacker's reaction, and broadcasts the
  // result to everyone.
  //
  // combat:oa-decline — player dismissed the prompt; we just swallow
  // it silently. (Present for symmetry — the client can emit it so
  // the server can audit-log in the future.)
  // ----------------------------------------------------------------------
  socket.on('combat:oa-execute', (data: { attackerTokenId?: string; moverTokenId?: string }) => {
    if (!data?.attackerTokenId || !data?.moverTokenId) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Permission: must be the attacker's owner OR the DM.
    const attacker = ctx.room.tokens.get(data.attackerTokenId);
    if (!attacker) return;
    const isDM = ctx.player.role === 'dm';
    const isOwner = attacker.ownerUserId === ctx.player.userId;
    if (!isDM && !isOwner) return;

    const result = OpportunityAttackService.executeOpportunityAttack(
      ctx.room.sessionId,
      data.attackerTokenId,
      data.moverTokenId,
    );

    // Broadcast every result line as a single system chat message
    // so the combat log shows the attack on one contiguous card.
    if (result.messages.length > 0) {
      io.to(ctx.room.sessionId).emit('chat:new-message', {
        id: (Math.random() + 1).toString(36).substring(2),
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
    const attackerEconomy = ctx.room.actionEconomies.get(data.attackerTokenId);
    if (attackerEconomy) {
      io.to(ctx.room.sessionId).emit('combat:action-used', {
        tokenId: data.attackerTokenId,
        actionType: 'reaction',
        economy: attackerEconomy,
      });
    }
  });

  socket.on('combat:oa-decline', (_data) => {
    // Intentional no-op — reserved for future audit logging.
  });

  // ----------------------------------------------------------------------
  // combat:spell-cast-attempt — broadcast a leveled spell cast intent
  // to every client so eligible counterspellers can show their
  // prompt. The original cast resolver waits ~2s for a counterspell
  // response before committing the spell's effects.
  //
  // combat:spell-counterspelled — sent by a counterspeller's client
  // when they confirm they're spending their reaction. Broadcast back
  // to everyone so the original caster's client aborts the cast.
  // ----------------------------------------------------------------------
  socket.on('combat:spell-cast-attempt', (data: {
    castId?: string;
    casterTokenId?: string;
    casterName?: string;
    spellName?: string;
    spellLevel?: number;
  }) => {
    if (!data?.castId || !data?.spellName || data?.spellLevel == null) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    io.to(ctx.room.sessionId).emit('combat:spell-cast-attempt', data);
  });

  socket.on('combat:spell-counterspelled', (data: {
    castId?: string;
    counterCasterName?: string;
    counterSlotLevel?: number;
  }) => {
    if (!data?.castId) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    io.to(ctx.room.sessionId).emit('combat:spell-counterspelled', data);
  });

  // ----------------------------------------------------------------------
  // combat:attack-hit-attempt — broadcast when an attack rolls a value
  // that would hit. The target's owner gets a Shield prompt if their
  // character has Shield prepared. Server is just a relay; the
  // attack resolver waits ~1.4 s for a response.
  //
  // combat:shield-cast — fired by the target's client when they
  // confirm they're spending the slot+reaction on Shield. Broadcast
  // back so the original attacker's resolver can recompute the hit.
  // ----------------------------------------------------------------------
  socket.on('combat:attack-hit-attempt', (data: {
    attackId?: string;
    targetTokenId?: string;
    attackerName?: string;
    attackTotal?: number;
    currentAC?: number;
  }) => {
    if (!data?.attackId || !data?.targetTokenId) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    io.to(ctx.room.sessionId).emit('combat:attack-hit-attempt', data);
  });

  socket.on('combat:shield-cast', (data: { attackId?: string; defenderName?: string }) => {
    if (!data?.attackId) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    io.to(ctx.room.sessionId).emit('combat:shield-cast', data);
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

  // ----------------------------------------------------------------------
  // condition:apply-with-meta — register a duration-tracked condition
  // ----------------------------------------------------------------------
  socket.on('condition:apply-with-meta', (data) => {
    const parsed = conditionWithMetaSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const room = ctx.room;
    const targetToken = room.tokens.get(parsed.data.targetTokenId);
    if (!targetToken) return;

    // Apply via the service which handles both the conditions array AND
    // the metadata map
    ConditionService.applyConditionWithMeta(ctx.room.sessionId, parsed.data.targetTokenId, {
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
      changes: { conditions: targetToken.conditions },
    });
  });

  // ----------------------------------------------------------------------
  // damage:side-effects — server processes the side effects of a token
  // taking damage:
  //   1. CON save to maintain concentration on a spell
  //   2. Clear conditions with endsOnDamage = true (Sleep)
  //   3. Re-roll save with advantage for saveOnDamage spells (Hideous Laughter)
  // The caller (cast resolver) provides tokenId + final damage amount.
  // ----------------------------------------------------------------------
  socket.on('damage:side-effects', (data: { tokenId?: string; damageAmount?: number }) => {
    if (!data?.tokenId || typeof data.damageAmount !== 'number') return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const result = ConditionService.processDamageSideEffects(
      ctx.room.sessionId, data.tokenId, data.damageAmount,
    );

    // Broadcast updated tokens for any whose conditions changed
    for (const tokenId of result.affectedTokens) {
      const t = ctx.room.tokens.get(tokenId);
      if (t) {
        io.to(ctx.room.sessionId).emit('map:token-updated', {
          tokenId, changes: { conditions: t.conditions },
        });
      }
    }

    // If the target dropped concentration, also broadcast the cleared
    // concentratingOn field on their character
    if (result.droppedConcentration && data.tokenId) {
      const t = ctx.room.tokens.get(data.tokenId);
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
        id: (Math.random() + 1).toString(36).substring(2),
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
  });

  // ----------------------------------------------------------------------
  // concentration:dropped — clear all conditions sourced from a caster's
  // concentration spell. Called when the caster takes damage and fails
  // the CON save, OR voluntarily switches concentration.
  // ----------------------------------------------------------------------
  socket.on('concentration:dropped', (data: { casterTokenId?: string; spellName?: string }) => {
    if (!data?.casterTokenId || !data?.spellName) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const cleared = ConditionService.clearConcentrationConditions(
      ctx.room.sessionId, data.casterTokenId, data.spellName,
    );

    // Broadcast the updated conditions for each affected token
    for (const { tokenId } of cleared) {
      const t = ctx.room.tokens.get(tokenId);
      if (t) {
        io.to(ctx.room.sessionId).emit('map:token-updated', {
          tokenId, changes: { conditions: t.conditions },
        });
      }
    }

    if (cleared.length > 0) {
      const now = new Date().toISOString();
      io.to(ctx.room.sessionId).emit('chat:new-message', {
        id: (Math.random() + 1).toString(36).substring(2),
        sessionId: ctx.room.sessionId,
        userId: 'system',
        displayName: 'System',
        type: 'system',
        content: `⚡ Concentration on ${data.spellName} dropped — ${cleared.length} affected creature${cleared.length !== 1 ? 's' : ''} freed`,
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: now,
      });
    }
  });
}
