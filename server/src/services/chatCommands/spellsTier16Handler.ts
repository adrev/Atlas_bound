import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import { computeSaveModifiers, type AttackBreakdownModifier, type Token, type SpellCastBreakdown, type SpellTargetOutcome } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Tier 16 — Common damage/control spells:
 *   !fireball, !lightningbolt, !magicmissile, !scorchingray,
 *   !coneofcold, !shatter, !entangle, !web, !moonbeam, !calllightning,
 *   !mistystep
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

function spellcastingAbility(classLower: string): 'int' | 'wis' | 'cha' {
  if (classLower.includes('wizard') || classLower.includes('artificer')) return 'int';
  if (classLower.includes('cleric') || classLower.includes('druid') || classLower.includes('ranger')) return 'wis';
  if (classLower.includes('bard') || classLower.includes('sorcerer') || classLower.includes('warlock') || classLower.includes('paladin')) return 'cha';
  if (classLower.includes('monk')) return 'wis';
  if (classLower.includes('fighter') || classLower.includes('rogue')) return 'int';
  return 'cha';
}

interface CasterStats {
  caller: Token;
  callerName: string;
  classLower: string;
  spellMod: number;
  spellSaveDc: number;
  spellAttackBonus: number;
}

async function loadCaster(c: ChatCommandContext, cmd: string): Promise<CasterStats | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, name, ability_scores, proficiency_bonus, spell_save_dc, spell_attack_bonus FROM characters WHERE id = $1',
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
    callerName: (row?.name as string) || caller.name,
    classLower,
    spellMod: mod,
    spellSaveDc,
    spellAttackBonus,
  };
}

async function loadTargetSaveMod(
  target: Token,
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
): Promise<{ mod: number; displayName: string; race: string | null }> {
  if (!target.characterId) return { mod: 0, displayName: target.name, race: null };
  try {
    const { rows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus, name, race FROM characters WHERE id = $1',
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
    return { mod, displayName: (row?.name as string) || target.name, race: (row?.race as string) ?? null };
  } catch {
    return { mod: 0, displayName: target.name, race: null };
  }
}

function parseSlotLevel(parts: string[], fallback: number, min = 1, max = 9): number {
  const first = parseInt(parts[0], 10);
  if (Number.isFinite(first) && first >= min && first <= max) return first;
  return fallback;
}

function splitSlotAndTargets(
  parts: string[],
  defaultSlot: number,
  minSlot: number,
): { slot: number; targets: string[] } {
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slot = lastIsNum ? parseSlotLevel([parts[parts.length - 1]], defaultSlot, minSlot) : defaultSlot;
  const targets = lastIsNum ? parts.slice(0, -1) : parts;
  return { slot, targets };
}

function roll(diceCount: number, sides: number): { rolls: number[]; sum: number } {
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < diceCount; i++) {
    const r = Math.floor(Math.random() * sides) + 1;
    rolls.push(r);
    sum += r;
  }
  return { rolls, sum };
}

interface RolledSave {
  d20: number;
  d20Rolls?: number[];
  advantage: 'normal' | 'advantage' | 'disadvantage';
  modifiers: AttackBreakdownModifier[];
  total: number;
  saved: boolean;
  autoFailed?: boolean;
  displayName: string;
  notes: string[];
  rollText: string;
  totalMod: number;
}

async function rollTargetSave(
  c: ChatCommandContext,
  target: Token,
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  dc: number,
  savingAgainst: string | null,
): Promise<RolledSave> {
  const { mod, displayName, race } = await loadTargetSaveMod(target, ability);
  const conditions = (target.conditions as string[]) || [];
  const combatant = c.ctx.room.combatState?.combatants.find((cm) => cm.tokenId === target.id);
  const exhaustion = combatant?.exhaustionLevel ?? 0;
  const mods = computeSaveModifiers(conditions, ability, exhaustion, race, savingAgainst);
  const totalMod = mod + mods.flatModifier;

  let d20 = 1;
  let d20Rolls: number[] | undefined;
  let rollText = 'auto-fail';
  if (!mods.autoFail) {
    if (mods.effectiveAdvantage === 'advantage') {
      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      d20 = Math.max(r1, r2);
      d20Rolls = [r1, r2];
      rollText = `[${r1},${r2}] adv keep ${d20}`;
    } else if (mods.effectiveAdvantage === 'disadvantage') {
      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      d20 = Math.min(r1, r2);
      d20Rolls = [r1, r2];
      rollText = `[${r1},${r2}] disadv keep ${d20}`;
    } else {
      d20 = Math.floor(Math.random() * 20) + 1;
      rollText = `${d20}`;
    }
  }

  const total = mods.autoFail ? 0 : d20 + totalMod;
  const modifiers: AttackBreakdownModifier[] = [];
  if (mod !== 0) {
    modifiers.push({ label: `${ability.toUpperCase()} save mod`, value: mod, source: 'ability' });
  }
  if (mods.flatModifier !== 0) {
    modifiers.push({
      label: mods.flatModifier > 0 ? 'Cover / condition' : 'Slow / condition',
      value: mods.flatModifier,
      source: 'condition',
    });
  }

  return {
    d20,
    d20Rolls,
    advantage: mods.effectiveAdvantage,
    modifiers,
    total,
    saved: !mods.autoFail && total >= dc,
    autoFailed: mods.autoFail || undefined,
    displayName,
    notes: mods.notes,
    rollText,
    totalMod,
  };
}

