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
 * Tier 14 — Remaining Fighter subclasses:
 *   Arcane Archer: !arcaneshot (6 options)
 *   Banneret/Purple Dragon Knight: !rallyingcry
 *   Psi Warrior: !psidie (pool), !psistrike, !psifield (protective)
 *   Rune Knight: !giantsmight, !rune (stone/cloud/fire/frost/hill/storm)
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

async function loadFighter(c: ChatCommandContext, cmd: string): Promise<{
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
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: ${caller.name} isn't a Fighter.`);
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

// ────── Arcane Archer — Arcane Shot ───────────────────
/**
 * Six+ options. Each costs 2 per short rest. Most trigger a save
 * tied to INT DC. We support 6 core options.
 */
const ARCANE_SHOT_OPTIONS: Record<string, { save: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha' | 'none'; dice: string; type: string; extra: string }> = {
  banishing: { save: 'cha', dice: '2d6', type: 'force', extra: 'Banished to Feywild until end of your next turn' },
  beguiling: { save: 'wis', dice: '2d6', type: 'psychic', extra: 'Charmed by an ally of your choice (1 min)' },
  bursting: { save: 'dex', dice: '2d6', type: 'force', extra: '2d6 force to all creatures within 10 ft of target' },
  grasping: { save: 'str', dice: '2d6', type: 'poison', extra: 'Speed halved, disadv on STR checks, 2d6 poison on move' },
  piercing: { save: 'dex', dice: '1d6', type: 'piercing', extra: 'Line attack — all in 30-ft line, 1d6 piercing, half on save' },
  seeking: { save: 'none', dice: '2d6', type: 'piercing', extra: 'Auto-hits + 2d6 extra vs a target you know is within range' },
  shadow: { save: 'wis', dice: '2d6', type: 'necrotic', extra: 'Blinded in bright light (until end of your next turn)' },
  slowing: { save: 'dex', dice: '1d6', type: 'piercing', extra: 'Speed reduced by 10 ft until end of your next turn' },
};

async function handleArcaneShot(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, `!arcaneshot: usage \`!arcaneshot <option> <target>\` (${Object.keys(ARCANE_SHOT_OPTIONS).join(', ')})`);
    return true;
  }
  const opt = parts[0].toLowerCase();
  const cfg = ARCANE_SHOT_OPTIONS[opt];
  if (!cfg) {
    whisperToCaller(c.io, c.ctx, `!arcaneshot: unknown option "${opt}".`);
    return true;
  }
  const targetName = parts.slice(1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!arcaneshot: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadFighter(c, 'arcaneshot');
  if (!loaded) return true;
  const { classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /arcane\s+shot/i) && !classLower.includes('arcane archer')) {
    whisperToCaller(c.io, c.ctx, `!arcaneshot: ${callerName} isn't an Arcane Archer.`);
    return true;
  }
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const prof = Number(row?.proficiency_bonus) || 2;
  const dc = 8 + prof + abilityMod(scores as Record<string, number>, 'int');
  // Dice upgrade at L18: 2d6 → 4d6 for base options.
  const extraDamage = level >= 18 ? '+2 dice (L18)' : '';
  broadcastSystem(
    c.io, c.ctx,
    `🏹 **Arcane Shot: ${opt.charAt(0).toUpperCase() + opt.slice(1)}** — ${callerName} → ${target.name}: ${cfg.dice} ${cfg.type}${extraDamage ? ` ${extraDamage}` : ''}${cfg.save !== 'none' ? ` (${cfg.save.toUpperCase()} DC ${dc})` : ''}. ${cfg.extra}`,
  );
  return true;
}

