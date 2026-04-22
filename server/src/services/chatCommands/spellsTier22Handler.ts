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

/**
 * Tier 22 — resurrection family + ongoing damage pseudo-conditions.
 *
 * Resurrection:
 *   !raisedead, !resurrection, !trueresurrection, !reincarnate,
 *   !gentlerepose
 *
 * Ongoing damage (applied at start of affected creature's turn until
 * save ends it). Saving throws use the initial caster's spell save DC
 * when applicable.
 *   !burning <target> <dice> <die>    — e.g. `!burning goblin 3 6` = 3d6 fire/turn
 *   !bleeding <target> <dice> <die>   — necrotic / slashing bleed
 *   !acidsplash <target> <dice> <die> — acid corrosion
 *
 * All three use a shared `ongoing-damage` pseudo-condition with
 * embedded metadata. The combat turn-tick reads the metadata and
 * applies damage via CombatService.applyDamage.
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

async function loadCaller(c: ChatCommandContext, cmd: string): Promise<{ caller: Token; callerName: string } | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query('SELECT name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  return { caller, callerName: (row?.name as string) || caller.name };
}

async function applyRevive(
  c: ChatCommandContext,
  target: Token,
  hp: number,
): Promise<void> {
  const combat = c.ctx.room.combatState;
  const combatant = combat?.combatants.find((x) => x.tokenId === target.id);
  if (combatant) {
    combatant.hp = Math.max(combatant.hp, hp);
    combatant.deathSaves = { successes: 0, failures: 0 };
  }
  if (target.characterId) {
    await pool.query(
      'UPDATE characters SET hit_points = $1, death_saves = $2 WHERE id = $3',
      [hp, JSON.stringify({ successes: 0, failures: 0 }), target.characterId],
    ).catch((e) => console.warn('[revive] hp write failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { hitPoints: hp, deathSaves: { successes: 0, failures: 0 } },
    });
  }
  // Clear the `dead` pseudo-condition if it was set.
  if ((target.conditions as string[]).includes('dead')) {
    ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'dead');
  }
  if ((target.conditions as string[]).includes('unconscious')) {
    ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'unconscious');
  }
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: target.id,
    hp,
    tempHp: 0,
    change: hp,
    type: 'heal',
  });
}

// ═══════════════════════════════════════════════════════════════════
// Raise Dead — L5, 500 gp diamond, dead ≤ 10 days
// ═══════════════════════════════════════════════════════════════════
async function handleRaiseDead(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!raisedead: usage `!raisedead <target>` (dead ≤ 10 days, 500 gp diamond)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!raisedead: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'raisedead');
  if (!loaded) return true;
  await applyRevive(c, target, 1);
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Raise Dead** (L5, 1 hr to cast, 500 gp diamond consumed) — ${loaded.callerName} returns ${target.name} to life at 1 HP. Target suffers penalties: -4 on attack rolls / saves / checks, reducing by 1 per long rest (4 long rests to fully recover). Doesn't restore missing limbs or cure diseases / poison.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Resurrection — L7, 1000 gp diamond, dead ≤ 100 years
// ═══════════════════════════════════════════════════════════════════
async function handleResurrection(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!resurrection: usage `!resurrection <target>` (dead ≤ 100 years, 1000 gp diamond)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!resurrection: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'resurrection');
  if (!loaded) return true;
  let newHp = 1;
  if (target.characterId) {
    const { rows } = await pool.query('SELECT max_hit_points FROM characters WHERE id = $1', [target.characterId]);
    newHp = Number((rows[0] as Record<string, unknown>)?.max_hit_points) || 1;
  }
  await applyRevive(c, target, newHp);
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Resurrection** (L7, 1 hr to cast, 1000 gp diamond consumed) — ${loaded.callerName} returns ${target.name} to full HP. Restores missing organs / limbs, cures diseases / poisons, ends curses. Target takes -4 penalty on all d20 rolls for 96 hrs (4 long rests).`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// True Resurrection — L9, 25,000 gp diamond, dead ≤ 200 years
// ═══════════════════════════════════════════════════════════════════
async function handleTrueResurrection(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!trueresurrection: usage `!trueresurrection <target>` (dead ≤ 200 years, 25000 gp diamond)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!trueresurrection: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'trueresurrection');
  if (!loaded) return true;
  let newHp = 1;
  if (target.characterId) {
    const { rows } = await pool.query('SELECT max_hit_points FROM characters WHERE id = $1', [target.characterId]);
    newHp = Number((rows[0] as Record<string, unknown>)?.max_hit_points) || 1;
  }
  await applyRevive(c, target, newHp);
  broadcastSystem(
    c.io, c.ctx,
    `🌟 **True Resurrection** (L9, 1 hr, 25,000 gp diamond consumed) — ${loaded.callerName} restores ${target.name} to perfect health + full HP. Creates a new body if needed. No post-resurrection penalty. Can reach souls anywhere on any plane.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Reincarnate — L5, target returns as random race
// ═══════════════════════════════════════════════════════════════════
const REINCARNATE_RACES = [
  'Dragonborn', 'Dwarf (Hill)', 'Dwarf (Mountain)', 'Elf (Dark)',
  'Elf (High)', 'Elf (Wood)', 'Gnome (Forest)', 'Gnome (Rock)',
  'Half-Elf', 'Half-Orc', 'Halfling (Lightfoot)', 'Halfling (Stout)',
  'Human', 'Tiefling',
];

async function handleReincarnate(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!reincarnate: usage `!reincarnate <target>` (dead ≤ 10 days, 1000 gp rare oils)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!reincarnate: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'reincarnate');
  if (!loaded) return true;
  const newRace = REINCARNATE_RACES[Math.floor(Math.random() * REINCARNATE_RACES.length)];
  await applyRevive(c, target, 1);
  broadcastSystem(
    c.io, c.ctx,
    `🌿 **Reincarnate** (L5, 1 hr, 1000 gp rare oils) — ${loaded.callerName} restores ${target.name}'s soul into a **new body**. Rolled on the reincarnation table: **${newRace}**. Ability scores / class levels persist; subrace traits reset to the new body.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Gentle Repose — L2 ritual, 10 days of "fresh" corpse
// ═══════════════════════════════════════════════════════════════════
async function handleGentleRepose(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!gentlerepose: usage `!gentlerepose <corpse>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!gentlerepose: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'gentlerepose');
  if (!loaded) return true;
  broadcastSystem(
    c.io, c.ctx,
    `🪦 **Gentle Repose** (L2 ritual, 10 days) — ${loaded.callerName} preserves ${target.name}'s corpse: no decay, can't become undead. Spells that raise the dead (Raise Dead etc.) don't count the 10-day gentle-repose window against their time limit.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Ongoing damage — generic applicator
// ═══════════════════════════════════════════════════════════════════
async function applyOngoingDamage(
  c: ChatCommandContext,
  cmd: string,
  label: string,
  icon: string,
  dmgType: string,
): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: usage \`!${cmd} <target> <dice> <die>\` (e.g. ${cmd} goblin 3 6 = 3d6/turn)`);
    return true;
  }
  const die = parseInt(parts[parts.length - 1], 10);
  const dice = parseInt(parts[parts.length - 2], 10);
  if (!Number.isFinite(dice) || !Number.isFinite(die) || dice < 1 || die < 2) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: dice + die must be positive integers.`);
    return true;
  }
  const targetName = parts.slice(0, -2).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, cmd);
  if (!loaded) return true;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  // Each ongoing-damage instance uses a unique condition name so
  // multiple overlapping effects don't collapse into one.
  const condName = `${cmd}-${dice}d${die}`;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: condName,
    source: `${loaded.callerName} (${label} ${dice}d${die} ${dmgType})`,
    casterTokenId: loaded.caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });
  broadcastSystem(
    c.io, c.ctx,
    `${icon} **${label}** — ${target.name} takes **${dice}d${die} ${dmgType}** at the start of its turn. Roll \`!${cmd}tick ${target.name}\` each turn to resolve — or spend an action on \`!${cmd}stop ${target.name}\` to suppress (extinguish / staunch / neutralize).`,
  );
  return true;
}

async function handleBurning(c: ChatCommandContext): Promise<boolean> {
  return applyOngoingDamage(c, 'burning', 'Burning', '🔥', 'fire');
}

async function handleBleeding(c: ChatCommandContext): Promise<boolean> {
  return applyOngoingDamage(c, 'bleeding', 'Bleeding', '🩸', 'necrotic');
}

async function handleAcidSplash(c: ChatCommandContext): Promise<boolean> {
  return applyOngoingDamage(c, 'acidsplash', 'Acid Corrosion', '🧪', 'acid');
}

// Tick: roll the damage for the affected target for this turn.
async function ongoingDamageTick(
  c: ChatCommandContext,
  cmd: string,
  label: string,
  icon: string,
  dmgType: string,
): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, `!${cmd}tick: usage \`!${cmd}tick <target>\``);
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!${cmd}tick: no token named "${targetName}".`);
    return true;
  }
  // Find the most recent <cmd>-NdM condition on this token.
  const conds = (target.conditions as string[]) || [];
  const match = conds.find((c2) => c2.startsWith(`${cmd}-`));
  if (!match) {
    whisperToCaller(c.io, c.ctx, `!${cmd}tick: ${target.name} isn't affected.`);
    return true;
  }
  const m = match.match(/(\d+)d(\d+)/);
  if (!m) return true;
  const dice = parseInt(m[1], 10);
  const die = parseInt(m[2], 10);
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < dice; i++) {
    const r = Math.floor(Math.random() * die) + 1;
    rolls.push(r);
    sum += r;
  }
  broadcastSystem(
    c.io, c.ctx,
    `${icon} **${label} tick** — ${target.name}: ${dice}d${die} [${rolls.join(',')}] = **${sum} ${dmgType}** damage.`,
  );
  return true;
}

async function ongoingDamageStop(
  c: ChatCommandContext,
  cmd: string,
  label: string,
): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, `!${cmd}stop: usage \`!${cmd}stop <target>\``);
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!${cmd}stop: no token named "${targetName}".`);
    return true;
  }
  const conds = (target.conditions as string[]) || [];
  const match = conds.find((c2) => c2.startsWith(`${cmd}-`));
  if (!match) {
    whisperToCaller(c.io, c.ctx, `!${cmd}stop: ${target.name} isn't affected.`);
    return true;
  }
  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, match);
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });
  const caller = resolveCallerToken(c.ctx);
  broadcastSystem(
    c.io, c.ctx,
    `⛔ ${caller?.name ?? 'Someone'} suppresses **${label}** on ${target.name}.`,
  );
  return true;
}

registerChatCommand(['raisedead', 'raise'], handleRaiseDead);
registerChatCommand(['resurrection', 'res'], handleResurrection);
registerChatCommand(['trueresurrection', 'tres'], handleTrueResurrection);
registerChatCommand(['reincarnate', 'reinc'], handleReincarnate);
registerChatCommand(['gentlerepose', 'repose'], handleGentleRepose);

registerChatCommand('burning', handleBurning);
registerChatCommand('bleeding', handleBleeding);
registerChatCommand(['acidsplash', 'acidburn'], handleAcidSplash);
registerChatCommand('burningtick', (c) => ongoingDamageTick(c, 'burning', 'Burning', '🔥', 'fire'));
registerChatCommand('bleedingtick', (c) => ongoingDamageTick(c, 'bleeding', 'Bleeding', '🩸', 'necrotic'));
registerChatCommand('acidsplashtick', (c) => ongoingDamageTick(c, 'acidsplash', 'Acid Corrosion', '🧪', 'acid'));
registerChatCommand('burningstop', (c) => ongoingDamageStop(c, 'burning', 'Burning'));
registerChatCommand('bleedingstop', (c) => ongoingDamageStop(c, 'bleeding', 'Bleeding'));
registerChatCommand('acidsplashstop', (c) => ongoingDamageStop(c, 'acidsplash', 'Acid Corrosion'));
