import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import * as CombatService from '../CombatService.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

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
      changes: tokenConditionChanges(c.ctx.room, caller.id),
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

// ───── !pam <target> — Polearm Master butt-end bonus attack ──
async function handlePolearmButt(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!pam: usage `!pam <target>` — bonus action butt-end strike with your polearm.');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!pam: no owned PC token on this map.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  if (!row) { whisperToCaller(c.io, c.ctx, '!pam: character not found.'); return true; }

  // Feat + weapon check.
  let hasFeat = false;
  try {
    const rawF = row.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF) : (rawF ?? []);
    hasFeat = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /^\s*polearm\s+master\s*$/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasFeat) {
    whisperToCaller(c.io, c.ctx, `!pam: ${caller.name} doesn't have the Polearm Master feat.`);
    return true;
  }

  // Find the equipped polearm and pull its ability mod (same one used
  // for the main attack — typically STR).
  let abilityMod = 0;
  let profBonus = 2;
  let weaponName = 'polearm';
  try {
    const rawI = row.inventory;
    const inv = typeof rawI === 'string' ? JSON.parse(rawI) : (rawI ?? []);
    const scoresRaw = row.ability_scores;
    const scores = typeof scoresRaw === 'string' ? JSON.parse(scoresRaw) : (scoresRaw ?? {});
    const strMod = Math.floor(((scores?.str ?? 10) - 10) / 2);
    const dexMod = Math.floor(((scores?.dex ?? 10) - 10) / 2);
    profBonus = Number(row.proficiency_bonus) || 2;
    if (Array.isArray(inv)) {
      for (const item of inv) {
        const name = String((item as Record<string, unknown>)?.name ?? '').toLowerCase();
        if ((item as Record<string, unknown>)?.equipped && /glaive|halberd|pike|quarterstaff|spear/.test(name)) {
          weaponName = (item as Record<string, unknown>).name as string;
          const props = ((item as Record<string, unknown>)?.properties as string[] | undefined) ?? [];
          const isFinesse = props.some((p) => /finesse/i.test(String(p)));
          abilityMod = isFinesse ? Math.max(strMod, dexMod) : strMod;
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // Spend the bonus action slot.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, `!pam: ${caller.name} has already spent their bonus action this turn.`);
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }

  // Roll to hit + roll damage. We don't have the target's AC in this
  // path (it's adjudicated client-side normally), so the DM applies
  // the hit outcome manually. Still useful to roll both numbers.
  const atkBonus = abilityMod + profBonus;
  const d20 = Math.floor(Math.random() * 20) + 1;
  const atkTotal = d20 + atkBonus;
  const d4 = Math.floor(Math.random() * 4) + 1;
  const dmg = Math.max(0, d4 + abilityMod);
  const atkSign = atkBonus >= 0 ? '+' : '';
  const dmgSign = abilityMod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `🪙 ${caller.name} butt-ends with ${weaponName} (PAM bonus):\n` +
    `   to hit: d20=${d20}${atkSign}${atkBonus}=${atkTotal}${d20 === 20 ? ' 💥CRIT' : d20 === 1 ? ' 💀fumble' : ''}\n` +
    `   dmg: d4(${d4})${dmgSign}${abilityMod}=${dmg} bludgeoning`,
  );
  return true;
}

// ───── !uncanny <damage> — Rogue Uncanny Dodge reaction ─────
/**
 * Rogue's Uncanny Dodge (L5): when an attacker you can see hits you
 * with an attack, you can use your reaction to halve the attack's
 * damage against you. Since damage has already been rolled + applied
 * by the time the player realises they want to use it, the simplest
 * model is a "heal back the half" chat command that also burns the
 * reaction slot.
 *
 *   !uncanny <damage-amount>
 *     Example: took 18 damage → `!uncanny 18` heals 9 back and
 *     marks reaction spent.
 */
async function handleUncanny(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim();
  const dmg = parseInt(arg, 10);
  if (!Number.isFinite(dmg) || dmg < 1) {
    whisperToCaller(c.io, c.ctx, '!uncanny: usage `!uncanny <incoming-damage-amount>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!uncanny: no owned PC token.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!uncanny: ${caller.name} isn't a Rogue.`);
    return true;
  }
  const level = Number(row?.level) || 1;
  if (level < 5) {
    whisperToCaller(c.io, c.ctx, `!uncanny: Uncanny Dodge requires Rogue level 5 (${caller.name} is ${level}).`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, `!uncanny: ${caller.name} has already used their reaction this round.`);
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

  // Heal back half the damage. Route through CombatService in combat
  // so the tracker + auto-conditions stay in sync.
  const healback = Math.floor(dmg / 2);
  if (c.ctx.room.combatState?.active) {
    const r = await CombatService.applyHeal(c.ctx.room.sessionId, caller.id, healback);
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: caller.id, hp: r.hp, tempHp: r.tempHp, change: healback, type: 'heal',
    });
    if (r.characterId) {
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: r.characterId,
        changes: { hitPoints: r.hp, tempHitPoints: r.tempHp },
      });
    }
  }
  broadcastSystem(
    c.io, c.ctx,
    `🗡 ${caller.name} uses Uncanny Dodge (reaction) — halves the incoming damage: ${dmg} → ${dmg - healback} (heal back ${healback}).`,
  );
  return true;
}

// ───── !evasion <damage> — Rogue Evasion (L7) ───────────────
/**
 * Rogue's Evasion (L7): when subjected to an effect that allows a
 * DEX save for half damage, you take no damage on success + half on
 * fail. Because the DM is already routing saves through !save, this
 * helper heals back the full or half depending on what the DM
 * passes — but in practice this is just a "half the damage again"
 * or "take zero" wrapper.
 *
 *   !evasion pass <damage>   — saved; heal back ALL applied damage
 *   !evasion fail <damage>   — failed; heal back HALF applied damage
 */
async function handleEvasion(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!evasion: usage `!evasion <pass|fail> <damage-applied>`');
    return true;
  }
  const outcome = parts[0].toLowerCase();
  const dmg = parseInt(parts[1], 10);
  if ((outcome !== 'pass' && outcome !== 'fail') || !Number.isFinite(dmg) || dmg < 1) {
    whisperToCaller(c.io, c.ctx, '!evasion: usage `!evasion <pass|fail> <damage-applied>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!evasion: no owned PC token.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue') && !classLower.includes('monk')) {
    whisperToCaller(c.io, c.ctx, `!evasion: ${caller.name} isn't a Rogue or Monk.`);
    return true;
  }
  const level = Number(row?.level) || 1;
  if (level < 7) {
    whisperToCaller(c.io, c.ctx, `!evasion: Evasion requires Rogue/Monk level 7 (${caller.name} is ${level}).`);
    return true;
  }
  // pass = full save means ZERO damage, but the DM already applied
  //         full/half. Refund everything.
  // fail = half-damage means take half, but the DM may have applied
  //         full. Refund half.
  const refund = outcome === 'pass' ? dmg : Math.floor(dmg / 2);
  if (c.ctx.room.combatState?.active) {
    const r = await CombatService.applyHeal(c.ctx.room.sessionId, caller.id, refund);
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: caller.id, hp: r.hp, tempHp: r.tempHp, change: refund, type: 'heal',
    });
    if (r.characterId) {
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: r.characterId,
        changes: { hitPoints: r.hp, tempHitPoints: r.tempHp },
      });
    }
  }
  broadcastSystem(
    c.io, c.ctx,
    `💨 ${caller.name} uses Evasion (${outcome}) — ${outcome === 'pass' ? 'takes 0 damage (refund full)' : 'takes half (refund other half)'}: +${refund} HP.`,
  );
  return true;
}

registerChatCommand(['secondwind', 'sw'], handleSecondWind);
registerChatCommand(['actionsurge', 'surge'], handleActionSurge);
registerChatCommand('cunning', handleCunning);
registerChatCommand(['lay', 'layonhands', 'loh'], handleLayOnHands);
registerChatCommand(['channel', 'cd'], handleChannelDivinity);
registerChatCommand(['pam', 'buttend'], handlePolearmButt);
registerChatCommand(['uncanny', 'uncannydodge'], handleUncanny);
registerChatCommand('evasion', handleEvasion);
