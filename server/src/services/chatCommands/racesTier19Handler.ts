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
 * Tier 19 — Race feature handlers:
 *   !radiantsoul           — Aasimar (transform + fly + +CHA radiant)
 *   !infernallegacy        — Tiefling (Hellish Rebuke, Darkness at higher levels)
 *   !stonesendurance       — Goliath (reduce dmg by 1d12+CON)
 *   !hiddenstep            — Firbolg (bonus action invisibility until next turn)
 *   !felinestep            — Tabaxi (Feline Agility — double speed 1 turn)
 *   !feystep               — Eladrin (30 ft teleport as bonus action, season effect)
 *   !magicres              — Yuan-Ti/Gnome/Satyr/etc. passive reminder
 *   !savageattacks <dmg>   — Half-Orc (extra damage die on crit)
 *   !mimicry <sound>       — Kenku (mimic any sound they've heard)
 *   !shift [minor]         — Shifter (change form for 1 min)
 *   !breath                is already in classFeatureHandlers (Dragonborn).
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

async function loadCaller(c: ChatCommandContext, cmd: string): Promise<{
  caller: Token;
  row: Record<string, unknown> | undefined;
  callerName: string;
  race: string;
  level: number;
} | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, race, features, ability_scores, proficiency_bonus FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return {
    caller,
    row,
    callerName: (row?.name as string) || caller.name,
    race: String(row?.race || '').toLowerCase(),
    level: Number(row?.level) || 1,
  };
}

// ────── Radiant Soul (Aasimar Protector) ────────────
async function handleRadiantSoul(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaller(c, 'radiantsoul');
  if (!loaded) return true;
  if (!loaded.race.includes('aasimar')) {
    whisperToCaller(c.io, c.ctx, `!radiantsoul: ${loaded.callerName} isn't an Aasimar.`);
    return true;
  }
  if (loaded.level < 3) {
    whisperToCaller(c.io, c.ctx, '!radiantsoul: requires Aasimar level 3.');
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.action) {
    whisperToCaller(c.io, c.ctx, '!radiantsoul: action already spent.');
    return true;
  }
  if (economy) {
    economy.action = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: loaded.caller.id,
      actionType: 'action',
      economy,
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Radiant Soul** — ${loaded.callerName} transforms (1 min): **fly speed 30 ft**, once/turn when dealing damage to a creature or object, add +${loaded.level} radiant to the damage roll.`,
  );
  return true;
}

// ────── Infernal Legacy (Tiefling) ─────────────────
async function handleInfernalLegacy(c: ChatCommandContext): Promise<boolean> {
  const spell = c.rest.trim().toLowerCase() || 'thaumaturgy';
  const loaded = await loadCaller(c, 'infernallegacy');
  if (!loaded) return true;
  if (!loaded.race.includes('tiefling')) {
    whisperToCaller(c.io, c.ctx, `!infernallegacy: ${loaded.callerName} isn't a Tiefling.`);
    return true;
  }
  const map: Record<string, { level: string; note: string }> = {
    thaumaturgy: { level: 'cantrip (always)', note: 'Voice up to 3× volume, fire flickers, loud noise, tremors, stone symbol, eye color shift.' },
    hellishrebuke: { level: '1/long rest (L3+)', note: 'Reaction when damaged: attacker DEX save or take 2d10 fire (+1d10 per caster level above 3).' },
    darkness: { level: '1/long rest (L5+)', note: '15-ft radius sphere of magical darkness for 10 min.' },
  };
  const key = spell.replace(/\s+/g, '');
  const info = map[key] ?? map.thaumaturgy;
  broadcastSystem(
    c.io, c.ctx,
    `🔥 **Infernal Legacy** (${info.level}) — ${loaded.callerName} casts **${spell}**: ${info.note}`,
  );
  return true;
}

