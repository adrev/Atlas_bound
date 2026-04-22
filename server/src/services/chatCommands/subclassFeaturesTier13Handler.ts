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
 * Tier 13 — Cleric / Paladin Channel-Divinity subclass features:
 *   Forge: !forgeblessing (+1 AC item, 24 hr)
 *   Grave: !pathtograve (vulnerability to next attack)
 *   Order: !voiceofauthority (ally reaction attack)
 *   Peace: !emboldenbond (1d4 to bonded creatures)
 *   Twilight: !twilightsanct (temp HP or end fright/charm)
 *   Trickery: !trickstersblessing (advantage on Stealth 1 hr)
 *   Ancients: !natureswrath (STR or DEX save vs restrained)
 *   Conquest: !conqueringpresence (WIS save vs frightened 1 min)
 *   Crown: !championchallenge (WIS save vs can't move > 30 ft)
 *   Oathbreaker: !dreadfulaspect (WIS save vs frightened 1 min)
 *   Redemption: !rebukeviolent (reaction radiant dmg to attacker)
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

function hasFeature(row: Record<string, unknown> | undefined, pattern: RegExp): boolean {
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    if (!Array.isArray(feats)) return false;
    return feats.some((f: { name?: string }) => typeof f?.name === 'string' && pattern.test(f.name));
  } catch {
    return false;
  }
}

function abilityMod(scores: Record<string, number> | undefined, ability: string): number {
  const raw = (scores ?? {})[ability] ?? 10;
  return Math.floor((raw - 10) / 2);
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

interface CasterMeta {
  caller: Token;
  row: Record<string, unknown> | undefined;
  classLower: string;
  callerName: string;
  spellSaveDc: number;
}

async function loadCaster(c: ChatCommandContext, cmd: string): Promise<CasterMeta | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, ability_scores, proficiency_bonus, spell_save_dc FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const prof = Number(row?.proficiency_bonus) || 2;
  // Clerics use WIS, Paladins CHA.
  const ability = classLower.includes('paladin') ? 'cha' : 'wis';
  const dcFromRow = Number(row?.spell_save_dc);
  const spellSaveDc = Number.isFinite(dcFromRow) && dcFromRow > 0
    ? dcFromRow
    : 8 + prof + abilityMod(scores as Record<string, number>, ability);
  return {
    caller,
    row,
    classLower,
    callerName: (row?.name as string) || caller.name,
    spellSaveDc,
  };
}

// ────── Forge Cleric: Blessing of the Forge (L1) ─────
async function handleForgeBlessing(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!forgeblessing: usage `!forgeblessing <target>` (ally holding weapon/armor)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!forgeblessing: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'forgeblessing');
  if (!loaded) return true;
  const { classLower, callerName, row } = loaded;
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!forgeblessing: ${callerName} isn't a Cleric.`);
    return true;
  }
  if (!hasFeature(row, /blessing\s+of\s+the\s+forge/i) && !classLower.includes('forge')) {
    whisperToCaller(c.io, c.ctx, `!forgeblessing: ${callerName} isn't a Forge Cleric.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🔨 **Blessing of the Forge** — ${callerName} imbues ${target.name}'s weapon or armor: **+1 AC** (if armor/shield) OR **+1 attack + damage** (if weapon, becomes magical) for **24 hours**. 1/long rest.`,
  );
  return true;
}

// ────── Grave Cleric: Path to the Grave (L2 CD) ──────
async function handlePathToGrave(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!pathtograve: usage `!pathtograve <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!pathtograve: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'pathtograve');
  if (!loaded) return true;
  const { caller, classLower, callerName, row } = loaded;
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!pathtograve: ${callerName} isn't a Cleric.`);
    return true;
  }
  if (!hasFeature(row, /path\s+to\s+the\s+grave/i) && !classLower.includes('grave')) {
    whisperToCaller(c.io, c.ctx, `!pathtograve: ${callerName} isn't a Grave Cleric.`);
    return true;
  }
  // Apply vulnerability pseudo-condition (first attack only).
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'marked-for-grave',
    source: `${callerName} (Path to the Grave)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 1,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `⚰ **Path to the Grave** (CD) — ${callerName} curses ${target.name}. Next attack against it has **vulnerability to ALL damage** (doubles damage). Curse ends when the attack resolves.`,
  );
  return true;
}

// ────── Order Cleric: Voice of Authority (L1) ────────
async function handleVoiceOfAuthority(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!voice: usage `!voice <ally-who-got-spelled>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!voice: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'voice');
  if (!loaded) return true;
  const { classLower, callerName, row } = loaded;
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!voice: ${callerName} isn't a Cleric.`);
    return true;
  }
  if (!hasFeature(row, /voice\s+of\s+authority/i) && !classLower.includes('order')) {
    whisperToCaller(c.io, c.ctx, `!voice: ${callerName} isn't an Order Cleric.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `📣 **Voice of Authority** — ${callerName} cast a L1+ spell on ${target.name}; ${target.name} can use its **reaction** to make **one weapon attack** against a creature of ${callerName}'s choice.`,
  );
  return true;
}

