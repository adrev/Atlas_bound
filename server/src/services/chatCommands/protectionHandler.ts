import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Protection fighting style (PHB p.72): when an attacker within 5 ft
 * of you hits a different creature with an attack, you can use your
 * reaction + shield to impose disadvantage on the attack roll.
 *
 * Full retroactive disadvantage (roll a second d20 AFTER the first
 * landed) is messy in a VTT — the roller already saw their result.
 * Simpler, pragmatic model: the protector fires `!protect <ally>`
 * the moment an attack is announced, which applies a one-shot
 * `protected` pseudo-condition. The next attack resolver sees it via
 * getTargetRollModifiers and imposes disadvantage. The condition
 * auto-expires at the start of next round so a stale badge doesn't
 * leak protection across turns.
 *
 *   !protect <ally>   caller must have Protection fighting style +
 *                     a shield equipped + a reaction available; we
 *                     validate each.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

function resolveTargetByName(ctx: PlayerContext, name: string): Token | null {
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) => t.name.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

async function characterHasProtection(characterId: string): Promise<{ has: boolean; hasShield: boolean }> {
  const { rows } = await pool.query(
    'SELECT features, inventory FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { has: false, hasShield: false };
  let has = false;
  let hasShield = false;
  try {
    const rawF = row.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF) : (rawF ?? []);
    if (Array.isArray(feats)) {
      has = feats.some(
        (f: { name?: string }) => typeof f?.name === 'string' && /^\s*protection\s*$/i.test(f.name),
      );
    }
  } catch { /* ignore */ }
  try {
    const rawI = row.inventory;
    const inv = typeof rawI === 'string' ? JSON.parse(rawI) : (rawI ?? []);
    if (Array.isArray(inv)) {
      hasShield = inv.some((i: { type?: string; equipped?: boolean; name?: string }) => {
        const type = String(i?.type || '').toLowerCase();
        const name = String(i?.name || '').toLowerCase();
        return i?.equipped && (type === 'shield' || name.includes('shield'));
      });
    }
  } catch { /* ignore */ }
  return { has, hasShield };
}

async function handleProtect(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!protect: usage `!protect <ally name>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!protect: no owned PC token on this map.');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!protect: no token named "${targetName}".`);
    return true;
  }
  if (target.id === caller.id) {
    whisperToCaller(c.io, c.ctx, '!protect: Protection protects an ally, not yourself. Use the Shield spell for self-defense.');
    return true;
  }

  // Validate feat + shield.
  const { has, hasShield } = await characterHasProtection(caller.characterId);
  if (!has) {
    whisperToCaller(c.io, c.ctx, `!protect: ${caller.name} doesn't have the Protection fighting style.`);
    return true;
  }
  if (!hasShield) {
    whisperToCaller(c.io, c.ctx, `!protect: ${caller.name} has no shield equipped — Protection requires one.`);
    return true;
  }

  // Validate 5 ft reach between protector and ally.
  const gridSize =
    (c.ctx.room.currentMapId && c.ctx.room.mapGridSizes.get(c.ctx.room.currentMapId)) || 70;
  const cSize = (caller as Token).size || 1;
  const tSize = (target as Token).size || 1;
  const ccx = caller.x + (gridSize * cSize) / 2;
  const ccy = caller.y + (gridSize * cSize) / 2;
  const tcx = target.x + (gridSize * tSize) / 2;
  const tcy = target.y + (gridSize * tSize) / 2;
  const dx = Math.max(0, Math.abs(ccx - tcx) - (cSize * gridSize) / 2 - (tSize * gridSize) / 2);
  const dy = Math.max(0, Math.abs(ccy - tcy) - (cSize * gridSize) / 2 - (tSize * gridSize) / 2);
  const edge = Math.max(dx, dy);
  if (edge > gridSize + 1) {
    whisperToCaller(c.io, c.ctx, `!protect: ${target.name} isn't within 5 ft of ${caller.name}.`);
    return true;
  }

  // Validate + burn reaction slot.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, `!protect: ${caller.name} has already used their reaction this round.`);
    return true;
  }
  if (economy) {
    economy.reaction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'reaction',
      economy,
    });
  }

  // Apply the `protected` pseudo-condition. Auto-expire at the start
  // of the next round so a stale badge doesn't persist into the next
  // combat round.
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'protected',
    source: `${caller.name} (Protection)`,
    appliedRound: currentRound,
    expiresAfterRound: currentRound, // expires next round start
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });

  broadcastSystem(
    c.io, c.ctx,
    `🛡 ${caller.name} uses Protection (reaction + shield) — next attack against ${target.name} has disadvantage.`,
  );
  return true;
}

registerChatCommand('protect', handleProtect);
