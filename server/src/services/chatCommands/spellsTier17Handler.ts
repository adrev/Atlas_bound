import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token, SpellCastBreakdown, SpellTargetOutcome } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Tier 17 — Support / utility / restoration spells:
 *   !aid, !revivify, !invisibility, !greaterinvisibility, !haste,
 *   !fly, !passwithouttrace, !lesserrestoration, !greaterrestoration,
 *   !blur, !stoneskin, !deathward
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

interface CasterMeta {
  caller: Token;
  callerName: string;
  classLower: string;
}

async function loadCaster(c: ChatCommandContext, cmd: string): Promise<CasterMeta | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query('SELECT class, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  return {
    caller,
    callerName: (row?.name as string) || caller.name,
    classLower: String(row?.class || '').toLowerCase(),
  };
}

function parseSlotLevel(parts: string[], fallback: number, min = 1): number {
  const first = parseInt(parts[0], 10);
  if (Number.isFinite(first) && first >= min && first <= 9) return first;
  return fallback;
}

async function bumpMaxHp(target: Token, amount: number, c: ChatCommandContext): Promise<{ newMax: number; newHp: number } | null> {
  if (!target.characterId) return null;
  const { rows } = await pool.query(
    'SELECT hit_points, max_hit_points FROM characters WHERE id = $1',
    [target.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const curHp = Number(row?.hit_points) || 0;
  const curMax = Number(row?.max_hit_points) || 0;
  const newMax = curMax + amount;
  const newHp = curHp + amount;
  await pool.query(
    'UPDATE characters SET hit_points = $1, max_hit_points = $2 WHERE id = $3',
    [newHp, newMax, target.characterId],
  ).catch(() => {});
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: target.characterId,
    changes: { hitPoints: newHp, maxHitPoints: newMax },
  });
  return { newMax, newHp };
}

