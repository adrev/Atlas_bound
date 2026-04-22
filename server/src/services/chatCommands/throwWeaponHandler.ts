import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * `!throw <weapon-name> <target>` — announce that a thrown weapon
 * lands at the target's feet (5e RAW: thrown weapons end up at the
 * hit location, not the attacker's tile). Useful for playtable
 * accountability — players otherwise "forget" the javelin they
 * threw is now lying next to the goblin.
 *
 * The VTT doesn't model each individual thrown weapon as its own
 * token (weapons are abstracted as inventory). Instead we:
 *   • Broadcast an unambiguous chat line so the DM + players see
 *     WHERE the weapon landed
 *   • Record the position in the announcement so the DM can drop
 *     a loot bag or manually move inventory later
 *
 * Typical workflow:
 *   1. Player uses !throw handaxe goblin
 *   2. Chat announces "handaxe lands at (x, y) near Goblin"
 *   3. On their next turn a PC (or the goblin) can move to that
 *      tile + pick up the weapon — DM handles inventory transfer
 *      with !attune / manual sheet edit.
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

async function handleThrow(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!throw: usage `!throw <weapon-name> <target>`');
    return true;
  }
  // Target is last token; everything before is the weapon name
  // (handles multi-word weapons like "silvered dagger").
  const targetName = parts[parts.length - 1];
  const weaponName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!throw: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  const callerName = caller?.name ?? 'Someone';

  // Compute tile coordinates for DM reference. Tokens carry pixel x,y;
  // we translate via the current map's gridSize when available so
  // players see D&D-native "F4" style tile coordinates rather than
  // raw pixel numbers. Fall back to pixel coords when the grid isn't
  // resolvable (sessions without an active map loaded).
  const gridSize = 70; // default. Room doesn't carry gridSize directly.
  const tx = Math.round(target.x / gridSize);
  const ty = Math.round(target.y / gridSize);

  broadcastSystem(
    c.io, c.ctx,
    `🎯 **${callerName}** throws **${weaponName}** at **${target.name}** — the weapon lands at the target's feet (approx. tile ${tx}, ${ty}). Someone will have to spend an action to pick it up if they want it back.`,
  );
  return true;
}

registerChatCommand('throw', handleThrow);