// ────── Stone's Endurance (Goliath) ────────────────
async function handleStonesEndurance(c: ChatCommandContext): Promise<boolean> {
  const dmg = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(dmg) || dmg < 0) {
    whisperToCaller(c.io, c.ctx, '!stonesendurance: usage `!stonesendurance <incoming-dmg>`');
    return true;
  }
  const loaded = await loadCaller(c, 'stonesendurance');
  if (!loaded) return true;
  if (!loaded.race.includes('goliath')) {
    whisperToCaller(c.io, c.ctx, `!stonesendurance: ${loaded.callerName} isn't a Goliath.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!stonesendurance: reaction already spent.');
    return true;
  }
  if (economy) {
    economy.reaction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: loaded.caller.id,
      actionType: 'reaction',
      economy,
    });
  }
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const conMod = abilityMod(scores as Record<string, number>, 'con');
  const roll = Math.floor(Math.random() * 12) + 1;
  const reduction = roll + conMod;
  const actualRed = Math.min(reduction, dmg);
  const newDmg = Math.max(0, dmg - reduction);
  // Refund HP if PC.
  if (actualRed > 0 && loaded.caller.characterId) {
    const { rows } = await pool.query(
      'SELECT hit_points, max_hit_points FROM characters WHERE id = $1',
      [loaded.caller.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const cur = Number(row?.hit_points) || 0;
    const maxHp = Number(row?.max_hit_points) || 0;
    const newHp = Math.min(maxHp, cur + actualRed);
    await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [newHp, loaded.caller.characterId]).catch(() => {});
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: loaded.caller.characterId,
      changes: { hitPoints: newHp },
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `⛰ **Stone's Endurance** — ${loaded.callerName} absorbs 1d12+${conMod} = **${reduction}** damage (${dmg} → ${newDmg}). 1/short rest.`,
  );
  return true;
}