// ────── Aid ────────────────────────────────────────
async function handleAid(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!aid: usage `!aid <t1> [t2] [t3] [slot]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slot = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 2, 2) : 2;
  const targets = lastIsNum ? parts.slice(0, -1) : parts;
  if (targets.length < 1 || targets.length > 3) {
    whisperToCaller(c.io, c.ctx, '!aid: 1-3 targets.');
    return true;
  }
  const loaded = await loadCaster(c, 'aid');
  if (!loaded) return true;
  const bonus = 5 + Math.max(0, slot - 2) * 5;
  const lines: string[] = [];
  lines.push(`💚 **Aid** (L${slot}, 8 hrs) — ${loaded.callerName} grants +${bonus} to max + current HP:`);
  const aidOutcomes: SpellTargetOutcome[] = [];
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const result = await bumpMaxHp(target, bonus, c);
    lines.push(result ? `  • ${target.name}: HP ${result.newHp}/${result.newMax}` : `  • ${target.name}: +${bonus} HP`);
    aidOutcomes.push({
      name: target.name, tokenId: target.id, kind: 'heal',
      healing: result
        ? { dice: '—', diceRolls: [], mainRoll: bonus,
            targetHpBefore: result.newHp - bonus, targetHpAfter: result.newHp }
        : { dice: '—', diceRolls: [], mainRoll: bonus,
            targetHpBefore: 0, targetHpAfter: bonus },
      notes: [`Max HP also raised by +${bonus} for 8 hours`],
    });
  }
  const aidBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: `Aid (L${slot})`, level: slot, kind: 'heal' },
    notes: [`+${bonus} to max HP AND current HP for 8 hours`],
    targets: aidOutcomes,
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { spellResult: aidBreakdown });
  return true;
}

// ────── Revivify ───────────────────────────────────
async function handleRevivify(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!revivify: usage `!revivify <dead-target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!revivify: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'revivify');
  if (!loaded) return true;
  if (target.characterId) {
    await pool.query(
      'UPDATE characters SET hit_points = 1, death_saves = $1 WHERE id = $2',
      [JSON.stringify({ successes: 0, failures: 0 }), target.characterId],
    ).catch(() => {});
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { hitPoints: 1, deathSaves: { successes: 0, failures: 0 } },
    });
  }
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: target.id,
    hp: 1,
    tempHp: 0,
    change: 1,
    type: 'heal',
  });
  const revBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: 'Revivify', level: 3, kind: 'heal' },
    notes: ['Returns creature that died within last 1 minute'],
    targets: [{
      name: target.name,
      tokenId: target.id,
      kind: 'heal',
      healing: { dice: '—', diceRolls: [], mainRoll: 1,
        targetHpBefore: 0, targetHpAfter: 1 },
      notes: ['Death saves reset'],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Revivify** — ${loaded.callerName} calls ${target.name} back from the brink! Returns at **1 HP** (died within last 1 min).`,
    { spellResult: revBreakdown },
  );
  return true;
}

// ────── Invisibility / Greater Invisibility ────────
async function applyInvisible(c: ChatCommandContext, targetName: string, duration: number, label: string, cmd: string): Promise<boolean> {
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, cmd);
  if (!loaded) return true;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'invisible',
    source: `${loaded.callerName} (${label})`,
    casterTokenId: loaded.caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + duration,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  const invisBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: label, level: label.includes('Greater') ? 4 : 2, kind: 'utility' },
    notes: [duration === 600 ? 'Concentration, 1 hour' : 'Concentration, 1 minute'],
    targets: [{
      name: target.name, tokenId: target.id, kind: 'buff',
      conditionsApplied: ['invisible'],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `👻 **${label}** — ${loaded.callerName} turns ${target.name} invisible for ${duration === 600 ? '1 hour' : '1 min'} (concentration).`,
    { spellResult: invisBreakdown },
  );
  return true;
}

async function handleInvisibility(c: ChatCommandContext): Promise<boolean> {
  const name = c.rest.trim();
  if (!name) {
    whisperToCaller(c.io, c.ctx, '!invisibility: usage `!invisibility <target>`');
    return true;
  }
  return applyInvisible(c, name, 600, 'Invisibility (L2)', 'invisibility');
}

async function handleGreaterInvisibility(c: ChatCommandContext): Promise<boolean> {
  const name = c.rest.trim();
  if (!name) {
    whisperToCaller(c.io, c.ctx, '!greaterinvisibility: usage `!greaterinvisibility <target>`');
    return true;
  }
  return applyInvisible(c, name, 10, 'Greater Invisibility (L4)', 'greaterinvisibility');
}

// ────── Haste ──────────────────────────────────────
async function handleHaste(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!haste: usage `!haste <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!haste: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'haste');
  if (!loaded) return true;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'hasted',
    source: `${loaded.callerName} (Haste)`,
    casterTokenId: loaded.caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  const hasteBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: 'Haste', level: 3, kind: 'utility' },
    notes: ['Concentration, 1 min. +2 AC, adv on DEX saves, speed doubled, extra action'],
    targets: [{
      name: target.name, tokenId: target.id, kind: 'buff',
      conditionsApplied: ['hasted'],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `⚡ **Haste** (L3, concentration 1 min) — ${loaded.callerName} hastens ${target.name}: +2 AC, adv on DEX saves, speed doubled, extra action (Attack 1-atk/Dash/Disengage/Hide/Use).`,
    { spellResult: hasteBreakdown },
  );
  return true;
}