function formatSaveTotal(save: RolledSave): string {
  if (save.autoFailed) return 'auto-fail';
  const sign = save.totalMod >= 0 ? '+' : '';
  return `d20=${save.rollText}${sign}${save.totalMod}=${save.total}`;
}

// Generic save-for-half AoE handler. Builds a full SpellCastBreakdown
// alongside the plain text so chat renders a SpellCastCard with
// per-target save + damage rows, matching the client-resolver path.
async function aoeSaveForHalf(
  c: ChatCommandContext,
  cmd: string,
  spellName: string,
  icon: string,
  shape: string,
  dice: number,
  die: number,
  dmgType: string,
  save: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  targets: string[],
  dc: number,
  callerName: string,
  onFail?: (target: Token) => Promise<void>,
  opts?: { level?: number; casterTokenId?: string },
): Promise<void> {
  const lines: string[] = [];
  lines.push(`${icon} **${spellName}** (${shape}, ${save.toUpperCase()} DC ${dc}) — ${callerName}:`);
  const spellOutcomes: SpellTargetOutcome[] = [];
  for (const name of targets) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const { rolls, sum } = roll(dice, die);
    const saveResult = await rollTargetSave(c, target, save, dc, dmgType || spellName);
    const dmg = saveResult.saved ? Math.floor(sum / 2) : sum;
    const noteLabel = saveResult.notes.length > 0 ? ` [${saveResult.notes.join(', ')}]` : '';
    lines.push(`  • ${saveResult.displayName}: ${save.toUpperCase()} ${formatSaveTotal(saveResult)} → ${saveResult.saved ? 'SAVED' : 'FAILED'}, **${dmg} ${dmgType}** [${rolls.join(',')}]${noteLabel}`);
    if (!saveResult.saved && onFail) await onFail(target);

    spellOutcomes.push({
      name: saveResult.displayName,
      tokenId: target.id,
      kind: 'save',
      save: {
        d20: saveResult.d20,
        d20Rolls: saveResult.d20Rolls,
        advantage: saveResult.advantage,
        ability: save,
        modifiers: saveResult.modifiers,
        total: saveResult.total,
        dc,
        saved: saveResult.saved,
        autoFailed: saveResult.autoFailed,
      },
      damage: {
        dice: `${dice}d${die}`,
        diceRolls: rolls,
        mainRoll: sum,
        bonuses: [],
        halfDamage: saveResult.saved || undefined,
        finalDamage: dmg,
        targetHpBefore: 0,
        targetHpAfter: 0,
      },
      notes: saveResult.notes.length > 0 ? saveResult.notes : undefined,
    });
  }

  const level = opts?.level ?? 0;
  const breakdown: SpellCastBreakdown = {
    caster: { name: callerName, tokenId: opts?.casterTokenId },
    spell: {
      name: spellName,
      level,
      kind: 'save',
      damageType: dmgType,
      saveAbility: save,
      saveDc: dc,
      halfOnSave: true,
    },
    notes: [shape],
    targets: spellOutcomes,
  };

  broadcastSystem(c.io, c.ctx, lines.join('\n'), { spellResult: breakdown });
}

