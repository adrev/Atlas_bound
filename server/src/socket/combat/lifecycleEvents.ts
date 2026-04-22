import { v4 as uuidv4 } from 'uuid';
import type { Server, Socket } from 'socket.io';
import { getPlayerBySocketId } from '../../utils/roomState.js';
import * as CombatService from '../../services/CombatService.js';
import * as DiscordService from '../../services/DiscordService.js';
import {
  combatStartSchema, combatAddCombatantSchema,
  combatReadyCheckSchema, combatReadyResponseSchema,
} from '../../utils/validation.js';
import { safeHandler } from '../../utils/socketHelpers.js';
import { startCombat } from './startCombatHelper.js';

/**
 * Combat lifecycle events — start / add combatant / ready check /
 * lock initiative / end. Extracted from combatEvents.ts to keep each
 * concern in a file the reader can hold in their head.
 */
export function registerCombatLifecycle(io: Server, socket: Socket): void {
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
      // Snapshot defeated NPCs + PC count BEFORE endCombat clears
      // combatState. Auto-summarise XP the party earned so the DM
      // can run `!xp` with the right number (or accept the default).
      const defeatedNames: string[] = [];
      let pcCount = 0;
      if (ctx.room.combatState) {
        for (const cm of ctx.room.combatState.combatants) {
          if (cm.isNPC && cm.hp <= 0) defeatedNames.push(cm.name);
          else if (!cm.isNPC) pcCount += 1;
        }
      }

      await CombatService.endCombat(ctx.room.sessionId);
      // R7 — turn/round hooks are scoped to the encounter. Wipe them
      // when combat ends so a new combat starts with a clean slate.
      ctx.room.turnHooks.clear();
      ctx.room.roundHooks = [];
      io.to(ctx.room.sessionId).emit('combat:ended', {});
      void DiscordService.notifySession(ctx.room.sessionId, {
        title: '\uD83C\uDFF3\uFE0F Combat Ended',
        color: 0x27ae60,
      });

      // \u2500\u2500 XP summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
      // Look up each defeated monster in compendium_monsters by name
      // (case-insensitive exact match). Sum CR \u2192 XP. Split by PC
      // count. Emit a system chat line so DM can accept or adjust.
      if (defeatedNames.length > 0 && pcCount > 0) {
        const { default: dbPool } = await import('../../db/connection.js');
        const CR_XP: Record<number, number> = {
          0: 10, 0.125: 25, 0.25: 50, 0.5: 100,
          1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300,
          7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400,
          13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000,
          18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000,
          23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000,
          28: 120000, 29: 135000, 30: 155000,
        };
        let totalXp = 0;
        const perMonster: string[] = [];
        for (const name of defeatedNames) {
          try {
            const { rows } = await dbPool.query(
              'SELECT cr_numeric FROM compendium_monsters WHERE LOWER(name) = LOWER($1) ORDER BY source LIMIT 1',
              [name],
            );
            const cr = Number((rows[0] as Record<string, unknown> | undefined)?.cr_numeric);
            if (Number.isFinite(cr)) {
              const xp = CR_XP[cr] ?? 0;
              totalXp += xp;
              perMonster.push(`${name} (CR ${cr}, ${xp} XP)`);
            } else {
              perMonster.push(`${name} (unknown CR)`);
            }
          } catch {
            perMonster.push(`${name} (CR lookup failed)`);
          }
        }
        const perPc = Math.floor(totalXp / pcCount);
        const lines: string[] = [];
        lines.push(`\uD83C\uDFC6 Combat ended \u2014 ${defeatedNames.length} defeated, ${pcCount} PC${pcCount === 1 ? '' : 's'}:`);
        for (const line of perMonster) lines.push(`  \u2022 ${line}`);
        lines.push(`  **Total: ${totalXp} XP \u2192 ${perPc} per PC**. Award via \`!xp <target\u2026> ${perPc}\`.`);
        io.to(ctx.room.sessionId).emit('chat:new-message', {
          id: uuidv4(),
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
      }
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Failed to end combat',
      });
    }
  }));
}
