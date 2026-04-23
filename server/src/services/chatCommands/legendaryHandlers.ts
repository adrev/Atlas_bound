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
    {
      actionResult: {
        actor: { name: target.name, tokenId: target.id },
        action: {
          name: actionName || 'Legendary Action',
          category: 'legendary',
          icon: '\uD83D\uDC51',
          cost: `${budget.remaining}/${budget.max} remaining`,
        },
        effect: actionName
          ? `${target.name} spends a Legendary Action to use ${actionName}.`
          : `${target.name} spends a Legendary Action.`,
        notes: [],
      },
    },
  );
  return true;
}

/**
 * !legres set <target> <max>    configure the resistance pool (default 3)
 * !legres <target>              spend one: flips the target's most recent
 *                               failed save into a success, decrements pool.
 * !legres list <target>         show remaining
 * !legres reset <target>        refresh to max (new day)
 */
async function handleLegRes(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const isDM = c.ctx.player.role === 'dm';
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!legres: usage `!legres <target>` | `!legres set <target> <max>` | `!legres list <target>` | `!legres reset <target>`',
    );
    return true;
  }
  const sub = parts[0].toLowerCase();

  if (sub === 'set') {
    if (!isDM) { whisperToCaller(c.io, c.ctx, '!legres set: DM only.'); return true; }
    const maxRaw = parts[parts.length - 1];
    const max = parseInt(maxRaw, 10);
    if (!Number.isFinite(max) || max < 1 || max > 9) {
      whisperToCaller(c.io, c.ctx, '!legres set: max must be 1-9.');
      return true;
    }
    const targetName = parts.slice(1, -1).join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!legres set: no token named "${targetName}".`);
      return true;
    }
    c.ctx.room.legendaryResistance.set(target.id, { max, remaining: max });
    broadcastSystem(c.io, c.ctx, `🛡 ${target.name} has ${max} legendary resistance${max === 1 ? '' : 's'}/day.`);
    return true;
  }

  if (sub === 'list') {
    const targetName = parts.slice(1).join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!legres list: no token named "${targetName}".`);
      return true;
    }
    const pool = c.ctx.room.legendaryResistance.get(target.id);
    if (!pool) {
      whisperToCaller(c.io, c.ctx, `!legres: ${target.name} has no Legendary Resistance configured.`);
      return true;
    }
    whisperToCaller(c.io, c.ctx, `${target.name}: ${pool.remaining}/${pool.max} legendary resistances remaining.`);
    return true;
  }

  if (sub === 'reset') {
    if (!isDM) { whisperToCaller(c.io, c.ctx, '!legres reset: DM only.'); return true; }
    const targetName = parts.slice(1).join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!legres reset: no token named "${targetName}".`);
      return true;
    }
    const pool = c.ctx.room.legendaryResistance.get(target.id);
    if (!pool) {
      whisperToCaller(c.io, c.ctx, `!legres: ${target.name} has no pool to reset.`);
      return true;
    }
    pool.remaining = pool.max;
    broadcastSystem(c.io, c.ctx, `🛡 ${target.name}: Legendary Resistance refreshed (${pool.max}/${pool.max}).`);
    return true;
  }

  // Default: spend one — same target-name parsing as !legendary.
  let consumed = 0;
  let target: Token | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join(' ');
    const match = resolveTarget(c.ctx, candidate);
    if (match) { target = match; consumed = i; }
  }
  // Allow "!legres <target>" with single-token target too (skip the
  // subcommand detection since we already set sub).
  if (!target) target = resolveTarget(c.ctx, parts.join(' '));
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!legres: no token matched.');
    return true;
  }
  const pool = c.ctx.room.legendaryResistance.get(target.id);
  if (!pool) {
    whisperToCaller(
      c.io, c.ctx,
      `!legres: ${target.name} has no budget. DM: \`!legres set ${target.name} 3\` first.`,
    );
    return true;
  }
  if (pool.remaining <= 0) {
    whisperToCaller(c.io, c.ctx, `!legres: ${target.name} has no resistances remaining.`);
    return true;
  }
  pool.remaining -= 1;
  broadcastSystem(
    c.io, c.ctx,
    `🛡 **${target.name} uses Legendary Resistance** — failed save becomes a success (${pool.remaining}/${pool.max} left).`,
  );
  return true;
}

registerChatCommand(['legendary', 'leg'], handleLegendary);
registerChatCommand(['legres', 'legresist'], handleLegRes);
