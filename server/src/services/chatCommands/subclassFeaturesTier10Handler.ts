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
 * Tier 10 subclass features:
 * - Healing Light (Celestial Warlock L1)
 * - Awakened Mind (Great Old One Warlock L1)
 * - Frenzy (Berserker Barbarian L3)
 * - Spirit Shield (Ancestral Guardian Barbarian L6)
 * - Draconic Resilience + Elemental Affinity (Draconic Sorcerer L1 / L6)
 * - Combat Wild Shape (Moon Druid L2)
 * - Fancy Footwork + Rakish Audacity (Swashbuckler Rogue L3)
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

function getClassFeatures(row: Record<string, unknown> | undefined): string[] {
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    if (!Array.isArray(feats)) return [];
    return feats
      .map((f: { name?: string }) => typeof f?.name === 'string' ? f.name : '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasFeature(row: Record<string, unknown> | undefined, pattern: RegExp): boolean {
  return getClassFeatures(row).some((f) => pattern.test(f));
}

// ────── Healing Light (Celestial Warlock L1) ───────────
/**
 * Pool of d6s; total dice = 1 + warlock level. Bonus action to heal
 * a creature within 60 ft for XdN HP, X ≤ warlock level, each die
 * drawn from the pool. Refreshes on long rest.
 *
 *   !healinglight <target> <n-dice>   spend N dice, heal target
 *   !healinglight status               show remaining dice
 *   !healinglight reset                refill pool (long rest)
 */
async function handleHealingLight(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!healinglight: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('warlock')) {
    whisperToCaller(c.io, c.ctx, `!healinglight: ${caller.name} isn't a Warlock.`);
    return true;
  }
  if (!hasFeature(row, /healing\s+light/i) && !classLower.includes('celestial')) {
    whisperToCaller(c.io, c.ctx, `!healinglight: ${caller.name} isn't a Celestial Warlock.`);
    return true;
  }
  const warlockLvl = Number(row?.level) || 1;
  const maxDice = 1 + warlockLvl;

  // Pool lives in RoomState.pointPools keyed as 'healinglight'.
  let pools = c.ctx.room.pointPools.get(caller.characterId);
  if (!pools) {
    pools = new Map();
    c.ctx.room.pointPools.set(caller.characterId, pools);
  }
  let pool_ = pools.get('healinglight');
  if (!pool_) {
    pool_ = { max: maxDice, remaining: maxDice };
    pools.set('healinglight', pool_);
  } else if (pool_.max !== maxDice) {
    // level-up: recalc cap
    pool_.max = maxDice;
    pool_.remaining = Math.min(pool_.remaining, pool_.max);
  }

  const callerName = (row?.name as string) || caller.name;
  const sub = parts[0]?.toLowerCase() || 'status';

  if (sub === 'status' || sub === '') {
    whisperToCaller(
      c.io, c.ctx,
      `✨ ${callerName} Healing Light: ${pool_.remaining}/${pool_.max} d6 (max ${warlockLvl}/spend).`,
    );
    return true;
  }

  if (sub === 'reset' || sub === 'refresh') {
    pool_.remaining = pool_.max;
    broadcastSystem(
      c.io, c.ctx,
      `✨ ${callerName} rests — Healing Light pool refreshed to ${pool_.max}/${pool_.max}.`,
    );
    return true;
  }

  // Spend path: !healinglight <target> <n-dice>
  if (parts.length < 2) {
    whisperToCaller(
      c.io, c.ctx,
      '!healinglight: usage `!healinglight <target> <n-dice>` | `status` | `reset`',
    );
    return true;
  }
  const n = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(n) || n < 1) {
    whisperToCaller(c.io, c.ctx, '!healinglight: dice count must be ≥ 1.');
    return true;
  }
  if (n > warlockLvl) {
    whisperToCaller(
      c.io, c.ctx,
      `!healinglight: max ${warlockLvl} dice per spend (warlock level).`,
    );
    return true;
  }
  if (n > pool_.remaining) {
    whisperToCaller(
      c.io, c.ctx,
      `!healinglight: only ${pool_.remaining} dice left in the pool.`,
    );
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!healinglight: no token named "${targetName}".`);
    return true;
  }

  // Burn bonus action.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!healinglight: bonus action already spent.');
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

  // Roll N d6.
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(Math.random() * 6) + 1;
    rolls.push(r);
    total += r;
  }
  pool_.remaining -= n;

  // Apply heal — prefer in-combat combatant lookup so NPC monsters
  // and PCs both work. Fall back to direct characters row when out
  // of combat.
  let newHp = 0;
  let maxHp = 0;
  const combat = c.ctx.room.combatState;
  const combatant = combat?.combatants.find((x) => x.tokenId === target.id);
  if (combatant) {
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + total);
    newHp = combatant.hp;
    maxHp = combatant.maxHp;
    if (combatant.characterId) {
      await pool.query(
        'UPDATE characters SET hit_points = $1 WHERE id = $2',
        [newHp, combatant.characterId],
      ).catch((e) => console.warn('[!healinglight] hp write failed:', e));
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: combatant.characterId,
        changes: { hitPoints: newHp },
      });
    }
  } else if (target.characterId) {
    const { rows: trows } = await pool.query(
      'SELECT hit_points, max_hit_points FROM characters WHERE id = $1',
      [target.characterId],
    );
    const trow = trows[0] as Record<string, unknown> | undefined;
    const curHp = Number(trow?.hit_points) || 0;
    maxHp = Number(trow?.max_hit_points) || 0;
    newHp = Math.min(maxHp, curHp + total);
    await pool.query(
      'UPDATE characters SET hit_points = $1 WHERE id = $2',
      [newHp, target.characterId],
    ).catch((e) => console.warn('[!healinglight] hp write failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { hitPoints: newHp },
    });
  }
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: target.id,
    hp: newHp,
    tempHp: 0,
    change: total,
    type: 'heal',
  });

  broadcastSystem(
    c.io, c.ctx,
    `✨ **Healing Light** — ${callerName} restores ${target.name} for ${n}d6 = [${rolls.join(',')}] = **${total} HP**${maxHp ? ` (${newHp}/${maxHp})` : ''}. Pool ${pool_.remaining}/${pool_.max}.`,
  );
  return true;
}

// ────── Awakened Mind (Great Old One Warlock L1) ───────
/**
 * Telepathic communication within 30 ft. Target doesn't have to
 * understand a language, but must be intelligent. One-way channel
 * by default. We just announce the contact.
 *
 *   !awakened <target> | <message>
 */
async function handleAwakenedMind(c: ChatCommandContext): Promise<boolean> {
  const raw = c.rest.trim();
  const pipe = raw.indexOf('|');
  if (pipe < 0) {
    whisperToCaller(c.io, c.ctx, '!awakened: usage `!awakened <target> | <message>`');
    return true;
  }
  const targetName = raw.slice(0, pipe).trim();
  const message = raw.slice(pipe + 1).trim();
  if (!targetName || !message) {
    whisperToCaller(c.io, c.ctx, '!awakened: target and message both required.');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!awakened: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!awakened: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('warlock')) {
    whisperToCaller(c.io, c.ctx, `!awakened: ${caller.name} isn't a Warlock.`);
    return true;
  }
  if (
    !hasFeature(row, /awakened\s+mind/i) &&
    !classLower.includes('great old one') &&
    !classLower.includes('goo')
  ) {
    whisperToCaller(c.io, c.ctx, `!awakened: ${caller.name} isn't a Great Old One Warlock.`);
    return true;
  }
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🧠 **Awakened Mind** — ${callerName} telepathically reaches ${target.name} (30 ft): *"${message}"*`,
  );
  return true;
}

// ────── Frenzy (Berserker Barbarian L3) ────────────────
/**
 * While raging, you can Frenzy. For the duration of the rage, you
 * can make a single melee weapon attack as a bonus action on each
 * of your turns. When your rage ends, you suffer 1 level of
 * exhaustion.
 *
 *   !frenzy         activate (requires Rage already active)
 *   !frenzy attack  spend bonus action for extra melee attack
 *   !frenzy end     end frenzy (applies exhaustion)
 */
async function handleFrenzy(c: ChatCommandContext): Promise<boolean> {
  const sub = (c.rest.trim().toLowerCase() || 'activate');
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!frenzy: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features, exhaustion_level FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('barbarian')) {
    whisperToCaller(c.io, c.ctx, `!frenzy: ${caller.name} isn't a Barbarian.`);
    return true;
  }
  if (!hasFeature(row, /frenzy/i) && !classLower.includes('berserker')) {
    whisperToCaller(c.io, c.ctx, `!frenzy: ${caller.name} isn't a Berserker.`);
    return true;
  }
  const callerName = (row?.name as string) || caller.name;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;

  if (sub === 'activate' || sub === 'on' || sub === 'start') {
    if (!(caller.conditions as string[]).includes('raging')) {
      whisperToCaller(c.io, c.ctx, '!frenzy: must be Raging first (!rage).');
      return true;
    }
    if ((caller.conditions as string[]).includes('frenzied')) {
      whisperToCaller(c.io, c.ctx, `!frenzy: ${callerName} is already frenzying.`);
      return true;
    }
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
      name: 'frenzied',
      source: `${callerName} (Frenzy)`,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 10,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: caller.id,
      changes: tokenConditionChanges(c.ctx.room, caller.id),
    });
    broadcastSystem(
      c.io, c.ctx,
      `🩸 **Frenzy!** — ${callerName} enters a berserker frenzy. Bonus-action melee attack each turn. **Exhaustion +1 when Rage ends.**`,
    );
    return true;
  }

  if (sub === 'attack' || sub === 'swing' || sub === 'hit') {
    if (!(caller.conditions as string[]).includes('frenzied')) {
      whisperToCaller(c.io, c.ctx, '!frenzy attack: not frenzying. Use `!frenzy` first.');
      return true;
    }
    const economy = c.ctx.room.actionEconomies.get(caller.id);
    if (economy?.bonusAction) {
      whisperToCaller(c.io, c.ctx, '!frenzy: bonus action already spent.');
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
    broadcastSystem(
      c.io, c.ctx,
      `🩸 ${callerName} Frenzy-strikes — extra melee weapon attack as a bonus action.`,
    );
    return true;
  }

  if (sub === 'end' || sub === 'off') {
    if (!(caller.conditions as string[]).includes('frenzied')) {
      whisperToCaller(c.io, c.ctx, '!frenzy end: not frenzying.');
      return true;
    }
    ConditionService.removeCondition(c.ctx.room.sessionId, caller.id, 'frenzied');
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: caller.id,
      changes: tokenConditionChanges(c.ctx.room, caller.id),
    });
    // Apply 1 level of exhaustion.
    const curExh = Number(row?.exhaustion_level) || 0;
    const newExh = Math.min(6, curExh + 1);
    await pool.query(
      'UPDATE characters SET exhaustion_level = $1 WHERE id = $2',
      [newExh, caller.characterId],
    ).catch((e) => console.warn('[!frenzy] exhaustion write failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: caller.characterId,
      changes: { exhaustionLevel: newExh },
    });
    broadcastSystem(
      c.io, c.ctx,
      `🩸 ${callerName}'s Frenzy ends. **Exhaustion level ${curExh} → ${newExh}.**`,
    );
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!frenzy: unknown subcommand "${sub}".`);
  return true;
}

// ────── Spirit Shield (Ancestral Guardian Barbarian L6) ──
/**
 * While raging: reaction to reduce damage that an ally within 30 ft
 * takes by 2d6 (3d6 at L10, 4d6 at L14).
 *
 *   !spiritshield <ally> <incoming-dmg>
 */
async function handleSpiritShield(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!spiritshield: usage `!spiritshield <ally> <incoming-dmg>`');
    return true;
  }
  const dmg = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(dmg) || dmg < 0) {
    whisperToCaller(c.io, c.ctx, '!spiritshield: damage must be a number.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!spiritshield: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!spiritshield: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('barbarian')) {
    whisperToCaller(c.io, c.ctx, `!spiritshield: ${caller.name} isn't a Barbarian.`);
    return true;
  }
  if (!hasFeature(row, /spirit\s+shield/i) && !classLower.includes('ancestral')) {
    whisperToCaller(c.io, c.ctx, `!spiritshield: ${caller.name} isn't an Ancestral Guardian.`);
    return true;
  }
  const lvl = Number(row?.level) || 6;
  if (lvl < 6) {
    whisperToCaller(c.io, c.ctx, '!spiritshield: requires Barbarian L6.');
    return true;
  }
  if (!(caller.conditions as string[]).includes('raging')) {
    whisperToCaller(c.io, c.ctx, '!spiritshield: requires Rage (ancestral spirits manifest).');
    return true;
  }

  // Burn reaction.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!spiritshield: reaction already spent.');
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

  // Roll the reduction dice.
  const diceCount = lvl >= 14 ? 4 : lvl >= 10 ? 3 : 2;
  const rolls: number[] = [];
  let reduction = 0;
  for (let i = 0; i < diceCount; i++) {
    const r = Math.floor(Math.random() * 6) + 1;
    rolls.push(r);
    reduction += r;
  }
  const actualReduction = Math.min(reduction, dmg);
  const newDmg = Math.max(0, dmg - reduction);
  const callerName = (row?.name as string) || caller.name;

  // Refund HP if target already took the damage and has a PC sheet.
  if (target.characterId && actualReduction > 0) {
    const { rows: trows } = await pool.query(
      'SELECT hit_points, max_hit_points FROM characters WHERE id = $1',
      [target.characterId],
    );
    const trow = trows[0] as Record<string, unknown> | undefined;
    const curHp = Number(trow?.hit_points) || 0;
    const maxHp = Number(trow?.max_hit_points) || 0;
    const newHp = Math.min(maxHp, curHp + actualReduction);
    if (newHp !== curHp) {
      await pool.query(
        'UPDATE characters SET hit_points = $1 WHERE id = $2',
        [newHp, target.characterId],
      ).catch((e) => console.warn('[!spiritshield] hp refund failed:', e));
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: target.characterId,
        changes: { hitPoints: newHp },
      });
      c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
        tokenId: target.id,
        hp: newHp,
        tempHp: 0,
        change: actualReduction,
        type: 'heal',
      });
    }
  }

  broadcastSystem(
    c.io, c.ctx,
    `🛡 **Spirit Shield** — ${callerName}'s ancestors intercept! ${diceCount}d6 = [${rolls.join(',')}] = **${reduction}** damage reduction vs ${target.name} (${dmg} → ${newDmg}).`,
  );
  return true;
}

