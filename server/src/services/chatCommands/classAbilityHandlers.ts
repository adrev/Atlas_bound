import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Per-class bonus-action and feature commands that are common enough
 * to deserve a shortcut rather than forcing the player to track
 * everything by hand. Each command:
 *   • Resolves the caller's own token (first owned PC on this map).
 *   • Checks the relevant class / feature marker.
 *   • Rolls / applies / decrements as needed and broadcasts.
 *
 *   !secondwind          Fighter: heal 1d10 + fighter level, 1/short rest.
 *   !actionsurge         Fighter: mark action surge used (2nd action granted).
 *   !cunning <dash|disengage|hide>    Rogue Cunning Action bonus action.
 *   !lay <target> <amt>  Paladin Lay on Hands — spend from the class HP pool.
 *   !channel <name>      Cleric / Paladin Channel Divinity — DM-narrated effect.
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

async function loadCharacter(characterId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

// ───── !secondwind ─────────────────────────────────────────────
async function handleSecondWind(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!secondwind: no owned PC token on this map.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  if (!row) { whisperToCaller(c.io, c.ctx, '!secondwind: character not found.'); return true; }
  const classLower = String(row.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!secondwind: ${caller.name} isn't a Fighter.`);
    return true;
  }
  const level = Number(row.level) || 1;
  const hp = Number(row.hit_points) || 0;
  const maxHp = Number(row.max_hit_points) || 0;
  const roll = Math.floor(Math.random() * 10) + 1;
  const heal = roll + level;
  const newHp = Math.min(maxHp, hp + heal);
  await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [newHp, caller.characterId])
    .catch((e) => console.warn('[!secondwind] hp write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { hitPoints: newHp },
  });
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: caller.id,
    hp: newHp,
    tempHp: Number(row.temp_hit_points) || 0,
    change: newHp - hp,
    type: 'heal',
  });
  broadcastSystem(
    c.io, c.ctx,
    `💨 ${caller.name} uses Second Wind — heals d10(${roll})+${level} = **${heal}** HP → ${newHp}/${maxHp}. Bonus action. 1/short rest.`,
  );
  return true;
}

// ───── !actionsurge ────────────────────────────────────────────
// Simpler path: we announce the effect and flip the combatant's
// action slot back to available so the UI lets them take a second
// action this turn. No hard class-check gate — action surge is
// Fighter-only and mis-use is a player problem.
async function handleActionSurge(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!actionsurge: no owned PC token on this map.');
    return true;
  }
  const row = caller.characterId ? await loadCharacter(caller.characterId) : null;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!actionsurge: ${caller.name} isn't a Fighter.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy) {
    // Give the action slot back.
    economy.action = false;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'action',
      economy,
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `⚡ ${caller.name} uses Action Surge — takes an additional action this turn. 1/short rest (2/short rest at L17).`,
  );
  return true;
}

// ───── !cunning <kind> ────────────────────────────────────────
async function handleCunning(c: ChatCommandContext): Promise<boolean> {
  const kind = c.rest.trim().toLowerCase();
  const valid = ['dash', 'disengage', 'hide'];
  if (!valid.includes(kind)) {
    whisperToCaller(c.io, c.ctx, `!cunning: usage \`!cunning <dash|disengage|hide>\``);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!cunning: no owned PC token on this map.');
    return true;
  }
  const row = caller.characterId ? await loadCharacter(caller.characterId) : null;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!cunning: ${caller.name} isn't a Rogue.`);
    return true;
  }

  // Spend the bonus action slot + apply the matching condition badge.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy) {
    if (economy.bonusAction) {
      whisperToCaller(c.io, c.ctx, `!cunning: ${caller.name} has already spent their bonus action this turn.`);
      return true;
    }
    economy.bonusAction = true;
    // Dash: Cunning Action doubles movement for this turn. Apply the
    // bump here so the single emit below carries both updates.
    if (kind === 'dash') {
      economy.movementRemaining += economy.movementMax;
    }
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }

  // Map kind → existing pseudo-condition badge. Dash has no badge
  // (we just double movement via speed recalc above); Disengage +
  // Hide reuse the existing `disengaged` / `hidden` badges.
  if (kind === 'disengage' || kind === 'hide') {
    const condName = kind === 'disengage' ? 'disengaged' : 'hidden';
    const { applyConditionWithMeta } = await import('../ConditionService.js');
    applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
      name: condName,
      source: `${caller.name} (!cunning ${kind})`,
      appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: caller.id,
      changes: { conditions: caller.conditions },
    });
  }

  broadcastSystem(
    c.io, c.ctx,
    `🗡 ${caller.name} uses Cunning Action — ${kind.charAt(0).toUpperCase() + kind.slice(1)} (bonus action).`,
  );
  return true;
}