// ────── Fireball ────────────────────────────────────
async function handleFireball(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!fireball: usage `!fireball <t1> [t2 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'fireball');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 3, 3);
  const dice = 8 + Math.max(0, slot - 3);
  await aoeSaveForHalf(c, 'fireball', `Fireball (L${slot})`, '🔥', '20-ft radius',
    dice, 6, 'fire', 'dex', targets, loaded.spellSaveDc, loaded.callerName,
    undefined, { level: slot, casterTokenId: loaded.caller?.id });
  return true;
}

// ────── Lightning Bolt ──────────────────────────────
async function handleLightningBolt(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!lightningbolt: usage `!lightningbolt <t1> [t2 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'lightningbolt');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 3, 3);
  const dice = 8 + Math.max(0, slot - 3);
  await aoeSaveForHalf(c, 'lightningbolt', `Lightning Bolt (L${slot})`, '⚡', '100-ft line',
    dice, 6, 'lightning', 'dex', targets, loaded.spellSaveDc, loaded.callerName,
    undefined, { level: slot, casterTokenId: loaded.caller?.id });
  return true;
}

// ────── Magic Missile ───────────────────────────────
async function handleMagicMissile(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!magicmissile: usage `!magicmissile <t1> [t2 t3 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'magicmissile');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 1, 1);
  const darts = 3 + Math.max(0, slot - 1);
  // Targets repeated round-robin if fewer names than darts.
  const lines: string[] = [];
  lines.push(`🌟 **Magic Missile** (L${slot}, ${darts} darts, auto-hit, force) — ${loaded.callerName}:`);
  const totals: Record<string, { sum: number; rolls: number[] }> = {};
  for (let i = 0; i < darts; i++) {
    const targetName = targets[i % targets.length];
    const r = Math.floor(Math.random() * 4) + 1 + 1; // 1d4+1
    const rawD4 = r - 1;
    if (!totals[targetName]) totals[targetName] = { sum: 0, rolls: [] };
    totals[targetName].sum += r;
    totals[targetName].rolls.push(rawD4);
  }
  const mmOutcomes: SpellTargetOutcome[] = [];
  for (const [name, data] of Object.entries(totals)) {
    const target = resolveTargetByName(c.ctx, name);
    const count = data.rolls.length;
    lines.push(`  • ${target?.name ?? name}: ${count}× (1d4+1) [${data.rolls.map((r) => `${r}+1`).join(', ')}] = **${data.sum} force**`);
    mmOutcomes.push({
      name: target?.name ?? name,
      tokenId: target?.id,
      kind: 'damage-flat',
      damage: {
        dice: `${count}× 1d4+1`,
        diceRolls: data.rolls,
        mainRoll: data.sum,
        bonuses: [],
        finalDamage: data.sum,
        targetHpBefore: 0,
        targetHpAfter: 0,
      },
      notes: [`${count} dart${count !== 1 ? 's' : ''} auto-hit`],
    });
  }
  const mmBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: {
      name: `Magic Missile (L${slot})`,
      level: slot,
      kind: 'auto-damage',
      damageType: 'force',
    },
    notes: [`${darts} darts, auto-hit`],
    targets: mmOutcomes,
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { spellResult: mmBreakdown });
  return true;
}

// ────── Scorching Ray ───────────────────────────────
async function handleScorchingRay(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!scorchingray: usage `!scorchingray <t1> [t2 t3] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'scorchingray');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 2, 2);
  const rays = 3 + Math.max(0, slot - 2);
  const lines: string[] = [];
  lines.push(`🔥 **Scorching Ray** (L${slot}, ${rays} rays, ranged spell atk, fire) — ${loaded.callerName}:`);
  const rayOutcomes: SpellTargetOutcome[] = [];
  for (let i = 0; i < rays; i++) {
    const name = targets[i % targets.length];
    const target = resolveTargetByName(c.ctx, name);
    const d20 = Math.floor(Math.random() * 20) + 1;
    const atk = d20 + loaded.spellAttackBonus;
    const { rolls, sum } = roll(2, 6);
    const sign = loaded.spellAttackBonus >= 0 ? '+' : '';
    lines.push(`  • Ray ${i + 1} → ${target?.name ?? name}: atk d20=${d20}${sign}${loaded.spellAttackBonus}=${atk}, 2d6 [${rolls.join(',')}] = **${sum} fire** on hit`);
    rayOutcomes.push({
      name: `Ray ${i + 1} \u2192 ${target?.name ?? name}`,
      tokenId: target?.id,
      kind: 'attack',
      attack: {
        d20,
        advantage: 'normal',
        modifiers: loaded.spellAttackBonus !== 0
          ? [{ label: 'Spell attack bonus', value: loaded.spellAttackBonus, source: 'other' }]
          : [],
        total: atk,
        targetAc: 0,
        hitResult: d20 === 20 ? 'crit' : d20 === 1 ? 'fumble' : 'hit',
      },
      damage: {
        dice: '2d6',
        diceRolls: rolls,
        mainRoll: sum,
        bonuses: [],
        finalDamage: sum,
        targetHpBefore: 0,
        targetHpAfter: 0,
      },
      notes: ['DM adjudicates hit vs AC'],
    });
  }
  const srBreakdown: SpellCastBreakdown = {
    caster: { name: loaded.callerName, tokenId: loaded.caller.id },
    spell: {
      name: `Scorching Ray (L${slot})`,
      level: slot,
      kind: 'attack',
      damageType: 'fire',
      spellAttackBonus: loaded.spellAttackBonus,
    },
    notes: [`${rays} rays, distribute among targets`],
    targets: rayOutcomes,
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { spellResult: srBreakdown });
  return true;
}

