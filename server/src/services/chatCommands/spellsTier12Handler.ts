import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token, SpellCastBreakdown, SpellTargetOutcome } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Tier 12 — Common spell handlers used every session:
 *   Healing: healingword, curewounds, masshealingword
 *   Damage:  guidingbolt, thunderwave
 *   Concentration riders: spiritualweapon, spiritguardians
 *   Control: command, sanctuary, banishment, silverybarbs
 *   Counter: counterspell, dispelmagic
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

function abilityMod(scores: Record<string, number> | undefined, ability: string): number {
  const raw = (scores ?? {})[ability] ?? 10;
  return Math.floor((raw - 10) / 2);
}

/**
 * Pick the spellcasting ability for a class string. Multiclass
 * ambiguity is resolved by precedence order matching typical D&D
 * builds (pure casters before half/third casters).
 */
function spellcastingAbility(classLower: string): 'int' | 'wis' | 'cha' {
  if (classLower.includes('wizard')) return 'int';
  if (classLower.includes('cleric') || classLower.includes('druid') || classLower.includes('ranger')) return 'wis';
  if (classLower.includes('bard') || classLower.includes('sorcerer') || classLower.includes('warlock') || classLower.includes('paladin')) return 'cha';
  if (classLower.includes('monk')) return 'wis';
  if (classLower.includes('artificer')) return 'int';
  // Fighter Eldritch Knight + Rogue Arcane Trickster use INT.
  if (classLower.includes('fighter') || classLower.includes('rogue')) return 'int';
  return 'cha';
}

interface CasterStats {
  callerName: string;
  classLower: string;
  spellMod: number;
  spellSaveDc: number;
  spellAttackBonus: number;
  row: Record<string, unknown> | undefined;
}

async function loadCaster(c: ChatCommandContext, cmd: string): Promise<{ caller: Token; stats: CasterStats } | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, ability_scores, proficiency_bonus, spell_save_dc, spell_attack_bonus FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const ability = spellcastingAbility(classLower);
  const prof = Number(row?.proficiency_bonus) || 2;
  const mod = abilityMod(scores as Record<string, number>, ability);
  const dcFromRow = Number(row?.spell_save_dc);
  const atkFromRow = Number(row?.spell_attack_bonus);
  const spellSaveDc = Number.isFinite(dcFromRow) && dcFromRow > 0 ? dcFromRow : 8 + prof + mod;
  const spellAttackBonus = Number.isFinite(atkFromRow) && atkFromRow !== 0 ? atkFromRow : prof + mod;
  return {
    caller,
    stats: {
      callerName: (row?.name as string) || caller.name,
      classLower,
      spellMod: mod,
      spellSaveDc,
      spellAttackBonus,
      row,
    },
  };
}

async function loadTargetSaveMod(
  target: Token,
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
): Promise<{ mod: number; displayName: string }> {
  if (!target.characterId) return { mod: 0, displayName: target.name };
  try {
    const { rows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = $1',
      [target.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const scores = typeof row?.ability_scores === 'string'
      ? JSON.parse(row.ability_scores as string)
      : (row?.ability_scores ?? {});
    const prof = Number(row?.proficiency_bonus) || 2;
    const saves = typeof row?.saving_throws === 'string'
      ? JSON.parse(row.saving_throws as string)
      : (row?.saving_throws ?? []);
    const mod = abilityMod(scores as Record<string, number>, ability) +
      (Array.isArray(saves) && saves.includes(ability) ? prof : 0);
    return { mod, displayName: (row?.name as string) || target.name };
  } catch {
    return { mod: 0, displayName: target.name };
  }
}

async function applyHealToToken(
  c: ChatCommandContext, target: Token, amount: number,
): Promise<{ hpBefore: number; newHp: number; maxHp: number }> {
  const combat = c.ctx.room.combatState;
  const combatant = combat?.combatants.find((x) => x.tokenId === target.id);
  if (combatant) {
    const hpBefore = combatant.hp;
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + amount);
    if (combatant.characterId) {
      await pool.query(
        'UPDATE characters SET hit_points = $1 WHERE id = $2',
        [combatant.hp, combatant.characterId],
      ).catch((e) => console.warn('[spell heal] hp write failed:', e));
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: combatant.characterId,
        changes: { hitPoints: combatant.hp },
      });
    }
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: target.id,
      hp: combatant.hp,
      tempHp: combatant.tempHp,
      change: amount,
      type: 'heal',
    });
    return { hpBefore, newHp: combatant.hp, maxHp: combatant.maxHp };
  }
  if (target.characterId) {
    const { rows } = await pool.query(
      'SELECT hit_points, max_hit_points FROM characters WHERE id = $1',
      [target.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const curHp = Number(row?.hit_points) || 0;
    const maxHp = Number(row?.max_hit_points) || 0;
    const newHp = Math.min(maxHp, curHp + amount);
    await pool.query(
      'UPDATE characters SET hit_points = $1 WHERE id = $2',
      [newHp, target.characterId],
    ).catch((e) => console.warn('[spell heal] hp write failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { hitPoints: newHp },
    });
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: target.id,
      hp: newHp,
      tempHp: 0,
      change: amount,
      type: 'heal',
    });
    return { hpBefore: curHp, newHp, maxHp };
  }
  return { hpBefore: 0, newHp: 0, maxHp: 0 };
}

