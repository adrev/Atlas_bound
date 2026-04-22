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
 * Tier 11 subclass features:
 * - Samurai Fighter — Fighting Spirit
 * - Echo Knight Fighter — Manifest Echo + Unleash Incarnation
 * - Cavalier Fighter — Unwavering Mark + Warding Maneuver
 * - Wild Magic Barbarian — Wild Surge (d8 table)
 * - Zealot Barbarian — Divine Fury + Warrior of the Gods
 * - Open Hand Monk — Open Hand Technique
 * - Shadow Sorcerer — Strength of the Grave + Hound of Ill Omen
 * - Glamour Bard — Mantle of Inspiration + Enthralling Performance
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

function abilityMod(scores: Record<string, number> | undefined, ability: string): number {
  const raw = (scores ?? {})[ability] ?? 10;
  return Math.floor((raw - 10) / 2);
}

// ────── Fighting Spirit (Samurai Fighter L3) ───────────
/**
 * Bonus action: gain advantage on all attack rolls until end of
 * turn + temporary HP (5 at L3, 10 at L10, 15 at L15).
 * Uses = PB per long rest.
 *
 *   !fightingspirit
 */
async function handleFightingSpirit(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!fightingspirit: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, temp_hit_points FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!fightingspirit: ${caller.name} isn't a Fighter.`);
    return true;
  }
  if (!hasFeature(row, /fighting\s+spirit/i) && !classLower.includes('samurai')) {
    whisperToCaller(c.io, c.ctx, `!fightingspirit: ${caller.name} isn't a Samurai.`);
    return true;
  }
  const lvl = Number(row?.level) || 3;
  const thp = lvl >= 15 ? 15 : lvl >= 10 ? 10 : 5;
  // Burn bonus action.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!fightingspirit: bonus action already spent.');
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
  // Temp HP (keep max, RAW).
  const curThp = Number(row?.temp_hit_points) || 0;
  const newThp = Math.max(curThp, thp);
  await pool.query(
    'UPDATE characters SET temp_hit_points = $1 WHERE id = $2',
    [newThp, caller.characterId],
  ).catch((e) => console.warn('[!fightingspirit] thp write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { tempHitPoints: newThp },
  });
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `⚔ **Fighting Spirit** — ${callerName} gains **advantage on attacks until end of turn** + **${thp} temp HP** (now ${newThp}).`,
  );
  return true;
}

// ────── Echo Knight Fighter (L3) ────────────────────────
/**
 * Summon Echo (15 ft) — bonus action. Echo is an AC 14, 1 HP duplicate
 * you can attack through (Manifest Echo). On subsequent turns you can
 * teleport to swap places with it.
 *
 * Unleash Incarnation (L7) — once per round, make one additional
 * attack from the Echo's position as part of the Attack action.
 * Uses per long rest = CON mod.
 *
 *   !echo summon <x> <y>      — manifest the echo at grid position
 *   !echo swap                — teleport to echo's position
 *   !echo attack              — attack from echo's position
 *   !echo dismiss             — despawn the echo
 */
const echoPositions = new Map<string, { x: number; y: number }>();
const unleashUsed = new Map<string, number>(); // characterId -> roundNumber last used