// ────── Cone of Cold ────────────────────────────────
async function handleConeOfCold(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!coneofcold: usage `!coneofcold <t1> [t2 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'coneofcold');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 5, 5);
  const dice = 8 + Math.max(0, slot - 5);
  await aoeSaveForHalf(c, 'coneofcold', `Cone of Cold (L${slot})`, '❄', '60-ft cone',
    dice, 8, 'cold', 'con', targets, loaded.spellSaveDc, loaded.callerName,
    undefined, { level: slot, casterTokenId: loaded.caller.id });
  return true;
}

// ────── Shatter ─────────────────────────────────────
async function handleShatter(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!shatter: usage `!shatter <t1> [t2 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'shatter');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 2, 2);
  const dice = 3 + Math.max(0, slot - 2);
  await aoeSaveForHalf(c, 'shatter', `Shatter (L${slot})`, '💢', '10-ft radius',
    dice, 8, 'thunder', 'con', targets, loaded.spellSaveDc, loaded.callerName,
    undefined, { level: slot, casterTokenId: loaded.caller.id });
  return true;
}

// ────── Entangle ────────────────────────────────────
async function handleEntangle(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!entangle: usage `!entangle <t1> [t2 …]`');
    return true;
  }
  const loaded = await loadCaster(c, 'entangle');
  if (!loaded) return true;
  const { callerName, caller, spellSaveDc } = loaded;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const lines: string[] = [];
  lines.push(`🌿 **Entangle** (20-ft square, STR DC ${spellSaveDc}, concentration 1 min) — ${callerName}:`);
  const entangleOutcomes: SpellTargetOutcome[] = [];
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const saveResult = await rollTargetSave(c, target, 'str', spellSaveDc, 'restrained');
    if (!saveResult.saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'restrained',
        source: `${callerName} (Entangle)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 10,
        saveAtEndOfTurn: { ability: 'str', dc: spellSaveDc },
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
    const noteLabel = saveResult.notes.length > 0 ? ` [${saveResult.notes.join(', ')}]` : '';
    lines.push(`  • ${saveResult.displayName}: STR ${formatSaveTotal(saveResult)} → ${saveResult.saved ? 'SAVED' : 'RESTRAINED (save at end of turn)'}${noteLabel}`);
    entangleOutcomes.push({
      name: saveResult.displayName, tokenId: target.id, kind: 'save',
      save: {
        d20: saveResult.d20,
        d20Rolls: saveResult.d20Rolls,
        advantage: saveResult.advantage,
        ability: 'str',
        modifiers: saveResult.modifiers,
        total: saveResult.total,
        dc: spellSaveDc,
        saved: saveResult.saved,
        autoFailed: saveResult.autoFailed,
      },
      conditionsApplied: saveResult.saved ? undefined : ['restrained'],
      notes: saveResult.notes.length > 0 ? saveResult.notes : undefined,
    });
  }
  const entangleBreakdown: SpellCastBreakdown = {
    caster: { name: callerName, tokenId: caller.id },
    spell: {
      name: 'Entangle', level: 1, kind: 'save',
      saveAbility: 'str', saveDc: spellSaveDc,
    },
    notes: ['20-ft square, concentration 1 min, save at end of each turn'],
    targets: entangleOutcomes,
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { spellResult: entangleBreakdown });
  return true;
}

// ────── Web ─────────────────────────────────────────
async function handleWeb(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!web: usage `!web <t1> [t2 …]`');
    return true;
  }
  const loaded = await loadCaster(c, 'web');
  if (!loaded) return true;
  const { callerName, caller, spellSaveDc } = loaded;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const lines: string[] = [];
  lines.push(`🕸 **Web** (20-ft cube, DEX DC ${spellSaveDc}, concentration 1 hr) — ${callerName}:`);
  const webOutcomes: SpellTargetOutcome[] = [];
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    const saveResult = await rollTargetSave(c, target, 'dex', spellSaveDc, 'restrained');
    if (!saveResult.saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'restrained',
        source: `${callerName} (Web)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 600,
        saveAtEndOfTurn: { ability: 'str', dc: spellSaveDc },
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
    const noteLabel = saveResult.notes.length > 0 ? ` [${saveResult.notes.join(', ')}]` : '';
    lines.push(`  • ${saveResult.displayName}: DEX ${formatSaveTotal(saveResult)} → ${saveResult.saved ? 'SAVED' : 'RESTRAINED (STR save at end of turn)'}${noteLabel}`);
    webOutcomes.push({
      name: saveResult.displayName, tokenId: target.id, kind: 'save',
      save: {
        d20: saveResult.d20,
        d20Rolls: saveResult.d20Rolls,
        advantage: saveResult.advantage,
        ability: 'dex',
        modifiers: saveResult.modifiers,
        total: saveResult.total,
        dc: spellSaveDc,
        saved: saveResult.saved,
        autoFailed: saveResult.autoFailed,
      },
      conditionsApplied: saveResult.saved ? undefined : ['restrained'],
      notes: saveResult.notes.length > 0 ? saveResult.notes : undefined,
    });
  }
  const webBreakdown: SpellCastBreakdown = {
    caster: { name: callerName, tokenId: caller.id },
    spell: { name: 'Web', level: 2, kind: 'save', saveAbility: 'dex', saveDc: spellSaveDc },
    notes: ['20-ft cube, concentration 1 hr, STR save at end of each turn'],
    targets: webOutcomes,
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { spellResult: webBreakdown });
  return true;
}