/**
 * Build a SpellCastBreakdown for a heal-only spell cast. The caller
 * supplies per-target heal dice/rolls/mainRoll + HP before/after
 * captured by applyHealToToken. Single-target spells pass one entry
 * in `outcomes`; Mass Healing Word passes one per target.
 */
function buildHealBreakdown(
  spellName: string,
  level: number,
  callerName: string,
  casterTokenId: string,
  outcomes: SpellTargetOutcome[],
): SpellCastBreakdown {
  return {
    caster: { name: callerName, tokenId: casterTokenId },
    spell: { name: spellName, level, kind: 'heal' },
    notes: [],
    targets: outcomes,
  };
}

function parseSlotLevel(parts: string[], fallback: number, min = 1, max = 9): number {
  const first = parseInt(parts[0], 10);
  if (Number.isFinite(first) && first >= min && first <= max) return first;
  return fallback;
}

// ────── Healing Word ────────────────────────────────
/**
 *   !healingword <target> [slot-level]
 *
 * 1d4 + spellMod at level 1; +1d4 per slot level above 1st. Bonus
 * action, 60 ft.
 */
async function handleHealingWord(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!healingword: usage `!healingword <target> [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slotLvl = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 1) : 1;
  const targetName = (lastIsNum ? parts.slice(0, -1) : parts).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!healingword: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'healingword');
  if (!loaded) return true;
  const { caller, stats } = loaded;

  // Burn bonus action.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!healingword: bonus action already spent.');
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
  // Roll 1d4/slot level.
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < slotLvl; i++) {
    const r = Math.floor(Math.random() * 4) + 1;
    rolls.push(r);
    total += r;
  }
  total += stats.spellMod;
  const { hpBefore, newHp, maxHp } = await applyHealToToken(c, target, total);
  const hwBreakdown = buildHealBreakdown(
    `Healing Word (L${slotLvl})`, slotLvl,
    stats.callerName, caller.id,
    [{
      name: target.name, tokenId: target.id, kind: 'heal',
      healing: {
        dice: `${slotLvl}d4+${stats.spellMod}`,
        diceRolls: rolls,
        mainRoll: total,
        targetHpBefore: hpBefore,
        targetHpAfter: newHp,
      },
    }],
  );
  broadcastSystem(
    c.io, c.ctx,
    `💚 **Healing Word** (L${slotLvl}, bonus action, 60 ft) — ${stats.callerName} → ${target.name}: ${slotLvl}d4+${stats.spellMod} [${rolls.join(',')}]+${stats.spellMod} = **${total}**${maxHp ? ` (${newHp}/${maxHp})` : ''}.`,
    { spellResult: hwBreakdown },
  );
  return true;
}

// ────── Cure Wounds ─────────────────────────────────
/**
 *   !curewounds <target> [slot-level]
 *
 * 1d8 + spellMod; +1d8 per slot above 1st. Action, touch.
 */
async function handleCureWounds(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!curewounds: usage `!curewounds <target> [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slotLvl = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 1) : 1;
  const targetName = (lastIsNum ? parts.slice(0, -1) : parts).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!curewounds: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'curewounds');
  if (!loaded) return true;
  const { stats } = loaded;
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < slotLvl; i++) {
    const r = Math.floor(Math.random() * 8) + 1;
    rolls.push(r);
    total += r;
  }
  total += stats.spellMod;
  const { hpBefore, newHp, maxHp } = await applyHealToToken(c, target, total);
  const cwBreakdown = buildHealBreakdown(
    `Cure Wounds (L${slotLvl})`, slotLvl,
    stats.callerName, loaded.caller.id,
    [{
      name: target.name, tokenId: target.id, kind: 'heal',
      healing: {
        dice: `${slotLvl}d8+${stats.spellMod}`,
        diceRolls: rolls,
        mainRoll: total,
        targetHpBefore: hpBefore,
        targetHpAfter: newHp,
      },
    }],
  );
  broadcastSystem(
    c.io, c.ctx,
    `💚 **Cure Wounds** (L${slotLvl}, action, touch) — ${stats.callerName} → ${target.name}: ${slotLvl}d8+${stats.spellMod} [${rolls.join(',')}]+${stats.spellMod} = **${total}**${maxHp ? ` (${newHp}/${maxHp})` : ''}.`,
    { spellResult: cwBreakdown },
  );
  return true;
}

