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
 * Utility commands for common mid-session effects that players
 * otherwise track by hand: healing potions, the Lucky feat, the
 * Medicine-check stabilize rule, Turn Undead, and the two common
 * concentration damage-riders (Hex / Hunter's Mark).
 */

// ────── Helpers ─────────────────────────────────────────────────

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

function rollDice(notation: string): { total: number; rolls: number[] } {
  const m = notation.match(/^(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?$/i);
  if (!m) return { total: 0, rolls: [] };
  const count = parseInt(m[1], 10);
  const sides = parseInt(m[2], 10);
  const sign = m[3] === '-' ? -1 : 1;
  const mod = m[4] ? parseInt(m[4], 10) * sign : 0;
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const r = Math.floor(Math.random() * sides) + 1;
    rolls.push(r);
    sum += r;
  }
  return { total: Math.max(0, sum + mod), rolls };
}

// ────── !potion <target> [dice] ───────────────────────────────
/**
 * Healing potion. Default 2d4+2 (standard potion). Other types:
 *   potion of greater healing  → 4d4+4
 *   potion of superior healing → 8d4+8
 *   potion of supreme healing  → 10d4+20
 * Pass the dice notation as the second arg to override the default.
 */
async function handlePotion(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!potion: usage `!potion <target> [dice]` — default 2d4+2 (potion of healing).',
    );
    return true;
  }

  // Last arg is dice notation if it matches NdN pattern; everything
  // before is target name.
  let notation = '2d4+2';
  const last = parts[parts.length - 1];
  if (/^\d+d\d+(\s*[+-]\s*\d+)?$/i.test(last)) {
    notation = last;
    parts.pop();
  }
  const targetName = parts.join(' ');
  const target = targetName ? resolveTargetByName(c.ctx, targetName) : resolveCallerToken(c.ctx);
  if (!target?.characterId) {
    whisperToCaller(c.io, c.ctx, `!potion: no target with a character sheet named "${targetName}".`);
    return true;
  }

  const { rows } = await pool.query('SELECT hit_points, max_hit_points, temp_hit_points, name FROM characters WHERE id = $1', [target.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!potion: character not found.');
    return true;
  }
  const curHp = Number(row.hit_points) || 0;
  const maxHp = Number(row.max_hit_points) || 0;
  const tempHp = Number(row.temp_hit_points) || 0;
  if (curHp <= 0) {
    // Stable-but-unconscious character drinking a potion is valid;
    // downed characters need someone else to administer. We'll allow
    // either case and let the DM adjudicate RP-wise.
  }
  const { total: heal, rolls } = rollDice(notation);
  const newHp = Math.min(maxHp, curHp + heal);
  await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [newHp, target.characterId])
    .catch((e) => console.warn('[!potion] hp write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: target.characterId,
    changes: { hitPoints: newHp },
  });
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: target.id,
    hp: newHp,
    tempHp,
    change: newHp - curHp,
    type: 'heal',
  });
  broadcastSystem(
    c.io, c.ctx,
    `🧪 ${target.name} drinks a potion (${notation}) — heals ${notation}(${rolls.join('+')}) = **${heal}** → ${newHp}/${maxHp} HP.`,
  );
  return true;
}

// ────── !lucky (Lucky feat reroll) ────────────────────────────
/**
 * Lucky feat: 3 luck points per long rest. When you make an attack
 * roll, ability check, or saving throw, you can spend 1 luck point
 * to roll an additional d20 and choose which of the two to use.
 * (If an attacker rolls with advantage against you, you can also
 * spend a point to force them to use the lower — omitted here; DM
 * adjudicates that variant.)
 *
 * We track points as a session-level counter keyed on the character
 * id so it survives across individual rolls. Reset on long rest via
 * a dedicated flag — for now, the DM runs !lucky reset after any
 * long rest.
 */
const luckPoints = new Map<string, number>();
const LUCKY_MAX = 3;

