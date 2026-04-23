import type { Token } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import type { PlayerContext } from '../../utils/roomState.js';

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

/**
 * Lair actions (Monster Manual p.6). A monster in its lair has lair
 * actions it can spend on initiative count 20, losing ties. The VTT
 * doesn't insert a virtual init-20 combatant because that'd require
 * the tracker to interrupt play mid-round; instead we surface a
 * reminder at the start of each round so the DM can narrate + resolve.
 *
 *   !lair enable <target>   flag this monster as in-lair
 *   !lair disable <target>  clear the flag (moved out of lair / killed)
 *   !lair <target> <name>   announce / resolve a specific lair action
 *   !lair list              show currently-enabled lair tokens
 */
async function handleLair(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!lair: usage `!lair enable <target>` | `!lair disable <target>` | `!lair <target> <action>` | `!lair list`',
    );
    return true;
  }
  const isDM = c.ctx.player.role === 'dm';

  if (parts[0].toLowerCase() === 'list') {
    const ids = Array.from(c.ctx.room.lairActionTokens);
    if (ids.length === 0) {
      whisperToCaller(c.io, c.ctx, '!lair: no tokens currently flagged as in-lair.');
      return true;
    }
    const names = ids
      .map((id) => c.ctx.room.tokens.get(id)?.name ?? `<missing:${id}>`)
      .join(', ');
    whisperToCaller(c.io, c.ctx, `!lair: in-lair monsters — ${names}`);
    return true;
  }

  if (parts[0].toLowerCase() === 'enable' || parts[0].toLowerCase() === 'disable') {
    if (!isDM) {
      whisperToCaller(c.io, c.ctx, `!lair ${parts[0]}: DM only.`);
      return true;
    }
    const targetName = parts.slice(1).join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!lair: no token named "${targetName}" on this map.`);
      return true;
    }
    if (parts[0].toLowerCase() === 'enable') {
      c.ctx.room.lairActionTokens.add(target.id);
      broadcastSystem(c.io, c.ctx, `🏰 ${target.name} is in its lair — lair actions will remind at the start of each round (init 20).`);
    } else {
      c.ctx.room.lairActionTokens.delete(target.id);
      broadcastSystem(c.io, c.ctx, `🏰 ${target.name} is no longer in its lair — no more reminders.`);
    }
    return true;
  }

  // Spend / announce: "!lair <target> <action-name>". Target name can
  // span multiple words — walk left-to-right and pick the longest
  // prefix that resolves to a token, same trick as !legendary.
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
    whisperToCaller(c.io, c.ctx, '!lair: no token matched the target name.');
    return true;
  }
  if (!c.ctx.room.lairActionTokens.has(target.id)) {
    whisperToCaller(
      c.io, c.ctx,
      `!lair: ${target.name} isn't marked as in-lair. DM: \`!lair enable ${target.name}\` first.`,
    );
    return true;
  }
  const actionName = parts.slice(consumed).join(' ').trim();
  if (!actionName) {
    whisperToCaller(c.io, c.ctx, '!lair: specify the lair action name.');
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🏰 ${target.name} triggers a lair action — ${actionName}`,
    {
      actionResult: {
        actor: { name: target.name, tokenId: target.id },
        action: {
          name: actionName,
          category: 'lair',
          icon: '\uD83C\uDFF0',
        },
        effect: `${target.name} invokes the lair: ${actionName}.`,
        notes: ['Init 20 (losing ties)'],
      },
    },
  );
  return true;
}

/**
 * Monster recharge abilities (Recharge 5-6, Recharge 4-6, etc.). When
 * used, the ability becomes unavailable until the start of the
 * monster's next turn — at which point the engine rolls 1d6; if it
 * meets the threshold, the ability recharges. The roll itself happens
 * in CombatService.nextTurn so the socket layer just gets a notice.
 *
 *   !recharge set <target> <ability> <min>   configure (e.g. min=5 for Recharge 5-6)
 *   !recharge use <target> <ability>         mark as used (triggers the next-turn re-roll)
 *   !recharge list <target>                  show pool status
 *   !recharge clear <target>                 remove all tracked abilities on this token
 */
async function handleRecharge(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!recharge: usage `!recharge set <target> <ability> <min>` | `!recharge use <target> <ability>` | `!recharge list <target>` | `!recharge clear <target>`',
    );
    return true;
  }
  const isDM = c.ctx.player.role === 'dm';
  const sub = parts.shift()!.toLowerCase();

  if (sub === 'list') {
    const targetName = parts.join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!recharge: no token named "${targetName}".`);
      return true;
    }
    const pool = c.ctx.room.rechargePools.get(target.id);
    if (!pool || pool.size === 0) {
      whisperToCaller(c.io, c.ctx, `!recharge: ${target.name} has no recharge abilities tracked.`);
      return true;
    }
    const lines: string[] = [];
    for (const [name, entry] of pool.entries()) {
      lines.push(`  • ${name} (Recharge ${entry.min}-6) — ${entry.available ? 'READY' : 'spent, re-rolling on next turn'}`);
    }
    whisperToCaller(c.io, c.ctx, `!recharge ${target.name}:\n${lines.join('\n')}`);
    return true;
  }

  if (sub === 'clear') {
    if (!isDM) {
      whisperToCaller(c.io, c.ctx, '!recharge clear: DM only.');
      return true;
    }
    const targetName = parts.join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!recharge: no token named "${targetName}".`);
      return true;
    }
    c.ctx.room.rechargePools.delete(target.id);
    broadcastSystem(c.io, c.ctx, `🔥 ${target.name}: recharge tracking cleared.`);
    return true;
  }

  if (sub === 'set') {
    if (!isDM) {
      whisperToCaller(c.io, c.ctx, '!recharge set: DM only.');
      return true;
    }
    // Parse from the right: last token = min, penultimate = ability,
    // everything else = target name.
    if (parts.length < 3) {
      whisperToCaller(c.io, c.ctx, '!recharge set: usage `!recharge set <target> <ability> <min>`');
      return true;
    }
    const minRaw = parts.pop()!;
    const min = parseInt(minRaw, 10);
    if (!Number.isFinite(min) || min < 2 || min > 6) {
      whisperToCaller(c.io, c.ctx, '!recharge set: min must be 2-6.');
      return true;
    }
    const abilityName = parts.pop()!.toLowerCase();
    const targetName = parts.join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!recharge set: no token named "${targetName}".`);
      return true;
    }
    let pool = c.ctx.room.rechargePools.get(target.id);
    if (!pool) {
      pool = new Map();
      c.ctx.room.rechargePools.set(target.id, pool);
    }
    pool.set(abilityName, { min, available: true });
    broadcastSystem(
      c.io, c.ctx,
      `🔥 ${target.name} tracks ${abilityName} (Recharge ${min}-6). Starts available.`,
    );
    return true;
  }

  if (sub === 'use') {
    if (!isDM) {
      whisperToCaller(c.io, c.ctx, '!recharge use: DM only.');
      return true;
    }
    if (parts.length < 2) {
      whisperToCaller(c.io, c.ctx, '!recharge use: usage `!recharge use <target> <ability>`');
      return true;
    }
    const abilityName = parts.pop()!.toLowerCase();
    const targetName = parts.join(' ');
    const target = resolveTarget(c.ctx, targetName);
    if (!target) {
      whisperToCaller(c.io, c.ctx, `!recharge use: no token named "${targetName}".`);
      return true;
    }
    const pool = c.ctx.room.rechargePools.get(target.id);
    const entry = pool?.get(abilityName);
    if (!entry) {
      whisperToCaller(c.io, c.ctx, `!recharge use: ${target.name} has no "${abilityName}" tracked.`);
      return true;
    }
    if (!entry.available) {
      whisperToCaller(c.io, c.ctx, `!recharge use: ${target.name}'s ${abilityName} is already spent.`);
      return true;
    }
    entry.available = false;
    broadcastSystem(
      c.io, c.ctx,
      `💨 ${target.name} uses ${abilityName}. Recharge ${entry.min}-6 on ${target.name}'s next turn.`,
    );
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!recharge: unknown subcommand "${sub}". Try set / use / list / clear.`);
  return true;
}

registerChatCommand('lair', handleLair);
registerChatCommand('recharge', handleRecharge);