// ────── Mass Healing Word ────────────────────────────
/**
 *   !masshealingword <t1> [t2 …] [slot-level]
 *
 * 1d4+mod to up to 6 creatures within 60 ft, +1d4 per slot above 3rd.
 * Bonus action.
 */
async function handleMassHealingWord(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!masshealingword: usage `!masshealingword <t1> [t2 …] [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const castSlot = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 3, 3) : 3;
  const targets = lastIsNum ? parts.slice(0, -1) : parts;
  if (targets.length === 0 || targets.length > 6) {
    whisperToCaller(c.io, c.ctx, '!masshealingword: 1-6 targets required.');
    return true;
  }
  const loaded = await loadCaster(c, 'masshealingword');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!masshealingword: bonus action already spent.');
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
  // Dice count: 1d4 at L3, 2 at L4, etc.
  const dice = 1 + Math.max(0, castSlot - 3);
  const lines: string[] = [];
  lines.push(`💚 **Mass Healing Word** (L${castSlot}) — ${stats.callerName} heals up to ${targets.length} within 60 ft:`);
  const mhwOutcomes: SpellTargetOutcome[] = [];
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) {
      lines.push(`  • ${name}: not found`);
      continue;
    }
    const rolls: number[] = [];
    let total = 0;
    for (let i = 0; i < dice; i++) {
      const r = Math.floor(Math.random() * 4) + 1;
      rolls.push(r);
      total += r;
    }
    total += stats.spellMod;
    const { hpBefore, newHp, maxHp } = await applyHealToToken(c, target, total);
    lines.push(`  • ${target.name}: [${rolls.join(',')}]+${stats.spellMod} = **${total}**${maxHp ? ` (${newHp}/${maxHp})` : ''}`);
    mhwOutcomes.push({
      name: target.name, tokenId: target.id, kind: 'heal',
      healing: {
        dice: `${dice}d4+${stats.spellMod}`,
        diceRolls: rolls,
        mainRoll: total,
        targetHpBefore: hpBefore,
        targetHpAfter: newHp,
      },
    });
  }
  const mhwBreakdown = buildHealBreakdown(
    `Mass Healing Word (L${castSlot})`, castSlot,
    stats.callerName, caller.id, mhwOutcomes,
  );
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { spellResult: mhwBreakdown });
  return true;
}

// ────── Guiding Bolt ────────────────────────────────
/**
 *   !guidingbolt <target> [slot-level]
 *
 * Spell attack (ranged 120 ft). On hit: 4d6 radiant + next attack
 * against target has advantage until end of caster's next turn.
 * +1d6 per slot above 1st.
 */
async function handleGuidingBolt(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!guidingbolt: usage `!guidingbolt <target> [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slotLvl = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 1) : 1;
  const targetName = (lastIsNum ? parts.slice(0, -1) : parts).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!guidingbolt: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'guidingbolt');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  // Attack roll.
  const d20 = Math.floor(Math.random() * 20) + 1;
  const atkTotal = d20 + stats.spellAttackBonus;
  // Damage roll (assume hit; DM can overrule).
  const dice = 4 + Math.max(0, slotLvl - 1);
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < dice; i++) {
    const r = Math.floor(Math.random() * 6) + 1;
    rolls.push(r);
    total += r;
  }
  const sign = stats.spellAttackBonus >= 0 ? '+' : '';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'outlined',
    source: `${stats.callerName} (Guiding Bolt)`,
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
    `✨ **Guiding Bolt** (L${slotLvl}) — ${stats.callerName} → ${target.name}: atk d20=${d20}${sign}${stats.spellAttackBonus}=${atkTotal} vs AC. On hit: ${dice}d6 = [${rolls.join(',')}] = **${total} radiant**. Next attack vs ${target.name} has advantage.`,
  );
  return true;
}

