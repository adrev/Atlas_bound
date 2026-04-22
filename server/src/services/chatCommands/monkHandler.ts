import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Monk class features — Ki pool + bonus-action spenders.
 *
 * Ki points per RAW = Monk level (L1=1? actually L2 gets them; we
 * just default pool max to level and let the DM adjust). Refreshes
 * on a short rest.
 *
 *   !ki              → status
 *   !ki use [n]      → spend n (default 1)
 *   !ki reset        → refill to max on short/long rest (DM)
 *   !ki set <n>      → configure pool max (DM, defaults to level)
 *
 * Bonus-action spenders (each consumes 1 ki + the bonus action):
 *   !flurry               — Flurry of Blows (2 unarmed strikes)
 *   !patient              — Patient Defense (take Dodge)
 *   !stepwind             — Step of the Wind (Dash + Disengage; doubled jump)
 *   !stunstrike <t> <dc>  — Stunning Strike on a hit (CON save vs stun)
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

async function requireMonk(c: ChatCommandContext, cmdName: string): Promise<{ caller: Token; level: number; charId: string; monkName: string } | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('monk')) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: ${caller.name} isn't a Monk.`);
    return null;
  }
  return {
    caller,
    level: Number(row?.level) || 1,
    charId: caller.characterId,
    monkName: (row?.name as string) || caller.name,
  };
}

function getOrSeedKi(ctx: PlayerContext, charId: string, level: number): { max: number; remaining: number } {
  let pools = ctx.room.pointPools.get(charId);
  if (!pools) {
    pools = new Map();
    ctx.room.pointPools.set(charId, pools);
  }
  let ki = pools.get('ki');
  if (!ki) {
    ki = { max: level, remaining: level };
    pools.set('ki', ki);
  }
  return ki;
}

function spendKi(ki: { max: number; remaining: number }, amount: number): boolean {
  if (ki.remaining < amount) return false;
  ki.remaining -= amount;
  return true;
}

// ────── !ki status | use [n] | reset | set <n> ──────────────
async function handleKi(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const monk = await requireMonk(c, 'ki');
  if (!monk) return true;
  const ki = getOrSeedKi(c.ctx, monk.charId, monk.level);

  const sub = parts[0]?.toLowerCase() || 'status';

  if (sub === 'status' || sub === '') {
    whisperToCaller(c.io, c.ctx, `🧘 ${monk.monkName} Ki: ${ki.remaining}/${ki.max}.`);
    return true;
  }

  if (sub === 'set') {
    if (c.ctx.player.role !== 'dm') {
      whisperToCaller(c.io, c.ctx, '!ki set: DM only.');
      return true;
    }
    const n = parseInt(parts[1], 10);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      whisperToCaller(c.io, c.ctx, '!ki set: max must be 0-20.');
      return true;
    }
    ki.max = n;
    ki.remaining = Math.min(ki.remaining, ki.max);
    broadcastSystem(c.io, c.ctx, `🧘 ${monk.monkName} Ki pool set to ${ki.max}.`);
    return true;
  }

  if (sub === 'reset' || sub === 'refresh') {
    ki.remaining = ki.max;
    broadcastSystem(c.io, c.ctx, `🧘 ${monk.monkName} meditates — Ki refreshed to ${ki.max}/${ki.max}.`);
    return true;
  }

  if (sub === 'use' || sub === 'spend') {
    const n = parseInt(parts[1], 10) || 1;
    if (!spendKi(ki, n)) {
      whisperToCaller(c.io, c.ctx, `!ki: not enough Ki (${ki.remaining}/${ki.max}).`);
      return true;
    }
    broadcastSystem(c.io, c.ctx, `🧘 ${monk.monkName} spends ${n} Ki (${ki.remaining}/${ki.max} left).`);
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!ki: unknown subcommand "${sub}".`);
  return true;
}

// ────── !flurry ──────────────────────────────────────────────
async function handleFlurry(c: ChatCommandContext): Promise<boolean> {
  const monk = await requireMonk(c, 'flurry');
  if (!monk) return true;
  const ki = getOrSeedKi(c.ctx, monk.charId, monk.level);
  if (!spendKi(ki, 1)) {
    whisperToCaller(c.io, c.ctx, `!flurry: no Ki left (${ki.remaining}/${ki.max}).`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(monk.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, `!flurry: bonus action already spent this turn.`);
    ki.remaining += 1; // refund
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: monk.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `👊 ${monk.monkName} uses Flurry of Blows — 2 unarmed strikes as a bonus action. Ki ${ki.remaining}/${ki.max}.`,
  );
  return true;
}

// ────── !patient ─────────────────────────────────────────────
async function handlePatient(c: ChatCommandContext): Promise<boolean> {
  const monk = await requireMonk(c, 'patient');
  if (!monk) return true;
  const ki = getOrSeedKi(c.ctx, monk.charId, monk.level);
  if (!spendKi(ki, 1)) {
    whisperToCaller(c.io, c.ctx, `!patient: no Ki left (${ki.remaining}/${ki.max}).`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(monk.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, `!patient: bonus action already spent.`);
    ki.remaining += 1;
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: monk.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, monk.caller.id, {
    name: 'dodging',
    source: `${monk.monkName} (Patient Defense)`,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: monk.caller.id,
    changes: tokenConditionChanges(c.ctx.room, monk.caller.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🧘 ${monk.monkName} takes Patient Defense (Dodge) as a bonus action. Ki ${ki.remaining}/${ki.max}.`,
  );
  return true;
}