async function handleEchoKnight(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase() || 'summon';
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!echo: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!echo: ${caller.name} isn't a Fighter.`);
    return true;
  }
  if (!hasFeature(row, /(manifest\s+echo|echo\s+knight)/i) && !classLower.includes('echo')) {
    whisperToCaller(c.io, c.ctx, `!echo: ${caller.name} isn't an Echo Knight.`);
    return true;
  }
  const callerName = (row?.name as string) || caller.name;

  if (sub === 'summon' || sub === 'manifest') {
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      whisperToCaller(c.io, c.ctx, '!echo summon: usage `!echo summon <gridX> <gridY>` (within 15 ft / 3 squares of you)');
      return true;
    }
    const economy = c.ctx.room.actionEconomies.get(caller.id);
    if (economy?.bonusAction) {
      whisperToCaller(c.io, c.ctx, '!echo summon: bonus action already spent.');
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
    echoPositions.set(caller.characterId, { x, y });
    broadcastSystem(
      c.io, c.ctx,
      `🪞 **Manifest Echo** — ${callerName}'s echo appears at (${x}, ${y}). AC 14, 1 HP. Movement shared with ${callerName}.`,
    );
    return true;
  }

  if (sub === 'swap' || sub === 'teleport') {
    const echo = echoPositions.get(caller.characterId);
    if (!echo) {
      whisperToCaller(c.io, c.ctx, '!echo swap: no echo manifested. Use `!echo summon <x> <y>` first.');
      return true;
    }
    // Swap: echo -> caller's current position, caller -> echo's position.
    const oldCallerPos = { x: caller.x, y: caller.y };
    echoPositions.set(caller.characterId, oldCallerPos);
    // Don't actually move the token (DM controls movement) — just announce.
    broadcastSystem(
      c.io, c.ctx,
      `🪞 **Echo Swap** — ${callerName} teleports to echo at (${echo.x}, ${echo.y}); echo takes ${callerName}'s old position. (15 ft, no action cost)`,
    );
    return true;
  }

  if (sub === 'attack' || sub === 'unleash') {
    const echo = echoPositions.get(caller.characterId);
    if (!echo) {
      whisperToCaller(c.io, c.ctx, '!echo attack: no echo manifested.');
      return true;
    }
    const lvl = Number(row?.level) || 3;
    if (lvl >= 7) {
      // Unleash Incarnation: extra attack as part of Attack action.
      const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
      const lastUsed = unleashUsed.get(caller.characterId) ?? -1;
      if (lastUsed === currentRound) {
        whisperToCaller(c.io, c.ctx, '!echo unleash: already used this round (Unleash Incarnation = 1/round).');
        return true;
      }
      unleashUsed.set(caller.characterId, currentRound);
      const scores = typeof row?.ability_scores === 'string'
        ? JSON.parse(row.ability_scores as string)
        : (row?.ability_scores ?? {});
      const conMod = Math.max(1, abilityMod(scores as Record<string, number>, 'con'));
      broadcastSystem(
        c.io, c.ctx,
        `🪞 **Unleash Incarnation** — ${callerName} adds an extra attack from the echo's position at (${echo.x}, ${echo.y}). Uses/long rest: ${conMod}.`,
      );
    } else {
      broadcastSystem(
        c.io, c.ctx,
        `🪞 ${callerName} attacks from the echo's position at (${echo.x}, ${echo.y}) (range + reach measured from echo).`,
      );
    }
    return true;
  }

  if (sub === 'dismiss' || sub === 'clear') {
    echoPositions.delete(caller.characterId);
    broadcastSystem(c.io, c.ctx, `🪞 ${callerName}'s echo dissipates.`);
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!echo: unknown subcommand "${sub}".`);
  return true;
}

// ────── Cavalier Fighter (L3) ──────────────────────────
/**
 * Unwavering Mark — when you hit a creature with a melee weapon,
 * you can mark it until end of your next turn. Marked creature has
 * disadvantage vs anyone other than you, and can punish it with a
 * reaction attack if it attacks someone else. (Encoded as `marked`
 * pseudo-condition in shared.)
 *
 * Warding Maneuver (L7) — reaction: add 1d8 to an ally's AC vs one
 * incoming attack if within 5 ft.
 *
 *   !mark <target>              (alias: !cavmark — reserves !mark
 *                                for ranger Hunter's Mark)
 *   !warding <ally> <attacker>  warding maneuver reaction
 */
async function handleCavalierMark(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!cavmark: usage `!cavmark <target>` (after hitting in melee)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!cavmark: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!cavmark: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!cavmark: ${caller.name} isn't a Fighter.`);
    return true;
  }
  if (!hasFeature(row, /unwavering\s+mark/i) && !classLower.includes('cavalier')) {
    whisperToCaller(c.io, c.ctx, `!cavmark: ${caller.name} isn't a Cavalier.`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'cav-marked',
    source: `${caller.name} (Unwavering Mark)`,
    casterTokenId: caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 1,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: { conditions: target.conditions },
  });
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🛡 **Unwavering Mark** — ${callerName} marks ${target.name}. Disadvantage on attacks vs anyone other than ${callerName}; if it attacks someone else, ${callerName} can use a reaction for a special melee attack.`,
  );
  return true;
}

async function handleWardingManeuver(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!warding: usage `!warding <ally>` (reaction when ally within 5 ft is targeted)');
    return true;
  }
  const allyName = parts.join(' ');
  const ally = resolveTargetByName(c.ctx, allyName);
  if (!ally) {
    whisperToCaller(c.io, c.ctx, `!warding: no token named "${allyName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!warding: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!warding: ${caller.name} isn't a Fighter.`);
    return true;
  }
  if (!hasFeature(row, /warding\s+maneuver/i) && !classLower.includes('cavalier')) {
    whisperToCaller(c.io, c.ctx, `!warding: ${caller.name} isn't a Cavalier.`);
    return true;
  }
  const lvl = Number(row?.level) || 7;
  if (lvl < 7) {
    whisperToCaller(c.io, c.ctx, '!warding: requires Fighter L7.');
    return true;
  }
  // Burn reaction.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!warding: reaction already spent.');
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
  const roll = Math.floor(Math.random() * 8) + 1;
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🛡 **Warding Maneuver** — ${callerName} protects ${ally.name}: **+1d8 = ${roll}** to AC + DEX save vs the triggering attack (reaction). Usable ${Math.max(1, abilityMod(typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores as Record<string, number> ?? {}), 'con'))}/long rest.`,
  );
  return true;
}

// ────── Wild Magic Barbarian (L3) ─────────────────────
/**
 * When you enter Rage, roll on a d8 Wild Magic table. Effect lasts
 * until rage ends.
 *
 *   !wildbarb    roll + apply (announce the effect)
 */
const WILD_BARB_TABLE: Record<number, string> = {
  1: 'Shadowy tendrils — each creature within 30 ft makes DC 15 CON save or takes 1d12 necrotic. Regain HP = total necrotic dealt.',
  2: 'Ghostly image for 1 min — creatures have disadvantage on opportunity attacks vs you.',
  3: 'Magical energy arcs — one creature of your choice within 30 ft takes 1d12 force damage.',
  4: 'Veil of twinkling stars — bright light 30 ft, dim 60 ft beyond. Creatures provoke OA when they approach within 5 ft.',
  5: 'You can teleport up to 30 ft as a bonus action on each of your turns.',
  6: 'Intangible spirit manifests within 5 ft of a creature within 30 ft — it has disadvantage until next turn.',
  7: 'Plants sprout in 15 ft sphere centered on you — difficult terrain until rage ends.',
  8: 'Beam of light shoots from your chest — DC 15 CON save or be blinded until next turn. Repeats each of your turns.',
};

async function handleWildBarb(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!wildbarb: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('barbarian')) {
    whisperToCaller(c.io, c.ctx, `!wildbarb: ${caller.name} isn't a Barbarian.`);
    return true;
  }
  if (!hasFeature(row, /wild\s+magic/i) && !classLower.includes('wild magic')) {
    whisperToCaller(c.io, c.ctx, `!wildbarb: ${caller.name} isn't a Wild Magic Barbarian.`);
    return true;
  }
  if (!(caller.conditions as string[]).includes('raging')) {
    whisperToCaller(c.io, c.ctx, '!wildbarb: roll when you enter Rage (`!rage` first).');
    return true;
  }
  const d8 = Math.floor(Math.random() * 8) + 1;
  const effect = WILD_BARB_TABLE[d8];
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🌀 **Wild Magic Surge** — ${callerName} rolls d8 = **${d8}**: ${effect}`,
  );
  return true;
}

// ────── Zealot Barbarian (L3) ─────────────────────────
/**
 * Divine Fury — while raging, the first creature you hit with a melee
 * weapon takes extra damage = 1d6 + half barbarian level, radiant or
 * necrotic (your choice), once per turn.
 *
 * Warrior of the Gods — L3 utility: the cost of Revivify / Raise Dead
 * is waived when cast on you. DM reminder, not a command.
 *
 *   !divinefury [necro]   — roll 1d6 + half-level, announce
 */
const divineFuryUsed = new Set<string>();

async function handleDivineFury(c: ChatCommandContext): Promise<boolean> {
  const useNecrotic = c.rest.trim().toLowerCase().startsWith('necro');
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!divinefury: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('barbarian')) {
    whisperToCaller(c.io, c.ctx, `!divinefury: ${caller.name} isn't a Barbarian.`);
    return true;
  }
  if (!hasFeature(row, /divine\s+fury/i) && !classLower.includes('zealot')) {
    whisperToCaller(c.io, c.ctx, `!divinefury: ${caller.name} isn't a Zealot.`);
    return true;
  }
  if (!(caller.conditions as string[]).includes('raging')) {
    whisperToCaller(c.io, c.ctx, '!divinefury: requires Rage.');
    return true;
  }
  const combat = c.ctx.room.combatState;
  const turnKey = `${combat?.roundNumber ?? 0}_${combat?.currentTurnIndex ?? 0}_${caller.characterId}`;
  if (divineFuryUsed.has(turnKey)) {
    whisperToCaller(c.io, c.ctx, '!divinefury: already used this turn.');
    return true;
  }
  divineFuryUsed.add(turnKey);
  const lvl = Number(row?.level) || 3;
  const half = Math.floor(lvl / 2);
  const roll = Math.floor(Math.random() * 6) + 1;
  const total = roll + half;
  const type = useNecrotic ? 'necrotic' : 'radiant';
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `⚡ **Divine Fury** — ${callerName} channels divine wrath: **+1d6+${half} = ${total} ${type}** damage (once/turn, first melee hit).`,
  );
  return true;
}