// ────── Thunderwave ─────────────────────────────────
/**
 *   !thunderwave <t1> [t2 …] [slot-level]
 *
 * 15-ft cube. CON save DC. 2d8 thunder (half on save) + push 10 ft
 * on fail. +1d8 per slot above 1st.
 */
async function handleThunderwave(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!thunderwave: usage `!thunderwave <t1> [t2 …] [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slotLvl = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 1) : 1;
  const targets = lastIsNum ? parts.slice(0, -1) : parts;
  if (targets.length < 1) {
    whisperToCaller(c.io, c.ctx, '!thunderwave: at least 1 target.');
    return true;
  }
  const loaded = await loadCaster(c, 'thunderwave');
  if (!loaded) return true;
  const { stats } = loaded;
  const dice = 2 + Math.max(0, slotLvl - 1);
  const lines: string[] = [];
  lines.push(`💥 **Thunderwave** (L${slotLvl}, 15-ft cube, CON DC ${stats.spellSaveDc}) — ${stats.callerName}:`);
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) {
      lines.push(`  • ${name}: not found`);
      continue;
    }
    const rolls: number[] = [];
    let raw = 0;
    for (let i = 0; i < dice; i++) {
      const r = Math.floor(Math.random() * 8) + 1;
      rolls.push(r);
      raw += r;
    }
    const { mod, displayName } = await loadTargetSaveMod(target, 'con');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= stats.spellSaveDc;
    const dmg = saved ? Math.floor(raw / 2) : raw;
    const sign = mod >= 0 ? '+' : '';
    const pushText = saved ? 'no push' : 'pushed 10 ft';
    lines.push(`  • ${displayName}: CON d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : 'FAILED'}, ${dmg} thunder [${rolls.join(',')}] (${pushText})`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Spiritual Weapon ────────────────────────────
/**
 *   !spiritualweapon <target> [slot-level]
 *
 * Ranged spell attack (60 ft), 1d8 + spellMod force. Bonus action
 * to cast AND to attack in subsequent turns. Lasts 1 min. At L3+:
 * 2d8; +1d8 per 2 levels above (L5=2d8, L6=3d8, L7-8=3d8, L9=4d8).
 */
async function handleSpiritualWeapon(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!spiritualweapon: usage `!spiritualweapon <target> [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slotLvl = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 2, 2) : 2;
  const targetName = (lastIsNum ? parts.slice(0, -1) : parts).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!spiritualweapon: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'spiritualweapon');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  // Burn bonus action.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!spiritualweapon: bonus action already spent.');
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
  // RAW PHB p.278: damage increases by 1d8 for every TWO slot levels
  // above 2nd. Scaling: L2=1, L3=1, L4=2, L5=2, L6=3, L7=3, L8=4, L9=4.
  const dice = 1 + Math.floor(Math.max(0, slotLvl - 2) / 2);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const atkTotal = d20 + stats.spellAttackBonus;
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < dice; i++) {
    const r = Math.floor(Math.random() * 8) + 1;
    rolls.push(r);
    total += r;
  }
  total += stats.spellMod;
  const sign = stats.spellAttackBonus >= 0 ? '+' : '';
  const isCrit = d20 === 20;
  const isFumble = d20 === 1;
  const swBreakdown: SpellCastBreakdown = {
    caster: { name: stats.callerName, tokenId: caller.id },
    spell: {
      name: `Spiritual Weapon (L${slotLvl})`,
      level: slotLvl,
      kind: 'attack',
      damageType: 'force',
      spellAttackBonus: stats.spellAttackBonus,
    },
    notes: ['Bonus action to cast + attack subsequent turns. Lasts 1 min.'],
    targets: [{
      name: target.name,
      tokenId: target.id,
      kind: 'attack',
      attack: {
        d20,
        advantage: 'normal',
        modifiers: stats.spellAttackBonus !== 0
          ? [{ label: 'Spell attack bonus', value: stats.spellAttackBonus, source: 'other' }]
          : [],
        total: atkTotal,
        targetAc: 0, // unknown server-side
        hitResult: isCrit ? 'crit' : isFumble ? 'fumble' : 'hit',
      },
      damage: {
        dice: `${dice}d8+${stats.spellMod}`,
        diceRolls: rolls,
        mainRoll: total,
        bonuses: [],
        finalDamage: total,
        targetHpBefore: 0,
        targetHpAfter: 0,
      },
      notes: ['DM adjudicates hit vs AC'],
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `⚔ **Spiritual Weapon** (L${slotLvl}) — ${stats.callerName} → ${target.name}: atk d20=${d20}${sign}${stats.spellAttackBonus}=${atkTotal}. On hit: ${dice}d8+${stats.spellMod} [${rolls.join(',')}]+${stats.spellMod} = **${total} force**. Lasts 1 min (bonus action to move + attack subsequent turns).`,
    { spellResult: swBreakdown },
  );
  return true;
}

// ────── Spirit Guardians ────────────────────────────
/**
 *   !spiritguardians <t1> [t2 …] [slot-level]
 *
 * 15-ft radius around caster, WIS save, 3d8 radiant (half on save),
 * speed halved in the area. Concentration, 10 min. +1d8 per slot
 * above 3rd. Good vs undead/fiends variants not encoded here
 * (class-color tagged).
 */
async function handleSpiritGuardians(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!spiritguardians: usage `!spiritguardians <t1> [t2 …] [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slotLvl = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 3, 3) : 3;
  const targets = lastIsNum ? parts.slice(0, -1) : parts;
  const loaded = await loadCaster(c, 'spiritguardians');
  if (!loaded) return true;
  const { stats } = loaded;
  const dice = 3 + Math.max(0, slotLvl - 3);
  const lines: string[] = [];
  lines.push(`✨ **Spirit Guardians** (L${slotLvl}, 15-ft radius, WIS DC ${stats.spellSaveDc}) — ${stats.callerName} (concentration, 10 min):`);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) {
      lines.push(`  • ${name}: not found`);
      continue;
    }
    const rolls: number[] = [];
    let raw = 0;
    for (let i = 0; i < dice; i++) {
      const r = Math.floor(Math.random() * 8) + 1;
      rolls.push(r);
      raw += r;
    }
    const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
    const d20 = Math.floor(Math.random() * 20) + 1;
    const tot = d20 + mod;
    const saved = tot >= stats.spellSaveDc;
    const dmg = saved ? Math.floor(raw / 2) : raw;
    const sign = mod >= 0 ? '+' : '';
    // Apply slowed pseudo-condition for aura effect (half speed).
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'slowed',
      source: `${stats.callerName} (Spirit Guardians)`,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 1,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
    lines.push(`  • ${displayName}: WIS d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED' : 'FAILED'}, ${dmg} radiant [${rolls.join(',')}]. Speed halved while in area.`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Command ────────────────────────────────────
/**
 *   !command <target> <word>
 *
 * 60 ft, WIS save. On fail the target follows a 1-word command on
 * its next turn. Recognized commands: approach, drop, flee, grovel,
 * halt. We apply a marker condition for bookkeeping.
 */
async function handleCommand(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!command: usage `!command <target> <approach|drop|flee|grovel|halt>`');
    return true;
  }
  const word = parts[parts.length - 1].toLowerCase();
  const valid = ['approach', 'drop', 'flee', 'grovel', 'halt'];
  if (!valid.includes(word)) {
    whisperToCaller(c.io, c.ctx, `!command: word must be one of ${valid.join(', ')}.`);
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!command: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'command');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  const { mod, displayName } = await loadTargetSaveMod(target, 'wis');
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + mod;
  const saved = tot >= stats.spellSaveDc;
  const sign = mod >= 0 ? '+' : '';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  if (!saved) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'commanded',
      source: `${stats.callerName} (Command: ${word})`,
      casterTokenId: caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 1,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `📢 **Command "${word}"** (WIS DC ${stats.spellSaveDc}) — ${stats.callerName} → ${displayName}: d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED — no effect' : `COMPELLED: ${word.toUpperCase()} on next turn`}`,
  );
  return true;
}

