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

/**
 * High-frequency subclass features that interact meaningfully with
 * the combat pipeline — Portent, Colossus Slayer, Assassinate,
 * Guided Strike, Hexblade's Curse, Wrath of the Storm, Bear Totem.
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

// ────── Portent (Divination Wizard L2) ────────────────────
/**
 * 2 portent dice at dawn — 3 at L14. The Diviner rolls a d20 at each
 * dawn and RESERVES the roll; any attack / check / save made by any
 * creature the Diviner can see can be replaced with a reserved die.
 *
 *   !portent roll           — refresh dice at dawn (rolls 2 or 3 d20s)
 *   !portent use <d20>      — spend the die matching the rolled value
 *   !portent list           — whisper remaining dice
 */
const portentDice = new Map<string, number[]>();

async function handlePortent(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase() || 'list';
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!portent: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('wizard')) {
    whisperToCaller(c.io, c.ctx, `!portent: ${caller.name} isn't a Wizard.`);
    return true;
  }
  // Feature gate — must actually be Diviner school.
  let hasPortent = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasPortent = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /portent/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasPortent) {
    whisperToCaller(c.io, c.ctx, `!portent: ${caller.name} doesn't have Portent (School of Divination).`);
    return true;
  }
  const lvl = Number(row?.level) || 2;
  const slots = lvl >= 14 ? 3 : 2;
  const charName = (row?.name as string) || caller.name;
  const stored = portentDice.get(caller.characterId) ?? [];

  if (sub === 'roll' || sub === 'refresh') {
    const dice: number[] = [];
    for (let i = 0; i < slots; i++) dice.push(Math.floor(Math.random() * 20) + 1);
    portentDice.set(caller.characterId, dice);
    broadcastSystem(c.io, c.ctx, `🔮 ${charName} awakens with Portent — dice: **${dice.join(', ')}**.`);
    return true;
  }
  if (sub === 'list' || sub === 'status') {
    if (stored.length === 0) {
      whisperToCaller(c.io, c.ctx, `🔮 ${charName} has no portent dice. Run !portent roll at dawn to refresh.`);
    } else {
      whisperToCaller(c.io, c.ctx, `🔮 ${charName} portent dice remaining: **${stored.join(', ')}**.`);
    }
    return true;
  }
  if (sub === 'use' || sub === 'spend') {
    const wanted = parseInt(parts[1], 10);
    if (!Number.isFinite(wanted) || wanted < 1 || wanted > 20) {
      whisperToCaller(c.io, c.ctx, '!portent use: `!portent use <d20-value>`');
      return true;
    }
    const idx = stored.indexOf(wanted);
    if (idx < 0) {
      whisperToCaller(c.io, c.ctx, `!portent: no stored die matching ${wanted}. Current: ${stored.join(', ')}.`);
      return true;
    }
    stored.splice(idx, 1);
    portentDice.set(caller.characterId, stored);
    broadcastSystem(
      c.io, c.ctx,
      `🔮 ${charName} spends a Portent die — the target's attack/check/save is replaced with a **${wanted}**. (${stored.length} left)`,
    );
    return true;
  }
  whisperToCaller(c.io, c.ctx, `!portent: unknown subcommand "${sub}".`);
  return true;
}

// ────── Colossus Slayer (Hunter Ranger L3) ───────────────
/**
 * Once per turn, when you hit a creature with a weapon attack AND
 * that target is below its HP max, add +1d8 damage. We track the
 * once-per-turn gate via a Set keyed on turn-key, same pattern as
 * Sneak Attack on the client.
 *
 *   !colossus — rolls 1d8 + announces the bonus damage. Caller is
 *               responsible for checking the target is wounded.
 */
const colossusUsed = new Set<string>();

