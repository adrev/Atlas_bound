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
 * Class-feature toggle commands. These apply the VTT's pseudo-condition
 * badges (raging, sneak-attack-ready, etc.) that the client-side attack
 * resolver keys off of for damage / resistance adjustments.
 *
 * Players can toggle their own character; DMs can toggle anyone. Each
 * toggle is broadcast as a standard map:token-updated so every client
 * repaints the badge strip.
 *
 *   !rage [target]
 *       Apply the `raging` condition. If no target given, defaults to
 *       the caller's own token on the current map. Duration: 10 rounds
 *       (1 minute). Server-side duration handling reuses the same path
 *       Bless uses — the badge auto-drops when the round counter
 *       advances past appliedRound+10.
 *
 *   !unrage [target]
 *       Clear `raging` from the target (or self). No duration tracking
 *       needed — this is the voluntary end-rage path.
 */

function resolveTargetOrSelf(
  ctx: PlayerContext,
  name: string,
): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  if (!name) {
    // Default: caller's own token on this map. Players usually have
    // exactly one PC token — if there are multiple we pick the one
    // owned by the caller and most recently created.
    const ownTokens = all
      .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return ownTokens[0] ?? null;
  }
  const needle = name.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase() === needle);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

function canTarget(ctx: PlayerContext, token: Token): boolean {
  if (ctx.player.role === 'dm') return true;
  return (token as Token).ownerUserId === ctx.player.userId;
}

async function handleRage(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(
      c.io, c.ctx,
      targetName
        ? `!rage: no token named “${targetName}” on this map.`
        : '!rage: no owned token on this map — specify a target.',
    );
    return true;
  }
  if (!canTarget(c.ctx, target)) {
    whisperToCaller(c.io, c.ctx, `!rage: you don't own ${target.name}.`);
    return true;
  }

  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  // Rage lasts 1 minute = 10 rounds of combat. Outside combat the
  // expiration is meaningless (duration ticks on start-of-turn), so
  // we only wire expiresAfterRound when combat is actually running.
  const expiresAfterRound = currentRound > 0 ? currentRound + 10 : undefined;

  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'raging',
    source: `${c.ctx.player.displayName} (!rage)`,
    appliedRound: currentRound,
    ...(expiresAfterRound !== undefined ? { expiresAfterRound } : {}),
  });

  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });

  const durLabel = expiresAfterRound !== undefined
    ? ' for 10 rounds (1 min)'
    : ' (no combat — duration paused)';
  broadcastSystem(c.io, c.ctx, `🪓 ${target.name} enters a Rage${durLabel}.`);
  return true;
}

async function handleUnrage(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(
      c.io, c.ctx,
      targetName
        ? `!unrage: no token named “${targetName}” on this map.`
        : '!unrage: no owned token on this map — specify a target.',
    );
    return true;
  }
  if (!canTarget(c.ctx, target)) {
    whisperToCaller(c.io, c.ctx, `!unrage: you don't own ${target.name}.`);
    return true;
  }

  const hadIt = (target.conditions as string[]).some(
    (cond) => cond.toLowerCase() === 'raging',
  );
  if (!hadIt) {
    whisperToCaller(c.io, c.ctx, `!unrage: ${target.name} is not raging.`);
    return true;
  }

  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'raging');

  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `😮‍💨 ${target.name}'s Rage ends.`);
  return true;
}

/**
 *   !cover <target> <half|three|full|none>
 *       Apply / change / remove cover on a target. Half = +2 AC,
 *       three = +5 AC, full = not attackable (pass to DM), none =
 *       clears any existing cover. DM-only since cover is a
 *       battlefield call, not a per-token choice.
 */
const COVER_LEVEL_ALIASES: Record<string, 'half-cover' | 'three-quarters-cover' | 'full-cover' | 'none'> = {
  none: 'none', off: 'none', clear: 'none',
  half: 'half-cover', '½': 'half-cover', '1/2': 'half-cover',
  three: 'three-quarters-cover', '3/4': 'three-quarters-cover', 'threequarters': 'three-quarters-cover',
  full: 'full-cover', total: 'full-cover',
};

