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
 * Misc class / race features that didn't warrant their own file:
 *   Barbarian Reckless Attack, Half-Orc Relentless Endurance, Wizard
 *   Arcane Recovery, Dragonborn Breath Weapon, Warlock Eldritch Blast
 *   with Agonizing Blast / Repelling Blast invocations, Fighter
 *   Battle Master Superiority Dice + common maneuvers.
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

function rollD6Pool(n: number): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(Math.random() * 6) + 1;
    rolls.push(r);
    total += r;
  }
  return { total, rolls };
}

// ────── !reckless (Barbarian, toggle) ──────────────────────
async function handleReckless(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!reckless: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('barbarian')) {
    whisperToCaller(c.io, c.ctx, `!reckless: ${caller.name} isn't a Barbarian.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  if (lvl < 2) {
    whisperToCaller(c.io, c.ctx, `!reckless: Reckless Attack requires Barbarian level 2.`);
    return true;
  }
  // Toggle — if already reckless, clear. Otherwise apply.
  const already = (caller.conditions as string[]).includes('reckless');
  if (already) {
    ConditionService.removeCondition(c.ctx.room.sessionId, caller.id, 'reckless');
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: caller.id,
      changes: tokenConditionChanges(c.ctx.room, caller.id),
    });
    broadcastSystem(c.io, c.ctx, `😤 ${caller.name} drops Reckless Attack.`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
    name: 'reckless',
    source: `${caller.name} (Reckless Attack)`,
    appliedRound: currentRound,
    // Reckless lasts until your next turn. We put a 1-round expiry
    // so the engine auto-clears at the start of the next turn.
    expiresAfterRound: currentRound,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: caller.id,
    changes: tokenConditionChanges(c.ctx.room, caller.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `😤 ${caller.name} attacks recklessly — advantage on own STR melee attacks, attacks against have advantage until next turn.`,
  );
  return true;
}

// ────── !endurance (Half-Orc Relentless Endurance, auto-1HP) ──
/**
 * When a half-orc drops to 0 HP but not killed outright, they drop
 * to 1 HP instead. 1/long rest. We track usage in a module-level
 * Set keyed on characterId (reset via !endurance reset on long rest
 * or automatically if the DM runs !rest long).
 */
const endUsed = new Set<string>();

async function handleEndurance(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim().toLowerCase();
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!endurance: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT race, name, hit_points, max_hit_points FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const raceLower = String(row?.race || '').toLowerCase();
  if (!raceLower.includes('half-orc') && !raceLower.includes('orc')) {
    whisperToCaller(c.io, c.ctx, `!endurance: ${caller.name} isn't a Half-Orc.`);
    return true;
  }

  if (arg === 'reset') {
    endUsed.delete(caller.characterId);
    broadcastSystem(c.io, c.ctx, `💪 ${caller.name}'s Relentless Endurance refreshed.`);
    return true;
  }
  if (arg === 'status') {
    const used = endUsed.has(caller.characterId);
    whisperToCaller(c.io, c.ctx, `💪 Relentless Endurance: ${used ? 'USED (resets on long rest)' : 'available'}.`);
    return true;
  }

  // Default: use it. Only legal if HP is 0.
  const hp = Number(row?.hit_points) || 0;
  if (hp > 0) {
    whisperToCaller(c.io, c.ctx, `!endurance: only usable when at 0 HP (you're at ${hp}).`);
    return true;
  }
  if (endUsed.has(caller.characterId)) {
    whisperToCaller(c.io, c.ctx, '!endurance: already used this long rest.');
    return true;
  }
  endUsed.add(caller.characterId);
  await pool.query('UPDATE characters SET hit_points = 1 WHERE id = $1', [caller.characterId])
    .catch((e) => console.warn('[!endurance] hp write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { hitPoints: 1 },
  });
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: caller.id,
    hp: 1,
    tempHp: 0,
    change: 1,
    type: 'heal',
  });
  broadcastSystem(
    c.io, c.ctx,
    `💪 **${caller.name} uses Relentless Endurance** — drops to 1 HP instead of 0! (1/long rest.)`,
  );
  return true;
}