// ────── Open Hand Monk (L3) ──────────────────────────
/**
 * When you hit with Flurry of Blows, each unarmed strike can:
 *   - force CON save vs knocked prone (or)
 *   - force STR save vs push 15 ft (or)
 *   - no reactions until end of your next turn
 *
 *   !openhand <target> <dc> <prone|push|noreact>
 */
async function handleOpenHand(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    whisperToCaller(
      c.io, c.ctx,
      '!openhand: usage `!openhand <target> <dc> <prone|push|noreact>`',
    );
    return true;
  }
  const effect = parts[parts.length - 1].toLowerCase();
  if (!['prone', 'push', 'noreact'].includes(effect)) {
    whisperToCaller(c.io, c.ctx, '!openhand: effect must be `prone`, `push`, or `noreact`.');
    return true;
  }
  const dc = parseInt(parts[parts.length - 2], 10);
  if (!Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!openhand: DC must be a number.');
    return true;
  }
  const targetName = parts.slice(0, -2).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!openhand: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!openhand: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('monk')) {
    whisperToCaller(c.io, c.ctx, `!openhand: ${caller.name} isn't a Monk.`);
    return true;
  }
  if (!hasFeature(row, /open\s+hand\s+technique/i) && !classLower.includes('open hand')) {
    whisperToCaller(c.io, c.ctx, `!openhand: ${caller.name} isn't an Open Hand Monk.`);
    return true;
  }
  // noreact has no save — it's automatic on a hit.
  if (effect === 'noreact') {
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'no-reactions',
      source: `${caller.name} (Open Hand)`,
      casterTokenId: caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 1,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: { conditions: target.conditions },
    });
    broadcastSystem(
      c.io, c.ctx,
      `👊 **Open Hand Technique** — ${caller.name} strips ${target.name} of reactions until end of next turn (no save).`,
    );
    return true;
  }
  // Roll save.
  const saveAbility = effect === 'prone' ? 'dex' : 'str';
  let saveMod = 0;
  let tName = target.name;
  if (target.characterId) {
    const { rows: trows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = $1',
      [target.characterId],
    );
    const trow = trows[0] as Record<string, unknown> | undefined;
    try {
      const scores = typeof trow?.ability_scores === 'string'
        ? JSON.parse(trow.ability_scores as string)
        : (trow?.ability_scores ?? {});
      const prof = Number(trow?.proficiency_bonus) || 2;
      const saves = typeof trow?.saving_throws === 'string'
        ? JSON.parse(trow.saving_throws as string)
        : (trow?.saving_throws ?? []);
      saveMod = abilityMod(scores as Record<string, number>, saveAbility) +
        (Array.isArray(saves) && saves.includes(saveAbility) ? prof : 0);
      if (trow?.name) tName = trow.name as string;
    } catch { /* ignore */ }
  }
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + saveMod;
  const saved = total >= dc;
  const modSign = saveMod >= 0 ? '+' : '';
  const label = effect === 'prone' ? 'DEX save vs prone' : 'STR save vs push 15 ft';
  const condName = effect === 'prone' ? 'prone' : null;
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  if (!saved && condName) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: condName,
      source: `${caller.name} (Open Hand)`,
      casterTokenId: caller.id,
      appliedRound: currentRound,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: { conditions: target.conditions },
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `👊 **Open Hand Technique** (${label}) — ${tName}: d20=${d20}${modSign}${saveMod}=${total} vs ${dc} → ${saved ? 'SAVED' : effect === 'push' ? 'pushed 15 ft' : 'KNOCKED PRONE'}`,
  );
  return true;
}