// ────── Fly ────────────────────────────────────────
async function handleFly(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!fly: usage `!fly <t1> [t2 …] [slot]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slot = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 3, 3) : 3;
  const targets = lastIsNum ? parts.slice(0, -1) : parts;
  const maxTargets = 1 + Math.max(0, slot - 3);
  if (targets.length > maxTargets) {
    whisperToCaller(c.io, c.ctx, `!fly: L${slot} can target up to ${maxTargets}.`);
    return true;
  }
  const loaded = await loadCaster(c, 'fly');
  if (!loaded) return true;
  const flyOutcomes: SpellTargetOutcome[] = targets.map((name) => {
    const t = resolveTargetByName(c.ctx, name);
    return {
      name: t?.name ?? name,
      tokenId: t?.id,
      kind: 'buff',
      notes: ['60 ft fly speed'],
    };
  });
  const flyBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: `Fly (L${slot})`, level: slot, kind: 'utility' },
    notes: ['Concentration, 10 min'],
    targets: flyOutcomes,
  };
  broadcastSystem(
    c.io, c.ctx,
    `🪶 **Fly** (L${slot}, concentration 10 min) — ${loaded.callerName} grants **60 ft fly speed** to: ${targets.join(', ')}.`,
    { spellResult: flyBreakdown },
  );
  return true;
}

// ────── Pass Without Trace ─────────────────────────
async function handlePassWithoutTrace(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaster(c, 'passwithouttrace');
  if (!loaded) return true;
  const pwtBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: 'Pass Without Trace', level: 2, kind: 'utility' },
    notes: ['30-ft aura, +10 Stealth, leave no tracks. Concentration, 1 hr.'],
    targets: [],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🌲 **Pass Without Trace** (L2, concentration 1 hr) — ${loaded.callerName} blesses all creatures within 30 ft: **+10 Stealth**, leave no tracks.`,
    { spellResult: pwtBreakdown },
  );
  return true;
}

// ────── Lesser Restoration ─────────────────────────
async function handleLesserRestoration(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!lesserrestoration: usage `!lesserrestoration <target> <poisoned|paralyzed|blinded|deafened|disease>`');
    return true;
  }
  const cond = parts[parts.length - 1].toLowerCase();
  const valid = ['poisoned', 'paralyzed', 'blinded', 'deafened', 'disease', 'diseased'];
  if (!valid.includes(cond)) {
    whisperToCaller(c.io, c.ctx, `!lesserrestoration: condition must be one of ${valid.join(', ')}.`);
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!lesserrestoration: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'lesserrestoration');
  if (!loaded) return true;
  if (cond !== 'disease' && cond !== 'diseased') {
    if ((target.conditions as string[]).includes(cond)) {
      ConditionService.removeCondition(c.ctx.room.sessionId, target.id, cond);
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
  }
  const lrBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: 'Lesser Restoration', level: 2, kind: 'utility' },
    notes: [`Cure ${cond} on target`],
    targets: [{
      name: target.name, tokenId: target.id, kind: 'utility',
      notes: [`Cured of ${cond}`],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Lesser Restoration** (L2) — ${loaded.callerName} cures ${target.name} of **${cond}**.`,
    { spellResult: lrBreakdown },
  );
  return true;
}

// ────── Greater Restoration ────────────────────────
async function handleGreaterRestoration(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!greaterrestoration: usage `!greaterrestoration <target> <exhaustion|charm|petrify|curse|reduce-hp>`');
    return true;
  }
  const eff = parts[parts.length - 1].toLowerCase();
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!greaterrestoration: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'greaterrestoration');
  if (!loaded) return true;
  // Exhaustion reduction if PC character tracked.
  if ((eff === 'exhaustion' || eff === 'exhaust') && target.characterId) {
    const { rows } = await pool.query('SELECT exhaustion_level FROM characters WHERE id = $1', [target.characterId]);
    const cur = Number((rows[0] as Record<string, unknown>)?.exhaustion_level) || 0;
    const newLvl = Math.max(0, cur - 1);
    await pool.query('UPDATE characters SET exhaustion_level = $1 WHERE id = $2', [newLvl, target.characterId]).catch(() => {});
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { exhaustionLevel: newLvl },
    });
  }
  if (eff === 'charm') {
    if ((target.conditions as string[]).includes('charmed')) {
      ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'charmed');
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
  }
  if (eff === 'petrify' || eff === 'petrified') {
    if ((target.conditions as string[]).includes('petrified')) {
      ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'petrified');
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
  }
  const grBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: 'Greater Restoration', level: 5, kind: 'utility' },
    notes: [`Restoration effect: ${eff}`],
    targets: [{
      name: target.name, tokenId: target.id, kind: 'utility',
      notes: [`Restored from ${eff}`],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Greater Restoration** (L5) — ${loaded.callerName} restores ${target.name} from **${eff}**.`,
    { spellResult: grBreakdown },
  );
  return true;
}