// ────── !stepwind <dash|disengage> ──────────────────────────
async function handleStepWind(c: ChatCommandContext): Promise<boolean> {
  const kind = (c.rest.trim().toLowerCase() || 'dash');
  if (kind !== 'dash' && kind !== 'disengage') {
    whisperToCaller(c.io, c.ctx, '!stepwind: usage `!stepwind <dash|disengage>`');
    return true;
  }
  const monk = await requireMonk(c, 'stepwind');
  if (!monk) return true;
  const ki = getOrSeedKi(c.ctx, monk.charId, monk.level);
  if (!spendKi(ki, 1)) {
    whisperToCaller(c.io, c.ctx, `!stepwind: no Ki left (${ki.remaining}/${ki.max}).`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(monk.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, `!stepwind: bonus action already spent.`);
    ki.remaining += 1;
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    if (kind === 'dash') economy.movementRemaining += economy.movementMax;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: monk.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  if (kind === 'disengage') {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, monk.caller.id, {
      name: 'disengaged',
      source: `${monk.monkName} (Step of the Wind)`,
      appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: monk.caller.id,
      changes: tokenConditionChanges(c.ctx.room, monk.caller.id),
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🪶 ${monk.monkName} uses Step of the Wind — ${kind === 'dash' ? 'Dash (double movement)' : 'Disengage (no OA)'}, jump distance doubled. Ki ${ki.remaining}/${ki.max}.`,
  );
  return true;
}

// ────── !stunstrike <target> <dc> ───────────────────────────
async function handleStunStrike(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!stunstrike: usage `!stunstrike <target> <dc>` (after landing a hit on the target)');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target || !Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!stunstrike: invalid target or DC.');
    return true;
  }
  const monk = await requireMonk(c, 'stunstrike');
  if (!monk) return true;
  if (monk.level < 5) {
    whisperToCaller(c.io, c.ctx, `!stunstrike: requires Monk level 5 (${monk.monkName} is ${monk.level}).`);
    return true;
  }
  const ki = getOrSeedKi(c.ctx, monk.charId, monk.level);
  if (!spendKi(ki, 1)) {
    whisperToCaller(c.io, c.ctx, `!stunstrike: no Ki left (${ki.remaining}/${ki.max}).`);
    return true;
  }

  // Roll the target's CON save. We reuse the !save pattern inline
  // since we only need one target + no damage.
  let saveMod = 0;
  let tName = target.name;
  if (target.characterId) {
    const { rows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = $1',
      [target.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    try {
      const scores = typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores ?? {});
      const con = Math.floor((((scores as Record<string, number>).con ?? 10) - 10) / 2);
      const prof = Number(row?.proficiency_bonus) || 2;
      const saves = typeof row?.saving_throws === 'string' ? JSON.parse(row.saving_throws as string) : (row?.saving_throws ?? []);
      const isProf = Array.isArray(saves) && saves.includes('con');
      saveMod = con + (isProf ? prof : 0);
      if (row?.name) tName = row.name as string;
    } catch { /* ignore */ }
  }
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + saveMod;
  const saved = total >= dc;
  const modSign = saveMod >= 0 ? '+' : '';

  const lines: string[] = [];
  lines.push(`👊 ${monk.monkName} uses Stunning Strike on ${tName}! (CON DC ${dc})`);
  lines.push(`   CON save: d20=${d20}${modSign}${saveMod}=${total} → ${saved ? 'SAVED' : 'STUNNED (until end of next turn)'}`);
  if (!saved) {
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'stunned',
      source: `${monk.monkName} (Stunning Strike)`,
      casterTokenId: monk.caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 1,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }
  lines.push(`   Ki ${ki.remaining}/${ki.max}.`);
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

registerChatCommand('ki', handleKi);
registerChatCommand('flurry', handleFlurry);
registerChatCommand(['patient', 'patientdefense'], handlePatient);
registerChatCommand(['stepwind', 'step'], handleStepWind);
registerChatCommand(['stunstrike', 'stun'], handleStunStrike);
