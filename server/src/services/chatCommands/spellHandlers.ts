import type { Token } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Shortcuts for the save-or-suck and buff/debuff spells that come up
 * every other encounter. Each command wires the spell's specific
 * metadata (save retry each turn, endsOnDamage, concentration,
 * duration) into ConditionService.applyConditionWithMeta so the
 * engine handles turn-by-turn ticking without the DM tracking it
 * manually.
 *
 * Pattern: caller supplies target name + DC. The engine stamps:
 *   • condition name on the target
 *   • casterTokenId so concentration drops cascade correctly
 *   • expiresAfterRound (duration in rounds)
 *   • saveAtEndOfTurn + ability + DC where applicable
 *   • endsOnDamage for Sleep
 */

function resolveCaller(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

function resolveTarget(ctx: PlayerContext, name: string): Token | null {
  if (!name) return null;
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) => t.name.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

interface SaveOrSuckArgs {
  ctx: PlayerContext;
  c: ChatCommandContext;
  spellName: string;
  conditionName: string;
  dc: number;
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  durationRounds: number;
  target: Token;
  saveAtEndOfTurn: boolean;
  endsOnDamage?: boolean;
}

function apply(args: SaveOrSuckArgs): void {
  const { ctx, c, spellName, conditionName, dc, saveAbility, durationRounds, target, saveAtEndOfTurn, endsOnDamage } = args;
  const caller = resolveCaller(ctx);
  const currentRound = ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(ctx.room.sessionId, target.id, {
    name: conditionName,
    source: spellName,
    casterTokenId: caller?.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + durationRounds,
    ...(saveAtEndOfTurn ? { saveAtEndOfTurn: { ability: saveAbility, dc } } : {}),
    ...(endsOnDamage ? { endsOnDamage: true } : {}),
  });
  c.io.to(ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(ctx.room, target.id),
  });
}

// ────── !holdperson <target> <dc> ────────────────────────────
async function handleHoldPerson(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!holdperson: usage `!holdperson <target> <dc>`');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTarget(c.ctx, targetName);
  if (!target || !Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!holdperson: invalid target or DC.');
    return true;
  }
  apply({
    ctx: c.ctx, c,
    spellName: 'Hold Person',
    conditionName: 'paralyzed',
    dc, saveAbility: 'wis',
    durationRounds: 10, target,
    saveAtEndOfTurn: true,
  });
  broadcastSystem(
    c.io, c.ctx,
    `🖐 ${target.name} is PARALYZED by Hold Person (WIS DC ${dc}, save at end of each turn, 1 min).`,
  );
  return true;
}

// ────── !holdmonster <target> <dc> ───────────────────────────
async function handleHoldMonster(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!holdmonster: usage `!holdmonster <target> <dc>`');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTarget(c.ctx, targetName);
  if (!target || !Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!holdmonster: invalid target or DC.');
    return true;
  }
  apply({
    ctx: c.ctx, c,
    spellName: 'Hold Monster',
    conditionName: 'paralyzed',
    dc, saveAbility: 'wis',
    durationRounds: 10, target,
    saveAtEndOfTurn: true,
  });
  broadcastSystem(c.io, c.ctx, `🖐 ${target.name} PARALYZED by Hold Monster (WIS DC ${dc}).`);
  return true;
}