// ────── Draconic Resilience (Sorcerer L1) ──────────────
/**
 * Passive — HP max is 1 + DEX mod + 1/level higher than base. Natural
 * AC = 13 + DEX mod. This command just reports the effective values;
 * actual HP + AC calc belongs in the character-level code path but
 * isn't wired yet, so this is a DM/player reference helper.
 *
 *   !draconicresilience    whisper effective AC + HP bonus
 */
async function handleDraconicResilience(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!draconicresilience: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('sorcerer')) {
    whisperToCaller(c.io, c.ctx, `!draconicresilience: ${caller.name} isn't a Sorcerer.`);
    return true;
  }
  if (!hasFeature(row, /draconic\s+resilience/i) && !classLower.includes('draconic')) {
    whisperToCaller(c.io, c.ctx, `!draconicresilience: ${caller.name} isn't a Draconic Sorcerer.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const dex = (scores as Record<string, number>).dex ?? 10;
  const dexMod = Math.floor((dex - 10) / 2);
  const naturalAC = 13 + dexMod;
  const hpBonus = lvl; // +1 HP per sorcerer level
  const callerName = (row?.name as string) || caller.name;
  whisperToCaller(
    c.io, c.ctx,
    `🐉 **Draconic Resilience** — ${callerName}: +${hpBonus} HP (1/sorcerer level) baked into max HP. Natural AC (unarmored) = **13 + DEX (${dexMod}) = ${naturalAC}**.`,
  );
  return true;
}

// ────── Elemental Affinity (Draconic Sorcerer L6) ──────
/**
 * When you cast a spell that deals damage of the type associated
 * with your draconic ancestry, add your CHA mod to one damage roll
 * of that spell. Additionally, you can spend 1 SP to gain resistance
 * to that damage type for 1 hour.
 *
 *   !elemental              — announce CHA mod bonus on next spell
 *   !elemental resist       — spend 1 SP for resistance (1 hr)
 */
async function handleElementalAffinity(c: ChatCommandContext): Promise<boolean> {
  const sub = (c.rest.trim().toLowerCase() || 'damage');
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!elemental: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('sorcerer')) {
    whisperToCaller(c.io, c.ctx, `!elemental: ${caller.name} isn't a Sorcerer.`);
    return true;
  }
  if (!hasFeature(row, /elemental\s+affinity/i) && !classLower.includes('draconic')) {
    whisperToCaller(c.io, c.ctx, `!elemental: ${caller.name} isn't a Draconic Sorcerer.`);
    return true;
  }
  const lvl = Number(row?.level) || 6;
  if (lvl < 6) {
    whisperToCaller(c.io, c.ctx, '!elemental: requires Sorcerer L6.');
    return true;
  }
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const chaMod = Math.floor((((scores as Record<string, number>).cha ?? 10) - 10) / 2);
  const callerName = (row?.name as string) || caller.name;

  // Look for ancestry hint (features) — Red=fire, Black=acid, Blue=lightning,
  // Green=poison, White=cold, Brass=fire, Bronze=lightning, Copper=acid,
  // Gold=fire, Silver=cold.
  const feats = getClassFeatures(row).join(' ').toLowerCase();
  let elementType = 'ancestry';
  if (/\b(red|brass|gold)\b/.test(feats) || /fire/.test(feats)) elementType = 'fire';
  else if (/\b(blue|bronze)\b/.test(feats) || /lightning/.test(feats)) elementType = 'lightning';
  else if (/\b(black|copper)\b/.test(feats) || /acid/.test(feats)) elementType = 'acid';
  else if (/\b(green)\b/.test(feats) || /poison/.test(feats)) elementType = 'poison';
  else if (/\b(white|silver)\b/.test(feats) || /cold/.test(feats)) elementType = 'cold';

  if (sub === 'resist') {
    // Spend 1 SP.
    let pools = c.ctx.room.pointPools.get(caller.characterId);
    if (!pools) {
      pools = new Map();
      c.ctx.room.pointPools.set(caller.characterId, pools);
    }
    const sp = pools.get('sp');
    if (!sp || sp.remaining < 1) {
      whisperToCaller(c.io, c.ctx, '!elemental resist: no SP available.');
      return true;
    }
    sp.remaining -= 1;
    broadcastSystem(
      c.io, c.ctx,
      `🐉 **Elemental Affinity (Resist)** — ${callerName} spends 1 SP, gains **resistance to ${elementType}** for 1 hour. SP ${sp.remaining}/${sp.max}.`,
    );
    return true;
  }

  // Damage path.
  broadcastSystem(
    c.io, c.ctx,
    `🐉 **Elemental Affinity** — ${callerName}'s next ${elementType}-damage spell adds **+${chaMod} CHA** to one damage roll.`,
  );
  return true;
}