async function handleColossus(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!colossus: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('ranger')) {
    whisperToCaller(c.io, c.ctx, `!colossus: ${caller.name} isn't a Ranger.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /colossus\s+slayer/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt) {
    whisperToCaller(c.io, c.ctx, `!colossus: ${caller.name} doesn't have Colossus Slayer (Hunter Ranger L3).`);
    return true;
  }
  const combat = c.ctx.room.combatState;
  const turnKey = `${combat?.roundNumber ?? 0}_${combat?.currentTurnIndex ?? 0}_${caller.characterId}`;
  if (colossusUsed.has(turnKey)) {
    whisperToCaller(c.io, c.ctx, `!colossus: already used this turn.`);
    return true;
  }
  colossusUsed.add(turnKey);
  const roll = Math.floor(Math.random() * 8) + 1;
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🏹 **Colossus Slayer** — ${charName} deals +1d8 = **${roll}** damage (target must already be below max HP).`,
  );
  return true;
}

// ────── Assassinate (Rogue Assassin L3) ──────────────────
/**
 * Advantage on attack rolls against any creature that hasn't taken
 * a turn in combat yet. Any hit against a SURPRISED creature is an
 * automatic critical. We don't check surprise state end-to-end (the
 * DM knows), so this command whispers the conditions + rolls an
 * attack with advantage for the player.
 *
 *   !assassinate <target> <attack-bonus> [surprised]
 *     Auto-rolls 2d20 (advantage) + adds bonus. If `surprised` flag
 *     is passed, a hit is announced as auto-crit.
 */
async function handleAssassinate(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(
      c.io, c.ctx,
      '!assassinate: usage `!assassinate <target> <attack-bonus> [surprised]`',
    );
    return true;
  }
  const surprised = parts[parts.length - 1].toLowerCase() === 'surprised';
  if (surprised) parts.pop();
  const bonusRaw = parts[parts.length - 1];
  const bonus = parseInt(bonusRaw, 10);
  if (!Number.isFinite(bonus)) {
    whisperToCaller(c.io, c.ctx, '!assassinate: attack bonus must be a number.');
    return true;
  }
  parts.pop();
  const targetName = parts.join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!assassinate: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!assassinate: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!assassinate: ${caller.name} isn't a Rogue.`);
    return true;
  }
  // Feature check (Assassin subclass at L3+).
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /assassinate/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt && !classLower.includes('assassin')) {
    whisperToCaller(c.io, c.ctx, `!assassinate: ${caller.name} doesn't have Assassinate (Rogue Assassin L3).`);
    return true;
  }
  const r1 = Math.floor(Math.random() * 20) + 1;
  const r2 = Math.floor(Math.random() * 20) + 1;
  const kept = Math.max(r1, r2);
  const total = kept + bonus;
  const sign = bonus >= 0 ? '+' : '';
  const isCrit = kept === 20 || surprised;
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🗡 **${charName} Assassinates ${target.name}** — adv attack: [${r1},${r2}]${sign}${bonus} = **${total}**.${isCrit ? ' 💥 CRIT (surprised target = auto-crit on hit).' : ''}`,
  );
  return true;
}

// ────── Guided Strike (War Cleric Channel Divinity) ──────
async function handleGuided(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!guided: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!guided: ${caller.name} isn't a Cleric.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /guided\s+strike/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt && !classLower.includes('war')) {
    whisperToCaller(c.io, c.ctx, `!guided: ${caller.name} doesn't have Guided Strike (War Cleric L2 Channel Divinity).`);
    return true;
  }
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `⚔ **Guided Strike** — ${charName} uses Channel Divinity, adds **+10** to the attack roll just made (after seeing the roll). 1 CD charge spent.`,
  );
  return true;
}

// ────── Hexblade's Curse ─────────────────────────────────
/**
 * Hexblade Warlock (L1). Bonus action. Curse a creature you can see
 * within 30 ft. For 1 min: (1) +prof bonus to your damage vs target,
 * (2) crit on 19-20 vs target, (3) regain HP = warlock level + CHA
 * mod if the target dies. 1/short rest.
 *
 *   !hbc <target>           apply the curse
 *   !hbc clear <target>     lift early
 */
