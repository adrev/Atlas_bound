import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token, ActionBreakdown } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Tier 15 — Remaining Rogue subclasses:
 *   Mastermind: !helpat (Help action at 30 ft)
 *   Inquisitive: !insightfight (1-min advantage Sneak Attack)
 *   Scout: !skirmish (reaction move)
 *   Soulknife: !psyblade (summon), !psiknife (pool of psychic dice)
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

function hasFeature(row: Record<string, unknown> | undefined, pattern: RegExp): boolean {
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    if (!Array.isArray(feats)) return false;
    return feats.some((f: { name?: string }) => typeof f?.name === 'string' && pattern.test(f.name));
  } catch {
    return false;
  }
}

function abilityMod(scores: Record<string, number> | undefined, ability: string): number {
  const raw = (scores ?? {})[ability] ?? 10;
  return Math.floor((raw - 10) / 2);
}

async function loadRogue(c: ChatCommandContext, cmd: string): Promise<{
  caller: Token;
  row: Record<string, unknown> | undefined;
  classLower: string;
  callerName: string;
  level: number;
} | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, ability_scores, proficiency_bonus FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: ${caller.name} isn't a Rogue.`);
    return null;
  }
  return {
    caller,
    row,
    classLower,
    callerName: (row?.name as string) || caller.name,
    level: Number(row?.level) || 3,
  };
}

// ────── Mastermind — Master of Tactics (L3) ────────
/**
 * Use Help as a bonus action instead of action, and can Help allies
 * up to 30 ft away.
 */
async function handleHelpAt(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!helpat: usage `!helpat <target>` (bonus action, 30 ft)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!helpat: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadRogue(c, 'helpat');
  if (!loaded) return true;
  const { caller, classLower, callerName, row } = loaded;
  if (!hasFeature(row, /master\s+of\s+tactics/i) && !classLower.includes('mastermind')) {
    whisperToCaller(c.io, c.ctx, `!helpat: ${callerName} isn't a Mastermind.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!helpat: bonus action already spent.');
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'helped',
    source: `${callerName} (Master of Tactics)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 1,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🎯 **Master of Tactics** — ${callerName} Helps ${target.name} as a **bonus action** (up to 30 ft). Next attack or check has advantage.`,
  );
  return true;
}

// ────── Inquisitive — Insightful Fighting (L3) ─────
/**
 * Bonus action: Insight (WIS) check vs target's Deception (CHA).
 * On success, you have Sneak Attack against that target for 1 min
 * without needing advantage (if within 5 ft + no ally adjacent).
 */
async function handleInsightFight(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!insightfight: usage `!insightfight <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, parts.join(' '));
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!insightfight: no token matched.`);
    return true;
  }
  const loaded = await loadRogue(c, 'insightfight');
  if (!loaded) return true;
  const { caller, classLower, callerName, row } = loaded;
  if (!hasFeature(row, /insightful\s+fighting/i) && !classLower.includes('inquisitive')) {
    whisperToCaller(c.io, c.ctx, `!insightfight: ${callerName} isn't an Inquisitive.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!insightfight: bonus action already spent.');
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  // Caller's Insight roll.
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const prof = Number(row?.proficiency_bonus) || 2;
  const insightMod = abilityMod(scores as Record<string, number>, 'wis') + prof; // assume proficiency
  // Target's Deception.
  let decMod = 0;
  let tName = target.name;
  if (target.characterId) {
    const { rows: trows } = await pool.query(
      'SELECT ability_scores, proficiency_bonus, name FROM characters WHERE id = $1',
      [target.characterId],
    );
    const trow = trows[0] as Record<string, unknown> | undefined;
    const tscores = typeof trow?.ability_scores === 'string'
      ? JSON.parse(trow.ability_scores as string)
      : (trow?.ability_scores ?? {});
    decMod = abilityMod(tscores as Record<string, number>, 'cha');
    if (trow?.name) tName = trow.name as string;
  }
  const d20a = Math.floor(Math.random() * 20) + 1;
  const d20b = Math.floor(Math.random() * 20) + 1;
  const insTotal = d20a + insightMod;
  const decTotal = d20b + decMod;
  const win = insTotal > decTotal;
  const iSign = insightMod >= 0 ? '+' : '';
  const dSign = decMod >= 0 ? '+' : '';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  if (win) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'insight-marked',
      source: `${callerName} (Insightful Fighting)`,
      casterTokenId: caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 10,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }
  const ifBreakdown: ActionBreakdown = {
    actor: { name: callerName, tokenId: caller.id },
    action: {
      name: 'Insightful Fighting',
      category: 'class-feature',
      icon: '🔍',
      cost: 'Bonus action',
    },
    effect: `Contest: ${callerName} Insight d20=${d20a}${iSign}${insightMod}=${insTotal} vs ${tName} Deception d20=${d20b}${dSign}${decMod}=${decTotal} → ${win ? `INSIGHT — Sneak Attack without advantage vs ${tName} for 1 min` : 'MISS — no benefit'}.`,
    targets: [{
      name: tName,
      tokenId: target.id,
      effect: win
        ? `INSIGHT: Sneak Attack vs this target for 1 min without advantage`
        : `Miss: no benefit`,
      ...(win ? { conditionsApplied: ['insight-marked'] } : {}),
    }],
    notes: [
      `Inquisitive Rogue L3`,
      `Caller Insight: d20=${d20a} ${iSign}${insightMod} = ${insTotal}`,
      `Target Deception: d20=${d20b} ${dSign}${decMod} = ${decTotal}`,
      `Result: ${win ? 'Caller wins' : 'Target wins (tie = target)'}`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🔍 **Insightful Fighting** — ${callerName} Insight d20=${d20a}${iSign}${insightMod}=${insTotal} vs ${tName} Deception d20=${d20b}${dSign}${decMod}=${decTotal} → ${win ? `INSIGHT ON ${tName}: Sneak Attack without advantage for 1 min` : 'MISSED — no Sneak Attack benefit'}`,
    { actionResult: ifBreakdown },
  );
  return true;
}

// ────── Scout — Skirmisher (L3) ─────────────────────
/**
 * Reaction: when an enemy ends its turn within 5 ft, move up to half
 * your speed without provoking opportunity attacks.
 */
async function handleSkirmish(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadRogue(c, 'skirmish');
  if (!loaded) return true;
  const { caller, classLower, callerName, row } = loaded;
  if (!hasFeature(row, /skirmisher/i) && !classLower.includes('scout')) {
    whisperToCaller(c.io, c.ctx, `!skirmish: ${callerName} isn't a Scout.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!skirmish: reaction already spent.');
    return true;
  }
  if (economy) {
    economy.reaction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'reaction',
      economy,
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `👣 **Skirmisher** — ${callerName} uses reaction to move **half speed** without provoking opportunity attacks.`,
  );
  return true;
}