// ────── Hidden Step (Firbolg) ──────────────────────
async function handleHiddenStep(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaller(c, 'hiddenstep');
  if (!loaded) return true;
  if (!loaded.race.includes('firbolg')) {
    whisperToCaller(c.io, c.ctx, `!hiddenstep: ${loaded.callerName} isn't a Firbolg.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!hiddenstep: bonus action already spent.');
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: loaded.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, loaded.caller.id, {
    name: 'invisible',
    source: `${loaded.callerName} (Hidden Step)`,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 1,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: loaded.caller.id,
    changes: tokenConditionChanges(c.ctx.room, loaded.caller.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🌲 **Hidden Step** — ${loaded.callerName} turns **invisible** until end of next turn or after attacking/casting. 1/short rest.`,
  );
  return true;
}

// ────── Feline Agility (Tabaxi) ────────────────────
async function handleFelineStep(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaller(c, 'felinestep');
  if (!loaded) return true;
  if (!loaded.race.includes('tabaxi')) {
    whisperToCaller(c.io, c.ctx, `!felinestep: ${loaded.callerName} isn't a Tabaxi.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy) {
    economy.movementRemaining += economy.movementMax;
    economy.movementMax *= 2;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: loaded.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🐈 **Feline Agility** — ${loaded.callerName}'s speed **doubled** this turn. Must end turn stationary before using again.`,
  );
  return true;
}

// ────── Fey Step (Eladrin) ─────────────────────────
const SEASON_EFFECTS: Record<string, string> = {
  autumn: 'Up to 2 creatures within 10 ft of you must make a WIS save or be charmed for 1 min.',
  winter: 'One creature within 5 ft must make a WIS save or be frightened until end of your next turn.',
  spring: 'Touch 1 willing creature within 5 ft and swap positions on the teleport.',
  summer: 'Each creature within 5 ft of your destination takes fire damage = CHA mod (min 1).',
};

async function handleFeyStep(c: ChatCommandContext): Promise<boolean> {
  const season = c.rest.trim().toLowerCase();
  const loaded = await loadCaller(c, 'feystep');
  if (!loaded) return true;
  if (!loaded.race.includes('eladrin')) {
    whisperToCaller(c.io, c.ctx, `!feystep: ${loaded.callerName} isn't an Eladrin.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!feystep: bonus action already spent.');
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: loaded.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  const seasonEffect = season && season in SEASON_EFFECTS ? SEASON_EFFECTS[season] : '';
  broadcastSystem(
    c.io, c.ctx,
    `🧚 **Fey Step** — ${loaded.callerName} teleports up to **30 ft** to an unoccupied space they can see.${seasonEffect ? ` (${season.charAt(0).toUpperCase() + season.slice(1)}: ${seasonEffect})` : ''} 1/short rest.`,
  );
  return true;
}

// ────── Magic Resistance (passive) ────────────────
async function handleMagicRes(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaller(c, 'magicres');
  if (!loaded) return true;
  const magicResRaces = ['yuan-ti', 'yuanti', 'satyr', 'gnome'];
  if (!magicResRaces.some((r) => loaded.race.includes(r))) {
    whisperToCaller(c.io, c.ctx, `!magicres: ${loaded.callerName}'s race doesn't grant Magic Resistance.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Magic Resistance** — ${loaded.callerName} has **advantage on saving throws against spells and magical effects**.`,
  );
  return true;
}

// ────── Savage Attacks (Half-Orc) ─────────────────
async function handleSavageAttacks(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaller(c, 'savageattacks');
  if (!loaded) return true;
  if (!loaded.race.includes('half-orc') && !loaded.race.includes('halforc') && !loaded.race.includes('orc')) {
    whisperToCaller(c.io, c.ctx, `!savageattacks: ${loaded.callerName} isn't a Half-Orc.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🪓 **Savage Attacks** — ${loaded.callerName} rolls **one additional weapon damage die** when scoring a critical hit with a melee weapon.`,
  );
  return true;
}

// ────── Kenku Mimicry ──────────────────────────────
async function handleMimicry(c: ChatCommandContext): Promise<boolean> {
  const sound = c.rest.trim() || 'a sound';
  const loaded = await loadCaller(c, 'mimicry');
  if (!loaded) return true;
  if (!loaded.race.includes('kenku')) {
    whisperToCaller(c.io, c.ctx, `!mimicry: ${loaded.callerName} isn't a Kenku.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🦜 **Mimicry** — ${loaded.callerName} perfectly imitates **${sound}**. Deception (CHA) vs listener's Insight (WIS) to detect the fake.`,
  );
  return true;
}

// ────── Shifter (Change form) ─────────────────────
async function handleShift(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaller(c, 'shift');
  if (!loaded) return true;
  if (!loaded.race.includes('shifter')) {
    whisperToCaller(c.io, c.ctx, `!shift: ${loaded.callerName} isn't a Shifter.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!shift: bonus action already spent.');
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: loaded.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const conMod = abilityMod(scores as Record<string, number>, 'con');
  const tempHp = loaded.level + conMod;
  if (loaded.caller.characterId) {
    const { rows } = await pool.query('SELECT temp_hit_points FROM characters WHERE id = $1', [loaded.caller.characterId]);
    const cur = Number((rows[0] as Record<string, unknown>)?.temp_hit_points) || 0;
    const newThp = Math.max(cur, tempHp);
    await pool.query('UPDATE characters SET temp_hit_points = $1 WHERE id = $2', [newThp, loaded.caller.characterId]).catch(() => {});
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: loaded.caller.characterId,
      changes: { tempHitPoints: newThp },
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🐺 **Shift** — ${loaded.callerName} takes on beast aspects for 1 min: **${tempHp} temp HP** (level + CON mod), plus subrace ability. 1/short rest.`,
  );
  return true;
}

registerChatCommand(['radiantsoul', 'rsoul'], handleRadiantSoul);
registerChatCommand(['infernallegacy', 'infernal'], handleInfernalLegacy);
registerChatCommand(['stonesendurance', 'goliath'], handleStonesEndurance);
registerChatCommand(['hiddenstep', 'firbolg'], handleHiddenStep);
registerChatCommand(['felinestep', 'feline', 'tabaxi'], handleFelineStep);
registerChatCommand(['feystep', 'eladrin'], handleFeyStep);
registerChatCommand(['magicres', 'mr'], handleMagicRes);
registerChatCommand(['savageattacks', 'halforc'], handleSavageAttacks);
registerChatCommand(['mimicry', 'kenku'], handleMimicry);
registerChatCommand(['shift', 'shifter'], handleShift);