// ───── !lay <target> <amount> ────────────────────────────────
async function handleLayOnHands(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!lay: usage `!lay <target> <amount>`');
    return true;
  }
  const amount = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(amount) || amount < 1 || amount > 999) {
    whisperToCaller(c.io, c.ctx, '!lay: amount must be a positive integer.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = targetName ? resolveTargetByName(c.ctx, targetName) : resolveCallerToken(c.ctx);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!lay: no token named "${targetName}".`);
    return true;
  }

  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!lay: no owned PC token on this map.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  if (!row) { whisperToCaller(c.io, c.ctx, '!lay: character not found.'); return true; }
  const classLower = String(row.class || '').toLowerCase();
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!lay: ${caller.name} isn't a Paladin.`);
    return true;
  }
  // Heal pool = 5 * Paladin level. We don't track the pool in the DB
  // today, so announce the heal and let the DM / player track the pool
  // manually. The heal itself we DO apply to the target.
  const level = Number(row.level) || 1;
  const poolMax = 5 * level;

  if (!target.characterId) {
    whisperToCaller(c.io, c.ctx, `!lay: ${target.name} isn't a linked character — cannot heal.`);
    return true;
  }
  const targetRow = await loadCharacter(target.characterId);
  if (!targetRow) { whisperToCaller(c.io, c.ctx, '!lay: target character not found.'); return true; }
  const curHp = Number(targetRow.hit_points) || 0;
  const maxHp = Number(targetRow.max_hit_points) || 0;
  const newHp = Math.min(maxHp, curHp + amount);
  await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [newHp, target.characterId])
    .catch((e) => console.warn('[!lay] hp write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: target.characterId,
    changes: { hitPoints: newHp },
  });
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: target.id,
    hp: newHp,
    tempHp: Number(targetRow.temp_hit_points) || 0,
    change: newHp - curHp,
    type: 'heal',
  });
  broadcastSystem(
    c.io, c.ctx,
    `🙌 ${caller.name} lays on hands — ${target.name} heals **${amount}** HP → ${newHp}/${maxHp}. (Pool ≤ ${poolMax}/day, reset on long rest.)`,
  );
  return true;
}

// ───── !channel <name> ────────────────────────────────────────
async function handleChannelDivinity(c: ChatCommandContext): Promise<boolean> {
  const effectName = c.rest.trim();
  if (!effectName) {
    whisperToCaller(c.io, c.ctx, '!channel: usage `!channel <effect name>` (e.g. "Turn Undead", "Sacred Weapon")');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!channel: no owned PC token on this map.');
    return true;
  }
  const row = caller.characterId ? await loadCharacter(caller.characterId) : null;
  const classLower = String(row?.class || '').toLowerCase();
  if (!(classLower.includes('cleric') || classLower.includes('paladin'))) {
    whisperToCaller(c.io, c.ctx, `!channel: ${caller.name} isn't a Cleric or Paladin.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `✨ ${caller.name} invokes Channel Divinity — **${effectName}**. DM narrates / resolves save DC + effect.`,
  );
  return true;
}

registerChatCommand(['secondwind', 'sw'], handleSecondWind);
registerChatCommand(['actionsurge', 'surge'], handleActionSurge);
registerChatCommand('cunning', handleCunning);
registerChatCommand(['lay', 'layonhands', 'loh'], handleLayOnHands);
registerChatCommand(['channel', 'cd'], handleChannelDivinity);