async function handleLucky(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim().toLowerCase();
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!lucky: no owned PC token on this map.');
    return true;
  }

  // Optional feat check — don't hard-block so Halfling racial Lucky
  // also works (Halfling Lucky auto-rerolls 1s; the feat is
  // different, but either way the rerolling intent is the same).
  let available = luckPoints.get(caller.characterId);
  if (available === undefined) {
    available = LUCKY_MAX;
    luckPoints.set(caller.characterId, available);
  }

  if (arg === 'reset') {
    if (c.ctx.player.role !== 'dm') {
      whisperToCaller(c.io, c.ctx, '!lucky reset: DM only (fires on long rest).');
      return true;
    }
    luckPoints.set(caller.characterId, LUCKY_MAX);
    broadcastSystem(c.io, c.ctx, `🍀 ${caller.name} — Lucky points refreshed (${LUCKY_MAX}/${LUCKY_MAX}).`);
    return true;
  }

  if (arg === 'status' || !arg) {
    whisperToCaller(c.io, c.ctx, `🍀 Lucky points: ${available}/${LUCKY_MAX}.`);
    return true;
  }

  if (arg === 'use' || arg === 'spend') {
    if (available <= 0) {
      whisperToCaller(c.io, c.ctx, '!lucky: no points remaining. Long rest to refresh.');
      return true;
    }
    luckPoints.set(caller.characterId, available - 1);
    const d20 = Math.floor(Math.random() * 20) + 1;
    broadcastSystem(
      c.io, c.ctx,
      `🍀 ${caller.name} spends Lucky — extra d20 = **${d20}**. Use either this or the original. (${available - 1}/${LUCKY_MAX} left)`,
    );
    return true;
  }

  whisperToCaller(c.io, c.ctx, '!lucky: usage `!lucky use` | `!lucky status` | `!lucky reset` (DM)');
  return true;
}

// ────── !stabilize <target> ───────────────────────────────────
/**
 * Medicine DC 10 check to stabilize a creature at 0 HP. On a
 * success, the creature doesn't have to make death saves any
 * more (HP stays at 0; condition effectively "stable"). On a
 * failure, nothing changes.
 *
 * We roll the caller's WIS + proficiency-if-proficient, broadcast
 * the result, and if it succeeds we clear the death-save counter
 * and apply a `stable` pseudo-condition.
 */
async function handleStabilize(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!stabilize: usage `!stabilize <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target?.characterId) {
    whisperToCaller(c.io, c.ctx, `!stabilize: no character named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!stabilize: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT ability_scores, skills, proficiency_bonus FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  let wisMod = 0, prof = 2, hasProf = false;
  try {
    const scores = typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores ?? {});
    wisMod = Math.floor((((scores as Record<string, number>).wis ?? 10) - 10) / 2);
    prof = Number(row?.proficiency_bonus) || 2;
    const sk = typeof row?.skills === 'string' ? JSON.parse(row.skills as string) : (row?.skills ?? {});
    const medicineProf = (sk as Record<string, string>)?.medicine ?? 'none';
    hasProf = medicineProf === 'proficient' || medicineProf === 'expertise';
  } catch { /* ignore */ }
  const bonus = wisMod + (hasProf ? prof : 0);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + bonus;
  const dc = 10;
  const success = total >= dc;
  const sign = bonus >= 0 ? '+' : '';
  const lines: string[] = [];
  lines.push(`🩹 ${caller.name} tries to Stabilize ${target.name}`);
  lines.push(`   Medicine (WIS${hasProf ? ' + prof' : ''}): d20=${d20}${sign}${bonus}=${total} vs DC ${dc} → ${success ? 'SUCCESS' : 'FAIL'}`);
  if (success) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'stable',
      source: `${caller.name} (!stabilize)`,
      appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
    });
    // Reset death saves on the target if present.
    await pool.query(
      'UPDATE characters SET death_saves = $1 WHERE id = $2',
      [JSON.stringify({ successes: 0, failures: 0 }), target.characterId],
    ).catch((e) => console.warn('[!stabilize] death-save reset failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { deathSaves: { successes: 0, failures: 0 } },
    });
    lines.push(`   → ${target.name} is STABLE (no more death saves; HP stays at 0).`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── !hex / !unhex <target> ──────────────────────────────
/**
 * Warlock's Hex cantrip. Deals +1d6 necrotic when the caster hits
 * the hexed target with an attack. Concentration spell — the
 * caster moves the hex on death. We track via the `hexed` pseudo-
 * condition with casterTokenId set so the attack resolver can
 * match "the hex caster is also the current attacker".
 *
 * Also imposes disadvantage on one ability check (caster's choice)
 * — out of scope here, DM adjudicates.
 */
async function handleHex(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!hex: usage `!hex <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!hex: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!hex: no owned PC token.');
    return true;
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'hexed',
    source: `${caller.name} (Hex)`,
    casterTokenId: caller.id,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🕷 ${caller.name} hexes ${target.name} — caster's attacks against this target deal +1d6 necrotic.`,
  );
  return true;
}

async function handleUnhex(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!unhex: usage `!unhex <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!unhex: no token named "${targetName}".`);
    return true;
  }
  if (!(target.conditions as string[]).some((x) => x.toLowerCase() === 'hexed')) {
    whisperToCaller(c.io, c.ctx, `!unhex: ${target.name} isn't hexed.`);
    return true;
  }
  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'hexed');
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `🕷 Hex lifted from ${target.name}.`);
  return true;
}