// ────── Combat Wild Shape (Moon Druid L2) ───────────────
/**
 * Wild Shape as a bonus action (instead of standard action). While
 * transformed, can use a bonus action to expend a spell slot (1st or
 * higher) and regain 1d8 HP per slot level.
 *
 *   !moondruid shape          transform as bonus action
 *   !moondruid heal <slot>    spend slot for 1d8/level HP
 */
async function handleMoonDruid(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase() || '';
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!moondruid: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, spell_slots, hit_points, max_hit_points FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('druid')) {
    whisperToCaller(c.io, c.ctx, `!moondruid: ${caller.name} isn't a Druid.`);
    return true;
  }
  if (!hasFeature(row, /combat\s+wild\s+shape/i) && !classLower.includes('moon')) {
    whisperToCaller(c.io, c.ctx, `!moondruid: ${caller.name} isn't a Circle of the Moon Druid.`);
    return true;
  }
  const callerName = (row?.name as string) || caller.name;

  if (sub === 'shape' || sub === 'transform' || sub === '' || sub === 'on') {
    // Burn bonus action.
    const economy = c.ctx.room.actionEconomies.get(caller.id);
    if (economy?.bonusAction) {
      whisperToCaller(c.io, c.ctx, '!moondruid: bonus action already spent.');
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
    broadcastSystem(
      c.io, c.ctx,
      `🌙 **Combat Wild Shape** — ${callerName} transforms as a **bonus action**. (Use \`!wildshape <beast> <hp>\` to track the beast form.)`,
    );
    return true;
  }

  if (sub === 'heal') {
    const slotLvl = parseInt(parts[1], 10);
    if (!Number.isFinite(slotLvl) || slotLvl < 1 || slotLvl > 9) {
      whisperToCaller(c.io, c.ctx, '!moondruid heal: usage `!moondruid heal <slot-level>`');
      return true;
    }
    const slotsRaw = typeof row?.spell_slots === 'string'
      ? JSON.parse(row.spell_slots as string)
      : (row?.spell_slots ?? {});
    const slotsByLevel = (slotsRaw as Record<string, { current?: number; max?: number }>) || {};
    const key = String(slotLvl);
    const slot = slotsByLevel[key];
    if (!slot || (slot.current ?? 0) < 1) {
      whisperToCaller(c.io, c.ctx, `!moondruid heal: no level-${slotLvl} slot available.`);
      return true;
    }
    // Burn bonus action.
    const economy = c.ctx.room.actionEconomies.get(caller.id);
    if (economy?.bonusAction) {
      whisperToCaller(c.io, c.ctx, '!moondruid heal: bonus action already spent.');
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
    // Roll 1d8/slot level.
    const rolls: number[] = [];
    let total = 0;
    for (let i = 0; i < slotLvl; i++) {
      const r = Math.floor(Math.random() * 8) + 1;
      rolls.push(r);
      total += r;
    }
    // Spend slot.
    slot.current = (slot.current ?? 0) - 1;
    await pool.query(
      'UPDATE characters SET spell_slots = $1 WHERE id = $2',
      [JSON.stringify(slotsByLevel), caller.characterId],
    ).catch((e) => console.warn('[!moondruid heal] slot write failed:', e));
    // Apply heal.
    const curHp = Number(row?.hit_points) || 0;
    const maxHp = Number(row?.max_hit_points) || 0;
    const newHp = Math.min(maxHp, curHp + total);
    await pool.query(
      'UPDATE characters SET hit_points = $1 WHERE id = $2',
      [newHp, caller.characterId],
    ).catch((e) => console.warn('[!moondruid heal] hp write failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: caller.characterId,
      changes: { hitPoints: newHp, spellSlots: slotsByLevel },
    });
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: caller.id,
      hp: newHp,
      tempHp: 0,
      change: total,
      type: 'heal',
    });
    broadcastSystem(
      c.io, c.ctx,
      `🌙 **Combat Wild Shape (Heal)** — ${callerName} burns a L${slotLvl} slot, rolls ${slotLvl}d8 = [${rolls.join(',')}] = **${total} HP** → ${newHp}/${maxHp}.`,
    );
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!moondruid: unknown subcommand "${sub}".`);
  return true;
}

// ────── Fancy Footwork (Swashbuckler Rogue L3) ─────────
/**
 * When you make a melee attack against a creature, that creature
 * can't make opportunity attacks against you for the rest of the
 * turn. We apply a marker on the ATTACKER indicating which target
 * it applies to; the movement handler can check this.
 *
 *   !footwork <target>
 */
async function handleFootwork(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!footwork: usage `!footwork <target-you-attacked>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!footwork: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!footwork: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!footwork: ${caller.name} isn't a Rogue.`);
    return true;
  }
  if (!hasFeature(row, /fancy\s+footwork/i) && !classLower.includes('swashbuckler')) {
    whisperToCaller(c.io, c.ctx, `!footwork: ${caller.name} isn't a Swashbuckler.`);
    return true;
  }
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🗡 **Fancy Footwork** — ${callerName} attacked ${target.name}; ${target.name} cannot make opportunity attacks against ${callerName} for the rest of the turn.`,
  );
  return true;
}

// ────── Rakish Audacity (Swashbuckler Rogue L3) ────────
/**
 * Two benefits:
 *   1. Add CHA mod to initiative rolls.
 *   2. You don't need advantage to get Sneak Attack if no other
 *      enemy is within 5 ft of the target (you alone + target).
 *
 *   !rakish init       → announce +CHA initiative bonus (rolls adjusted d20)
 *   !rakish sneak      → confirm SA eligibility (1v1 within 5 ft)
 */
async function handleRakish(c: ChatCommandContext): Promise<boolean> {
  const sub = (c.rest.trim().toLowerCase() || 'sneak');
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!rakish: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!rakish: ${caller.name} isn't a Rogue.`);
    return true;
  }
  if (!hasFeature(row, /rakish\s+audacity/i) && !classLower.includes('swashbuckler')) {
    whisperToCaller(c.io, c.ctx, `!rakish: ${caller.name} isn't a Swashbuckler.`);
    return true;
  }
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const chaMod = Math.floor((((scores as Record<string, number>).cha ?? 10) - 10) / 2);
  const callerName = (row?.name as string) || caller.name;

  if (sub === 'init' || sub === 'initiative') {
    broadcastSystem(
      c.io, c.ctx,
      `🗡 **Rakish Audacity** — ${callerName} rolls initiative with **+${chaMod}** CHA on top of the usual DEX bonus.`,
    );
    return true;
  }

  if (sub === 'sneak' || sub === 'sa' || sub === 'sneakattack') {
    broadcastSystem(
      c.io, c.ctx,
      `🗡 **Rakish Audacity** — ${callerName} qualifies for Sneak Attack (1-v-1 within 5 ft — no advantage required).`,
    );
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!rakish: unknown subcommand "${sub}". Try \`init\` or \`sneak\`.`);
  return true;
}

registerChatCommand(['healinglight', 'hlight'], handleHealingLight);
registerChatCommand(['awakened', 'awakenedmind'], handleAwakenedMind);
registerChatCommand('frenzy', handleFrenzy);
registerChatCommand(['spiritshield', 'sshield'], handleSpiritShield);
registerChatCommand(['draconicresilience', 'dracres'], handleDraconicResilience);
registerChatCommand(['elemental', 'elementalaffinity'], handleElementalAffinity);
registerChatCommand(['moondruid', 'cws'], handleMoonDruid);
registerChatCommand(['footwork', 'fancyfootwork'], handleFootwork);
registerChatCommand(['rakish', 'audacity'], handleRakish);