// ────── Soulknife — Psychic Blades + Psionic Power ──
/**
 * Psychic Blades (L3) — summon two psychic daggers. Primary: 1d6
 * psychic (finesse, thrown 60/120). Bonus-action attack after primary
 * deals 1d4 psychic. Scales to d8/d6 at L5, d10/d8 at L11, d12/d10 at L17.
 *
 * Psionic Power — Psionic Talent die: same pool rules as Psi Warrior,
 * but used for Psi-Bolstered Knack + Psychic Whispers.
 *   !psyblade <target> [bonus]  — primary or bonus attack
 *   !psiknife status|reset       — show pool
 *   !psiknack                     — spend 1 die to reroll skill
 */
function psychicDieSize(level: number): { primary: 6 | 8 | 10 | 12; offhand: 4 | 6 | 8 | 10 } {
  if (level >= 17) return { primary: 12, offhand: 10 };
  if (level >= 11) return { primary: 10, offhand: 8 };
  if (level >= 5) return { primary: 8, offhand: 6 };
  return { primary: 6, offhand: 4 };
}

async function handlePsyBlade(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!psyblade: usage `!psyblade <target> [bonus]`');
    return true;
  }
  const isBonus = parts[parts.length - 1].toLowerCase() === 'bonus';
  const targetName = (isBonus ? parts.slice(0, -1) : parts).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!psyblade: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadRogue(c, 'psyblade');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /psychic\s+blades/i) && !classLower.includes('soulknife')) {
    whisperToCaller(c.io, c.ctx, `!psyblade: ${callerName} isn't a Soulknife.`);
    return true;
  }
  if (isBonus) {
    const economy = c.ctx.room.actionEconomies.get(caller.id);
    if (economy?.bonusAction) {
      whisperToCaller(c.io, c.ctx, '!psyblade: bonus action already spent.');
      return true;
    }
    if (economy) {
      economy.bonusAction = true;
      c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
        tokenId: caller.id,
        actionType: 'bonusAction',
        economy,
      });
    }
  }
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const dexMod = abilityMod(scores as Record<string, number>, 'dex');
  const die = psychicDieSize(level);
  const d = isBonus ? die.offhand : die.primary;
  const roll = Math.floor(Math.random() * d) + 1;
  const total = roll + (isBonus ? 0 : dexMod);
  const pbBreakdown: ActionBreakdown = {
    actor: { name: callerName, tokenId: caller.id },
    action: {
      name: `Psychic Blade${isBonus ? ' (bonus)' : ''}`,
      category: 'class-feature',
      icon: '🗡',
      cost: isBonus ? 'Bonus action' : 'Action (part of Attack)',
    },
    effect: `1d${d}${isBonus ? '' : `+${dexMod}`} = **${total} psychic** damage (finesse, thrown 60/120).`,
    targets: [{
      name: target.name,
      tokenId: target.id,
      effect: `${total} psychic damage`,
      damage: { amount: total, damageType: 'psychic' },
    }],
    notes: [
      `Soulknife Rogue L${level}`,
      `Die: ${isBonus ? `offhand d${d}` : `primary d${d}`}`,
      `Roll: 1d${d} = ${roll}${isBonus ? '' : ` + DEX (${dexMod})`} = ${total}`,
      `Scaling: L3 d6/d4, L5 d8/d6, L11 d10/d8, L17 d12/d10`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🗡 **Psychic Blade${isBonus ? ' (bonus)' : ''}** — ${callerName} → ${target.name}: 1d${d}${isBonus ? '' : `+${dexMod}`} = **${total} psychic** (finesse, thrown 60/120).`,
    { actionResult: pbBreakdown },
  );
  return true;
}

async function handlePsiKnife(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadRogue(c, 'psiknife');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /psionic\s+power/i) && !classLower.includes('soulknife')) {
    whisperToCaller(c.io, c.ctx, `!psiknife: ${callerName} isn't a Soulknife.`);
    return true;
  }
  const sub = c.rest.trim().toLowerCase() || 'status';
  const prof = Number(row?.proficiency_bonus) || 2;
  const maxDice = prof * 2;
  let pools = c.ctx.room.pointPools.get(caller.characterId!);
  if (!pools) {
    pools = new Map();
    c.ctx.room.pointPools.set(caller.characterId!, pools);
  }
  let pool_ = pools.get('psi');
  if (!pool_) {
    pool_ = { max: maxDice, remaining: maxDice };
    pools.set('psi', pool_);
  }
  if (pool_.max !== maxDice) {
    pool_.max = maxDice;
    pool_.remaining = Math.min(pool_.remaining, maxDice);
  }
  const die = psychicDieSize(level).primary;
  if (sub === 'reset' || sub === 'refresh') {
    pool_.remaining = pool_.max;
    broadcastSystem(c.io, c.ctx, `🧠 ${callerName} regains Psionic Power — d${die} pool refreshed to ${pool_.max}.`);
    return true;
  }
  whisperToCaller(c.io, c.ctx, `🧠 ${callerName} Psionic Power: **${pool_.remaining}/${pool_.max}** d${die}.`);
  return true;
}