// ────── !mark / !unmark <target> (Hunter's Mark) ──────────
/**
 * Ranger's Hunter's Mark. Adds +1d6 to weapon damage when the
 * caster hits the marked target. Concentration; caster can move
 * it as a bonus action. Also grants adv on WIS(Perception) and
 * WIS(Survival) checks to find the target — DM adjudicates those.
 */
async function handleMark(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!mark: usage `!mark <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!mark: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!mark: no owned PC token.');
    return true;
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'marked',
    source: `${caller.name} (Hunter's Mark)`,
    casterTokenId: caller.id,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🏹 ${caller.name} marks ${target.name} (Hunter's Mark) — +1d6 weapon damage from caster.`,
  );
  return true;
}

async function handleUnmark(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!unmark: no token named "${targetName}".`);
    return true;
  }
  if (!(target.conditions as string[]).some((x) => x.toLowerCase() === 'marked')) {
    whisperToCaller(c.io, c.ctx, `!unmark: ${target.name} isn't marked.`);
    return true;
  }
  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'marked');
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `🏹 Hunter's Mark lifted from ${target.name}.`);
  return true;
}

// ────── !turnundead ─────────────────────────────────────────
/**
 * Cleric's Turn Undead Channel Divinity. Each undead within 30 ft
 * that can see or hear you must make a WIS save (DC = your spell
 * save DC). On a failure, they're Frightened of you for 1 minute
 * (10 rounds) and must spend movement to move away from you each
 * turn.
 *
 * We don't auto-detect "undead" creature type or 30-ft range — DM
 * decides who's in range. The command just rolls the save for each
 * target the DM passes.
 *
 *   !turnundead <target> [target2] [...]    DC = caller's spell save DC
 */
async function handleTurnUndead(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!turnundead: usage `!turnundead <target> [target2] ...`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!turnundead: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT spell_save_dc, class, name FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const dc = Number(row?.spell_save_dc) || 13;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('cleric') && !classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!turnundead: ${caller.name} isn't a Cleric or Paladin.`);
    return true;
  }

  const lines: string[] = [];
  lines.push(`⚱ ${caller.name} presents their holy symbol and speaks — Turn Undead (DC ${dc} WIS save)`);
  for (const targetName of parts) {
    const target = resolveTargetByName(c.ctx, targetName);
    if (!target) {
      lines.push(`   • ${targetName}: not found`);
      continue;
    }
    // Roll target's WIS save. If they have a character, use it; else
    // DM rolls externally and applies.
    if (!target.characterId) {
      lines.push(`   • ${target.name}: no character sheet — DM rolls WIS save externally.`);
      continue;
    }
    const { rows: trows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus FROM characters WHERE id = $1',
      [target.characterId],
    );
    const trow = trows[0] as Record<string, unknown> | undefined;
    let wisMod = 0, tProf = 2, isProf = false;
    try {
      const scores = typeof trow?.ability_scores === 'string' ? JSON.parse(trow.ability_scores as string) : (trow?.ability_scores ?? {});
      wisMod = Math.floor((((scores as Record<string, number>).wis ?? 10) - 10) / 2);
      tProf = Number(trow?.proficiency_bonus) || 2;
      const saves = typeof trow?.saving_throws === 'string' ? JSON.parse(trow.saving_throws as string) : (trow?.saving_throws ?? []);
      isProf = Array.isArray(saves) && saves.includes('wis');
    } catch { /* ignore */ }
    const saveMod = wisMod + (isProf ? tProf : 0);
    const d20 = Math.floor(Math.random() * 20) + 1;
    const total = d20 + saveMod;
    const saved = total >= dc;
    const modSign = saveMod >= 0 ? '+' : '';
    lines.push(`   • ${target.name} WIS save: d20=${d20}${modSign}${saveMod}=${total} → ${saved ? 'SAVED' : 'FAILED'}`);
    if (!saved) {
      const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'frightened',
        source: `${caller.name} (Turn Undead)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 10,
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
      lines.push(`     → Frightened for 1 min; must Dash away.`);
    }
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

registerChatCommand(['potion', 'drink'], handlePotion);
registerChatCommand('lucky', handleLucky);
registerChatCommand(['stabilize', 'stabilise'], handleStabilize);
registerChatCommand('hex', handleHex);
registerChatCommand('unhex', handleUnhex);
registerChatCommand(['mark', 'huntersmark'], handleMark);
registerChatCommand('unmark', handleUnmark);
registerChatCommand(['turnundead', 'turn'], handleTurnUndead);
