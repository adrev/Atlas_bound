import type { Token, Condition } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  isDM,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * R5 — Named-condition chat commands. Lets the DM quickly apply / clear
 * 5e-standard conditions (and duration-based variants) mid-combat
 * without digging through the token panel.
 *
 *   !cond <target> <name> [rounds]
 *       Apply a named condition. If `rounds` is provided, the condition
 *       auto-expires at the start of the target's turn once the combat
 *       round exceeds (applied + rounds). Without `rounds`, the
 *       condition persists until cleared. Routes through the same
 *       ConditionService.applyConditionWithMeta the spell-cast pipeline
 *       uses, so tickStartOfTurnConditions picks it up automatically.
 *
 *   !uncond <target> <name>
 *       Remove the condition from the target and drop any tracked meta
 *       (duration, end-of-turn save re-rolls). No-op if the condition
 *       isn't present.
 *
 * DM-only. Targeting follows the R1 convention: case-insensitive exact
 * token-name match on the current map; newest wins on ties.
 */

// 5e-standard conditions. We accept case-insensitive input and a few
// common aliases. Any string in the Condition union is allowed — the
// map below normalizes user input to the canonical key.
const CONDITION_ALIASES: Record<string, Condition> = {
  blinded: 'blinded', blind: 'blinded',
  charmed: 'charmed',
  deafened: 'deafened', deaf: 'deafened',
  frightened: 'frightened', frighten: 'frightened', scared: 'frightened',
  grappled: 'grappled', grapple: 'grappled',
  incapacitated: 'incapacitated', incap: 'incapacitated',
  invisible: 'invisible',
  paralyzed: 'paralyzed', paralysed: 'paralyzed',
  petrified: 'petrified',
  poisoned: 'poisoned', poison: 'poisoned',
  prone: 'prone',
  restrained: 'restrained', restrain: 'restrained',
  stunned: 'stunned', stun: 'stunned',
  unconscious: 'unconscious', unc: 'unconscious', out: 'unconscious',
  exhaustion: 'exhaustion', exhausted: 'exhaustion',
};

function normalizeCondition(raw: string): Condition | null {
  const key = raw.trim().toLowerCase();
  return CONDITION_ALIASES[key] ?? null;
}

function resolveTarget(ctx: PlayerContext, name: string): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  if (!name) return null;
  const needle = name.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase() === needle);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

async function handleCond(c: ChatCommandContext): Promise<boolean> {
  if (!isDM(c.ctx)) {
    whisperToCaller(c.io, c.ctx, '!cond: DM only.');
    return true;
  }
  // Parse from the right so targets with spaces work:
  //   !cond Young Red Dragon frightened 3  →  target="Young Red Dragon" cond=frightened rounds=3
  //   !cond Goblin stunned               →  target="Goblin" cond=stunned (no duration)
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!cond: usage `!cond <target> <condition> [rounds]`');
    return true;
  }

  // If the last token parses as a positive integer, treat it as the
  // round count. Otherwise it's part of the condition name.
  const last = parts[parts.length - 1];
  const maybeRounds = parseInt(last, 10);
  const hasRounds = /^\d+$/.test(last) && Number.isFinite(maybeRounds) && maybeRounds > 0 && maybeRounds <= 100;
  if (hasRounds) parts.pop();

  const condRaw = parts.pop();
  if (!condRaw) {
    whisperToCaller(c.io, c.ctx, '!cond: usage `!cond <target> <condition> [rounds]`');
    return true;
  }
  const targetName = parts.join(' ');
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!cond: usage `!cond <target> <condition> [rounds]`');
    return true;
  }

  const condition = normalizeCondition(condRaw);
  if (!condition) {
    whisperToCaller(
      c.io, c.ctx,
      `!cond: unknown condition “${condRaw}”. Allowed: ${Object.keys(CONDITION_ALIASES).slice(0, 15).join(', ')}…`,
    );
    return true;
  }

  const target = resolveTarget(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!cond: no token named “${targetName}” on this map.`);
    return true;
  }

  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const expiresAfterRound = hasRounds ? currentRound + maybeRounds : undefined;

  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: condition,
    source: `${c.ctx.player.displayName} (!cond)`,
    appliedRound: currentRound,
    ...(expiresAfterRound !== undefined ? { expiresAfterRound } : {}),
  });

  // Broadcast the updated condition list so all clients repaint token badges.
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });

  const durationLabel = hasRounds ? ` for ${maybeRounds} round${maybeRounds === 1 ? '' : 's'}` : '';
  whisperToCaller(c.io, c.ctx, `!cond: applied ${condition} to ${target.name}${durationLabel}.`);
  return true;
}

async function handleUncond(c: ChatCommandContext): Promise<boolean> {
  if (!isDM(c.ctx)) {
    whisperToCaller(c.io, c.ctx, '!uncond: DM only.');
    return true;
  }
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!uncond: usage `!uncond <target> <condition>`');
    return true;
  }
  const condRaw = parts.pop()!;
  const targetName = parts.join(' ');
  const condition = normalizeCondition(condRaw);
  if (!condition) {
    whisperToCaller(c.io, c.ctx, `!uncond: unknown condition “${condRaw}”.`);
    return true;
  }
  const target = resolveTarget(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!uncond: no token named “${targetName}” on this map.`);
    return true;
  }

  const hadIt = (target.conditions as string[]).includes(condition);
  if (!hadIt) {
    whisperToCaller(c.io, c.ctx, `!uncond: ${target.name} is not ${condition}.`);
    return true;
  }

  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, condition);

  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });

  whisperToCaller(c.io, c.ctx, `!uncond: cleared ${condition} from ${target.name}.`);
  return true;
}

registerChatCommand(['cond', 'condition'], handleCond);
registerChatCommand(['uncond', 'uncondition'], handleUncond);
