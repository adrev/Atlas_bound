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
 * Tier 21 — additional commonly-cast spells beyond Tiers 12/16/17.
 *
 * Control + debuff (save-or-suck):
 *   !hypnoticpattern, !dominateperson, !dominatemonster, !dominatebeast,
 *   !feeblemind, !holdmonster (already exists in spellHandlers — skip),
 *   !polymorph, !truepolymorph
 *
 * Damage spells:
 *   !stinkingcloud, !cloudkill, !meteorswarm, !powerwordkill,
 *   !powerwordstun, !wallofforce, !walloffire, !wallofstone, !wallofice
 *
 * Utility + high-level:
 *   !trueseeing, !scrying, !teleport, !planeshift, !gate, !wish,
 *   !simulacrum, !contingency, !glyphofwarding
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

function abilityMod(scores: Record<string, number> | undefined, ability: string): number {
  const raw = (scores ?? {})[ability] ?? 10;
  return Math.floor((raw - 10) / 2);
}

function spellcastingAbility(classLower: string): 'int' | 'wis' | 'cha' {
  if (classLower.includes('wizard') || classLower.includes('artificer')) return 'int';
  if (classLower.includes('cleric') || classLower.includes('druid') || classLower.includes('ranger')) return 'wis';
  if (classLower.includes('bard') || classLower.includes('sorcerer') || classLower.includes('warlock') || classLower.includes('paladin')) return 'cha';
  if (classLower.includes('monk')) return 'wis';
  if (classLower.includes('fighter') || classLower.includes('rogue')) return 'int';
  return 'cha';
}

interface CasterStats {
  caller: Token;
  callerName: string;
  classLower: string;
  spellSaveDc: number;
}

async function loadCaster(c: ChatCommandContext, cmd: string): Promise<CasterStats | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, name, ability_scores, proficiency_bonus, spell_save_dc FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const ability = spellcastingAbility(classLower);
  const prof = Number(row?.proficiency_bonus) || 2;
  const mod = abilityMod(scores as Record<string, number>, ability);
  const dcFromRow = Number(row?.spell_save_dc);
  const spellSaveDc = Number.isFinite(dcFromRow) && dcFromRow > 0 ? dcFromRow : 8 + prof + mod;
  return {
    caller,
    callerName: (row?.name as string) || caller.name,
    classLower,
    spellSaveDc,
  };
}

async function loadTargetSaveMod(
  target: Token,
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
): Promise<{ mod: number; displayName: string }> {
  if (!target.characterId) return { mod: 0, displayName: target.name };
  try {
    const { rows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = $1',
      [target.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const scores = typeof row?.ability_scores === 'string'
      ? JSON.parse(row.ability_scores as string)
      : (row?.ability_scores ?? {});
    const prof = Number(row?.proficiency_bonus) || 2;
    const saves = typeof row?.saving_throws === 'string'
      ? JSON.parse(row.saving_throws as string)
      : (row?.saving_throws ?? []);
    const mod = abilityMod(scores as Record<string, number>, ability) +
      (Array.isArray(saves) && saves.includes(ability) ? prof : 0);
    return { mod, displayName: (row?.name as string) || target.name };
  } catch {
    return { mod: 0, displayName: target.name };
  }
}

function parseSlotLevel(parts: string[], fallback: number, min = 1): number {
  const first = parseInt(parts[0], 10);
  if (Number.isFinite(first) && first >= min && first <= 9) return first;
  return fallback;
}

function splitSlotAndTargets(
  parts: string[],
  defaultSlot: number,
  minSlot: number,
): { slot: number; targets: string[] } {
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slot = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], defaultSlot, minSlot) : defaultSlot;
  const targets = lastIsNum ? parts.slice(0, -1) : parts;
  return { slot, targets };
}

function roll(diceCount: number, sides: number): { rolls: number[]; sum: number } {
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < diceCount; i++) {
    const r = Math.floor(Math.random() * sides) + 1;
    rolls.push(r);
    sum += r;
  }
  return { rolls, sum };
}