// ────── Banneret/Purple Dragon Knight: Rallying Cry ──
async function handleRallyingCry(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!rally: usage `!rally <t1> [t2 t3]` (up to 3 allies within 60 ft)');
    return true;
  }
  if (parts.length > 3) {
    whisperToCaller(c.io, c.ctx, '!rally: at most 3 targets.');
    return true;
  }
  const loaded = await loadFighter(c, 'rally');
  if (!loaded) return true;
  const { callerName, row, level, classLower } = loaded;
  if (!hasFeature(row, /rallying\s+cry/i) && !classLower.includes('banneret') && !classLower.includes('purple dragon')) {
    whisperToCaller(c.io, c.ctx, `!rally: ${callerName} isn't a Banneret / Purple Dragon Knight.`);
    return true;
  }
  const thpValue = level;
  const lines: string[] = [];
  lines.push(`🎺 **Rallying Cry** — ${callerName} heals via Second Wind (Second Wind self-heal rolled separately); up to 3 allies within 60 ft gain **${thpValue} temp HP** each:`);
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    if (target.characterId) {
      const { rows: trows } = await pool.query('SELECT temp_hit_points FROM characters WHERE id = $1', [target.characterId]);
      const curThp = Number((trows[0] as Record<string, unknown>)?.temp_hit_points) || 0;
      const newThp = Math.max(curThp, thpValue);
      await pool.query('UPDATE characters SET temp_hit_points = $1 WHERE id = $2', [newThp, target.characterId]).catch(() => {});
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: target.characterId,
        changes: { tempHitPoints: newThp },
      });
      lines.push(`  • ${target.name}: ${thpValue} temp HP (now ${newThp}).`);
    } else {
      lines.push(`  • ${target.name}: ${thpValue} temp HP (NPC — manual).`);
    }
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Psi Warrior — Psionic Power dice ──────────────
/**
 * Pool of dice: 2× PB dice, die size d6 at L3, d8 at L5, d10 at L11,
 * d12 at L17. Uses:
 *   Protective Field: reaction, spend 1 die, reduce damage by 1d6+INT
 *   Psionic Strike: after hit, spend 1 die, +1d6+INT force damage
 *
 *   !psidie status | reset
 *   !psistrike <target>
 *   !psifield <ally> <dmg>
 */
function psiDieSize(level: number): 6 | 8 | 10 | 12 {
  if (level >= 17) return 12;
  if (level >= 11) return 10;
  if (level >= 5) return 8;
  return 6;
}

async function handlePsiDie(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadFighter(c, 'psidie');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /psionic\s+power/i) && !classLower.includes('psi warrior')) {
    whisperToCaller(c.io, c.ctx, `!psidie: ${callerName} isn't a Psi Warrior.`);
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
  const dieSize = psiDieSize(level);

  if (sub === 'reset' || sub === 'refresh') {
    pool_.remaining = pool_.max;
    broadcastSystem(c.io, c.ctx, `🧠 ${callerName} regains Psionic Power — d${dieSize} pool refreshed to ${pool_.max}.`);
    return true;
  }
  whisperToCaller(c.io, c.ctx, `🧠 ${callerName} Psionic Power: **${pool_.remaining}/${pool_.max}** d${dieSize}. Reset on short rest.`);
  return true;
}

async function handlePsiStrike(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!psistrike: usage `!psistrike <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!psistrike: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadFighter(c, 'psistrike');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /psionic\s+strike/i) && !classLower.includes('psi warrior')) {
    whisperToCaller(c.io, c.ctx, `!psistrike: ${callerName} isn't a Psi Warrior.`);
    return true;
  }
  const pools = c.ctx.room.pointPools.get(caller.characterId!);
  const pool_ = pools?.get('psi');
  if (!pool_ || pool_.remaining < 1) {
    whisperToCaller(c.io, c.ctx, '!psistrike: no psionic dice available.');
    return true;
  }
  pool_.remaining -= 1;
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const intMod = abilityMod(scores as Record<string, number>, 'int');
  const dieSize = psiDieSize(level);
  const roll = Math.floor(Math.random() * dieSize) + 1;
  const total = roll + intMod;
  broadcastSystem(
    c.io, c.ctx,
    `🧠 **Psionic Strike** — ${callerName} on ${target.name}: 1d${dieSize}+${intMod} = ${roll}+${intMod} = **${total} force** damage. Dice ${pool_.remaining}/${pool_.max}.`,
  );
  return true;
}

