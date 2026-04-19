import type { Token } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  isDM,
  type ChatCommandContext,
} from '../ChatCommands.js';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * R7 — Turn / round hook chat commands. Lets the DM queue automated
 * chat broadcasts that fire at specific points in the combat loop,
 * without writing a full scripting macro (that's R10 territory).
 *
 *   !onturn <target> <message>
 *       Broadcast `<message>` as a system chat line when `<target>`'s
 *       initiative turn begins. Multiple hooks stack. Persists only
 *       in-memory — cleared when combat ends (or the server restarts).
 *
 *   !onround <message>
 *       Broadcast `<message>` when the combat advances to a new round.
 *       Fires for every new round, not just round 1.
 *
 *   !unhook <target|round> [index]
 *       Clear queued hooks. `!unhook <target>` wipes all on-turn hooks
 *       for that token. `!unhook round` wipes all on-round hooks.
 *       With an optional 1-based `index`, clears just that hook.
 *
 * Designed to stack with R5 — a DM can set up "spike trap activates,
 * everyone on tile makes DEX save" as a single `!onround` line that
 * reminds them each round, while running `!onturn <boss> Legendary
 * Actions remaining: 3` for per-turn reminders.
 */

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

async function handleOnTurn(c: ChatCommandContext): Promise<boolean> {
  if (!isDM(c.ctx)) {
    whisperToCaller(c.io, c.ctx, '!onturn: DM only.');
    return true;
  }
  // Parse target name as the FIRST token so spaces in the message
  // don't interfere. Multi-word target names in `!onturn` are rare;
  // if needed the DM can use double quotes — but we'll keep the
  // parser simple and document first-token target behaviour.
  const firstSpace = c.rest.search(/\s/);
  if (firstSpace === -1) {
    whisperToCaller(c.io, c.ctx, '!onturn: usage `!onturn <target> <message>`');
    return true;
  }
  const targetName = c.rest.slice(0, firstSpace).trim();
  const message = c.rest.slice(firstSpace + 1).trim();
  if (!message) {
    whisperToCaller(c.io, c.ctx, '!onturn: message cannot be empty.');
    return true;
  }

  const target = resolveTarget(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!onturn: no token named “${targetName}” on this map.`);
    return true;
  }

  const list = c.ctx.room.turnHooks.get(target.id) ?? [];
  if (list.length >= 20) {
    whisperToCaller(c.io, c.ctx, `!onturn: ${target.name} already has 20 hooks queued (max).`);
    return true;
  }
  list.push(message);
  c.ctx.room.turnHooks.set(target.id, list);

  whisperToCaller(
    c.io, c.ctx,
    `!onturn: queued hook #${list.length} for ${target.name} — fires at start of their turn.`,
  );
  return true;
}

async function handleOnRound(c: ChatCommandContext): Promise<boolean> {
  if (!isDM(c.ctx)) {
    whisperToCaller(c.io, c.ctx, '!onround: DM only.');
    return true;
  }
  const message = c.rest.trim();
  if (!message) {
    whisperToCaller(c.io, c.ctx, '!onround: usage `!onround <message>`');
    return true;
  }
  if (c.ctx.room.roundHooks.length >= 20) {
    whisperToCaller(c.io, c.ctx, '!onround: already 20 round hooks queued (max).');
    return true;
  }
  c.ctx.room.roundHooks.push(message);
  whisperToCaller(
    c.io, c.ctx,
    `!onround: queued hook #${c.ctx.room.roundHooks.length} — fires at the start of each new round.`,
  );
  return true;
}

async function handleUnhook(c: ChatCommandContext): Promise<boolean> {
  if (!isDM(c.ctx)) {
    whisperToCaller(c.io, c.ctx, '!unhook: DM only.');
    return true;
  }
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!unhook: usage `!unhook <target|round> [index]`');
    return true;
  }
  const firstArg = parts[0];
  const idxArg = parts[1];
  const idx = idxArg ? parseInt(idxArg, 10) : NaN;

  if (firstArg.toLowerCase() === 'round') {
    if (Number.isFinite(idx) && idx > 0 && idx <= c.ctx.room.roundHooks.length) {
      c.ctx.room.roundHooks.splice(idx - 1, 1);
      whisperToCaller(c.io, c.ctx, `!unhook: removed round hook #${idx}.`);
    } else {
      const n = c.ctx.room.roundHooks.length;
      c.ctx.room.roundHooks = [];
      whisperToCaller(c.io, c.ctx, `!unhook: cleared ${n} round hook${n === 1 ? '' : 's'}.`);
    }
    return true;
  }

  const target = resolveTarget(c.ctx, parts.join(' ').replace(/\s+\d+$/, ''));
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!unhook: no token named “${firstArg}” on this map.`);
    return true;
  }
  const list = c.ctx.room.turnHooks.get(target.id);
  if (!list || list.length === 0) {
    whisperToCaller(c.io, c.ctx, `!unhook: no hooks queued for ${target.name}.`);
    return true;
  }
  if (Number.isFinite(idx) && idx > 0 && idx <= list.length) {
    list.splice(idx - 1, 1);
    if (list.length === 0) c.ctx.room.turnHooks.delete(target.id);
    whisperToCaller(c.io, c.ctx, `!unhook: removed hook #${idx} from ${target.name}.`);
  } else {
    const n = list.length;
    c.ctx.room.turnHooks.delete(target.id);
    whisperToCaller(c.io, c.ctx, `!unhook: cleared ${n} hook${n === 1 ? '' : 's'} from ${target.name}.`);
  }
  return true;
}

registerChatCommand('onturn', handleOnTurn);
registerChatCommand('onround', handleOnRound);
registerChatCommand('unhook', handleUnhook);