async function handleHexbladeCurse(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!hbc: usage `!hbc <target>` | `!hbc clear <target>`');
    return true;
  }
  const isClear = parts[0].toLowerCase() === 'clear';
  const targetName = isClear ? parts.slice(1).join(' ') : parts.join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!hbc: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!hbc: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, features, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('warlock')) {
    whisperToCaller(c.io, c.ctx, `!hbc: ${caller.name} isn't a Warlock.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /hexblade'?s\s+curse/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt) {
    whisperToCaller(c.io, c.ctx, `!hbc: ${caller.name} doesn't have Hexblade's Curse.`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  if (isClear) {
    if (!(target.conditions as string[]).includes('hexblade-cursed')) {
      whisperToCaller(c.io, c.ctx, `!hbc: ${target.name} isn't cursed.`);
      return true;
    }
    ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'hexblade-cursed');
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: { conditions: target.conditions },
    });
    broadcastSystem(c.io, c.ctx, `🗡 Hexblade's Curse lifted from ${target.name}.`);
    return true;
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'hexblade-cursed',
    source: `${caller.name} (Hexblade's Curse)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });
  broadcastSystem(
    c.io, c.ctx,
    `🗡 **${caller.name} curses ${target.name}** (Hexblade's Curse) — +prof bonus damage, crits on 19-20, caster regains HP = level+CHA if target dies. 1 min.`,
  );
  return true;
}

// ────── Wrath of the Storm (Tempest Cleric L1, reaction) ──
/**
 * When a creature within 5 ft hits you with a melee attack, use your
 * reaction to force it to make a DEX save or take 2d8 lightning/thunder
 * damage (choose). Uses = 1 + WIS mod per long rest.
 *
 *   !wrath <target> <dc>           DEX save vs DC; attacker specified
 *   !wrath <target> <dc> lightning|thunder
 */
async function handleWrath(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!wrath: usage `!wrath <attacker> <dc> [lightning|thunder]`');
    return true;
  }
  // Allow optional damage type as last arg.
  let dmgType = 'lightning';
  const maybe = parts[parts.length - 1].toLowerCase();
  if (maybe === 'lightning' || maybe === 'thunder') {
    dmgType = maybe;
    parts.pop();
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!wrath: DC must be a number.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!wrath: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!wrath: no owned PC token.');
    return true;
  }
  // Spend reaction.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, `!wrath: reaction already spent.`);
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
  // Roll target's DEX save.
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
      const dex = Math.floor((((scores as Record<string, number>).dex ?? 10) - 10) / 2);
      const prof = Number(row?.proficiency_bonus) || 2;
      const saves = typeof row?.saving_throws === 'string' ? JSON.parse(row.saving_throws as string) : (row?.saving_throws ?? []);
      saveMod = dex + (Array.isArray(saves) && saves.includes('dex') ? prof : 0);
      if (row?.name) tName = row.name as string;
    } catch { /* ignore */ }
  }
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + saveMod;
  const saved = total >= dc;

  // Damage: 2d8
  const r1 = Math.floor(Math.random() * 8) + 1;
  const r2 = Math.floor(Math.random() * 8) + 1;
  const dmg = saved ? 0 : r1 + r2;
  const modSign = saveMod >= 0 ? '+' : '';
  broadcastSystem(
    c.io, c.ctx,
    `⚡ **Wrath of the Storm** — ${caller.name} blasts ${tName} (reaction, 2d8 ${dmgType}):\n   ${tName} DEX save: d20=${d20}${modSign}${saveMod}=${total} vs ${dc} → ${saved ? 'SAVED (no dmg)' : `FAILED — ${r1}+${r2} = ${dmg} ${dmgType} dmg`}`,
  );
  return true;
}