async function handlePsiField(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!psifield: usage `!psifield <ally> <incoming-dmg>` (reaction, 30 ft)');
    return true;
  }
  const dmg = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(dmg) || dmg < 0) {
    whisperToCaller(c.io, c.ctx, '!psifield: damage must be a number.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!psifield: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadFighter(c, 'psifield');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /protective\s+field/i) && !classLower.includes('psi warrior')) {
    whisperToCaller(c.io, c.ctx, `!psifield: ${callerName} isn't a Psi Warrior.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!psifield: reaction already spent.');
    return true;
  }
  const pools = c.ctx.room.pointPools.get(caller.characterId!);
  const pool_ = pools?.get('psi');
  if (!pool_ || pool_.remaining < 1) {
    whisperToCaller(c.io, c.ctx, '!psifield: no psionic dice available.');
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
  pool_.remaining -= 1;
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const intMod = abilityMod(scores as Record<string, number>, 'int');
  const dieSize = psiDieSize(level);
  const roll = Math.floor(Math.random() * dieSize) + 1;
  const reduction = roll + intMod;
  const actualReduction = Math.min(reduction, dmg);
  const newDmg = Math.max(0, dmg - reduction);
  // Refund HP if needed.
  if (actualReduction > 0 && target.characterId) {
    const { rows: trows } = await pool.query(
      'SELECT hit_points, max_hit_points FROM characters WHERE id = $1',
      [target.characterId],
    );
    const trow = trows[0] as Record<string, unknown> | undefined;
    const cur = Number(trow?.hit_points) || 0;
    const maxHp = Number(trow?.max_hit_points) || 0;
    const newHp = Math.min(maxHp, cur + actualReduction);
    await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [newHp, target.characterId]).catch(() => {});
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { hitPoints: newHp },
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🧠 **Protective Field** — ${callerName} shields ${target.name}: 1d${dieSize}+${intMod} = **${reduction}** damage reduction (${dmg} → ${newDmg}). Dice ${pool_.remaining}/${pool_.max}.`,
  );
  return true;
}

// ────── Rune Knight — Giant's Might + Runes ────────
/**
 * Giant's Might (L3) — bonus action, become Large + adv on STR checks +
 * adv on STR saves + bonus damage 1d6 (scales).
 *
 * Runes (L3) — carve one of six runes on gear; uses vary per rune.
 */
async function handleGiantsMight(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadFighter(c, 'giantsmight');
  if (!loaded) return true;
  const { caller, classLower, callerName, row, level } = loaded;
  if (!hasFeature(row, /giant'?s\s+might/i) && !classLower.includes('rune knight')) {
    whisperToCaller(c.io, c.ctx, `!giantsmight: ${callerName} isn't a Rune Knight.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!giantsmight: bonus action already spent.');
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
  const bonusDice = level >= 18 ? '1d10' : level >= 10 ? '1d8' : '1d6';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
    name: 'giant-size',
    source: `${callerName} (Giant's Might)`,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: caller.id,
    changes: tokenConditionChanges(c.ctx.room, caller.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `⛰ **Giant's Might** — ${callerName} grows to **Large size**. Advantage on STR checks + STR saves. Weapon attacks deal +${bonusDice} extra damage (1/turn). Duration: 1 min.`,
  );
  return true;
}

const RUNE_EFFECTS: Record<string, string> = {
  cloud: 'Redirect an attack to another creature within 30 ft (reaction).',
  fire: 'Shackle target: STR save or restrained + 2d6 fire/turn (action).',
  frost: 'Reaction: +2 to STR, DEX, CON checks + saves for 10 min.',
  hill: '+2 saves vs becoming poisoned, resist poison damage (passive).',
  stone: 'Darkvision 120 ft, passive Perception +2 (passive).',
  storm: 'See around the future — reaction: force a creature to reroll an attack / save / check.',
};

async function handleRune(c: ChatCommandContext): Promise<boolean> {
  const rune = c.rest.trim().toLowerCase();
  if (!rune || !(rune in RUNE_EFFECTS)) {
    whisperToCaller(c.io, c.ctx, `!rune: usage \`!rune <${Object.keys(RUNE_EFFECTS).join('|')}>\``);
    return true;
  }
  const loaded = await loadFighter(c, 'rune');
  if (!loaded) return true;
  const { classLower, callerName, row } = loaded;
  if (!hasFeature(row, /rune\s+carver|rune\s+knight/i) && !classLower.includes('rune knight')) {
    whisperToCaller(c.io, c.ctx, `!rune: ${callerName} isn't a Rune Knight.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🪨 **${rune.charAt(0).toUpperCase() + rune.slice(1)} Rune** — ${callerName} invokes: ${RUNE_EFFECTS[rune]} (1/short rest per rune).`,
  );
  return true;
}

registerChatCommand(['arcaneshot', 'as'], handleArcaneShot);
registerChatCommand(['rally', 'rallyingcry'], handleRallyingCry);
registerChatCommand('psidie', handlePsiDie);
registerChatCommand(['psistrike', 'pstrike'], handlePsiStrike);
registerChatCommand(['psifield', 'pfield'], handlePsiField);
registerChatCommand(['giantsmight', 'giantmight'], handleGiantsMight);
registerChatCommand('rune', handleRune);
