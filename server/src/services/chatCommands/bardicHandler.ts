import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import type { PlayerContext } from '../../utils/roomState.js';
import type { Token } from '@dnd-vtt/shared';

/**
 * Bardic Inspiration (PHB Bard class feature). The bard spends a
 * bonus action to hand an ally a BI die — d6 at L1, d8 at L5, d10
 * at L10, d12 at L15. The recipient can, within 10 minutes, add the
 * die to ONE attack roll, saving throw, or ability check. Used
 * once, gone until the bard short-rests.
 *
 *   !bardic <target> [d6|d8|d10|d12]
 *       Apply the `bardic-inspired` pseudo-condition. Source carries
 *       the die size so the recipient / DM can track which die to
 *       roll. Die size defaults to d6 if not specified.
 *
 *   !unbardic <target> [add|waste]
 *       Clear the badge. Default "add" means the recipient is
 *       spending the die now: roll it and broadcast the bonus so
 *       the DM can add it to the roll they're resolving. "waste"
 *       just clears the badge without rolling (10-minute timer ran
 *       out, etc.).
 */

function resolveTargetOrSelf(
  ctx: PlayerContext,
  name: string,
): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  if (!name) {
    const own = all
      .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return own[0] ?? null;
  }
  const needle = name.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase() === needle);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

function parseDie(arg: string): number | null {
  const m = arg.match(/^d?(\d+)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (![6, 8, 10, 12].includes(n)) return null;
  return n;
}

async function handleBardic(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  // Parse the die size if the LAST token matches. Everything else is
  // the target name. Default die: d6 (Bard L1).
  let die = 6;
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    const maybe = parseDie(last);
    if (maybe !== null) {
      die = maybe;
      parts.pop();
    }
  }
  const targetName = parts.join(' ');
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!bardic: no target matched. Usage: `!bardic <target> [d6|d8|d10|d12]`');
    return true;
  }

  const existing = (target.conditions as string[]).some(
    (x) => x.toLowerCase() === 'bardic-inspired',
  );
  if (existing) {
    whisperToCaller(c.io, c.ctx, `!bardic: ${target.name} already has Bardic Inspiration. Spend with !unbardic first.`);
    return true;
  }

  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'bardic-inspired',
    source: `d${die}`,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
    // 10-minute duration = 100 rounds. In practice combat rarely runs
    // that long, so the badge effectively persists until manually
    // spent or the fight ends.
    expiresAfterRound:
      c.ctx.room.combatState?.roundNumber != null
        ? c.ctx.room.combatState.roundNumber + 100
        : undefined,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });
  broadcastSystem(
    c.io, c.ctx,
    `🎵 ${c.ctx.player.displayName} inspires ${target.name} — Bardic Inspiration (d${die}). Spend with \`!unbardic\` before the next short rest.`,
  );
  return true;
}

async function handleUnbardic(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  let mode: 'add' | 'waste' = 'add';
  if (parts.length > 0) {
    const last = parts[parts.length - 1].toLowerCase();
    if (last === 'add' || last === 'waste' || last === 'use' || last === 'spend') {
      mode = last === 'waste' ? 'waste' : 'add';
      parts.pop();
    }
  }
  const targetName = parts.join(' ');
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, '!unbardic: no target matched.');
    return true;
  }
  const hasIt = (target.conditions as string[]).some(
    (x) => x.toLowerCase() === 'bardic-inspired',
  );
  if (!hasIt) {
    whisperToCaller(c.io, c.ctx, `!unbardic: ${target.name} doesn't have Bardic Inspiration.`);
    return true;
  }

  // Fish the die size out of the condition meta before we remove it.
  const meta = c.ctx.room.conditionMeta.get(target.id)?.get('bardic-inspired');
  const dieStr = meta?.source ?? 'd6';
  const dieMatch = dieStr.match(/d(\d+)/i);
  const dieSize = dieMatch ? parseInt(dieMatch[1], 10) : 6;

  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'bardic-inspired');
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });

  if (mode === 'waste') {
    broadcastSystem(c.io, c.ctx, `🎵 ${target.name}'s Bardic Inspiration fades unused.`);
  } else {
    const roll = Math.floor(Math.random() * dieSize) + 1;
    broadcastSystem(
      c.io, c.ctx,
      `🎵 ${target.name} spends Bardic Inspiration — d${dieSize} = **${roll}** (add to attack / save / check they just rolled).`,
    );
  }
  return true;
}

registerChatCommand(['bardic', 'bi'], handleBardic);
registerChatCommand('unbardic', handleUnbardic);
