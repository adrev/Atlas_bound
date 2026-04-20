import type { Token } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import type { PlayerContext } from '../../utils/roomState.js';

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
      .filter((t) => (t as any).ownerUserId === ctx.player.userId)
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
  return (token as any).ownerUserId === ctx.player.userId;
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
    changes: { conditions: target.conditions },
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
    changes: { conditions: target.conditions },
  });
  broadcastSystem(c.io, c.ctx, `😮‍💨 ${target.name}'s Rage ends.`);
  return true;
}

registerChatCommand('rage', handleRage);
registerChatCommand('unrage', handleUnrage);