// ────── Blur ───────────────────────────────────────
async function handleBlur(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaster(c, 'blur');
  if (!loaded) return true;
  const { caller, callerName } = loaded;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
    name: 'blur',
    source: `${callerName} (Blur)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: caller.id,
    changes: tokenConditionChanges(c.ctx.room, caller.id),
  });
  const blurBreakdown: SpellCastBreakdown = {
    caster: { name: callerName, tokenId: caller.id },
    spell: { name: 'Blur', level: 2, kind: 'utility' },
    notes: ['Concentration, 1 min. Attacks against have disadvantage (blindsight/truesight bypass)'],
    targets: [{
      name: callerName, tokenId: caller.id, kind: 'buff',
      conditionsApplied: ['blur'],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `💫 **Blur** (L2, concentration 1 min) — ${callerName} becomes blurred. Attack rolls against have **disadvantage** (unless blindsight / truesight).`,
    { spellResult: blurBreakdown },
  );
  return true;
}

// ────── Stoneskin ──────────────────────────────────
async function handleStoneskin(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!stoneskin: usage `!stoneskin <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!stoneskin: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'stoneskin');
  if (!loaded) return true;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'stoneskin',
    source: `${loaded.callerName} (Stoneskin)`,
    casterTokenId: loaded.caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 600,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  const ssBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: 'Stoneskin', level: 4, kind: 'utility' },
    notes: ['Concentration, 1 hr. Resistance to non-magical bludgeoning/piercing/slashing'],
    targets: [{
      name: target.name, tokenId: target.id, kind: 'buff',
      conditionsApplied: ['stoneskin'],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🗿 **Stoneskin** (L4, concentration 1 hr) — ${loaded.callerName} grants ${target.name} **resistance to non-magical BPS damage**.`,
    { spellResult: ssBreakdown },
  );
  return true;
}

// ────── Death Ward ─────────────────────────────────
async function handleDeathWard(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!deathward: usage `!deathward <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!deathward: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'deathward');
  if (!loaded) return true;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'death-warded',
    source: `${loaded.callerName} (Death Ward)`,
    casterTokenId: loaded.caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 4800, // 8 hours
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  const dwBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: { name: 'Death Ward', level: 4, kind: 'utility' },
    notes: ['8 hrs. First time target would drop to 0 HP, drop to 1 instead.'],
    targets: [{
      name: target.name, tokenId: target.id, kind: 'buff',
      conditionsApplied: ['death-warded'],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🛡 **Death Ward** (L4, 8 hrs) — ${loaded.callerName} wards ${target.name}: first time they would drop to 0 HP, drop to 1 instead. Single use.`,
    { spellResult: dwBreakdown },
  );
  return true;
}

registerChatCommand('aid', handleAid);
registerChatCommand('revivify', handleRevivify);
registerChatCommand(['invisibility', 'invis'], handleInvisibility);
registerChatCommand(['greaterinvisibility', 'ginvis'], handleGreaterInvisibility);
registerChatCommand(['haste', 'hastespell'], handleHaste);
registerChatCommand('fly', handleFly);
registerChatCommand(['passwithouttrace', 'pwt'], handlePassWithoutTrace);
registerChatCommand(['lesserrestoration', 'lr'], handleLesserRestoration);
registerChatCommand(['greaterrestoration', 'gr'], handleGreaterRestoration);
registerChatCommand('blur', handleBlur);
registerChatCommand('stoneskin', handleStoneskin);
registerChatCommand(['deathward', 'dw'], handleDeathWard);