// ────── !sleep <target> ──────────────────────────────────────
// Sleep has no save — it targets lowest-HP creatures up to total
// dice rolled. We just apply unconscious with endsOnDamage. The
// DM picks which creatures to target based on the caster's roll.
async function handleSleep(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!sleep: usage `!sleep <target>`');
    return true;
  }
  const target = resolveTarget(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!sleep: no token named "${targetName}".`);
    return true;
  }
  apply({
    ctx: c.ctx, c,
    spellName: 'Sleep',
    conditionName: 'unconscious',
    dc: 0, saveAbility: 'wis',
    durationRounds: 10, target,
    saveAtEndOfTurn: false,
    endsOnDamage: true,
  });
  broadcastSystem(
    c.io, c.ctx,
    `💤 ${target.name} falls UNCONSCIOUS from Sleep (ends on any damage; 1 min max).`,
  );
  return true;
}

// ────── !fear <target> <dc> ──────────────────────────────────
async function handleFear(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!fear: usage `!fear <target> <dc>`');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTarget(c.ctx, targetName);
  if (!target || !Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!fear: invalid target or DC.');
    return true;
  }
  apply({
    ctx: c.ctx, c,
    spellName: 'Fear',
    conditionName: 'frightened',
    dc, saveAbility: 'wis',
    durationRounds: 10, target,
    saveAtEndOfTurn: true,
  });
  broadcastSystem(
    c.io, c.ctx,
    `😱 ${target.name} is FRIGHTENED by Fear (WIS DC ${dc}, save at end of each turn, 1 min).`,
  );
  return true;
}

// ────── !slow <target> <dc> ──────────────────────────────────
async function handleSlow(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!slow: usage `!slow <target> <dc>`');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTarget(c.ctx, targetName);
  if (!target || !Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!slow: invalid target or DC.');
    return true;
  }
  apply({
    ctx: c.ctx, c,
    spellName: 'Slow',
    conditionName: 'slowed',
    dc, saveAbility: 'wis',
    durationRounds: 10, target,
    saveAtEndOfTurn: true,
  });
  broadcastSystem(
    c.io, c.ctx,
    `🐢 ${target.name} is SLOWED (half speed, -2 AC + DEX saves, no reactions, WIS DC ${dc}).`,
  );
  return true;
}

// ────── !bless <target1> [target2] [target3] — up to 3 allies ──
async function handleBless(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!bless: usage `!bless <target1> [target2] [target3]`');
    return true;
  }
  const caller = resolveCaller(c.ctx);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const applied: string[] = [];
  for (const name of parts.slice(0, 3)) {
    const t = resolveTarget(c.ctx, name);
    if (!t) continue;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, t.id, {
      name: 'blessed',
      source: 'Bless',
      casterTokenId: caller?.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 10,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: t.id,
      changes: tokenConditionChanges(c.ctx.room, t.id),
    });
    applied.push(t.name);
  }
  if (applied.length === 0) {
    whisperToCaller(c.io, c.ctx, '!bless: no targets matched.');
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `✨ Bless on ${applied.join(', ')} — +1d4 to attacks + saves for 10 rounds (concentration).`,
  );
  return true;
}

// ────── !bane <target1> <target2> <target3> <dc> ─────────────
async function handleBane(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!bane: usage `!bane <target1> [target2] [target3] <dc>`');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!bane: last argument must be the save DC.');
    return true;
  }
  const targetNames = parts.slice(0, -1);
  const caller = resolveCaller(c.ctx);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const applied: string[] = [];
  for (const name of targetNames.slice(0, 3)) {
    const t = resolveTarget(c.ctx, name);
    if (!t) continue;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, t.id, {
      name: 'baned',
      source: 'Bane',
      casterTokenId: caller?.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 10,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: t.id,
      changes: tokenConditionChanges(c.ctx.room, t.id),
    });
    applied.push(t.name);
  }
  if (applied.length === 0) {
    whisperToCaller(c.io, c.ctx, '!bane: no targets matched.');
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🩸 Bane on ${applied.join(', ')} (CHA DC ${dc} negates) — -1d4 to attacks + saves for 10 rounds.`,
  );
  return true;
}

// ────── !faeriefire <target> [target2 …] <dc> ───────────────
async function handleFaerieFire(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!faeriefire: usage `!faeriefire <target1> [target2 …] <dc>`');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!faeriefire: last argument must be the save DC.');
    return true;
  }
  const caller = resolveCaller(c.ctx);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const applied: string[] = [];
  for (const name of parts.slice(0, -1)) {
    const t = resolveTarget(c.ctx, name);
    if (!t) continue;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, t.id, {
      name: 'outlined',
      source: 'Faerie Fire',
      casterTokenId: caller?.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 10,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: t.id,
      changes: tokenConditionChanges(c.ctx.room, t.id),
    });
    applied.push(t.name);
  }
  if (applied.length === 0) {
    whisperToCaller(c.io, c.ctx, '!faeriefire: no targets matched.');
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `✨ Faerie Fire on ${applied.join(', ')} (DEX DC ${dc} negates) — attacks against have advantage, no invisibility.`,
  );
  return true;
}

registerChatCommand(['holdperson', 'hp-spell'], handleHoldPerson);
registerChatCommand(['holdmonster'], handleHoldMonster);
registerChatCommand('sleep', handleSleep);
registerChatCommand('fear', handleFear);
registerChatCommand('slow', handleSlow);
registerChatCommand('bless', handleBless);
registerChatCommand('bane', handleBane);
registerChatCommand(['faeriefire', 'ff'], handleFaerieFire);
