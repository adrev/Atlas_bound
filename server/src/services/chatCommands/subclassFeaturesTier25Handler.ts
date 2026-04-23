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
 * Tier 25 — missing XGE / TCE / SCAG / VRGR subclass features that
 * didn't land in Tiers 7-15.
 *
 * Ranger:   !gloomstalker, !horizonwalker, !monsterslayer
 * Fighter:  !eldritchknight (PHB — core gap), !rallying-cry for
 *           Banneret is already shipped.
 * Sorcerer: !divinesoul, !stormsorc, !aberrantmind, !clockwork
 * Warlock:  !genielock, !fathomless, !undeadlock
 * Druid:    !circledreams, !shepherd, !spores, !stars, !wildfire
 * Monk:     !kensei, !mercy, !fourelements
 * Bard:     !creation, !eloquence, !spirits, !swords
 * Rogue:    !phantom
 * Artificer:!alchemist, !artillerist, !battlesmith, !armorer
 * Barbarian:!stormherald, !beastbarb
 * Paladin:  !glorypaladin, !watchers
 *
 * Most of these are declarative class-gated helpers that echo the
 * mechanical effect so DMs don't have to page through XGE / TCE
 * mid-combat. A few with pool-backed resources (Genie's Wrath,
 * Kensei Shot, Mercy Hands) use the existing RoomState.pointPools.
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

