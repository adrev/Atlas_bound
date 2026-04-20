import type { Token } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Legendary Actions (Monster Manual p.11). A legendary creature has
 * a pool of 1–3 actions it can spend "at the end of another
 * creature's turn". Regains all spent actions at the start of its
 * own turn (handled in CombatService.nextTurn).
 *
 *   !legendary set <target> <max>
 *       DM-only. Configure the monster's action budget. Typical
 *       values: ancient dragons = 3, adult dragons / beholder = 3,
 *       lich = 3 (or 6 in lair). Resets the `remaining` pool to
 *       the new max.
 *
 *   !legendary <target> [name]
 *       Spend one legendary action. Optional <name> is the action's
 *       name (e.g. "Tail", "Detect"). Broadcast as a system message
 *       so the party sees exactly what's happening.
 *
 *   !legendary clear <target>
 *       DM-only. Remove the legendary-action budget entirely — use
 *       when the monster dies or loses its legendary status mid-
 *       combat.
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

async function handleLegendary(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!legendary: usage `!legendary set <target> <max>` | `!legendary <target> [action]` | `!legendary clear <target>`',
    );
    return true;
  }

  const isDM = c.ctx.player.role === 'dm';

  // --- Subcommand: set ---
  if (parts[0].toLowerCase() === 'set') {
    if (!isDM) {
      whisperToCaller(c.io, c.ctx, '!legendary set: DM only.');
      return true;
    }
    const maxRaw = parts[parts.length - 1];
    const max = parseInt(maxRaw, 10);
    if (!Number.isFinite(max) || max < 1 || max > 9) {
      whisperToCaller(c.io, c.ctx, '!legendary set: max must be 1-9.');
      return true;
    }
    const targetName = parts.slice(1, -1).join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!legendary set: no token named "${targetName}" on this map.`);
      return true;
    }
    c.ctx.room.legendaryActions.set(target.id, { max, remaining: max });
    broadcastSystem(
      c.io, c.ctx,
      `👑 ${target.name} has ${max} legendary action${max === 1 ? '' : 's'} per round. Regains on its own turn.`,
    );
    return true;
  }

  // --- Subcommand: clear ---
  if (parts[0].toLowerCase() === 'clear') {
    if (!isDM) {
      whisperToCaller(c.io, c.ctx, '!legendary clear: DM only.');
      return true;
    }
    const targetName = parts.slice(1).join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!legendary clear: no token named "${targetName}" on this map.`);
      return true;
    }
    const had = c.ctx.room.legendaryActions.has(target.id);
    c.ctx.room.legendaryActions.delete(target.id);
    if (had) {
      broadcastSystem(c.io, c.ctx, `👑 ${target.name} no longer has legendary actions.`);
    } else {
      whisperToCaller(c.io, c.ctx, `!legendary clear: ${target.name} had no budget.`);
    }
    return true;
  }

  // --- Spend: first arg is target, rest is action description ---
  // Parse from the right: any single action-name phrase after the
  // target. Since target names can have spaces, we accept a single
  // token as target (longer action names after). DMs who have
  // multi-word targets should quote or use the chat command from a
  // UI (future).
  //
  // Heuristic: if the first part is a token name (resolves), use it;
  // otherwise, walk right appending tokens until the prefix resolves
  // to a token on the map.
  let consumed = 0;
  let target: Token | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join(' ');
    const match = resolveTarget(c.ctx, candidate);
    if (match) {
      target = match;
      consumed = i;
    }
  }
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!legendary: no token matched the target name.');
    return true;
  }
  const actionName = parts.slice(consumed).join(' ');

  const budget = c.ctx.room.legendaryActions.get(target.id);
  if (!budget) {
    whisperToCaller(
      c.io, c.ctx,
      `!legendary: ${target.name} has no legendary actions configured. DM: run \`!legendary set ${target.name} <n>\` first.`,
    );
    return true;
  }
  if (budget.remaining <= 0) {
    whisperToCaller(
      c.io, c.ctx,
      `!legendary: ${target.name} has no legendary actions remaining this round — refreshes at the start of their turn.`,
    );
    return true;
  }

  budget.remaining -= 1;
  const label = actionName ? ` — ${actionName}` : '';
  broadcastSystem(
    c.io, c.ctx,
    `👑 ${target.name} spends a Legendary Action${label}. (${budget.remaining}/${budget.max} remaining)`,
  );
  return true;
}

registerChatCommand(['legendary', 'leg'], handleLegendary);