// ────── Moonbeam ────────────────────────────────────
async function handleMoonbeam(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!moonbeam: usage `!moonbeam <t1> [t2 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'moonbeam');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 2, 2);
  const dice = 2 + Math.max(0, slot - 2);
  await aoeSaveForHalf(c, 'moonbeam', `Moonbeam (L${slot})`, '🌙', '5-ft radius cylinder',
    dice, 10, 'radiant', 'con', targets, loaded.spellSaveDc, loaded.callerName,
    undefined, { level: slot, casterTokenId: loaded.caller.id });
  return true;
}

// ────── Call Lightning ──────────────────────────────
async function handleCallLightning(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!calllightning: usage `!calllightning <t1> [t2 …] [slot]`');
    return true;
  }
  const loaded = await loadCaster(c, 'calllightning');
  if (!loaded) return true;
  const { slot, targets } = splitSlotAndTargets(parts, 3, 3);
  const dice = 3 + Math.max(0, slot - 3);
  await aoeSaveForHalf(c, 'calllightning', `Call Lightning (L${slot})`, '⚡', '5-ft cylinder, 100 ft up',
    dice, 10, 'lightning', 'dex', targets, loaded.spellSaveDc, loaded.callerName,
    undefined, { level: slot, casterTokenId: loaded.caller.id });
  return true;
}

// ────── Misty Step ──────────────────────────────────
async function handleMistyStep(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaster(c, 'mistystep');
  if (!loaded) return true;
  const { caller, callerName } = loaded;
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!mistystep: bonus action already spent.');
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
  const msBreakdown: SpellCastBreakdown = {
    caster: { name: callerName, tokenId: caller.id },
    spell: { name: 'Misty Step', level: 2, kind: 'utility' },
    notes: ['Teleport up to 30 ft to unoccupied space in sight (bonus action)'],
    targets: [],
  };
  broadcastSystem(
    c.io, c.ctx,
    `💨 **Misty Step** (L2, bonus action) — ${callerName} teleports up to **30 ft** to an unoccupied space they can see.`,
    { spellResult: msBreakdown },
  );
  return true;
}

registerChatCommand(['fireball', 'fb'], handleFireball);
registerChatCommand(['lightningbolt', 'lbolt'], handleLightningBolt);
registerChatCommand(['magicmissile', 'mm'], handleMagicMissile);
registerChatCommand(['scorchingray', 'ray'], handleScorchingRay);
registerChatCommand(['coneofcold', 'cc'], handleConeOfCold);
registerChatCommand(['shatter'], handleShatter);
registerChatCommand(['entangle'], handleEntangle);
registerChatCommand(['web'], handleWeb);
registerChatCommand(['moonbeam'], handleMoonbeam);
registerChatCommand(['calllightning', 'cl'], handleCallLightning);
registerChatCommand(['mistystep', 'ms'], handleMistyStep);