// ────── Shadow Sorcerer (L1 / L3) ───────────────────
/**
 * Strength of the Grave (L1) — when reduced to 0 HP but not killed
 * outright, CHA save DC 5 + damage taken; on success drop to 1 HP
 * instead. 1/long rest per PHB; XGtE says per short rest. We go
 * with XGtE (short rest).
 *
 * Hound of Ill Omen (L3) — bonus action, spend 3 SP: summon a dire
 * wolf that pursues a target; target has disadvantage on saves vs
 * your spells while hound is within 5 ft.
 *
 *   !grave <dmg>                    — CHA save to stay at 1 HP
 *   !hound <target>                 — 3 SP summon
 */
async function handleGrave(c: ChatCommandContext): Promise<boolean> {
  const dmg = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(dmg) || dmg < 0) {
    whisperToCaller(c.io, c.ctx, '!grave: usage `!grave <damage-taken>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!grave: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features, ability_scores, saving_throws, proficiency_bonus, hit_points FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('sorcerer')) {
    whisperToCaller(c.io, c.ctx, `!grave: ${caller.name} isn't a Sorcerer.`);
    return true;
  }
  if (!hasFeature(row, /strength\s+of\s+the\s+grave/i) && !classLower.includes('shadow')) {
    whisperToCaller(c.io, c.ctx, `!grave: ${caller.name} isn't a Shadow Sorcerer.`);
    return true;
  }
  const dc = 5 + dmg;
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const prof = Number(row?.proficiency_bonus) || 2;
  const saves = typeof row?.saving_throws === 'string'
    ? JSON.parse(row.saving_throws as string)
    : (row?.saving_throws ?? []);
  const chaSave = abilityMod(scores as Record<string, number>, 'cha') +
    (Array.isArray(saves) && saves.includes('cha') ? prof : 0);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + chaSave;
  const saved = total >= dc;
  const sign = chaSave >= 0 ? '+' : '';
  const callerName = (row?.name as string) || caller.name;
  if (saved) {
    // Force HP to 1 if currently 0.
    const curHp = Number(row?.hit_points) || 0;
    if (curHp <= 0) {
      await pool.query(
        'UPDATE characters SET hit_points = 1 WHERE id = $1',
        [caller.characterId],
      ).catch((e) => console.warn('[!grave] hp write failed:', e));
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
    }
  }
  broadcastSystem(
    c.io, c.ctx,
    `💀 **Strength of the Grave** — ${callerName} clings to unlife! CHA save d20=${d20}${sign}${chaSave}=${total} vs DC ${dc} → ${saved ? '**SURVIVES at 1 HP**' : 'FAILS, drops normally'}.`,
  );
  return true;
}