async function handlePsiKnack(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadRogue(c, 'psiknack');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /psi.*bolstered\s+knack/i) && !classLower.includes('soulknife')) {
    whisperToCaller(c.io, c.ctx, `!psiknack: ${callerName} isn't a Soulknife.`);
    return true;
  }
  const pools = c.ctx.room.pointPools.get(caller.characterId!);
  const pool_ = pools?.get('psi');
  if (!pool_ || pool_.remaining < 1) {
    whisperToCaller(c.io, c.ctx, '!psiknack: no psionic dice available.');
    return true;
  }
  pool_.remaining -= 1;
  const die = psychicDieSize(level).primary;
  const roll = Math.floor(Math.random() * die) + 1;
  const pkBreakdown: ActionBreakdown = {
    actor: { name: callerName, tokenId: caller.id },
    action: {
      name: `Psi-Bolstered Knack (+${roll})`,
      category: 'class-feature',
      icon: '🧠',
      cost: '1 psionic die',
    },
    effect: `Roll 1d${die} = **${roll}** and add to a failed ability check using a proficient skill.`,
    notes: [
      `Soulknife Rogue L${level}`,
      `Die: d${die}`,
      `Rolled value: ${roll}`,
      `Pool remaining: ${pool_.remaining}/${pool_.max}`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🧠 **Psi-Bolstered Knack** — ${callerName} rolls 1d${die} = **${roll}** and adds it to a failed ability check (proficient skill). Dice ${pool_.remaining}/${pool_.max}.`,
    { actionResult: pkBreakdown },
  );
  return true;
}

registerChatCommand(['helpat', 'tactics'], handleHelpAt);
registerChatCommand(['insightfight', 'insightfighting'], handleInsightFight);
registerChatCommand(['skirmish', 'skirmisher'], handleSkirmish);
registerChatCommand(['psyblade', 'psychicblade'], handlePsyBlade);
registerChatCommand('psiknife', handlePsiKnife);
registerChatCommand(['psiknack', 'knack'], handlePsiKnack);
