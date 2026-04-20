import { v4 as uuidv4 } from 'uuid';
import type { Server, Socket } from 'socket.io';
import {
  getPlayerBySocketId, playerIsDM, isTokenOwnerOrDM,
  canTargetToken, isCurrentTurnOwnerOrDM, isTokenActionable,
} from '../utils/roomState.js';
import * as CombatService from '../services/CombatService.js';
import * as DiscordService from '../services/DiscordService.js';
import * as DiceService from '../services/DiceService.js';
import * as ConditionService from '../services/ConditionService.js';
import { applyDamageSideEffects } from '../services/damageEffects.js';
import * as OpportunityAttackService from '../services/OpportunityAttackService.js';
import { getSpellAnimation } from '@dnd-vtt/shared';
import {
  combatStartSchema, combatAddCombatantSchema, combatRollInitiativeSchema, combatSetInitiativeSchema,
  combatDamageSchema, combatHealSchema, combatConditionSchema,
  combatDeathSaveSchema, combatUseActionSchema, combatUseMovementSchema,
  combatCastSpellSchema, conditionWithMetaSchema,
  combatReadyCheckSchema, combatReadyResponseSchema, combatOaExecuteSchema,
  combatSpellCastAttemptSchema, combatSpellCounterspelledSchema,
  combatAttackHitAttemptSchema, combatShieldCastSchema,
  damageSideEffectsSchema, concentrationDroppedSchema,
} from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';

/**
 * Shared helper that creates combat state, emits all combat-start events,
 * and broadcasts the initiative order as a system chat message.
 */