// ────── !arcanerecovery (Wizard, short rest) ─────────────
/**
 * Wizard's Arcane Recovery: on a short rest, recover slots of total
 * levels ≤ ⌈wizard level / 2⌉, none of 6th+. The player chooses
 * which slots to refill; we just announce the budget + let the DM /
 * player tick slots manually via the character sheet.
 *
 *   !arcanerecovery
 */
async function handleArcaneRecovery(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!arcanerecovery: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('wizard')) {
    whisperToCaller(c.io, c.ctx, `!arcanerecovery: ${caller.name} isn't a Wizard.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  const budget = Math.ceil(lvl / 2);
  broadcastSystem(
    c.io, c.ctx,
    `📖 ${caller.name} uses Arcane Recovery — recover spell slots totalling up to ${budget} levels (no slot 6+). 1/long rest.`,
  );
  return true;
}

// ────── !breath <damage-dice>/<save-ability>/<dc> <target1> […] ──
/**
 * Dragonborn Breath Weapon. Damage type depends on draconic ancestry
 * (red = fire, gold = fire, blue = lightning, etc.) — the player
 * supplies the dice notation since we don't track ancestry.
 *
 * Shape: 15 ft cone (Str-based saves — STR, CHA, DEX depending on
 * ancestry) OR 5 × 30 ft line (DEX). Target list is DM-supplied.
 *
 *   !breath <dice>/<ability>/<dc> <target1> [target2 …]
 *     e.g. `!breath 2d6/dex/13 goblin orc`   — blue dragonborn DEX save
 */
async function handleBreath(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(
      c.io, c.ctx,
      '!breath: usage `!breath <dice>/<ability>/<dc> <target1> [target2 …]`\n  e.g. `!breath 2d6/dex/13 goblin orc`',
    );
    return true;
  }
  const spec = parts[0];
  const specParts = spec.split('/');
  if (specParts.length !== 3) {
    whisperToCaller(c.io, c.ctx, '!breath: spec must be `<dice>/<ability>/<dc>`.');
    return true;
  }
  const [diceRaw, abilityRaw, dcRaw] = specParts;
  const ability = abilityRaw.toLowerCase();
  if (!['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(ability)) {
    whisperToCaller(c.io, c.ctx, `!breath: unknown save ability "${abilityRaw}".`);
    return true;
  }
  const dc = parseInt(dcRaw, 10);
  if (!Number.isFinite(dc) || dc < 1 || dc > 40) {
    whisperToCaller(c.io, c.ctx, `!breath: DC must be 1-40.`);
    return true;
  }
  if (!/^\d+d\d+(\s*[+-]\s*\d+)?$/i.test(diceRaw)) {
    whisperToCaller(c.io, c.ctx, `!breath: damage must be NdN[+M].`);
    return true;
  }
  // Fan out via the existing !save command for consistency. This
  // means we get Aura of Protection, condition mods, etc. for free.
  // Just reformat and dispatch by calling the save handler directly.
  //
  // We inline a minimal version here rather than importing because
  // keeping this handler self-contained avoids a circular dep.
  const rollDice = (notation: string): { total: number; rolls: number[] } => {
    const m = notation.match(/(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?/);
    if (!m) return { total: 0, rolls: [] };
    const n = parseInt(m[1], 10), s = parseInt(m[2], 10);
    const sign = m[3] === '-' ? -1 : 1;
    const mod = m[4] ? parseInt(m[4], 10) * sign : 0;
    const rolls: number[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(Math.random() * s) + 1;
      rolls.push(r);
      total += r;
    }
    return { total: Math.max(0, total + mod), rolls };
  };
  const { total: fullDmg, rolls: dmgRolls } = rollDice(diceRaw);
  const halfDmg = Math.floor(fullDmg / 2);

  const caller = resolveCallerToken(c.ctx);
  const callerName = caller?.name || c.ctx.player.displayName;

  const lines: string[] = [];
  const breathTargets: NonNullable<ActionBreakdown['targets']> = [];
  lines.push(`🐲 ${callerName} uses Breath Weapon: ${diceRaw} (${dmgRolls.join('+')} = ${fullDmg}) vs ${ability.toUpperCase()} DC ${dc}`);
  for (const name of parts.slice(1)) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) {
      lines.push(`  • ${name}: not found`);
      breathTargets.push({ name, effect: 'Token not found' });
      continue;
    }
    // Lightweight save roll (no condition adv etc. — the DM can
    // re-roll through !save if they want the full pipeline).
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
        const ab = Math.floor((((scores as Record<string, number>)[ability] ?? 10) - 10) / 2);
        const prof = Number(row?.proficiency_bonus) || 2;
        const saves = typeof row?.saving_throws === 'string' ? JSON.parse(row.saving_throws as string) : (row?.saving_throws ?? []);
        const isProf = Array.isArray(saves) && saves.includes(ability);
        saveMod = ab + (isProf ? prof : 0);
        if (row?.name) tName = row.name as string;
      } catch { /* ignore */ }
    }
    const d20 = Math.floor(Math.random() * 20) + 1;
    const total = d20 + saveMod;
    const saved = total >= dc;
    const dmg = saved ? halfDmg : fullDmg;
    const sign = saveMod >= 0 ? '+' : '';
    lines.push(`  • ${tName}: d20=${d20}${sign}${saveMod}=${total} → ${saved ? 'SAVED (half)' : 'FAILED'} — ${dmg} dmg`);
    breathTargets.push({
      name: tName,
      tokenId: target.id,
      effect: saved
        ? `SAVED (half): ${ability.toUpperCase()} d20=${d20}${sign}${saveMod}=${total} vs DC ${dc} — ${dmg} damage`
        : `FAILED: ${ability.toUpperCase()} d20=${d20}${sign}${saveMod}=${total} vs DC ${dc} — ${dmg} damage`,
      damage: { amount: dmg, damageType: 'breath' },
    });
  }
  const breathBreakdown: ActionBreakdown = {
    actor: { name: callerName, tokenId: caller?.id },
    action: {
      name: `Breath Weapon (${diceRaw}, ${ability.toUpperCase()} DC ${dc})`,
      category: 'racial',
      icon: '🐲',
      cost: 'Action (1/short rest)',
    },
    effect: `${diceRaw} = ${fullDmg} damage, ${ability.toUpperCase()} save DC ${dc} halves.`,
    targets: breathTargets,
    notes: [
      `Dragonborn racial`,
      `Damage: ${diceRaw} = [${dmgRolls.join(', ')}] = ${fullDmg} (half = ${halfDmg})`,
      `Save: ${ability.toUpperCase()} DC ${dc}`,
      `Shape: 15-ft cone or 5×30-ft line (by ancestry)`,
    ],
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { actionResult: breathBreakdown });
  return true;
}

// ────── !eldritch <bolts> <caster-cha-mod> <target1> […] ──────
/**
 * Eldritch Blast cantrip. Fires N beams (1 at L1, 2 at L5, 3 at L11,
 * 4 at L17); each hits for 1d10 force. With Agonizing Blast invocation,
 * each beam adds CHA mod to damage. With Repelling Blast, each
 * hit pushes the target 10 ft.
 *
 * We just roll + announce — hit/miss is DM-adjudicated (attack roll
 * goes through the normal weapon-attack flow via the spells list).
 * This is a DAMAGE ROLL helper so the bard / warlock can roll N beams
 * quickly with modifier math.
 *
 *   !eldritch <bolts> <cha-mod> [target-label]
 */
async function handleEldritch(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!eldritch: usage `!eldritch <bolts> <cha-mod> [target-name]`\n  e.g. `!eldritch 2 4` → 2 beams, +4 CHA per beam');
    return true;
  }
  const bolts = parseInt(parts[0], 10);
  const cha = parseInt(parts[1], 10);
  if (!Number.isFinite(bolts) || bolts < 1 || bolts > 4) {
    whisperToCaller(c.io, c.ctx, '!eldritch: bolts must be 1-4 (1 @ L1, 2 @ L5, 3 @ L11, 4 @ L17).');
    return true;
  }
  if (!Number.isFinite(cha)) {
    whisperToCaller(c.io, c.ctx, '!eldritch: cha-mod must be a number (0 = no Agonizing Blast).');
    return true;
  }
  const targetLabel = parts.slice(2).join(' ');
  const caller = resolveCallerToken(c.ctx);
  const callerName = caller?.name || c.ctx.player.displayName;
  const lines: string[] = [];
  lines.push(`✨ ${callerName} fires ${bolts} Eldritch Blast beam${bolts === 1 ? '' : 's'}${targetLabel ? ` at ${targetLabel}` : ''}:`);
  const beamRolls: number[] = [];
  const beamTotals: number[] = [];
  let total = 0;
  for (let i = 0; i < bolts; i++) {
    const roll = Math.floor(Math.random() * 10) + 1;
    const beam = roll + (cha !== 0 ? cha : 0);
    total += beam;
    beamRolls.push(roll);
    beamTotals.push(beam);
    lines.push(`  • beam ${i + 1}: d10=${roll}${cha >= 0 ? '+' : ''}${cha}=${beam} force`);
  }
  lines.push(`  Total: ${total} force${cha !== 0 ? ' (incl. Agonizing Blast)' : ''}. DM: roll to hit for each beam separately.`);
  const ebBreakdown: ActionBreakdown = {
    actor: { name: callerName, tokenId: caller?.id },
    action: {
      name: `Eldritch Blast (${bolts} beam${bolts === 1 ? '' : 's'}, ${total} force)`,
      category: 'class-feature',
      icon: '✨',
      cost: 'Action (cantrip)',
    },
    effect: `${bolts}× 1d10${cha !== 0 ? ` +${cha} (Agonizing Blast)` : ''} force. Total potential damage: **${total}**.`,
    ...(targetLabel ? {
      targets: [{
        name: targetLabel,
        effect: `${bolts} beams × d10${cha !== 0 ? `+${cha}` : ''} — total ${total} force`,
      }],
    } : {}),
    notes: [
      `Warlock cantrip`,
      `Bolts: ${bolts} (1 @ L1, 2 @ L5, 3 @ L11, 4 @ L17)`,
      `Per-beam: d10 roll + CHA mod (${cha}) = beam damage`,
      `Rolls: [${beamRolls.join(', ')}] → beams: [${beamTotals.join(', ')}] = ${total}`,
      ...(cha !== 0 ? ['Agonizing Blast invocation active'] : []),
    ],
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { actionResult: ebBreakdown });
  return true;
}

// ────── Battle Master Superiority Dice + Maneuvers ───────────
/**
 * Battle Master Fighter (L3+). Superiority Dice pool — 4 at L3, 5 at
 * L7, 6 at L15. Die size scales: d8 at L3, d10 at L10, d12 at L18.
 *
 *   !superiority status | use | reset | set <n> <die>
 *   !maneuver <name> [target] [dc]
 *
 * Maneuvers we know about (each spends 1 superiority die):
 *   trip      — target creature makes STR save or knocked prone
 *   pushing   — target STR save or pushed 15 ft
 *   disarming — target STR save or drops a weapon
 *   riposte   — reaction after enemy misses you, +sup die damage
 *   distracting — next ally attack on target has advantage
 *   parry     — reaction, add +sup die to AC vs one attack
 *   feinting  — advantage on next attack this turn (+sup die dmg)
 *   menacing  — WIS save or frightened until end of your next turn
 *   precision — add sup die to an attack roll
 *   evasive footwork — bonus to AC until you move
 */

const MANEUVER_SAVES: Record<string, { ability: 'str' | 'wis'; on: string }> = {
  trip: { ability: 'str', on: 'prone' },
  pushing: { ability: 'str', on: 'push' },
  disarming: { ability: 'str', on: 'disarm' },
  menacing: { ability: 'wis', on: 'frightened' },
};
const MANEUVER_DESC: Record<string, string> = {
  trip: 'Trip Attack — STR save or knocked prone',
  pushing: 'Pushing Attack — STR save or pushed 15 ft',
  disarming: 'Disarming Attack — STR save or drops a weapon',
  riposte: 'Riposte — reaction: after an enemy misses you, attack + add sup die',
  distracting: 'Distracting Strike — next ally attack on target has advantage',
  parry: 'Parry — reaction: add sup die to your AC against one attack',
  feinting: 'Feinting Attack — advantage on your next attack this turn',
  menacing: 'Menacing Attack — WIS save or frightened',
  precision: 'Precision Attack — add sup die to an attack roll',
  evasive: 'Evasive Footwork — add sup die to AC while moving',
  lunging: 'Lunging Attack — melee reach +5 ft for one attack',
  rally: 'Rally — grant a chosen ally sup die + CHA mod temp HP',
};

function getOrSeedSup(ctx: PlayerContext, charId: string, level: number): { max: number; remaining: number; die: number } {
  let pools = ctx.room.pointPools.get(charId);
  if (!pools) {
    pools = new Map();
    ctx.room.pointPools.set(charId, pools);
  }
  let sup = pools.get('superiority') as { max: number; remaining: number; die?: number } | undefined;
  if (!sup) {
    const count = level >= 15 ? 6 : level >= 7 ? 5 : 4;
    const die = level >= 18 ? 12 : level >= 10 ? 10 : 8;
    sup = { max: count, remaining: count, die };
    pools.set('superiority', sup);
  }
  return sup as { max: number; remaining: number; die: number };
}

async function requireBattleMaster(c: ChatCommandContext, cmd: string): Promise<{ caller: Token; level: number; charId: string; name: string } | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query('SELECT class, level, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: ${caller.name} isn't a Fighter.`);
    return null;
  }
  const level = Number(row?.level) || 1;
  if (level < 3) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: Battle Master features require Fighter L3+.`);
    return null;
  }
  return { caller, level, charId: caller.characterId, name: (row?.name as string) || caller.name };
}

async function handleSuperiority(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const bm = await requireBattleMaster(c, 'superiority');
  if (!bm) return true;
  const sup = getOrSeedSup(c.ctx, bm.charId, bm.level);
  const sub = parts[0]?.toLowerCase() || 'status';
  if (sub === 'status' || sub === '') {
    whisperToCaller(c.io, c.ctx, `⚔ ${bm.name} Superiority Dice: ${sup.remaining}/${sup.max} (d${sup.die}).`);
    return true;
  }
  if (sub === 'reset' || sub === 'refresh') {
    sup.remaining = sup.max;
    broadcastSystem(c.io, c.ctx, `⚔ ${bm.name} Superiority Dice refreshed: ${sup.max}/${sup.max} (d${sup.die}).`);
    return true;
  }
  if (sub === 'use' || sub === 'spend') {
    if (sup.remaining <= 0) {
      whisperToCaller(c.io, c.ctx, '!superiority: no dice left.');
      return true;
    }
    sup.remaining -= 1;
    const roll = Math.floor(Math.random() * sup.die) + 1;
    const supBreakdown: ActionBreakdown = {
      actor: { name: bm.name, tokenId: bm.caller.id },
      action: {
        name: `Superiority Die (+${roll})`,
        category: 'class-feature',
        icon: '⚔',
        cost: '1 superiority die',
      },
      effect: `Roll d${sup.die} = **${roll}** (apply to a maneuver or other superiority ability).`,
      notes: [
        `Battle Master Fighter L${bm.level}`,
        `Die size: d${sup.die} (L3=d8, L10=d10, L18=d12)`,
        `Rolled value: ${roll}`,
        `Dice remaining: ${sup.remaining}/${sup.max}`,
      ],
    };
    broadcastSystem(c.io, c.ctx, `⚔ ${bm.name} spends a sup die — d${sup.die} = **${roll}**. (${sup.remaining}/${sup.max} left)`, { actionResult: supBreakdown });
    return true;
  }
  whisperToCaller(c.io, c.ctx, `!superiority: unknown subcommand "${sub}".`);
  return true;
}

async function handleManeuver(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!maneuver: usage `!maneuver <name> [target] [dc]`\n  Options: trip, pushing, disarming, menacing, riposte, distracting, parry, feinting, precision, evasive, lunging, rally',
    );
    return true;
  }
  const name = parts[0].toLowerCase();
  const desc = MANEUVER_DESC[name];
  if (!desc) {
    whisperToCaller(c.io, c.ctx, `!maneuver: unknown maneuver "${name}".`);
    return true;
  }
  const bm = await requireBattleMaster(c, 'maneuver');
  if (!bm) return true;
  const sup = getOrSeedSup(c.ctx, bm.charId, bm.level);
  if (sup.remaining <= 0) {
    whisperToCaller(c.io, c.ctx, '!maneuver: no superiority dice left.');
    return true;
  }
  sup.remaining -= 1;
  const roll = Math.floor(Math.random() * sup.die) + 1;

  const lines: string[] = [];
  lines.push(`⚔ ${bm.name} uses **${name.charAt(0).toUpperCase() + name.slice(1)}** — ${desc}`);
  lines.push(`   Sup die d${sup.die} = **${roll}**. (${sup.remaining}/${sup.max} left)`);

  // For save-based maneuvers (trip / pushing / disarming / menacing),
  // auto-roll the target's save if target + DC supplied.
  const maneuverTargets: NonNullable<ActionBreakdown['targets']> = [];
  const saveMeta = MANEUVER_SAVES[name];
  let appliedCondition: string | null = null;
  if (saveMeta && parts.length >= 3) {
    const dc = parseInt(parts[parts.length - 1], 10);
    const targetName = parts.slice(1, -1).join(' ');
    const target = resolveTargetByName(c.ctx, targetName);
    if (target && Number.isFinite(dc)) {
      let saveMod = 0;
      if (target.characterId) {
        const { rows } = await pool.query(
          'SELECT ability_scores, saving_throws, proficiency_bonus FROM characters WHERE id = $1',
          [target.characterId],
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        try {
          const scores = typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores ?? {});
          const ab = Math.floor((((scores as Record<string, number>)[saveMeta.ability] ?? 10) - 10) / 2);
          const prof = Number(row?.proficiency_bonus) || 2;
          const saves = typeof row?.saving_throws === 'string' ? JSON.parse(row.saving_throws as string) : (row?.saving_throws ?? []);
          const isProf = Array.isArray(saves) && saves.includes(saveMeta.ability);
          saveMod = ab + (isProf ? prof : 0);
        } catch { /* ignore */ }
      }
      const d20 = Math.floor(Math.random() * 20) + 1;
      const total = d20 + saveMod;
      const saved = total >= dc;
      const sign = saveMod >= 0 ? '+' : '';
      lines.push(`   ${target.name} ${saveMeta.ability.toUpperCase()} save: d20=${d20}${sign}${saveMod}=${total} vs DC ${dc} → ${saved ? 'SAVED' : 'FAILED'}`);
      if (!saved && (saveMeta.on === 'prone' || saveMeta.on === 'frightened')) {
        const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
        ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
          name: saveMeta.on,
          source: `${bm.name} (${name})`,
          casterTokenId: bm.caller.id,
          appliedRound: currentRound,
          expiresAfterRound: saveMeta.on === 'frightened' ? currentRound + 1 : undefined,
        });
        c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
          tokenId: target.id,
          changes: tokenConditionChanges(c.ctx.room, target.id),
        });
        lines.push(`     → ${target.name} is ${saveMeta.on.toUpperCase()}.`);
        appliedCondition = saveMeta.on;
      }
      maneuverTargets.push({
        name: target.name,
        tokenId: target.id,
        effect: saved
          ? `SAVED: ${saveMeta.ability.toUpperCase()} d20=${d20}${sign}${saveMod}=${total} vs DC ${dc}`
          : `FAILED: ${saveMeta.ability.toUpperCase()} d20=${d20}${sign}${saveMod}=${total} vs DC ${dc}${appliedCondition ? ` — ${appliedCondition}` : ''}`,
        ...(appliedCondition ? { conditionsApplied: [appliedCondition] } : {}),
      });
    }
  }
  const maneuverBreakdown: ActionBreakdown = {
    actor: { name: bm.name, tokenId: bm.caller.id },
    action: {
      name: `${name.charAt(0).toUpperCase() + name.slice(1)} (+${roll})`,
      category: 'class-feature',
      icon: '⚔',
      cost: '1 superiority die',
    },
    effect: `${desc}. Sup die d${sup.die} = ${roll}.`,
    ...(maneuverTargets.length > 0 ? { targets: maneuverTargets } : {}),
    notes: [
      `Battle Master Fighter L${bm.level}`,
      `Die: d${sup.die}`,
      `Rolled: ${roll}`,
      `Dice remaining: ${sup.remaining}/${sup.max}`,
      ...(saveMeta ? [`Save: ${saveMeta.ability.toUpperCase()}`] : []),
    ],
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { actionResult: maneuverBreakdown });
  return true;
}

// ────── !crit — Champion Improved Critical notice ────────
/**
 * Champion subclass (L3) crits on 19-20; L15 crits on 18-20. There's
 * no good single hook in the attack resolver to auto-apply this
 * without touching a lot of code, so this command just reminds the
 * player + DM. For any attack where the player rolled a 19 (or 18),
 * announce the crit and the DM adjusts damage manually via !damage.
 *
 *   !crit <d20-roll> — announces whether Champion Improved Critical
 *   fires for this roll.
 */
async function handleCrit(c: ChatCommandContext): Promise<boolean> {
  const rollRaw = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(rollRaw) || rollRaw < 1 || rollRaw > 20) {
    whisperToCaller(c.io, c.ctx, '!crit: usage `!crit <d20-natural-roll>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!crit: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  const level = Number(row?.level) || 1;
  let champLevel = 0;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    if (Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /improved\s+critical/i.test(f.name),
    )) champLevel = Math.max(champLevel, 3);
    if (Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /superior\s+critical/i.test(f.name),
    )) champLevel = Math.max(champLevel, 15);
  } catch { /* ignore */ }
  // Fallback: Champion subclass detected on the class string.
  if (champLevel === 0 && classLower.includes('champion')) champLevel = level >= 15 ? 15 : level >= 3 ? 3 : 0;
  const threshold = champLevel >= 15 ? 18 : champLevel >= 3 ? 19 : 20;
  const isCrit = rollRaw >= threshold;
  whisperToCaller(
    c.io, c.ctx,
    `⚔ d20=${rollRaw}: ${isCrit ? `CRIT (Champion ${threshold}-20 threshold)` : `not a crit (need ≥${threshold})`}.`,
  );
  return true;
}

registerChatCommand(['reckless', 'recklessattack'], handleReckless);
registerChatCommand(['endurance', 'relentless'], handleEndurance);
registerChatCommand(['arcanerecovery', 'ar'], handleArcaneRecovery);
registerChatCommand(['breath', 'breathweapon'], handleBreath);
registerChatCommand(['eldritch', 'eldritchblast', 'eb'], handleEldritch);
registerChatCommand(['superiority', 'supdice'], handleSuperiority);
registerChatCommand(['maneuver'], handleManeuver);
registerChatCommand('crit', handleCrit);