async function handleHound(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!hound: usage `!hound <target>` (3 SP)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!hound: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!hound: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('sorcerer')) {
    whisperToCaller(c.io, c.ctx, `!hound: ${caller.name} isn't a Sorcerer.`);
    return true;
  }
  if (!hasFeature(row, /hound\s+of\s+ill\s+omen/i) && !classLower.includes('shadow')) {
    whisperToCaller(c.io, c.ctx, `!hound: ${caller.name} isn't a Shadow Sorcerer.`);
    return true;
  }
  // Spend 3 SP.
  let pools = c.ctx.room.pointPools.get(caller.characterId);
  if (!pools) {
    pools = new Map();
    c.ctx.room.pointPools.set(caller.characterId, pools);
  }
  const sp = pools.get('sp');
  if (!sp || sp.remaining < 3) {
    whisperToCaller(c.io, c.ctx, `!hound: requires 3 SP (have ${sp?.remaining ?? 0}).`);
    return true;
  }
  sp.remaining -= 3;
  // Burn bonus action.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!hound: bonus action already spent.');
    sp.remaining += 3; // refund
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
  const callerName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🐺 **Hound of Ill Omen** — ${callerName} summons a spectral dire wolf to hunt ${target.name}. 5 min, 40 ft speed, ignores difficult terrain. ${target.name} has **disadvantage on saves** vs ${callerName}'s spells while hound is within 5 ft. SP ${sp.remaining}/${sp.max}.`,
  );
  return true;
}