// ────── Bear Totem (Barbarian L3 Path of the Totem Warrior) ──
/**
 * While raging, you have resistance to ALL damage except psychic.
 * We apply a `bear-raging` pseudo-condition that the damage
 * resolver can pair with the standard `raging` to grant blanket
 * resistance. The feature key is "Spirit Seeker / Bear" — we detect
 * via a class-features regex.
 *
 *   !bear on   apply when rage starts
 *   !bear off  clear when rage ends
 */
async function handleBear(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim().toLowerCase();
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!bear: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, features, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('barbarian')) {
    whisperToCaller(c.io, c.ctx, `!bear: ${caller.name} isn't a Barbarian.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /bear/i.test(f.name) && /(totem|spirit)/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt) {
    whisperToCaller(c.io, c.ctx, `!bear: ${caller.name} doesn't have Bear Totem (Path of the Totem Warrior L3).`);
    return true;
  }

  if (arg === 'off' || arg === 'end') {
    ConditionService.removeCondition(c.ctx.room.sessionId, caller.id, 'bear-raging');
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: caller.id,
      changes: { conditions: caller.conditions },
    });
    broadcastSystem(c.io, c.ctx, `🐻 ${caller.name}'s Bear Spirit fades.`);
    return true;
  }

  if (!(caller.conditions as string[]).includes('raging')) {
    whisperToCaller(c.io, c.ctx, `!bear: activate Rage first (!rage).`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
    name: 'bear-raging',
    source: `${caller.name} (Bear Totem)`,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: caller.id,
    changes: { conditions: caller.conditions },
  });
  broadcastSystem(
    c.io, c.ctx,
    `🐻 **Bear Spirit** awakens — ${caller.name} has resistance to ALL damage except psychic while raging.`,
  );
  return true;
}

// ────── Stillness of Mind (Monk L7) ─────────────────────
/**
 * Action: end one effect on yourself that is causing you to be
 * charmed or frightened. Targets the specific condition.
 */
async function handleStillness(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!stillness: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('monk')) {
    whisperToCaller(c.io, c.ctx, `!stillness: ${caller.name} isn't a Monk.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  if (lvl < 7) {
    whisperToCaller(c.io, c.ctx, '!stillness: requires Monk L7.');
    return true;
  }
  const conds = (caller.conditions as string[]) || [];
  const cleared: string[] = [];
  if (conds.includes('charmed')) {
    ConditionService.removeCondition(c.ctx.room.sessionId, caller.id, 'charmed');
    cleared.push('charmed');
  }
  if (conds.includes('frightened')) {
    ConditionService.removeCondition(c.ctx.room.sessionId, caller.id, 'frightened');
    cleared.push('frightened');
  }
  if (cleared.length > 0) {
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: caller.id,
      changes: { conditions: caller.conditions },
    });
  }
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    cleared.length > 0
      ? `🧘 **Stillness of Mind** — ${charName} clears: ${cleared.join(', ')} (action).`
      : `🧘 Stillness of Mind — ${charName} isn't charmed or frightened; nothing to clear.`,
  );
  return true;
}

// ────── Fast Hands (Thief Rogue L3) ────────────────────
/**
 * Bonus action: use a Sleight of Hand check, use Thieves' Tools to
 * disarm a trap or pick a lock, or Use an Object. Just announce
 * + burn the bonus action.
 */
async function handleFastHands(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim() || 'use an object';
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!fasthands: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, features, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!fasthands: ${caller.name} isn't a Rogue.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /fast\s+hands/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt && !classLower.includes('thief')) {
    whisperToCaller(c.io, c.ctx, `!fasthands: ${caller.name} doesn't have Fast Hands (Thief Rogue L3).`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, `!fasthands: bonus action already spent.`);
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
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🖐 **Fast Hands** — ${charName} uses bonus action to ${arg} (Sleight of Hand / Thieves' Tools / Use Object).`,
  );
  return true;
}