// ────── Sanctuary ──────────────────────────────────
/**
 *   !sanctuary <ally>
 *
 * Bonus action. Protect one creature. When a creature targets the
 * warded creature with an attack or harmful spell, attacker makes a
 * WIS save or must target a different creature. Concentration, 1 min.
 *
 * This is a buff on the ally; resolver side checks it when an attack
 * is declared against them.
 */
async function handleSanctuary(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!sanctuary: usage `!sanctuary <ally>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!sanctuary: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'sanctuary');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!sanctuary: bonus action already spent.');
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
    name: 'sanctuary',
    source: `${stats.callerName} (Sanctuary)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🕊 **Sanctuary** — ${stats.callerName} wards ${target.name} (WIS DC ${stats.spellSaveDc}). Attackers must succeed on WIS save or pick a different target. Drops if ${target.name} attacks or casts harmful spell. (Concentration, 1 min)`,
  );
  return true;
}

// ────── Banishment ─────────────────────────────────
/**
 *   !banishment <target> [slot-level]
 *
 * 60 ft. CHA save. On fail the creature is banished to another plane
 * for up to 1 min (concentration). One extra target per slot above 4.
 */
async function handleBanishment(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!banishment: usage `!banishment <target> [slot-level]`');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slotLvl = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], 4, 4) : 4;
  const targetName = (lastIsNum ? parts.slice(0, -1) : parts).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!banishment: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaster(c, 'banishment');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  const { mod, displayName } = await loadTargetSaveMod(target, 'cha');
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + mod;
  const saved = tot >= stats.spellSaveDc;
  const sign = mod >= 0 ? '+' : '';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  if (!saved) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'banished',
      source: `${stats.callerName} (Banishment L${slotLvl})`,
      casterTokenId: caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 10,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🌀 **Banishment** (L${slotLvl}, CHA DC ${stats.spellSaveDc}) — ${stats.callerName} → ${displayName}: d20=${d20}${sign}${mod}=${tot} → ${saved ? 'SAVED — no effect' : 'BANISHED to another plane (concentration, 1 min)'}`,
  );
  return true;
}