async function startCombat(io: Server, sessionId: string, tokenIds: string[]) {
  const combatState = await CombatService.startCombatAsync(sessionId, tokenIds);

  // Initiative review phase — combat is technically active on the
  // server so tokens / HP are locked in, but the DM gets to inspect
  // and hand-edit every rolled initiative before turns start
  // advancing. Clients receive reviewPhase=true on combat:started
  // and hold the DM-facing review modal + the player-facing
  // "DM reviewing" banner until the DM confirms (see the
  // combat:lock-initiative handler below).
  io.to(sessionId).emit('combat:started', {
    combatants: combatState.combatants,
    roundNumber: combatState.roundNumber,
    reviewPhase: true,
  });

  // Announce the initiative order in chat as a system message.
  const lines: string[] = ['⚔️ Combat begins! Initiative order:'];
  combatState.combatants.forEach((c, idx) => {
    const marker = idx === 0 ? '▶' : ' ';
    const tag = c.isNPC ? '' : ' (PC)';
    lines.push(`   ${marker} ${idx + 1}. ${c.name}${tag} — ${c.initiative}`);
  });
  lines.push(`   Round 1 — ${combatState.combatants[0]?.name ?? '?'}'s turn`);

  // Fire-and-forget Discord notification. The service is a no-op when
  // no webhook is configured, and internally swallows network errors
  // so a flaky webhook can never stall combat-start.
  void DiscordService.notifySession(sessionId, {
    title: '⚔️ Combat Begins',
    description: combatState.combatants
      .map((c, idx) => `**${idx + 1}.** ${c.name}${c.isNPC ? '' : ' *(PC)*'} — ${c.initiative}`)
      .join('\n'),
    color: 0xc0392b,
  });

  io.to(sessionId).emit('chat:new-message', {
    id: uuidv4(),
    sessionId,
    userId: 'system',
    displayName: 'System',
    type: 'system',
    content: lines.join('\n'),
    characterName: null,
    whisperTo: null,
    rollData: null,
    createdAt: new Date().toISOString(),
  });

  // Broadcast each initiative roll so every client sees the values.
  for (const combatant of combatState.combatants) {
    if (combatant.initiative === 0) continue;
    io.to(sessionId).emit('combat:initiative-set', {
      tokenId: combatant.tokenId,
      roll: combatant.initiative - combatant.initiativeBonus,
      bonus: combatant.initiativeBonus,
      total: combatant.initiative,
    });
  }

  // Emit the sorted combatants so every client has the correct order.
  if (CombatService.allInitiativesRolled(sessionId)) {
    const sorted = CombatService.sortInitiative(sessionId);
    io.to(sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
  }
}

export function registerCombatEvents(io: Server, socket: Socket): void {

  socket.on('combat:start', safeHandler(socket, async (data) => {
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
      await startCombat(io, ctx.room.sessionId, parsed.data.tokenIds);
    } catch (err) {
      console.error('[COMBAT START] error:', err);
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to start combat',
      });
    }
  }));

  socket.on('combat:add-combatant', safeHandler(socket, async (data) => {
    const parsed = combatAddCombatantSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const combatant = await CombatService.addCombatantAsync(ctx.room.sessionId, parsed.data.tokenId);
    if (!combatant) {
      socket.emit('session:error', { message: 'Combat inactive or token already in initiative' });
      return;
    }
    const state = ctx.room.combatState;
    if (!state) return;
    io.to(ctx.room.sessionId).emit('combat:state', {
      active: state.active,
      combatants: state.combatants,
      roundNumber: state.roundNumber,
      currentTurnIndex: state.currentTurnIndex,
    });
  }));

  // ------------------------------------------------------------------
  // Ready Check — DM sends a ready check before starting combat.
  // Players respond, and once all are ready (or 15s timeout) combat
  // starts automatically with the stored tokenIds.
  // ------------------------------------------------------------------

  socket.on('combat:ready-check', safeHandler(socket, async (data: unknown) => {
    const parsed = combatReadyCheckSchema.safeParse(data);
    if (!parsed.success) return;
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
    const tokenIds = parsed.data.tokenIds;

    ctx.room.readyCheck = {
      tokenIds,
      responses: new Map(),
      timeout: setTimeout(async () => {
        // Auto-start after 15 seconds
        if (!ctx.room.readyCheck) return;
        ctx.room.readyCheck = null;

        io.to(ctx.room.sessionId).emit('combat:ready-check-complete', {});

        // Start combat with the stored tokenIds
        try {
          await startCombat(io, ctx.room.sessionId, tokenIds);
        } catch (err) {
          console.error('[READY CHECK] auto-start combat error:', err);
        }
      }, 15000),
    };

    io.to(ctx.room.sessionId).emit('combat:ready-check-started', {
      playerIds,
      deadline,
    });
  }));

  socket.on('combat:ready-response', safeHandler(socket, async (data: unknown) => {
    const parsed = combatReadyResponseSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || !ctx.room.readyCheck) return;

    ctx.room.readyCheck.responses.set(ctx.player.userId, parsed.data.ready);

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

      // Start combat
      try {
        await startCombat(io, ctx.room.sessionId, tokenIds);
      } catch (err) {
        console.error('[READY CHECK] all-ready combat start error:', err);
      }
    }
  }));

  // DM finishes reviewing/editing initiative rolls and wants the
  // round to actually start. The server doesn't gate anything on
  // reviewPhase itself (initiatives were already rolled at start);
  // this event just lets every other client hide the review UI in
  // lockstep with the DM so nobody sees turns advance out of sync.
  socket.on('combat:lock-initiative', safeHandler(socket, async () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    io.to(ctx.room.sessionId).emit('combat:review-complete', {});
  }));

  socket.on('combat:end', safeHandler(socket, async () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    try {
      await CombatService.endCombat(ctx.room.sessionId);
      // R7 — turn/round hooks are scoped to the encounter. Wipe them
      // when combat ends so a new combat starts with a clean slate.
      ctx.room.turnHooks.clear();
      ctx.room.roundHooks = [];
      io.to(ctx.room.sessionId).emit('combat:ended', {});
      void DiscordService.notifySession(ctx.room.sessionId, {
        title: '🏳️ Combat Ended',
        color: 0x27ae60,
      });
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to end combat',
      });
    }
  }));

  socket.on('combat:roll-initiative', safeHandler(socket, async (data) => {
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
  }));

  socket.on('combat:set-initiative', safeHandler(socket, async (data) => {
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
  }));

  socket.on('combat:next-turn', safeHandler(socket, async () => {
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
        ? await ConditionService.tickEndOfTurnConditions(
            ctx.room.sessionId,
            endingCombatant.tokenId,
          )
        : { removed: [], messages: [] };

      // Capture the pre-advance round so R7 round hooks can fire
      // once per transition (e.g. round 3 → round 4), not on every
      // turn inside a round.
      const preAdvanceRound = state.roundNumber;

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
      // R7 — round hooks fire when the round number advanced.
      if (result.roundNumber !== preAdvanceRound) {
        for (const m of ctx.room.roundHooks) lines.push(`📣 ${m}`);
      }
      // R7 — turn hooks for the combatant whose turn is now starting.
      if (startingCombatant) {
        const hooks = ctx.room.turnHooks.get(startingCombatant.tokenId);
        if (hooks && hooks.length > 0) {
          for (const m of hooks) lines.push(`📣 ${m}`);
        }
      }
      lines.push(result.skippedTokenIds.length > 0
        ? `⚔️ Round ${result.roundNumber} — ${result.currentCombatant.name}'s turn (skipped ${result.skippedTokenIds.length} downed)`
        : `⚔️ Round ${result.roundNumber} — ${result.currentCombatant.name}'s turn`);
      const announcement = lines.join('\n');

      // Emit as a system chat message that gets persisted + broadcast.
      // Inline the message construction to avoid pulling in another import.
      const msgId = uuidv4();
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
  }));

  socket.on('combat:damage', safeHandler(socket, async (data) => {
    const parsed = combatDamageSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Target token must exist in this room.
    const targetToken = ctx.room.tokens.get(parsed.data.tokenId);
    if (!targetToken) return;

    // Defense in depth beyond the Zod cap — reject any non-finite or
    // implausibly large amount even if the schema is relaxed later.
    const amount = parsed.data.amount;
    if (!Number.isFinite(amount) || amount < 0 || amount > 9999) return;

    // Existing targeting rule (players → NPCs or self-tokens only; DM can
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
      // every client sees the ✗ land without the player having to
      // re-roll manually.
      if (result.autoDeathSaveFailure) {
        io.to(ctx.room.sessionId).emit('combat:death-save-updated', {
          tokenId: parsed.data.tokenId,
          deathSaves: result.autoDeathSaveFailure,
          roll: 0,
        });
      }
      // PC dropped to 0 HP → unconscious auto-applied. Broadcast the
      // token's new condition list so every client's badge tray
      // reflects the new state.
      if (result.autoAppliedConditions) {
        io.to(ctx.room.sessionId).emit('map:token-updated', {
          tokenId: parsed.data.tokenId,
          changes: { conditions: result.autoAppliedConditions },
        });
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
    // (concentration, dodge) — not save-or-suck effects that should
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

    // Only notify Discord on the dramatic outcomes — a successful
    // save every round would spam the channel. Nat-20 stabilises,
    // nat-1 is 2 failures, 3 failures = dead.
    const dead = combatant.deathSaves.failures >= 3;
    if (result.isCritSuccess || result.isCritFail || dead) {
      const title = dead
        ? `💀 ${combatant.name} has died`
        : result.isCritSuccess
          ? `✨ ${combatant.name} stabilised on a Nat 20`
          : `☠️ ${combatant.name} rolled a Nat 1 on a Death Save`;
      const color = dead ? 0x6b1d1d : result.isCritSuccess ? 0x27ae60 : 0xc0392b;
      void DiscordService.notifySession(ctx.room.sessionId, {
        title,
        description: `Death saves: ${combatant.deathSaves.successes}✓ / ${combatant.deathSaves.failures}✗`,
        color,
      });
    }
  }));

  socket.on('combat:use-action', safeHandler(socket, async (data) => {
    const parsed = combatUseActionSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (!isCurrentTurnOwnerOrDM(ctx)) return;

    // Block downed tokens from consuming action economy. DMs bypass —
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
  // combat:dash — take the Dash action: consume Action slot AND double
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
      content: `🏃 ${combatant.name} takes the Dash action (+${combatant.speed} ft movement)`,
      characterName: null,
      whisperTo: null,
      rollData: null,
      createdAt: new Date().toISOString(),
    });
  }));

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

    // Combat must be active — OA only happens during combat.
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
    // Intentional no-op — reserved for future audit logging.
  }));

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
    // counterCasterTokenId — the old "owns any token" fallback let a
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
  // combat:attack-hit-attempt — broadcast when an attack rolls a value
  // that would hit. The target's owner gets a Shield prompt if their
  // character has Shield prepared. Server is just a relay; the
  // attack resolver waits ~1.4 s for a response.
  //
  // combat:shield-cast — fired by the target's client when they
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
    // defenderTokenId — the old "owns any token" fallback let a
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
    // We don't filter by component type here — the DM can rule
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

  // ----------------------------------------------------------------------
  // condition:apply-with-meta — register a duration-tracked condition
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
      // of HP reduction or powerful save-or-suck effects — they should
      // only come from the server-side damage pipeline or the DM.
      // Standard saveable conditions (frightened, charmed, stunned,
      // restrained, etc.) are fine for players to apply from their
      // spells — the DM can always undo them.
      const DESTRUCTIVE_CONDITIONS = new Set([
        'dead', 'unconscious', 'petrified', 'stable',
      ]);
      if (DESTRUCTIVE_CONDITIONS.has(parsed.data.conditionName.toLowerCase())) return;

      // Players can only target unowned NPCs or their own tokens —
      // not other players' PCs (anti-grief: can't "charm" a teammate
      // to troll them).
      if (targetToken.ownerUserId && targetToken.ownerUserId !== ctx.player.userId) return;
    }

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
  }));

  // ----------------------------------------------------------------------
  // damage:side-effects — server processes the side effects of a token
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
    // trigger side-effects on ANY token — which meant a player could
    // force concentration saves on enemy casters without actually
    // dealing damage. Now non-DM attackers can only trigger side-
    // effects on unowned NPCs (the standard "I hit the goblin" case).
    const isDM = ctx.player.role === 'dm';
    if (!isDM) {
      const ownsTarget = targetToken.ownerUserId === ctx.player.userId;
      let isAttackingNPC = false;
      if (!targetToken.ownerUserId) {
        // Target is an unowned NPC — check current-turn ownership
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
          tokenId, changes: { conditions: t.conditions },
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
  // concentration:dropped — clear all conditions sourced from a caster's
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
          tokenId, changes: { conditions: t.conditions },
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
        content: `⚡ Concentration on ${parsed.data.spellName} dropped — ${cleared.length} affected creature${cleared.length !== 1 ? 's' : ''} freed`,
        characterName: null,
        whisperTo: null,
        rollData: null,
        createdAt: now,
      });
    }
  }));
}