// ────── Peace Cleric: Emboldening Bond (L1) ──────────
async function handleEmboldenBond(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!emboldenbond: usage `!emboldenbond <t1> <t2> [t3 …]` (up to prof-bonus creatures)');
    return true;
  }
  const loaded = await loadCaster(c, 'emboldenbond');
  if (!loaded) return true;
  const { caller, classLower, callerName, row } = loaded;
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!emboldenbond: ${callerName} isn't a Cleric.`);
    return true;
  }
  if (!hasFeature(row, /emboldening\s+bond/i) && !classLower.includes('peace')) {
    whisperToCaller(c.io, c.ctx, `!emboldenbond: ${callerName} isn't a Peace Cleric.`);
    return true;
  }
  const prof = Number(row?.proficiency_bonus) || 2;
  if (parts.length > prof) {
    whisperToCaller(c.io, c.ctx, `!emboldenbond: can bond up to PB (${prof}).`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const lines: string[] = [];
  lines.push(`🕊 **Emboldening Bond** — ${callerName} bonds ${parts.length} creatures for 10 min. While within 30 ft, bonded creatures can add **1d4** to any attack / save / check (1/turn each):`);
  for (const name of parts) {
    const t = resolveTargetByName(c.ctx, name);
    if (!t) { lines.push(`  • ${name}: not found`); continue; }
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, t.id, {
      name: 'bonded',
      source: `${callerName} (Emboldening Bond)`,
      casterTokenId: caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 100,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: t.id,
      changes: tokenConditionChanges(c.ctx.room, t.id),
    });
    lines.push(`  • ${t.name}: bonded.`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Twilight Cleric: Twilight Sanctuary (L2 CD) ──
async function handleTwilightSanct(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!twilightsanct: usage `!twilightsanct <target> <thp|clear>`');
    return true;
  }
  const effect = parts[parts.length - 1].toLowerCase();
  if (!['thp', 'clear'].includes(effect)) {
    whisperToCaller(c.io, c.ctx, '!twilightsanct: last arg must be `thp` or `clear`.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!twilightsanct: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'twilightsanct');
  if (!loaded) return true;
  const { classLower, callerName, row } = loaded;
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!twilightsanct: ${callerName} isn't a Cleric.`);
    return true;
  }
  if (!hasFeature(row, /twilight\s+sanctuary/i) && !classLower.includes('twilight')) {
    whisperToCaller(c.io, c.ctx, `!twilightsanct: ${callerName} isn't a Twilight Cleric.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  const d6 = Math.floor(Math.random() * 6) + 1;
  const thpValue = d6 + lvl;

  if (effect === 'clear') {
    const conds = (target.conditions as string[]) || [];
    const cleared: string[] = [];
    if (conds.includes('charmed')) {
      ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'charmed');
      cleared.push('charmed');
    }
    if (conds.includes('frightened')) {
      ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'frightened');
      cleared.push('frightened');
    }
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
    broadcastSystem(
      c.io, c.ctx,
      `🌙 **Twilight Sanctuary** — ${callerName} clears ${cleared.join(', ') || 'nothing (wasn\'t charmed/frightened)'} from ${target.name}.`,
    );
    return true;
  }

  // THP path.
  let newThp = 0;
  if (target.characterId) {
    const { rows } = await pool.query('SELECT temp_hit_points FROM characters WHERE id = $1', [target.characterId]);
    const curThp = Number((rows[0] as Record<string, unknown>)?.temp_hit_points) || 0;
    newThp = Math.max(curThp, thpValue);
    await pool.query(
      'UPDATE characters SET temp_hit_points = $1 WHERE id = $2',
      [newThp, target.characterId],
    ).catch(() => {});
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { tempHitPoints: newThp },
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🌙 **Twilight Sanctuary** — ${callerName} grants ${target.name} **1d6+${lvl} = ${thpValue} temp HP**${newThp ? ` (now ${newThp})` : ''}.`,
  );
  return true;
}

// ────── Trickery Cleric: Blessing of the Trickster ───
async function handleTrickstersBlessing(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!trickstersblessing: usage `!trickstersblessing <ally>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!trickstersblessing: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'trickstersblessing');
  if (!loaded) return true;
  const { classLower, callerName, row } = loaded;
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!trickstersblessing: ${callerName} isn't a Cleric.`);
    return true;
  }
  if (!hasFeature(row, /blessing\s+of\s+the\s+trickster/i) && !classLower.includes('trickery')) {
    whisperToCaller(c.io, c.ctx, `!trickstersblessing: ${callerName} isn't a Trickery Cleric.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🎭 **Blessing of the Trickster** — ${callerName} grants ${target.name} **advantage on Stealth checks for 1 hour**.`,
  );
  return true;
}

// ────── Ancients Paladin: Nature's Wrath (CD) ────────
async function handleNaturesWrath(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!natureswrath: usage `!natureswrath <target>`');
    return true;
  }
  const targetName = parts.join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!natureswrath: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'natureswrath');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, spellSaveDc } = loaded;
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!natureswrath: ${callerName} isn't a Paladin.`);
    return true;
  }
  if (!hasFeature(row, /nature'?s\s+wrath/i) && !classLower.includes('ancients')) {
    whisperToCaller(c.io, c.ctx, `!natureswrath: ${callerName} isn't an Ancients Paladin.`);
    return true;
  }
  // STR or DEX save (target picks best). We roll STR on their behalf.
  const { mod: strMod } = await loadTargetSaveMod(target, 'str');
  const { mod: dexMod, displayName } = await loadTargetSaveMod(target, 'dex');
  const bestAbility = strMod >= dexMod ? 'STR' : 'DEX';
  const bestMod = Math.max(strMod, dexMod);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + bestMod;
  const saved = tot >= spellSaveDc;
  const sign = bestMod >= 0 ? '+' : '';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  if (!saved) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'restrained',
      source: `${callerName} (Nature's Wrath)`,
      casterTokenId: caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 10,
      saveAtEndOfTurn: { ability: bestAbility.toLowerCase() as 'str' | 'dex', dc: spellSaveDc },
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🌿 **Nature's Wrath** (CD, ${bestAbility} DC ${spellSaveDc}) — ${callerName} → ${displayName}: d20=${d20}${sign}${bestMod}=${tot} → ${saved ? 'SAVED' : 'RESTRAINED by spectral vines (save at end of turn)'}`,
  );
  return true;
}