// ────── Glamour Bard (L3) ─────────────────────────────
/**
 * Mantle of Inspiration — bonus action, spend 1 Bardic Inspiration:
 * grant temp HP = 5/8/11/14 (die size 6/8/10/12) to up to CHA mod
 * creatures within 60 ft, each can immediately use its reaction to
 * move up to its speed without provoking OAs.
 *
 * Enthralling Performance (L3) — 1-min performance, up to CHA mod
 * creatures that can see + hear make WIS save or charmed for 1 hour.
 *
 *   !mantle <t1> [t2 …]       — spend 1 BI, grant tmpHP table
 *   !enthrall <t1> [t2 …] <dc> — performance; WIS save
 */
async function handleMantle(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!mantle: usage `!mantle <target1> [target2 …]`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!mantle: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, features, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('bard')) {
    whisperToCaller(c.io, c.ctx, `!mantle: ${caller.name} isn't a Bard.`);
    return true;
  }
  if (!hasFeature(row, /mantle\s+of\s+inspiration/i) && !classLower.includes('glamour')) {
    whisperToCaller(c.io, c.ctx, `!mantle: ${caller.name} isn't a Glamour Bard.`);
    return true;
  }
  const lvl = Number(row?.level) || 3;
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const chaMod = Math.max(1, abilityMod(scores as Record<string, number>, 'cha'));
  if (parts.length > chaMod) {
    whisperToCaller(c.io, c.ctx, `!mantle: can target up to CHA mod (${chaMod}).`);
    return true;
  }
  const thpValue = lvl >= 15 ? 14 : lvl >= 10 ? 11 : lvl >= 5 ? 8 : 5;
  // Burn bonus action.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!mantle: bonus action already spent.');
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
  // Apply temp HP to each target.
  const callerName = (row?.name as string) || caller.name;
  const lines: string[] = [];
  lines.push(`🎭 **Mantle of Inspiration** — ${callerName} grants ${thpValue} temp HP + free reaction-move to:`);
  for (const targetName of parts) {
    const target = resolveTargetByName(c.ctx, targetName);
    if (!target) {
      lines.push(`  • ${targetName}: not found`);
      continue;
    }
    if (target.characterId) {
      const { rows: trows } = await pool.query(
        'SELECT temp_hit_points FROM characters WHERE id = $1',
        [target.characterId],
      );
      const curThp = Number((trows[0] as Record<string, unknown>)?.temp_hit_points) || 0;
      const newThp = Math.max(curThp, thpValue);
      await pool.query(
        'UPDATE characters SET temp_hit_points = $1 WHERE id = $2',
        [newThp, target.characterId],
      ).catch((e) => console.warn('[!mantle] thp write failed:', e));
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: target.characterId,
        changes: { tempHitPoints: newThp },
      });
      lines.push(`  • ${target.name}: +${thpValue} temp HP (now ${newThp})`);
    } else {
      lines.push(`  • ${target.name}: +${thpValue} temp HP (NPC — apply manually)`);
    }
  }
  lines.push(`   Spent 1 Bardic Inspiration die.`);
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