async function saveOrCharm(
  c: ChatCommandContext,
  spellName: string,
  icon: string,
  targets: string[],
  condName: string,
  save: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  dc: number,
  callerName: string,
  casterId: string,
  durationRounds: number,
  extras: { saveAtEndOfTurn?: boolean; endsOnDamage?: boolean } = {},
): Promise<void> {
  const lines: string[] = [];
  lines.push(`${icon} **${spellName}** (${save.toUpperCase()} DC ${dc}) — ${callerName}:`);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const { mod, displayName } = await loadTargetSaveMod(target, save);
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= dc;
    const sign = mod >= 0 ? '+' : '';
    if (!saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: condName,
        source: `${callerName} (${spellName})`,
        casterTokenId: casterId,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + durationRounds,
        ...(extras.saveAtEndOfTurn ? { saveAtEndOfTurn: { ability: save, dc } } : {}),
        ...(extras.endsOnDamage ? { endsOnDamage: true } : {}),
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
    lines.push(`  • ${displayName}: ${save.toUpperCase()} d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : condName.toUpperCase()}`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════════
// Hypnotic Pattern — L3, 30-ft cube, WIS save, charmed + incapacitated
// ═══════════════════════════════════════════════════════════════════
async function handleHypnoticPattern(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!hypnoticpattern: usage `!hypnoticpattern <t1> [t2 …]`');
    return true;
  }
  const loaded = await loadCaster(c, 'hypnoticpattern');
  if (!loaded) return true;
  await saveOrCharm(
    c, 'Hypnotic Pattern', '🎶', parts,
    'charmed', 'wis', loaded.spellSaveDc, loaded.callerName, loaded.caller.id,
    10, { endsOnDamage: true },
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Dominate Person / Monster / Beast
// ═══════════════════════════════════════════════════════════════════
function dominateHandler(
  cmd: string, label: string, minSlot: number,
): (c: ChatCommandContext) => Promise<boolean> {
  return async (c: ChatCommandContext): Promise<boolean> => {
    const parts = c.rest.split(/\s+/).filter(Boolean);
    if (parts.length < 1) {
      whisperToCaller(c.io, c.ctx, `!${cmd}: usage \`!${cmd} <target> [slot]\``);
      return true;
    }
    const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
    const slot = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], minSlot, minSlot) : minSlot;
    const targetName = (lastIsNum ? parts.slice(0, -1) : parts).join(' ');
    const target = resolveTargetByName(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!${cmd}: no token named "${targetName}".`);
      return true;
    }
    const loaded = await loadCaster(c, cmd);
    if (!loaded) return true;
    const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= loaded.spellSaveDc;
    const sign = mod >= 0 ? '+' : '';
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    if (!saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'charmed',
        source: `${loaded.callerName} (${label} L${slot})`,
        casterTokenId: loaded.caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 100,
        saveAtEndOfTurn: { ability: 'wis', dc: loaded.spellSaveDc },
        endsOnDamage: true,
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
    broadcastSystem(
      c.io, c.ctx,
      `🧠 **${label} (L${slot}, WIS DC ${loaded.spellSaveDc})** — ${loaded.callerName} → ${displayName}: d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED — no effect' : 'DOMINATED (concentration, saves at end of turn / on damage)'}`,
    );
    return true;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Polymorph / True Polymorph
// ═══════════════════════════════════════════════════════════════════
async function handlePolymorph(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!polymorph: usage `!polymorph <target> <beast-CR>`');
    return true;
  }
  const crStr = parts[parts.length - 1];
  const cr = Number(crStr);
  if (!Number.isFinite(cr)) {
    whisperToCaller(c.io, c.ctx, '!polymorph: last arg must be beast CR.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!polymorph: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'polymorph');
  if (!loaded) return true;
  const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + mod;
  const saved = tot >= loaded.spellSaveDc;
  const sign = mod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `🦉 **Polymorph** (L4, WIS DC ${loaded.spellSaveDc}) — ${loaded.callerName} → ${displayName}: d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED — no effect' : `POLYMORPHED into CR ≤ ${cr} beast (concentration, 1 hr, reverts on 0 HP)`}`,
  );
  return true;
}

async function handleTruePolymorph(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!truepolymorph: usage `!truepolymorph <target>`');
    return true;
  }
  const targetName = parts.join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!truepolymorph: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'truepolymorph');
  if (!loaded) return true;
  const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + mod;
  const saved = tot >= loaded.spellSaveDc;
  const sign = mod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `✨ **True Polymorph** (L9, WIS DC ${loaded.spellSaveDc}) — ${loaded.callerName} → ${displayName}: d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED — no effect' : 'TRANSFORMED into any creature or object (concentration, 1 hr → permanent)'}`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Feeblemind — L8, INT save, INT & CHA become 1
// ═══════════════════════════════════════════════════════════════════
async function handleFeeblemind(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!feeblemind: usage `!feeblemind <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!feeblemind: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'feeblemind');
  if (!loaded) return true;
  const { mod, displayName } = await loadTargetSaveMod(target, 'int');
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + mod;
  const saved = tot >= loaded.spellSaveDc;
  const psychicRoll = roll(4, 8);
  const sign = mod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `🧠 **Feeblemind** (L8, INT DC ${loaded.spellSaveDc}) — ${loaded.callerName} → ${displayName}: d20=${d20}${sign}${mod}=${tot}. Takes ${psychicRoll.sum} psychic [${psychicRoll.rolls.join(',')}]. ${saved ? 'SAVED — no mental reduction' : 'FAILED — INT + CHA become 1, can\'t cast / speak. INT save at end of each 30 days to end.'}`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Stinking Cloud — L3, CON save, poisoned incap each turn
// ═══════════════════════════════════════════════════════════════════
async function handleStinkingCloud(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!stinkingcloud: usage `!stinkingcloud <t1> [t2 …]`');
    return true;
  }
  const loaded = await loadCaster(c, 'stinkingcloud');
  if (!loaded) return true;
  await saveOrCharm(
    c, 'Stinking Cloud', '💨', parts,
    'incapacitated', 'con', loaded.spellSaveDc, loaded.callerName, loaded.caller.id,
    10, { saveAtEndOfTurn: true },
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Cloudkill — L5, 5d8 poison, CON save for half, moves 10 ft/turn
// ═══════════════════════════════════════════════════════════════════
async function handleCloudkill(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!cloudkill: usage `!cloudkill <t1> [t2 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'cloudkill');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 5, 5);
  const dice = 5 + Math.max(0, slot - 5);
  const lines: string[] = [];
  lines.push(`☠ **Cloudkill** (L${slot}, 20-ft sphere, CON DC ${loaded.spellSaveDc}, moves 10 ft/turn) — ${loaded.callerName}:`);
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const { rolls, sum } = roll(dice, 8);
    const { mod, displayName } = await loadTargetSaveMod(target, 'con');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= loaded.spellSaveDc;
    const dmg = saved ? Math.floor(sum / 2) : sum;
    const sign = mod >= 0 ? '+' : '';
    lines.push(`  • ${displayName}: CON d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : 'FAILED'}, **${dmg} poison** [${rolls.join(',')}]`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Meteor Swarm — L9, 40d6 fire+bludgeoning, 4 × 40-ft radius
// ═══════════════════════════════════════════════════════════════════
async function handleMeteorSwarm(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!meteorswarm: usage `!meteorswarm <t1> [t2 …]`');
    return true;
  }
  const loaded = await loadCaster(c, 'meteorswarm');
  if (!loaded) return true;
  const lines: string[] = [];
  lines.push(`☄ **Meteor Swarm** (L9, 4 × 40-ft radius, DEX DC ${loaded.spellSaveDc}) — ${loaded.callerName}:`);
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const fire = roll(20, 6);
    const bludgeon = roll(20, 6);
    const raw = fire.sum + bludgeon.sum;
    const { mod, displayName } = await loadTargetSaveMod(target, 'dex');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= loaded.spellSaveDc;
    const dmg = saved ? Math.floor(raw / 2) : raw;
    const sign = mod >= 0 ? '+' : '';
    lines.push(`  • ${displayName}: DEX d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : 'FAILED'}, **${dmg}** (${fire.sum} fire + ${bludgeon.sum} bludgeoning)`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Power Word Kill — L9, target HP ≤ 100 dies, no save
// ═══════════════════════════════════════════════════════════════════
async function handlePowerWordKill(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!powerwordkill: usage `!powerwordkill <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!powerwordkill: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'powerwordkill');
  if (!loaded) return true;
  const combatant = c.ctx.room.combatState?.combatants.find((x) => x.tokenId === target.id);
  const hp = combatant?.hp ?? 200; // if out of combat we can't check — let DM adjudicate
  const dies = hp <= 100;
  broadcastSystem(
    c.io, c.ctx,
    `💀 **Power Word Kill** (L9, no save) — ${loaded.callerName} → ${target.name}: current HP ${hp}. ${dies ? '**DIES instantly** (HP ≤ 100).' : 'No effect (HP > 100).'}`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Power Word Stun — L8, no save, stunned until saves WIS DC
// ═══════════════════════════════════════════════════════════════════
async function handlePowerWordStun(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!powerwordstun: usage `!powerwordstun <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!powerwordstun: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'powerwordstun');
  if (!loaded) return true;
  const combatant = c.ctx.room.combatState?.combatants.find((x) => x.tokenId === target.id);
  const hp = combatant?.hp ?? 200;
  if (hp > 150) {
    broadcastSystem(c.io, c.ctx,
      `🌀 **Power Word Stun** (L8) — ${loaded.callerName} → ${target.name}: HP ${hp} > 150 — no effect.`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'stunned',
    source: `${loaded.callerName} (Power Word Stun)`,
    casterTokenId: loaded.caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 100,
    saveAtEndOfTurn: { ability: 'cha', dc: loaded.spellSaveDc },
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx,
    `🌀 **Power Word Stun** (L8) — ${loaded.callerName} → ${target.name}: HP ${hp} ≤ 150. **STUNNED** — CHA DC ${loaded.spellSaveDc} save at end of each turn to end.`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Wall spells — announce the wall (geometry is DM's call)
// ═══════════════════════════════════════════════════════════════════
function wallHandler(
  cmd: string, name: string, icon: string, slot: number, detail: string,
): (c: ChatCommandContext) => Promise<boolean> {
  return async (c: ChatCommandContext): Promise<boolean> => {
    const loaded = await loadCaster(c, cmd);
    if (!loaded) return true;
    broadcastSystem(
      c.io, c.ctx,
      `${icon} **${name}** (L${slot}) — ${loaded.callerName} conjures: ${detail}`,
    );
    return true;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Wish — L9, the mother of all flex spells
// ═══════════════════════════════════════════════════════════════════
async function handleWish(c: ChatCommandContext): Promise<boolean> {
  const intent = c.rest.trim() || '...(unspecified — DM adjudicates)';
  const loaded = await loadCaster(c, 'wish');
  if (!loaded) return true;
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Wish** (L9) — ${loaded.callerName} wishes: *"${intent}"*\n\n**Effect options** (DM picks):\n  • Duplicate any spell of 8th level or lower (no components)\n  • Restore HP or remove effects (end all effects on 20 creatures)\n  • Grant 20 creatures resistance to one damage type for 8 hrs\n  • Grant 10 creatures immunity to a single spell for 8 hrs\n  • Undo a single event\n  • Anything else — 33% chance of never casting again + 1d10 levels of exhaustion`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Simulacrum — L7, permanent half-strength duplicate
// ═══════════════════════════════════════════════════════════════════
async function handleSimulacrum(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!simulacrum: usage `!simulacrum <creature>`');
    return true;
  }
  const loaded = await loadCaster(c, 'simulacrum');
  if (!loaded) return true;
  broadcastSystem(
    c.io, c.ctx,
    `❄ **Simulacrum** (L7, 12 hrs to cast, consumes 1,500 gp diamond + snow/ice) — ${loaded.callerName} creates a duplicate of **${targetName}** with half its max HP. Acts on its own turn, obeys ${loaded.callerName}. Can't regain HP except with Complex Repair Magic.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Scrying — L5, WIS save vs caster DC
// ═══════════════════════════════════════════════════════════════════
async function handleScrying(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!scrying: usage `!scrying <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!scrying: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'scrying');
  if (!loaded) return true;
  const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + mod;
  const saved = tot >= loaded.spellSaveDc;
  const sign = mod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `🔮 **Scrying** (L5, WIS DC ${loaded.spellSaveDc}) — ${loaded.callerName} → ${displayName}: d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED — caster sees blackness' : 'FAILED — invisible sensor appears near target for 10 min'}`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Teleport / Plane Shift
// ═══════════════════════════════════════════════════════════════════
async function handleTeleport(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaster(c, 'teleport');
  if (!loaded) return true;
  const dest = c.rest.trim() || 'a destination known to the caster';
  // Roll the d100 mishap table. Familiarity is DM's call — we assume
  // "seen casually" (20 off-target, 25 on-target, 55 very familiar).
  const d100 = Math.floor(Math.random() * 100) + 1;
  let result = 'Arrives on target (very familiar).';
  if (d100 <= 10) result = 'Mishap — everyone takes 3d10 force damage + arrives in random location';
  else if (d100 <= 20) result = 'Similar area — within 1 mile of destination';
  else if (d100 <= 30) result = 'Off target — within 10 miles, random direction';
  else result = 'On target ✓';
  broadcastSystem(
    c.io, c.ctx,
    `🌀 **Teleport** (L7, 1 action, range 10 ft) — ${loaded.callerName} teleports self + up to 8 willing creatures to *"${dest}"*. Familiarity roll d100=${d100} → ${result}`,
  );
  return true;
}

async function handlePlaneShift(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!planeshift: usage `!planeshift <plane> [target1 target2 …]`');
    return true;
  }
  const plane = parts[0];
  const targets = parts.slice(1);
  const loaded = await loadCaster(c, 'planeshift');
  if (!loaded) return true;
  if (targets.length === 0) {
    broadcastSystem(
      c.io, c.ctx,
      `🌌 **Plane Shift** (L7) — ${loaded.callerName} transports self + up to 8 willing creatures to **${plane}**. Requires a forked metal rod attuned to the destination.`,
    );
  } else {
    // Unwilling: CHA save, fail → banished to named plane
    const lines: string[] = [];
    lines.push(`🌌 **Plane Shift** (L7, unwilling, CHA DC ${loaded.spellSaveDc}) — ${loaded.callerName} targets ${targets.length} creatures to banish to **${plane}**:`);
    for (const name of targets) {
      const target = resolveTargetByName(c.ctx, name);
      if (!target) { lines.push(`  • ${name}: not found`); continue; }
      const { mod, displayName } = await loadTargetSaveMod(target, 'cha');
      const d20 = Math.floor(Math.random() * 20) + 1;
      const tot = d20 + mod;
      const saved = tot >= loaded.spellSaveDc;
      const sign = mod >= 0 ? '+' : '';
      lines.push(`  • ${displayName}: CHA d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : `BANISHED to ${plane}`}`);
    }
    broadcastSystem(c.io, c.ctx, lines.join('\n'));
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Gate — L9, open a portal between planes
// ═══════════════════════════════════════════════════════════════════
async function handleGate(c: ChatCommandContext): Promise<boolean> {
  const plane = c.rest.trim() || 'another plane';
  const loaded = await loadCaster(c, 'gate');
  if (!loaded) return true;
  broadcastSystem(
    c.io, c.ctx,
    `🌀 **Gate** (L9, concentration 1 min) — ${loaded.callerName} opens a circular portal (5-20 ft diameter) to **${plane}**. Any creature can pass through. Naming a specific creature pulls it from its plane (CHA save to resist).`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// True Seeing — L6
// ═══════════════════════════════════════════════════════════════════
async function handleTrueSeeing(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!trueseeing: usage `!trueseeing <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!trueseeing: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'trueseeing');
  if (!loaded) return true;
  broadcastSystem(
    c.io, c.ctx,
    `👁 **True Seeing** (L6, 1 hr) — ${loaded.callerName} grants ${target.name} **120 ft truesight**: see through invisibility, illusions, and into the Ethereal.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Glyph of Warding — L3, stored spell or explosive
// ═══════════════════════════════════════════════════════════════════
async function handleGlyph(c: ChatCommandContext): Promise<boolean> {
  const glyphType = c.rest.trim().toLowerCase() || 'explosive';
  const loaded = await loadCaster(c, 'glyph');
  if (!loaded) return true;
  broadcastSystem(
    c.io, c.ctx,
    `⚜ **Glyph of Warding** (L3, inscribed over 1 hr, permanent until triggered) — ${loaded.callerName} inscribes a **${glyphType}** glyph. 200 gp worth of diamond dust consumed. Triggers on DM-defined condition. Explosive rune: 5d8 damage (chosen type), DEX save for half.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Contingency — L6, pre-load a spell to trigger later
// ═══════════════════════════════════════════════════════════════════
async function handleContingency(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\|/);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!contingency: usage `!contingency <stored spell> | <trigger condition>`');
    return true;
  }
  const spell = parts[0].trim();
  const trigger = parts[1].trim();
  const loaded = await loadCaster(c, 'contingency');
  if (!loaded) return true;
  broadcastSystem(
    c.io, c.ctx,
    `⏳ **Contingency** (L6, 10 min to cast, 10 days duration) — ${loaded.callerName} stores **${spell}**. Triggers when: *${trigger}*. Effectively self-cast. Only one active at a time.`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Mass Heal / Mass Cure Wounds
// ═══════════════════════════════════════════════════════════════════
async function writeHp(characterId: string, hp: number, c: ChatCommandContext): Promise<void> {
  await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [hp, characterId])
    .catch((e) => console.warn('[writeHp] hp update failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId,
    changes: { hitPoints: hp },
  });
}

async function handleMassHeal(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!massheal: usage `!massheal <t1> [t2 …]` (up to 12 targets in 60 ft, pool 700 HP total)');
    return true;
  }
  if (parts.length > 12) {
    whisperToCaller(c.io, c.ctx, '!massheal: at most 12 targets.');
    return true;
  }
  const loaded = await loadCaster(c, 'massheal');
  if (!loaded) return true;
  // 700 HP pool, distribute in order. Renamed from `pool` to
  // `healPool` to avoid shadowing the pg `pool` import.
  let healPool = 700;
  const lines: string[] = [];
  lines.push(`💚 **Mass Heal** (L9, 700 HP pool, cures blindness/deafness, no effect on undead/constructs) — ${loaded.callerName}:`);
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const combat = c.ctx.room.combatState;
    const combatant = combat?.combatants.find((x) => x.tokenId === target.id);
    if (combatant) {
      const needed = combatant.maxHp - combatant.hp;
      const heal = Math.min(needed, healPool);
      combatant.hp += heal;
      healPool -= heal;
      if (combatant.characterId) await writeHp(combatant.characterId, combatant.hp, c);
      lines.push(`  • ${target.name}: +${heal} HP → ${combatant.hp}/${combatant.maxHp}`);
    } else if (target.characterId) {
      const { rows } = await pool.query('SELECT hit_points, max_hit_points FROM characters WHERE id = $1', [target.characterId]);
      const row = rows[0] as Record<string, unknown> | undefined;
      const cur = Number(row?.hit_points) || 0;
      const max = Number(row?.max_hit_points) || 0;
      const needed = Math.max(0, max - cur);
      const heal = Math.min(needed, healPool);
      const newHp = cur + heal;
      healPool -= heal;
      await writeHp(target.characterId, newHp, c);
      lines.push(`  • ${target.name}: +${heal} HP → ${newHp}/${max}`);
    } else {
      lines.push(`  • ${target.name}: NPC — DM applies heal manually`);
    }
    if (healPool <= 0) break;
  }
  lines.push(`  (pool remaining: ${healPool} HP)`);
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

async function handleMassCureWounds(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!masscurewounds: usage `!masscurewounds <t1> [t2 …] [slot]` (up to 6 in 30 ft)');
    return true;
  }
  const loaded = await loadCaster(c, 'masscurewounds');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 5, 5);
  if (targets.length > 6) {
    whisperToCaller(c.io, c.ctx, '!masscurewounds: at most 6 targets.');
    return true;
  }
  const dice = 3 + Math.max(0, slot - 5);
  const scoreRow = await pool.query('SELECT class, ability_scores FROM characters WHERE id = $1', [loaded.caller.characterId]);
  const row = scoreRow.rows[0] as Record<string, unknown> | undefined;
  const scores = typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores ?? {});
  const classLower = String(row?.class || '').toLowerCase();
  const ability = spellcastingAbility(classLower);
  const mod = abilityMod(scores as Record<string, number>, ability);

  const lines: string[] = [];
  lines.push(`💚 **Mass Cure Wounds** (L${slot}, 30-ft radius, ${dice}d8+mod per target) — ${loaded.callerName}:`);
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const { rolls, sum } = roll(dice, 8);
    const total = sum + mod;
    if (target.characterId) {
      const { rows } = await pool.query('SELECT hit_points, max_hit_points FROM characters WHERE id = $1', [target.characterId]);
      const row2 = rows[0] as Record<string, unknown> | undefined;
      const cur = Number(row2?.hit_points) || 0;
      const max = Number(row2?.max_hit_points) || 0;
      const newHp = Math.min(max, cur + total);
      await writeHp(target.characterId, newHp, c);
      lines.push(`  • ${target.name}: ${dice}d8+${mod} [${rolls.join(',')}]+${mod} = ${total} → ${newHp}/${max}`);
    } else {
      lines.push(`  • ${target.name}: ${total} HP heal (NPC — manual)`);
    }
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Registration
// ═══════════════════════════════════════════════════════════════════

registerChatCommand(['hypnoticpattern', 'hpattern'], handleHypnoticPattern);
registerChatCommand(['dominateperson', 'dperson'], dominateHandler('dominateperson', 'Dominate Person', 5));
registerChatCommand(['dominatemonster', 'dmonster'], dominateHandler('dominatemonster', 'Dominate Monster', 8));
registerChatCommand(['dominatebeast', 'dbeast'], dominateHandler('dominatebeast', 'Dominate Beast', 4));
registerChatCommand(['polymorph', 'poly'], handlePolymorph);
registerChatCommand(['truepolymorph', 'tpoly'], handleTruePolymorph);
registerChatCommand(['feeblemind', 'fmind'], handleFeeblemind);
registerChatCommand(['stinkingcloud', 'stench'], handleStinkingCloud);
registerChatCommand(['cloudkill', 'ckill'], handleCloudkill);
registerChatCommand(['meteorswarm', 'meteor'], handleMeteorSwarm);
registerChatCommand(['powerwordkill', 'pwkill'], handlePowerWordKill);
registerChatCommand(['powerwordstun', 'pwstun'], handlePowerWordStun);
registerChatCommand(['wallofforce', 'wforce'], wallHandler('wallofforce', 'Wall of Force', '🟦', 5, '10 × 10-ft panels (up to 10) or 10-ft sphere, 1 hr concentration. Nothing physical can pass; Disintegrate destroys it.'));
registerChatCommand(['walloffire', 'wfire'], wallHandler('walloffire', 'Wall of Fire', '🔥', 4, '60-ft wall or 20-ft ring, 20 ft tall, 5d8 fire on creatures in area or passing through (DEX half), concentration 1 min.'));
registerChatCommand(['wallofstone', 'wstone'], wallHandler('wallofstone', 'Wall of Stone', '🪨', 5, '10 × 10-ft panels (up to 10), 6 in thick, AC 15, 30 HP per 10×10 panel. Permanent if maintained for 10 min.'));
registerChatCommand(['wallofice', 'wice'], wallHandler('wallofice', 'Wall of Ice', '🧊', 6, '10-ft wall (10 panels) or 10-ft hemisphere, AC 12, 30 HP, vulnerable to fire. Breaking panel leaves 5-ft cold area, DEX save or 5d6 cold.'));
registerChatCommand('wish', handleWish);
registerChatCommand('simulacrum', handleSimulacrum);
registerChatCommand(['scrying', 'scry'], handleScrying);
registerChatCommand('teleport', handleTeleport);
registerChatCommand(['planeshift', 'pshift'], handlePlaneShift);
registerChatCommand('gate', handleGate);
registerChatCommand(['trueseeing', 'tsee'], handleTrueSeeing);
registerChatCommand(['glyph', 'glyphofwarding'], handleGlyph);
registerChatCommand('contingency', handleContingency);
registerChatCommand(['massheal', 'mheal'], handleMassHeal);
registerChatCommand(['masscurewounds', 'mcure'], handleMassCureWounds);