// ────── Conquest Paladin: Conquering Presence (CD) ───
async function handleConqueringPresence(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!conquer: usage `!conquer <t1> [t2 …]` (all creatures in 30 ft)');
    return true;
  }
  const loaded = await loadCaster(c, 'conquer');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, spellSaveDc } = loaded;
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!conquer: ${callerName} isn't a Paladin.`);
    return true;
  }
  if (!hasFeature(row, /conquering\s+presence/i) && !classLower.includes('conquest')) {
    whisperToCaller(c.io, c.ctx, `!conquer: ${callerName} isn't a Conquest Paladin.`);
    return true;
  }
  const lines: string[] = [];
  lines.push(`👑 **Conquering Presence** (CD, WIS DC ${spellSaveDc}) — ${callerName} terrifies all in 30 ft:`);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= spellSaveDc;
    const sign = mod >= 0 ? '+' : '';
    if (!saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'frightened',
        source: `${callerName} (Conquering Presence)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 10,
        saveAtEndOfTurn: { ability: 'wis', dc: spellSaveDc },
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
    lines.push(`  • ${displayName}: WIS d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : 'FRIGHTENED (save at end of turn, 1 min)'}`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Crown Paladin: Champion Challenge (CD) ───────
async function handleChampionChallenge(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!challenge: usage `!challenge <t1> [t2 …]` (all creatures in 30 ft)');
    return true;
  }
  const loaded = await loadCaster(c, 'challenge');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, spellSaveDc } = loaded;
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!challenge: ${callerName} isn't a Paladin.`);
    return true;
  }
  if (!hasFeature(row, /champion\s+challenge/i) && !classLower.includes('crown')) {
    whisperToCaller(c.io, c.ctx, `!challenge: ${callerName} isn't a Crown Paladin.`);
    return true;
  }
  const lines: string[] = [];
  lines.push(`👑 **Champion Challenge** (CD, WIS DC ${spellSaveDc}) — ${callerName} compels all in 30 ft to stay near:`);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= spellSaveDc;
    const sign = mod >= 0 ? '+' : '';
    if (!saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'challenged',
        source: `${callerName} (Champion Challenge)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 10,
        saveAtEndOfTurn: { ability: 'wis', dc: spellSaveDc },
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
    lines.push(`  • ${displayName}: WIS d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : "CHALLENGED (can't willingly move > 30 ft from caster)"}`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Oathbreaker: Dreadful Aspect (CD) ─────────
async function handleDreadfulAspect(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!dread: usage `!dread <t1> [t2 …]` (all creatures in 30 ft)');
    return true;
  }
  const loaded = await loadCaster(c, 'dread');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, spellSaveDc } = loaded;
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!dread: ${callerName} isn't a Paladin.`);
    return true;
  }
  if (!hasFeature(row, /dreadful\s+aspect/i) && !classLower.includes('oathbreaker')) {
    whisperToCaller(c.io, c.ctx, `!dread: ${callerName} isn't an Oathbreaker Paladin.`);
    return true;
  }
  const lines: string[] = [];
  lines.push(`💀 **Dreadful Aspect** (CD, WIS DC ${spellSaveDc}) — ${callerName} unleashes dark presence (30 ft):`);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= spellSaveDc;
    const sign = mod >= 0 ? '+' : '';
    if (!saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'frightened',
        source: `${callerName} (Dreadful Aspect)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 10,
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
    lines.push(`  • ${displayName}: WIS d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : 'FRIGHTENED (1 min, no save mid-duration while in line of sight)'}`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Redemption: Rebuke the Violent ────────────
async function handleRebukeViolent(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!rebuke: usage `!rebuke <attacker> <dmg-dealt>`');
    return true;
  }
  const dmgDealt = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(dmgDealt) || dmgDealt < 0) {
    whisperToCaller(c.io, c.ctx, '!rebuke: damage must be a number.');
    return true;
  }
  const attackerName = parts.slice(0, -1).join(' ');
  const attacker = resolveTargetByName(c.ctx, attackerName);
  if (!attacker) {
    whisperToCaller(c.io, c.ctx, `!rebuke: no token named "${attackerName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'rebuke');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, spellSaveDc } = loaded;
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!rebuke: ${callerName} isn't a Paladin.`);
    return true;
  }
  if (!hasFeature(row, /rebuke\s+the\s+violent/i) && !classLower.includes('redemption')) {
    whisperToCaller(c.io, c.ctx, `!rebuke: ${callerName} isn't a Redemption Paladin.`);
    return true;
  }
  // Burn reaction.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!rebuke: reaction already spent.');
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
  const { mod, displayName } = await loadTargetSaveMod(attacker, 'wis');
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + mod;
  const saved = tot >= spellSaveDc;
  const radiant = saved ? Math.floor(dmgDealt / 2) : dmgDealt;
  const sign = mod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Rebuke the Violent** (CD reaction, WIS DC ${spellSaveDc}) — ${callerName} punishes ${displayName}: d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED (half)' : 'FAILED'}, takes **${radiant} radiant** damage.`,
  );
  return true;
}

registerChatCommand(['forgeblessing', 'forgeblessing'], handleForgeBlessing);
registerChatCommand(['pathtograve', 'ptg'], handlePathToGrave);
registerChatCommand(['voice', 'voiceofauthority'], handleVoiceOfAuthority);
registerChatCommand(['emboldenbond', 'bond'], handleEmboldenBond);
registerChatCommand(['twilightsanct', 'twsanct'], handleTwilightSanct);
registerChatCommand(['trickstersblessing', 'trickbless'], handleTrickstersBlessing);
registerChatCommand(['natureswrath', 'nwrath'], handleNaturesWrath);
registerChatCommand(['conquer', 'conqueringpresence'], handleConqueringPresence);
registerChatCommand(['challenge', 'championchallenge'], handleChampionChallenge);
registerChatCommand(['dread', 'dreadfulaspect'], handleDreadfulAspect);
registerChatCommand(['rebuke', 'rebukeviolent'], handleRebukeViolent);