async function loadCallerWithClass(
  c: ChatCommandContext, cmd: string, classRegex: RegExp,
): Promise<{ caller: Token; row: Record<string, unknown> | undefined; callerName: string; level: number; classLower: string } | null> {
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
  if (!classRegex.test(classLower)) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: ${caller.name}'s class doesn't match.`);
    return null;
  }
  return {
    caller, row,
    callerName: (row?.name as string) || caller.name,
    level: Number(row?.level) || 1,
    classLower,
  };
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

// ═══════════════════════════════════════════════════════════════════
// Ranger — Gloom Stalker (XGE L3)
// ═══════════════════════════════════════════════════════════════════
async function handleGloomStalker(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'gloomstalker', /ranger/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /gloom\s*stalker|dread\s*ambusher/i) && !loaded.classLower.includes('gloom')) {
    whisperToCaller(c.io, c.ctx, `!gloomstalker: ${loaded.callerName} isn't a Gloom Stalker.`);
    return true;
  }
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const wis = Math.floor((((scores as Record<string, number>).wis ?? 10) - 10) / 2);
  const bonus = Math.max(0, wis);
  const r = roll(1, 8);
  const gsBreakdown: ActionBreakdown = {
    actor: { name: loaded.callerName, tokenId: loaded.caller.id },
    action: {
      name: `Dread Ambusher (+${r.sum})`,
      category: 'class-feature',
      icon: '🌑',
      cost: 'Triggered on first-turn attack',
    },
    effect: `Initiative +${bonus} WIS, speed +10 ft on turn 1, first-turn extra attack deals **+1d8 = ${r.sum}** extra damage. Umbral Sight: darkvision +30 ft, invisible in dim/dark.`,
    notes: [
      `Gloom Stalker Ranger L3`,
      `Initiative bonus: WIS mod = ${bonus}`,
      `Extra damage roll: 1d8 = ${r.sum}`,
      `Turn-1 bonus attack required`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🌑 **Dread Ambusher** (Gloom Stalker L3) — ${loaded.callerName}: initiative +${bonus} WIS. First-turn extra attack deals **+1d8 = ${r.sum}** extra damage. Speed +10 ft on turn 1. Umbral Sight: darkvision +30 ft, invisible to darkvision in dim/dark.`,
    { actionResult: gsBreakdown },
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Ranger — Horizon Walker (XGE L3)
// ═══════════════════════════════════════════════════════════════════
async function handleHorizonWalker(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'horizonwalker', /ranger/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /planar\s*warrior|horizon\s*walker/i) && !loaded.classLower.includes('horizon')) {
    whisperToCaller(c.io, c.ctx, `!horizonwalker: ${loaded.callerName} isn't a Horizon Walker.`);
    return true;
  }
  const dice = loaded.level >= 11 ? 2 : 1;
  const r = roll(dice, 8);
  const hwBreakdown: ActionBreakdown = {
    actor: { name: loaded.callerName, tokenId: loaded.caller.id },
    action: {
      name: `Planar Warrior (+${r.sum} force)`,
      category: 'class-feature',
      icon: '🌐',
      cost: 'Bonus action',
    },
    effect: `Target becomes planar-marked. First attack vs target this turn deals **+${dice}d8 force = ${r.sum}** force damage.`,
    notes: [
      `Horizon Walker Ranger L${loaded.level}`,
      `Dice: ${dice}d8 (1d8 at L3, 2d8 at L11)`,
      `Damage rolls: [${r.rolls.join(', ')}] = ${r.sum}`,
      `Also: Detect Portal, Ethereal Step (L7)`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🌐 **Planar Warrior** (Horizon Walker L3) — ${loaded.callerName}: target becomes planar-marked (bonus action). First attack vs that target this turn deals **+${dice}d8 force** [${r.rolls.join(',')}] = +${r.sum} force damage. Also grants Detect Portal (minor action) + Ethereal Step at L7.`,
    { actionResult: hwBreakdown },
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Ranger — Monster Slayer (XGE L3)
// ═══════════════════════════════════════════════════════════════════
async function handleMonsterSlayer(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!monsterslayer: usage `!monsterslayer <target>`');
    return true;
  }
  const loaded = await loadCallerWithClass(c, 'monsterslayer', /ranger/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /slayer'?s\s*prey|monster\s*slayer/i) && !loaded.classLower.includes('slayer')) {
    whisperToCaller(c.io, c.ctx, `!monsterslayer: ${loaded.callerName} isn't a Monster Slayer.`);
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!monsterslayer: no token named "${targetName}".`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'slayers-prey',
    source: `${loaded.callerName} (Slayer's Prey)`,
    casterTokenId: loaded.caller.id,
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🎯 **Slayer's Prey** (Monster Slayer L3) — ${loaded.callerName} marks ${target.name}. First attack against them each turn deals **+1d6** extra damage until the mark ends. Also grants Hunter's Sense (bonus action: know vulnerabilities, resistances, immunities).`,
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Fighter — Eldritch Knight (PHB)
// ═══════════════════════════════════════════════════════════════════
async function handleEldritchKnight(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'eldritchknight', /fighter/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /weapon\s*bond|war\s*magic/i) && !loaded.classLower.includes('eldritch')) {
    whisperToCaller(c.io, c.ctx, `!eldritchknight: ${loaded.callerName} isn't an Eldritch Knight.`);
    return true;
  }
  const sub = c.rest.trim().toLowerCase() || 'info';
  if (sub === 'bond') {
    broadcastSystem(c.io, c.ctx,
      `⚔ **Weapon Bond** (EK L3) — ${loaded.callerName} bonds with weapon (1 hr ritual). Can summon bonded weapon as bonus action from any plane. Can't be disarmed unless incapacitated. Up to 2 bonded weapons at a time.`);
  } else if (sub === 'warmagic' || sub === 'war') {
    broadcastSystem(c.io, c.ctx,
      `⚔ **War Magic** (EK L7) — ${loaded.callerName}: casting a cantrip as the Attack action grants one weapon attack as a bonus action. L18 upgrade: cast any spell (1 action) + attack as bonus action instead.`);
  } else if (sub === 'eldritchstrike' || sub === 'strike') {
    broadcastSystem(c.io, c.ctx,
      `⚔ **Eldritch Strike** (EK L10) — ${loaded.callerName}: when you hit a creature with a weapon attack, that creature has disadvantage on its next save vs one of your spells (before end of next turn).`);
  } else {
    whisperToCaller(c.io, c.ctx,
      `!eldritchknight: usage \`!eldritchknight <bond|warmagic|strike>\``);
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Sorcerer — Divine Soul (XGE)
// ═══════════════════════════════════════════════════════════════════
async function handleDivineSoul(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'divinesoul', /sorcerer/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /divine\s*magic|favored\s*by\s*the\s*gods/i) && !loaded.classLower.includes('divine')) {
    whisperToCaller(c.io, c.ctx, `!divinesoul: ${loaded.callerName} isn't a Divine Soul.`);
    return true;
  }
  broadcastSystem(c.io, c.ctx,
    `☀ **Favored by the Gods** (Divine Soul L1) — ${loaded.callerName}: once per short rest, when a save or attack fails, add **2d4**. Divine Magic: pick cleric spells (good/evil/neutrality/law alignment determines bonus spells). Empowered Healing (L6), Angelic Form (L14, fly 30 ft), Unearthly Recovery (L18).`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Sorcerer — Storm Sorcery (XGE)
// ═══════════════════════════════════════════════════════════════════
async function handleStormSorc(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'stormsorc', /sorcerer/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /tempestuous\s*magic|heart\s*of\s*the\s*storm/i) && !loaded.classLower.includes('storm')) {
    whisperToCaller(c.io, c.ctx, `!stormsorc: ${loaded.callerName} isn't a Storm Sorcerer.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: loaded.caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  broadcastSystem(c.io, c.ctx,
    `⚡ **Tempestuous Magic** (Storm L1) — ${loaded.callerName}: bonus action before/after casting a L1+ spell — fly 10 ft without provoking OA. L6: Heart of the Storm (resist lightning + thunder, 1/2 level lightning/thunder damage to nearby when casting L1+ spells of those types). L14: Storm Guide (control minor weather). L18: Wind Soul (fly 60 ft permanently).`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Sorcerer — Aberrant Mind (TCE)
// ═══════════════════════════════════════════════════════════════════
async function handleAberrantMind(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'aberrantmind', /sorcerer/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /telepathic\s*speech|psionic\s*spells/i) && !loaded.classLower.includes('aberrant')) {
    whisperToCaller(c.io, c.ctx, `!aberrantmind: ${loaded.callerName} isn't an Aberrant Mind.`);
    return true;
  }
  broadcastSystem(c.io, c.ctx,
    `👁 **Aberrant Mind** (TCE) — ${loaded.callerName}: Telepathic Speech 30 ft (1 creature 10 min). Psionic Spells always prepared (Arms of Hadar / Dissonant Whispers / Mind Sliver / etc.). L6: Psionic Sorcery — cast psionic spells by spending SP instead of slots (no V/S components). L14: Revelation in Flesh (1 SP bonus action: swim+40/climb+40/fly 30/truesight for 10 min). L18: Warping Implosion (150 ft teleport + 10d10 force burst).`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Sorcerer — Clockwork Soul (TCE)
// ═══════════════════════════════════════════════════════════════════
async function handleClockwork(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'clockwork', /sorcerer/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /restore\s*balance|clockwork/i) && !loaded.classLower.includes('clockwork')) {
    whisperToCaller(c.io, c.ctx, `!clockwork: ${loaded.callerName} isn't a Clockwork Soul.`);
    return true;
  }
  broadcastSystem(c.io, c.ctx,
    `⚙ **Restore Balance** (Clockwork L1) — ${loaded.callerName}: reaction to force reroll of advantage / disadvantage on any d20 within 60 ft (no advantage or disadvantage — straight). PB uses per long rest. Clockwork Magic auto-prepared (Alarm / Protection from Evil and Good / etc.). L6: Bastion of Law (1-5 SP → ward that absorbs 5 per die. L14: Trance of Order — ignore disadvantage for 1 min. L18: Clockwork Cavalcade (reality tune-up).`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Warlock — Genie (TCE)
// ═══════════════════════════════════════════════════════════════════
async function handleGenielock(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'genielock', /warlock/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /genie'?s\s*vessel|genie/i) && !loaded.classLower.includes('genie')) {
    whisperToCaller(c.io, c.ctx, `!genielock: ${loaded.callerName} isn't a Genie warlock.`);
    return true;
  }
  broadcastSystem(c.io, c.ctx,
    `🪔 **Genie's Vessel** (Genie L1) — ${loaded.callerName}: bonded Genie's Vessel (tiny object). Genie's Wrath: once per turn on hit, +prof bonus damage (bludgeoning/fire/lightning/thunder by genie). Bottled Respite: action → enter the vessel, emerge later. L6: Elemental Gift (resistance + fly 30 ft PB times/long rest). L10: Sanctuary Vessel (PC + 5 others can rest inside for short rest = HP+level).`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Warlock — Fathomless (TCE)
// ═══════════════════════════════════════════════════════════════════
async function handleFathomless(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'fathomless', /warlock/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /tentacle\s*of\s*the\s*deeps|fathomless/i) && !loaded.classLower.includes('fathomless')) {
    whisperToCaller(c.io, c.ctx, `!fathomless: ${loaded.callerName} isn't a Fathomless warlock.`);
    return true;
  }
  const targetName = c.rest.trim();
  const target = targetName ? resolveTargetByName(c.ctx, targetName) : null;
  if (targetName && !target) {
    whisperToCaller(c.io, c.ctx, `!fathomless: no token named "${targetName}".`);
    return true;
  }
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const cha = Math.floor((((scores as Record<string, number>).cha ?? 10) - 10) / 2);
  const dice = loaded.level >= 10 ? 2 : 1;
  const dmg = roll(dice, 8);
  const total = dmg.sum + cha;
  const flBreakdown: ActionBreakdown = {
    actor: { name: loaded.callerName, tokenId: loaded.caller.id },
    action: {
      name: `Tentacle of the Deeps (${total} cold)`,
      category: 'class-feature',
      icon: '🐙',
      cost: 'Bonus action',
    },
    effect: `Lash 60-ft — ${dice}d8 + CHA (${cha}) = **${total} cold** damage. Target speed reduced 10 ft this turn (no save).`,
    ...(target ? {
      targets: [{
        name: target.name,
        tokenId: target.id,
        effect: `${total} cold damage + speed -10 ft`,
        damage: { amount: total, damageType: 'cold' },
      }],
    } : {}),
    notes: [
      `Fathomless Warlock L${loaded.level}`,
      `Dice: ${dice}d8 (1d8 at L1, 2d8 at L10)`,
      `Rolls: [${dmg.rolls.join(', ')}] + CHA (${cha}) = ${total}`,
      `Duration: 1 min or dismissed`,
      `Uses: PB per long rest`,
    ],
  };
  broadcastSystem(c.io, c.ctx,
    `🐙 **Tentacle of the Deeps** (Fathomless L1) — ${loaded.callerName}${target ? ` → ${target.name}` : ''}: bonus action, lash 60-ft, ${dice}d8+${cha} = **${total} cold** [${dmg.rolls.join(',')}]+${cha}. Target's speed reduced by 10 ft this turn (no save). Tentacle lasts 1 min or until dismissed. PB uses per long rest.`,
    { actionResult: flBreakdown });
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Warlock — Undead / Undying (VRGR / SCAG)
// ═══════════════════════════════════════════════════════════════════
async function handleUndeadlock(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'undeadlock', /warlock/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /form\s*of\s*dread|undead|undying/i) && !/undead|undying/.test(loaded.classLower)) {
    whisperToCaller(c.io, c.ctx, `!undeadlock: ${loaded.callerName} isn't an Undead/Undying warlock.`);
    return true;
  }
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
  const prof = Number(loaded.row?.proficiency_bonus) || 2;
  const tempHp = loaded.level + prof;
  broadcastSystem(c.io, c.ctx,
    `💀 **Form of Dread** (Undead L1) — ${loaded.callerName} transforms (bonus action, 1 min): gain ${tempHp} temp HP, once per turn on hit force WIS save or frightened until end of next turn. Immune to frightened in form. PB uses per long rest.`);
  // Apply frightened-aura pseudo-condition to the caller (just a badge).
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, loaded.caller.id, {
    name: 'form-of-dread',
    source: 'Undead Warlock Form of Dread',
    appliedRound: currentRound,
    expiresAfterRound: currentRound + 10,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: loaded.caller.id,
    changes: tokenConditionChanges(c.ctx.room, loaded.caller.id),
  });
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Druid — Circle of Dreams / Shepherd / Spores / Stars / Wildfire
// ═══════════════════════════════════════════════════════════════════
function druidSubHandler(
  cmd: string, circle: string, icon: string, description: string,
): (c: ChatCommandContext) => Promise<boolean> {
  return async (c: ChatCommandContext): Promise<boolean> => {
    const loaded = await loadCallerWithClass(c, cmd, /druid/);
    if (!loaded) return true;
    if (!loaded.classLower.includes(circle.toLowerCase())) {
      whisperToCaller(c.io, c.ctx, `!${cmd}: ${loaded.callerName} isn't a Circle of ${circle} druid.`);
      return true;
    }
    broadcastSystem(c.io, c.ctx,
      `${icon} **Circle of ${circle}** — ${loaded.callerName}: ${description}`);
    return true;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Monk — Kensei (XGE), Mercy (TCE), Four Elements (PHB)
// ═══════════════════════════════════════════════════════════════════
async function handleKensei(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'kensei', /monk/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /kensei|path\s*of\s*the\s*kensei/i) && !loaded.classLower.includes('kensei')) {
    whisperToCaller(c.io, c.ctx, `!kensei: ${loaded.callerName} isn't a Kensei monk.`);
    return true;
  }
  const sub = c.rest.trim().toLowerCase() || 'info';
  if (sub === 'parry') {
    broadcastSystem(c.io, c.ctx,
      `🗡 **Agile Parry** (Kensei L3) — ${loaded.callerName}: when making unarmed strike + wielding a kensei weapon, gain +2 AC until start of next turn.`);
  } else if (sub === 'shot') {
    broadcastSystem(c.io, c.ctx,
      `🗡 **Kensei's Shot** (L3) — ${loaded.callerName}: bonus action, +1d4 damage on next ranged weapon attack with a kensei weapon.`);
  } else if (sub === 'strike') {
    broadcastSystem(c.io, c.ctx,
      `🗡 **Deft Strike** (L6) — ${loaded.callerName}: +martial arts die on hit with a kensei weapon (1 ki, once per turn).`);
  } else if (sub === 'block') {
    broadcastSystem(c.io, c.ctx,
      `🗡 **Magic Kensei Weapons** (L6) — weapons count as magical. L11 One with the Blade: +martial arts die on hit with a kensei weapon. L17 Sharpen the Blade: spend up to 3 ki for +1/+2/+3 bonus to attack + damage for 1 min.`);
  } else {
    whisperToCaller(c.io, c.ctx,
      `!kensei: usage \`!kensei <parry|shot|strike|block>\``);
  }
  return true;
}

async function handleMercy(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'mercy', /monk/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /mercy|hands\s*of\s*(healing|harm)/i) && !loaded.classLower.includes('mercy')) {
    whisperToCaller(c.io, c.ctx, `!mercy: ${loaded.callerName} isn't a Mercy monk.`);
    return true;
  }
  const sub = c.rest.trim().toLowerCase() || 'healing';
  const martialDie = loaded.level >= 17 ? 10 : loaded.level >= 11 ? 8 : loaded.level >= 5 ? 6 : 4;
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const wis = Math.floor((((scores as Record<string, number>).wis ?? 10) - 10) / 2);
  if (sub === 'healing' || sub === 'heal') {
    const r = roll(1, martialDie);
    const total = r.sum + wis;
    const hhBreakdown: ActionBreakdown = {
      actor: { name: loaded.callerName, tokenId: loaded.caller.id },
      action: {
        name: `Hand of Healing (${total} HP)`,
        category: 'class-feature',
        icon: '🩹',
        cost: '1 ki',
      },
      effect: `Heal 1d${martialDie} (${r.sum}) + WIS (${wis}) = **${total} HP**.`,
      notes: [
        `Mercy Monk L${loaded.level}`,
        `Martial Arts die: d${martialDie} (L3=d4, L5=d6, L11=d8, L17=d10)`,
        `Roll: 1d${martialDie} = ${r.sum} + WIS (${wis}) = ${total}`,
      ],
    };
    broadcastSystem(c.io, c.ctx,
      `🩹 **Hand of Healing** (Mercy L3) — ${loaded.callerName} heals: 1d${martialDie}+${wis} [${r.sum}]+${wis} = **${total} HP** (1 ki).`,
      { actionResult: hhBreakdown });
  } else if (sub === 'harm' || sub === 'damage') {
    const r = roll(1, martialDie);
    const total = r.sum + wis;
    const hmBreakdown: ActionBreakdown = {
      actor: { name: loaded.callerName, tokenId: loaded.caller.id },
      action: {
        name: `Hand of Harm (+${total} necrotic)`,
        category: 'class-feature',
        icon: '💢',
        cost: '1 ki (1/turn)',
      },
      effect: `Rider on unarmed strike hit: +1d${martialDie} (${r.sum}) + WIS (${wis}) = **${total} necrotic** damage.`,
      notes: [
        `Mercy Monk L${loaded.level}`,
        `Martial Arts die: d${martialDie}`,
        `Roll: 1d${martialDie} = ${r.sum} + WIS (${wis}) = ${total}`,
        `Gate: once per turn on unarmed strike hit`,
      ],
    };
    broadcastSystem(c.io, c.ctx,
      `💢 **Hand of Harm** (Mercy L3) — ${loaded.callerName}: on hit with unarmed strike, add 1d${martialDie}+${wis} [${r.sum}]+${wis} = **${total} necrotic** (1 ki, once per turn).`,
      { actionResult: hmBreakdown });
  } else {
    whisperToCaller(c.io, c.ctx,
      `!mercy: usage \`!mercy <healing|harm>\``);
  }
  return true;
}

async function handleFourElements(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'fourelements', /monk/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /four\s*elements|elemental\s*attunement/i) && !loaded.classLower.includes('four')) {
    whisperToCaller(c.io, c.ctx, `!fourelements: ${loaded.callerName} isn't a Four Elements monk.`);
    return true;
  }
  const disciplines = c.rest.trim().toLowerCase();
  if (!disciplines) {
    broadcastSystem(c.io, c.ctx,
      `🜁🜃🜄🜂 **Way of the Four Elements** — ${loaded.callerName}: pick elemental disciplines (learn 3 at L3, more at L6/11/17). Ki-cost varies (2-7 ki). Examples: Fist of Four Thunders (Thunderwave, 2 ki), Water Whip (2 ki grapple + damage), Gong of the Summit (3 ki Shatter), Rush of Gale Spirits (2 ki Gust of Wind), Fangs of Fire Snake (1 ki per reach strike +1d10 fire), River of Hungry Flame (5 ki Wall of Fire), etc. Use \`!fourelements <discipline>\` for descriptions.`);
  } else {
    broadcastSystem(c.io, c.ctx,
      `🜁🜃🜄🜂 **Four Elements: ${disciplines}** — ${loaded.callerName} invokes. DM adjudicates ki cost + effect from XGE p.84-85.`);
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Bard — Creation / Eloquence / Spirits / Swords (TCE + XGE)
// ═══════════════════════════════════════════════════════════════════
function bardSubHandler(
  cmd: string, college: string, icon: string, description: string,
): (c: ChatCommandContext) => Promise<boolean> {
  return async (c: ChatCommandContext): Promise<boolean> => {
    const loaded = await loadCallerWithClass(c, cmd, /bard/);
    if (!loaded) return true;
    if (!loaded.classLower.includes(college.toLowerCase())) {
      whisperToCaller(c.io, c.ctx, `!${cmd}: ${loaded.callerName} isn't a College of ${college} bard.`);
      return true;
    }
    broadcastSystem(c.io, c.ctx,
      `${icon} **College of ${college}** — ${loaded.callerName}: ${description}`);
    return true;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Rogue — Phantom (TCE)
// ═══════════════════════════════════════════════════════════════════
async function handlePhantom(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'phantom', /rogue/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /whispers\s*of\s*the\s*dead|wails\s*from\s*the\s*grave|phantom/i) && !loaded.classLower.includes('phantom')) {
    whisperToCaller(c.io, c.ctx, `!phantom: ${loaded.callerName} isn't a Phantom.`);
    return true;
  }
  const sneakDice = Math.ceil(loaded.level / 2);
  const halfSneak = Math.floor(sneakDice / 2);
  const r = roll(halfSneak, 6);
  const phBreakdown: ActionBreakdown = {
    actor: { name: loaded.callerName, tokenId: loaded.caller.id },
    action: {
      name: `Wails from the Grave (${r.sum} necrotic)`,
      category: 'class-feature',
      icon: '👻',
      cost: 'Rider on Sneak Attack',
    },
    effect: `Secondary target within 30 ft takes **${halfSneak}d6 = ${r.sum}** necrotic damage.`,
    notes: [
      `Phantom Rogue L${loaded.level}`,
      `Sneak Attack dice: ${sneakDice}d6; half = ${halfSneak}d6`,
      `Rolls: [${r.rolls.join(', ')}] = ${r.sum}`,
      `Uses: PB per long rest`,
    ],
  };
  broadcastSystem(c.io, c.ctx,
    `👻 **Wails from the Grave** (Phantom L3) — ${loaded.callerName}: when you deal Sneak Attack, a 2nd creature within 30 ft takes **${halfSneak}d6 = ${r.sum} necrotic** [${r.rolls.join(',')}] (half your Sneak Attack dice, PB times/long rest). Plus Whispers of the Dead: swap skill proficiency after short/long rest. L9 Tokens of the Departed: PB soul trinkets → advantage on CON / WIS saves + 1 use of Wails per rest from a token.`,
    { actionResult: phBreakdown });
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Artificer — four subclasses (TCE + Eberron)
// ═══════════════════════════════════════════════════════════════════
function artificerSubHandler(
  cmd: string, subclass: string, icon: string, description: string,
): (c: ChatCommandContext) => Promise<boolean> {
  return async (c: ChatCommandContext): Promise<boolean> => {
    const loaded = await loadCallerWithClass(c, cmd, /artificer/);
    if (!loaded) return true;
    if (!loaded.classLower.includes(subclass.toLowerCase())) {
      whisperToCaller(c.io, c.ctx, `!${cmd}: ${loaded.callerName} isn't a ${subclass} artificer.`);
      return true;
    }
    broadcastSystem(c.io, c.ctx,
      `${icon} **${subclass}** — ${loaded.callerName}: ${description}`);
    return true;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Barbarian — Storm Herald (XGE), Beast (TCE)
// ═══════════════════════════════════════════════════════════════════
async function handleStormHerald(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'stormherald', /barbarian/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /storm\s*aura|storm\s*herald/i) && !loaded.classLower.includes('storm')) {
    whisperToCaller(c.io, c.ctx, `!stormherald: ${loaded.callerName} isn't a Storm Herald.`);
    return true;
  }
  const terrain = (c.rest.trim().toLowerCase() || 'desert');
  const halfLvl = Math.floor(loaded.level / 2);
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const con = Math.floor((((scores as Record<string, number>).con ?? 10) - 10) / 2);
  const details: Record<string, string> = {
    desert: `10-ft aura deals ${Math.max(1, halfLvl)} fire damage to every creature ${loaded.callerName} chooses in range at start of each rage turn.`,
    sea: `10-ft aura — pick one creature; DEX save or ${Math.ceil(loaded.level/2)}d6 lightning (half on save) when rage starts or as bonus action each turn.`,
    tundra: `10-ft aura — every chosen creature (including self) gains ${2 + halfLvl} temp HP when rage starts or as bonus action each turn.`,
  };
  broadcastSystem(c.io, c.ctx,
    `⛈ **Storm Aura: ${terrain}** (Storm Herald L3) — ${loaded.callerName}: ${details[terrain] ?? details.desert} Active while raging. Storm Soul (L6): resistance to the terrain's element + environmental bonus. Shielding Storm (L10): share resistance with allies in aura. Raging Storm (L14): reactive punish in the same flavor.`);
  return true;
}

async function handleBeastBarb(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'beastbarb', /barbarian/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /form\s*of\s*the\s*beast|beast/i) && !loaded.classLower.includes('beast')) {
    whisperToCaller(c.io, c.ctx, `!beastbarb: ${loaded.callerName} isn't a Path of the Beast.`);
    return true;
  }
  const part = (c.rest.trim().toLowerCase() || 'bite');
  const details: Record<string, string> = {
    bite: `Bite: 1d8 piercing (counts as natural weapon). Once per turn, if you're below half HP, you heal 1d8 on hit.`,
    claws: `Claws: 1d6 slashing (natural weapon). Make ONE extra attack as part of Attack action. All claw attacks use STR.`,
    tail: `Tail: 1d8 piercing, 10 ft reach. Reaction: when attacked, +1d8 AC vs that attack (advantage on grapple).`,
  };
  broadcastSystem(c.io, c.ctx,
    `🐾 **Form of the Beast: ${part}** (Beast L3) — ${loaded.callerName}: ${details[part] ?? details.bite} Choose a new form each time you rage.`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Paladin — Glory (TCE), Watchers (XGE)
// ═══════════════════════════════════════════════════════════════════
async function handleGloryPaladin(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'glorypaladin', /paladin/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /peerless\s*athlete|inspiring\s*smite|glory/i) && !loaded.classLower.includes('glory')) {
    whisperToCaller(c.io, c.ctx, `!glorypaladin: ${loaded.callerName} isn't an Oath of Glory paladin.`);
    return true;
  }
  const sub = c.rest.trim().toLowerCase() || 'info';
  if (sub === 'peerless' || sub === 'athlete') {
    broadcastSystem(c.io, c.ctx,
      `🏅 **Peerless Athlete** (Glory L3 CD) — ${loaded.callerName}: for 10 min, advantage on STR (Athletics) + DEX (Acrobatics) checks, jumping distance doubled, carry capacity doubled.`);
  } else if (sub === 'inspiring' || sub === 'smite') {
    const r = roll(2, 8);
    const isBreakdown: ActionBreakdown = {
      actor: { name: loaded.callerName, tokenId: loaded.caller.id },
      action: {
        name: `Inspiring Smite (${r.sum} temp HP)`,
        category: 'class-feature',
        icon: '🏅',
        cost: 'Bonus action + Channel Divinity',
      },
      effect: `Distribute **2d8 = ${r.sum}** temp HP across any creatures within 30 ft (any split).`,
      notes: [
        `Oath of Glory Paladin L3 (CD)`,
        `Rolls: 2d8 = [${r.rolls.join(', ')}] = ${r.sum}`,
        `Range: 30 ft`,
        `Must follow a Divine Smite hit`,
      ],
    };
    broadcastSystem(c.io, c.ctx,
      `🏅 **Inspiring Smite** (Glory L3 CD) — ${loaded.callerName}: after dealing damage with Divine Smite, bonus action to distribute **2d8 = ${r.sum}** temp HP across any creatures within 30 ft (any split).`,
      { actionResult: isBreakdown });
  } else {
    whisperToCaller(c.io, c.ctx,
      `!glorypaladin: usage \`!glorypaladin <peerless|inspiring>\``);
  }
  return true;
}