// ────── Silvery Barbs (optional) ────────────────────
/**
 *   !silverybarbs <enemy> <ally>
 *
 * Reaction. When a creature within 60 ft succeeds on an attack roll,
 * saving throw, or ability check, force it to reroll (keep new).
 * One creature of your choice within 60 ft gains advantage on its
 * next attack/save/check within 1 min.
 */
async function handleSilveryBarbs(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!silverybarbs: usage `!silverybarbs <enemy> <ally>`');
    return true;
  }
  const enemy = resolveTargetByName(c.ctx, parts[0]);
  const ally = resolveTargetByName(c.ctx, parts.slice(1).join(' '));
  if (!enemy || !ally) {
    whisperToCaller(c.io, c.ctx, '!silverybarbs: both targets must exist.');
    return true;
  }
  const loaded = await loadCaster(c, 'silverybarbs');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  // Burn reaction.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!silverybarbs: reaction already spent.');
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
  // Grant ally an inspired-style advantage badge (reuse).
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, ally.id, {
    name: 'inspired',
    source: `${stats.callerName} (Silvery Barbs)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: ally.id,
    changes: tokenConditionChanges(c.ctx.room, ally.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🎀 **Silvery Barbs** (reaction, 60 ft) — ${stats.callerName} forces ${enemy.name} to reroll its success (keep new, likely worse) AND grants ${ally.name} advantage on its next attack/save/check within 1 min.`,
  );
  return true;
}

// ────── Counterspell ───────────────────────────────
/**
 *   !counterspell <caster> <spell-level> [my-slot-level]
 *
 * Reaction. Automatically counters any spell of L3 or lower. For
 * L4+ spells, make an ability check (d20 + spellcasting mod) vs
 * DC 10 + spell's level. We default my-slot-level to 3.
 */