async function handleCover(c: ChatCommandContext): Promise<boolean> {
  if (c.ctx.player.role !== 'dm') {
    whisperToCaller(c.io, c.ctx, '!cover: DM only.');
    return true;
  }
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!cover: usage `!cover <target> <none|half|three|full>`');
    return true;
  }
  const levelRaw = parts.pop()!.toLowerCase();
  const targetName = parts.join(' ');
  const level = COVER_LEVEL_ALIASES[levelRaw];
  if (!level) {
    whisperToCaller(c.io, c.ctx, `!cover: unknown level "${levelRaw}". Try none / half / three / full.`);
    return true;
  }

  const all = Array.from(c.ctx.room.tokens.values());
  const matches = all.filter((t) => t.name.toLowerCase() === targetName.toLowerCase());
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const target = matches[0];
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!cover: no token named "${targetName}" on this map.`);
    return true;
  }

  // Clear any prior cover first — only one cover grade at a time.
  for (const existing of ['half-cover', 'three-quarters-cover', 'full-cover']) {
    if ((target.conditions as string[]).includes(existing)) {
      ConditionService.removeCondition(c.ctx.room.sessionId, target.id, existing);
    }
  }

  if (level !== 'none') {
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: level,
      source: `${c.ctx.player.displayName} (!cover)`,
      appliedRound: currentRound,
    });
  }

  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });

  const label = level === 'none' ? 'no cover' :
    level === 'half-cover' ? 'half cover (+2 AC)' :
    level === 'three-quarters-cover' ? 'three-quarters cover (+5 AC)' :
    'full cover (cannot be targeted)';
  broadcastSystem(c.io, c.ctx, `🛡 ${target.name} now has ${label}.`);
  return true;
}

/**
 *   !power [target] [on|off]
 *       Toggle the `power-attack` pseudo-condition on a token. The
 *       client-side attack resolver only applies the -5 / +10
 *       trade-off if the attacker has GWM (for heavy melee) or
 *       Sharpshooter (for ranged) — so toggling on a character
 *       without the feat is a no-op mechanically, but still leaves
 *       the badge on the token. Defaults to the caller's own token.
 *       No-arg form is a toggle.
 */
async function handlePower(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  // Last token might be on/off; rest is target name.
  let mode: 'on' | 'off' | 'toggle' = 'toggle';
  if (parts.length && /^(on|off|toggle)$/i.test(parts[parts.length - 1])) {
    mode = parts.pop()!.toLowerCase() as 'on' | 'off' | 'toggle';
  }
  const targetName = parts.join(' ');
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!power: no token matched (or no owned token to default to).');
    return true;
  }
  if (!canTarget(c.ctx, target)) {
    whisperToCaller(c.io, c.ctx, `!power: you don't own ${target.name}.`);
    return true;
  }

  const has = (target.conditions as string[]).some((c2) => c2.toLowerCase() === 'power-attack');
  const shouldApply = mode === 'on' ? true : mode === 'off' ? false : !has;

  if (shouldApply && !has) {
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'power-attack',
      source: `${c.ctx.player.displayName} (!power)`,
      appliedRound: currentRound,
    });
  } else if (!shouldApply && has) {
    ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'power-attack');
  } else {
    whisperToCaller(c.io, c.ctx, `!power: ${target.name} already ${has ? 'has' : 'does not have'} power-attack.`);
    return true;
  }

  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `⚡ ${target.name} ${shouldApply ? 'commits to a Power Attack (-5 / +10)' : 'stops Power Attacking'}.`,
  );
  return true;
}

/**
 *   !inspire [target]
 *       DM-awards inspiration to a PC token (defaults to the caller's
 *       own token if omitted, useful for testing solo). Applies the
 *       `inspired` pseudo-condition which the client-side roll engine
 *       turns into advantage on the next attack / save / check.
 */
async function handleInspire(c: ChatCommandContext): Promise<boolean> {
  if (c.ctx.player.role !== 'dm') {
    whisperToCaller(c.io, c.ctx, '!inspire: DM only. Players spend inspiration with !uninspire.');
    return true;
  }
  const targetName = c.rest.trim();
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!inspire: no token matched (or no DM token on the map).');
    return true;
  }
  if ((target.conditions as string[]).some((x) => x.toLowerCase() === 'inspired')) {
    whisperToCaller(c.io, c.ctx, `!inspire: ${target.name} already has inspiration.`);
    return true;
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'inspired',
    source: `${c.ctx.player.displayName} (!inspire)`,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `✨ ${target.name} gains Inspiration.`);
  return true;
}

/**
 *   !uninspire [target]
 *       Spend / clear inspiration. Either the DM or the PC's owner can
 *       trigger this — the PC spends when they want the advantage on
 *       a roll, the DM clears when inspiration is otherwise lost.
 */
async function handleUninspire(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!uninspire: no token matched.');
    return true;
  }
  if (!canTarget(c.ctx, target)) {
    whisperToCaller(c.io, c.ctx, `!uninspire: you don't own ${target.name}.`);
    return true;
  }
  if (!(target.conditions as string[]).some((x) => x.toLowerCase() === 'inspired')) {
    whisperToCaller(c.io, c.ctx, `!uninspire: ${target.name} doesn't have inspiration.`);
    return true;
  }
  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'inspired');
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `💫 ${target.name} spends their Inspiration.`);
  return true;
}

/**
 *   !assist <target>
 *       Help action. Tags <target> with the `helped` pseudo-condition,
 *       which the roll engine turns into advantage on their next
 *       attack roll or ability check. DM or ally can use it.
 *   !unassist [target]
 *       Clear `helped`. Players call this after spending the advantage
 *       — or the DM can clear if the task the helper set up doesn't
 *       actually happen.
 */
async function handleAssist(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!assist: usage `!assist <target>`');
    return true;
  }
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!assist: no token named "${targetName}" on this map.`);
    return true;
  }
  if ((target.conditions as string[]).some((x) => x.toLowerCase() === 'helped')) {
    whisperToCaller(c.io, c.ctx, `!assist: ${target.name} is already helped.`);
    return true;
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'helped',
    source: `${c.ctx.player.displayName} (!assist)`,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `🤝 ${c.ctx.player.displayName} helps ${target.name} — advantage on their next attack or check.`);
  return true;
}

async function handleUnassist(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!unassist: no token matched.');
    return true;
  }
  if (!(target.conditions as string[]).some((x) => x.toLowerCase() === 'helped')) {
    whisperToCaller(c.io, c.ctx, `!unassist: ${target.name} is not helped.`);
    return true;
  }
  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'helped');
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `💪 ${target.name} spends the Help.`);
  return true;
}

registerChatCommand('rage', handleRage);
registerChatCommand('unrage', handleUnrage);
registerChatCommand('cover', handleCover);
registerChatCommand(['power', 'powerattack'], handlePower);
registerChatCommand('inspire', handleInspire);
registerChatCommand('uninspire', handleUninspire);
registerChatCommand('assist', handleAssist);
registerChatCommand('unassist', handleUnassist);