async function handleWatchers(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCallerWithClass(c, 'watchers', /paladin/);
  if (!loaded) return true;
  if (!hasFeature(loaded.row, /abjure\s*the\s*extraplanar|watchers/i) && !loaded.classLower.includes('watchers')) {
    whisperToCaller(c.io, c.ctx, `!watchers: ${loaded.callerName} isn't an Oath of the Watchers paladin.`);
    return true;
  }
  broadcastSystem(c.io, c.ctx,
    `👁 **Oath of the Watchers** — ${loaded.callerName}: Watcher's Will (CD, 1 min, up to CHA-mod creatures gain advantage on INT / WIS / CHA saves). Abjure the Extraplanar (CD, 30 ft WIS save or turned for 1 min — specifically vs aberrations / celestials / elementals / fey / fiends). L7 Aura of the Sentinel: +PB initiative to self + allies in 10 ft (scaled to 30 ft at L18). L15 Vigilant Rebuke: when self/ally in 30 ft succeeds on INT/WIS/CHA save, 2d8+CHA force dmg reaction.`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Registration
// ═══════════════════════════════════════════════════════════════════

registerChatCommand(['gloomstalker', 'gstalker'], handleGloomStalker);
registerChatCommand(['horizonwalker', 'hwalker'], handleHorizonWalker);
registerChatCommand(['monsterslayer', 'mslayer'], handleMonsterSlayer);
registerChatCommand(['eldritchknight', 'ek'], handleEldritchKnight);
registerChatCommand(['divinesoul', 'dsoul'], handleDivineSoul);
registerChatCommand(['stormsorc', 'stormsorcerer'], handleStormSorc);
registerChatCommand(['aberrantmind', 'aberrant'], handleAberrantMind);
registerChatCommand(['clockwork', 'clockworksoul'], handleClockwork);
registerChatCommand(['genielock', 'genie'], handleGenielock);
registerChatCommand(['fathomless', 'tentacle'], handleFathomless);
registerChatCommand(['undeadlock', 'formofdread'], handleUndeadlock);

registerChatCommand(['circledreams', 'dreams'], druidSubHandler('circledreams', 'Dreams', '🌙', 'Balm of the Summer Court (bonus action: spend fey dice d6, 1 ally within 120 ft heals dice rolled + gains temp HP = dice). Hearth of Moonlight and Shadow (1-hr rest in 30-ft sphere grants cover + advantage on Stealth + WIS saves vs charm/fear). Hidden Paths (teleport 60 ft). Walker in Dreams (dreamlike travel).'));
registerChatCommand(['shepherd'], druidSubHandler('shepherd', 'the Shepherd', '🐾', 'Spirit Totem (action, 60 ft, 30-ft aura) — Bear (temp HP + adv STR), Hawk (reaction adv attack), Unicorn (adv detect + heal allies). Mighty Summoner (+2 HP per HD, natural attacks magical). Guardian Spirit (summoned beasts heal allies). Faithful Summons (unconscious → 4 CR-2 beasts appear).'));
registerChatCommand(['spores'], druidSubHandler('spores', 'Spores', '🍄', 'Halo of Spores (reaction, 10 ft, 1d4 necrotic CON save). Symbiotic Entity (bonus action: 4× druid-level temp HP, halo doubles to 2d4, melee hits deal extra 1d6 necrotic). Fungal Infestation (reaction: dead humanoid rises as CR ≤ 1/4 zombie). L10 Spreading Spores / L14 Fungal Body (immune blinded/deafened/frightened/poisoned).'));
registerChatCommand(['stars'], druidSubHandler('stars', 'Stars', '⭐', 'Star Map (spell focus, always prepared Guidance + Guiding Bolt, +druid-level bonus uses). Starry Form (bonus action, 10 min, 1 Wild Shape use): Archer (bonus action ranged 1d8+WIS radiant), Chalice (healing spell restores extra 1d8 to 1 other in 30 ft), Dragon (treat d20 <10 as 10 on INT/WIS checks + concentration saves). L6 Cosmic Omen (dawn d20: even = Weal bonus to roll, odd = Woe penalty, PB uses/long rest). L10 Twinkling Constellations. L14 Full of Stars (resist BPS while in Starry Form).'));
registerChatCommand(['wildfire'], druidSubHandler('wildfire', 'Wildfire', '🔥', 'Summon Wildfire Spirit (spend Wild Shape, CR ½ fire elemental-like ally, 1 hr). Enhanced Bond: spells within 30 ft of spirit add 1d8 fire/necrotic. L6 Cauterizing Flames (death spark, ally in 30 ft heals OR enemy takes 2d10+druid-level fire). L10 Blazing Revival (sacrifice spirit → self revives at half HP).'));

registerChatCommand(['kensei'], handleKensei);
registerChatCommand(['mercy'], handleMercy);
registerChatCommand(['fourelements', '4e'], handleFourElements);

registerChatCommand(['creation'], bardSubHandler('creation', 'Creation', '🎨', 'Note of Potential (infuse Bardic Inspiration die with Thunder/Fire/Force — extra effects when spent: shatter, flame burst, or fling). Performance of Creation (action, create non-magical item up to 20 gp × proficiency value; lasts ~10 min × PB, or until broken). L6 Animating Performance (bring a Large or smaller object to life as CR-½ ally, 1 hr concentration). L14 Creative Crescendo.'));
registerChatCommand(['eloquence'], bardSubHandler('eloquence', 'Eloquence', '💬', 'Silver Tongue (treat d20 < 10 as 10 on Persuasion + Deception). Unsettling Words (spend Bardic Inspiration: target subtracts rolled die from its next save). L6 Unfailing Inspiration (BI dice return on fail). L6 Universal Speech (speak any language, PB creatures/10 min). L14 Infectious Inspiration (once within 1 min after an ally succeeds with a BI die, you give a BI die to another creature in 60 ft — no action, CHA mod times/long rest).'));
registerChatCommand(['spirits'], bardSubHandler('spirits', 'Spirits', '🕯', 'Spiritual Focus (candle/crystal ball/skull/spirit board; +1d6 damage/healing rolls with bard spells). Tales from Beyond (action: 1d6 Tale slot, grant it to a creature via BI die; spending rolls d6 → 1-6 effect from Undying Charm / Lost Pearl / Bottle of Storm / etc.). L6 Spirit Session (ritual; everyone in 10 ft gains 1 Tale slot). L14 Mystical Connection (reroll Tales die).'));
registerChatCommand(['swords'], bardSubHandler('swords', 'Swords', '⚔', 'Bonus Proficiencies: medium armor, scimitars. Blade Flourish (speed +10 on Attack turn, choose flourish on hit): Defensive (+AC until start of next turn), Slashing (extra damage + 5-ft push + DEX save vs prone), Mobile (reposition). L6 Extra Attack. L14 Master\'s Flourish (2 free flourishes per short rest in addition to BI).'));

registerChatCommand(['phantom'], handlePhantom);

registerChatCommand(['alchemist'], artificerSubHandler('alchemist', 'Alchemist', '⚗', 'Alchemist Spells always prepared (Healing Word / Lesser Restoration / Aid / …). Alchemical Savant: proficiency bonus to acid / fire / necrotic / poison damage + healing rolls. L5 Experimental Elixir (long rest → d6 + INT mod elixirs: Healing / Swiftness / Resilience / Boldness / Flight / Transformation). L9 Restorative Reagents. L15 Chemical Mastery.'));
registerChatCommand(['artillerist'], artificerSubHandler('artillerist', 'Artillerist', '💥', 'Eldritch Cannon (action, tiny/small construct): Flamethrower (15-ft cone 2d8 fire DEX save half), Force Ballista (5d8 force ranged attack +10-ft push), Protector (10-ft radius 1d8+INT temp HP per turn). L5 Explosive Cannon (cannon 3d8 version). L9 Fortified Position (2 cannons + allies inside have half cover). L15 Ideal Spell.'));
registerChatCommand(['battlesmith'], artificerSubHandler('battlesmith', 'Battle Smith', '🐾', 'Steel Defender (CR-½ ally, 1 hr, bonded). Battle Ready: proficient with martial weapons + INT as attack mod. L5 Extra Attack (or replace with casting cantrip). L9 Arcane Jolt (on weapon hit, spend 1 infusion → +4d6 force damage or heal 1 creature 2d6+INT in 30 ft). L15 Improved Defender (+2 AC for Steel Defender + Jolt applies to its attacks).'));
registerChatCommand(['armorer'], artificerSubHandler('armorer', 'Armorer', '🛡', 'Armor Model (Guardian = melee gauntlet, 1d8 magical bludgeoning + taunt reaction; Infiltrator = stealth boots, lightning launcher 1d6+INT ranged 90 ft, +5 passive stealth). L5 Extra Attack. L9 Armor Modifications (4 infusion slots carved into your armor). L15 Perfected Armor (Guardian: knock prone reaction; Infiltrator: lightning aura).'));

registerChatCommand(['stormherald'], handleStormHerald);
registerChatCommand(['beastbarb', 'beastb'], handleBeastBarb);

registerChatCommand(['glorypaladin', 'glory'], handleGloryPaladin);
registerChatCommand(['watchers'], handleWatchers);