// ────── Sacred Weapon (Devotion Paladin CD) ────────────
/**
 * Action: for 1 minute, weapon in hand is magical, adds CHA mod
 * to attack rolls (min +1), sheds bright light 20 ft + dim 20 ft
 * beyond. Uses 1 Channel Divinity.
 */
async function handleSacredWeapon(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!sacredweapon: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, ability_scores, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!sacredweapon: ${caller.name} isn't a Paladin.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /sacred\s+weapon/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt && !classLower.includes('devotion')) {
    whisperToCaller(c.io, c.ctx, `!sacredweapon: ${caller.name} doesn't have Sacred Weapon (Oath of Devotion).`);
    return true;
  }
  const scores = typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores ?? {});
  const chaMod = Math.max(1, Math.floor((((scores as Record<string, number>).cha ?? 10) - 10) / 2));
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Sacred Weapon** — ${charName}'s weapon glows (1 min, CD): **+${chaMod}** to attack rolls, weapon is MAGICAL, sheds bright 20 ft + dim 20 ft light.`,
  );
  return true;
}

// ────── Vow of Enmity (Vengeance Paladin CD) ─────────
async function handleVowOfEnmity(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!vow: usage `!vow <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!vow: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!vow: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!vow: ${caller.name} isn't a Paladin.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /vow\s+of\s+enmity/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt && !classLower.includes('vengeance')) {
    whisperToCaller(c.io, c.ctx, `!vow: ${caller.name} doesn't have Vow of Enmity (Oath of Vengeance).`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'vowed',
    source: `${caller.name} (Vow of Enmity)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🗡 **Vow of Enmity** — ${charName} vows to destroy ${target.name}. Advantage on attack rolls against them for 1 minute (CD).`,
  );
  return true;
}

// ────── Disciple of Life (Life Cleric L1) ──────────────
/**
 * Whenever you use a spell of 1st level or higher to restore HP
 * to a creature, the creature regains additional HP equal to
 * 2 + the spell's level. This command just announces the bonus
 * so the DM / player adds it to the heal.
 *
 *   !discipleoflife <spell-level>
 */
async function handleDiscipleOfLife(c: ChatCommandContext): Promise<boolean> {
  const lvl = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(lvl) || lvl < 1 || lvl > 9) {
    whisperToCaller(c.io, c.ctx, '!discipleoflife: usage `!discipleoflife <spell-level>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!discipleoflife: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('cleric')) {
    whisperToCaller(c.io, c.ctx, `!discipleoflife: ${caller.name} isn't a Cleric.`);
    return true;
  }
  let hasIt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasIt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /disciple\s+of\s+life/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasIt && !classLower.includes('life')) {
    whisperToCaller(c.io, c.ctx, `!discipleoflife: ${caller.name} doesn't have Disciple of Life (Life domain).`);
    return true;
  }
  const bonus = 2 + lvl;
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Disciple of Life** — ${charName}'s healing spell (level ${lvl}) adds **+${bonus}** HP to the base heal.`,
  );
  return true;
}

registerChatCommand('portent', handlePortent);
registerChatCommand(['colossus', 'colossusslayer'], handleColossus);
registerChatCommand(['assassinate', 'assassin'], handleAssassinate);
registerChatCommand(['guided', 'guidedstrike'], handleGuided);
registerChatCommand(['hbc', 'hexbladecurse'], handleHexbladeCurse);
registerChatCommand(['wrath', 'wrathofthestorm'], handleWrath);
registerChatCommand('bear', handleBear);
registerChatCommand(['stillness', 'stillnessofmind'], handleStillness);
registerChatCommand(['fasthands', 'fh'], handleFastHands);
registerChatCommand(['sacredweapon', 'sw-paladin'], handleSacredWeapon);
registerChatCommand(['vow', 'vowofenmity'], handleVowOfEnmity);
registerChatCommand(['discipleoflife', 'dol'], handleDiscipleOfLife);