async function handleEnthrall(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!enthrall: usage `!enthrall <target1> [target2 …] <dc>`');
    return true;
  }
  const dc = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(dc)) {
    whisperToCaller(c.io, c.ctx, '!enthrall: DC must be a number.');
    return true;
  }
  const targets = parts.slice(0, -1);
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!enthrall: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, name, features, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('bard')) {
    whisperToCaller(c.io, c.ctx, `!enthrall: ${caller.name} isn't a Bard.`);
    return true;
  }
  if (!hasFeature(row, /enthralling\s+performance/i) && !classLower.includes('glamour')) {
    whisperToCaller(c.io, c.ctx, `!enthrall: ${caller.name} isn't a Glamour Bard.`);
    return true;
  }
  const scores = typeof row?.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row?.ability_scores ?? {});
  const chaMod = Math.max(1, abilityMod(scores as Record<string, number>, 'cha'));
  if (targets.length > chaMod) {
    whisperToCaller(c.io, c.ctx, `!enthrall: can affect up to CHA mod (${chaMod}).`);
    return true;
  }
  const callerName = (row?.name as string) || caller.name;
  const lines: string[] = [];
  lines.push(`🎭 **Enthralling Performance** — ${callerName} captivates (WIS DC ${dc}):`);
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  for (const targetName of targets) {
    const target = resolveTargetByName(c.ctx, targetName);
    if (!target) {
      lines.push(`  • ${targetName}: not found`);
      continue;
    }
    let saveMod = 0;
    let tName = target.name;
    if (target.characterId) {
      const { rows: trows } = await pool.query(
        'SELECT ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = $1',
        [target.characterId],
      );
      const trow = trows[0] as Record<string, unknown> | undefined;
      try {
        const tscores = typeof trow?.ability_scores === 'string'
          ? JSON.parse(trow.ability_scores as string)
          : (trow?.ability_scores ?? {});
        const prof = Number(trow?.proficiency_bonus) || 2;
        const tsaves = typeof trow?.saving_throws === 'string'
          ? JSON.parse(trow.saving_throws as string)
          : (trow?.saving_throws ?? []);
        saveMod = abilityMod(tscores as Record<string, number>, 'wis') +
          (Array.isArray(tsaves) && tsaves.includes('wis') ? prof : 0);
        if (trow?.name) tName = trow.name as string;
      } catch { /* ignore */ }
    }
    const d20 = Math.floor(Math.random() * 20) + 1;
    const total = d20 + saveMod;
    const saved = total >= dc;
    const sign = saveMod >= 0 ? '+' : '';
    lines.push(`  • ${tName}: d20=${d20}${sign}${saveMod}=${total} → ${saved ? 'SAVED' : 'CHARMED for 1 hour'}`);
    if (!saved) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'charmed',
        source: `${callerName} (Enthralling Performance)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 600, // 1 hour = 600 rounds
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: { conditions: target.conditions },
      });
    }
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

registerChatCommand(['fightingspirit', 'fspirit'], handleFightingSpirit);
registerChatCommand('echo', handleEchoKnight);
registerChatCommand(['cavmark', 'unwaveringmark'], handleCavalierMark);
registerChatCommand(['warding', 'wardingmaneuver'], handleWardingManeuver);
registerChatCommand(['wildbarb', 'wildmagicbarb'], handleWildBarb);
registerChatCommand(['divinefury', 'fury'], handleDivineFury);
registerChatCommand(['openhand', 'oht'], handleOpenHand);
registerChatCommand(['grave', 'strengthofthegrave'], handleGrave);
registerChatCommand(['hound', 'houndofillomen'], handleHound);
registerChatCommand(['mantle', 'mantleofinspiration'], handleMantle);
registerChatCommand(['enthrall', 'enthrallingperformance'], handleEnthrall);