async function handleCounterspell(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!counterspell: usage `!counterspell <caster> <spell-level> [my-slot-level]`');
    return true;
  }
  const mySlotRaw = parts.length >= 3 ? parts[parts.length - 1] : '3';
  const mySlot = parseSlotLevel([mySlotRaw], 3, 3, 9);
  const spellLvl = parseInt(parts[parts.length - (parts.length >= 3 ? 2 : 1)], 10);
  if (!Number.isFinite(spellLvl) || spellLvl < 0 || spellLvl > 9) {
    whisperToCaller(c.io, c.ctx, '!counterspell: spell-level must be 0-9.');
    return true;
  }
  const casterName = parts.slice(0, parts.length - (parts.length >= 3 ? 2 : 1)).join(' ');
  const loaded = await loadCaster(c, 'counterspell');
  if (!loaded) return true;
  const { caller, stats } = loaded;
  // Burn reaction.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!counterspell: reaction already spent.');
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
  const autoCounter = spellLvl <= mySlot;
  if (autoCounter) {
    broadcastSystem(
      c.io, c.ctx,
      `🚫 **Counterspell** (L${mySlot}) — ${stats.callerName} counters ${casterName}'s L${spellLvl} spell automatically (slot ≥ spell level).`,
    );
    return true;
  }
  // Ability check: d20 + spellMod vs DC 10 + spellLvl.
  const dc = 10 + spellLvl;
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + stats.spellMod;
  const success = tot >= dc;
  const sign = stats.spellMod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `🚫 **Counterspell** (L${mySlot} vs L${spellLvl}) — ${stats.callerName} rolls d20=${d20}${sign}${stats.spellMod}=${tot} vs DC ${dc} → ${success ? 'COUNTERED' : 'FAILS — spell resolves'}`,
  );
  return true;
}

// ────── Dispel Magic ────────────────────────────────
/**
 *   !dispelmagic <target> <effect-level> [my-slot-level]
 *
 * Action. Same mechanics as Counterspell but for an active effect.
 */
async function handleDispelMagic(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!dispelmagic: usage `!dispelmagic <target> <effect-level> [my-slot-level]`');
    return true;
  }
  const mySlotRaw = parts.length >= 3 ? parts[parts.length - 1] : '3';
  const mySlot = parseSlotLevel([mySlotRaw], 3, 3, 9);
  const effLvl = parseInt(parts[parts.length - (parts.length >= 3 ? 2 : 1)], 10);
  if (!Number.isFinite(effLvl) || effLvl < 0 || effLvl > 9) {
    whisperToCaller(c.io, c.ctx, '!dispelmagic: effect-level must be 0-9.');
    return true;
  }
  const targetName = parts.slice(0, parts.length - (parts.length >= 3 ? 2 : 1)).join(' ');
  const loaded = await loadCaster(c, 'dispelmagic');
  if (!loaded) return true;
  const { stats } = loaded;
  const autoDispel = effLvl <= mySlot;
  if (autoDispel) {
    broadcastSystem(
      c.io, c.ctx,
      `🧹 **Dispel Magic** (L${mySlot}) — ${stats.callerName} dispels a L${effLvl} effect on ${targetName} automatically.`,
    );
    return true;
  }
  const dc = 10 + effLvl;
  const d20 = Math.floor(Math.random() * 20) + 1;
  const tot = d20 + stats.spellMod;
  const success = tot >= dc;
  const sign = stats.spellMod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `🧹 **Dispel Magic** (L${mySlot} vs L${effLvl}) — ${stats.callerName} on ${targetName}: d20=${d20}${sign}${stats.spellMod}=${tot} vs DC ${dc} → ${success ? 'DISPELLED' : 'effect persists'}`,
  );
  return true;
}

registerChatCommand(['healingword', 'hw'], handleHealingWord);
registerChatCommand(['curewounds', 'cw'], handleCureWounds);
registerChatCommand(['masshealingword', 'mhw'], handleMassHealingWord);
registerChatCommand(['guidingbolt', 'gb'], handleGuidingBolt);
registerChatCommand(['thunderwave', 'tw'], handleThunderwave);
registerChatCommand(['spiritualweapon', 'sw'], handleSpiritualWeapon);
registerChatCommand(['spiritguardians', 'sg'], handleSpiritGuardians);
registerChatCommand('command', handleCommand);
registerChatCommand('sanctuary', handleSanctuary);
registerChatCommand(['banishment', 'banish'], handleBanishment);
registerChatCommand(['silverybarbs', 'sb'], handleSilveryBarbs);
registerChatCommand(['counterspell', 'cs'], handleCounterspell);
registerChatCommand(['dispelmagic', 'dispel'], handleDispelMagic);
