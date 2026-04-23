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
 * Tier 18 — Feat handlers:
 *   !alert                   — +5 init, can't be surprised, no OA adv while hidden
 *   !crossbowexpert <target> — bonus action hand-crossbow attack
 *   !shieldmaster            — bonus action shove with shield
 *   !sentinel <target>       — reaction attack when adjacent enemy attacks ally
 *   !mobile                  — declare Mobile: no OA from target attacked
 *   !savageattacker <dmg1> <dmg2>  — reroll once/turn, keep better
 *   !warcaster [mode]         — adv on conc saves / reaction OA spell
 *   !inspiringleader          — 10-min speech, CHA+level temp HP to 6
 *   !tavernbrawler            — d4 unarmed + grapple on hit
 *   !heavyarmormaster <dmg>   — reduce dmg by 3 if nonmagical BPS
 *   !elementaladept <type>    — ignore resistance to chosen type
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

function hasFeat(row: Record<string, unknown> | undefined, pattern: RegExp): boolean {
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

async function loadCaller(c: ChatCommandContext, cmd: string): Promise<{
  caller: Token;
  row: Record<string, unknown> | undefined;
  callerName: string;
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
  return { caller, row, callerName: (row?.name as string) || caller.name };
}

// ────── Alert ──────────────────────────────────────
async function handleAlert(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCaller(c, 'alert');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /\balert\b/i)) {
    whisperToCaller(c.io, c.ctx, `!alert: ${loaded.callerName} doesn't have the Alert feat.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `👁 **Alert** — ${loaded.callerName} rolls initiative with **+5** bonus, cannot be surprised while conscious, and hidden attackers don't get advantage against them.`,
  );
  return true;
}

// ────── Crossbow Expert ────────────────────────────
async function handleCrossbowExpert(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!crossbowexpert: usage `!crossbowexpert <target>` (bonus-action hand crossbow attack)');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!crossbowexpert: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'crossbowexpert');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /crossbow\s+expert/i)) {
    whisperToCaller(c.io, c.ctx, `!crossbowexpert: ${loaded.callerName} doesn't have the Crossbow Expert feat.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!crossbowexpert: bonus action already spent.');
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
  broadcastSystem(
    c.io, c.ctx,
    `🏹 **Crossbow Expert** — ${loaded.callerName} takes bonus-action attack on ${target.name} with a loaded hand crossbow (1d6+DEX, no OA disadvantage at melee range).`,
  );
  return true;
}

// ────── Shield Master ──────────────────────────────
async function handleShieldMaster(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!shieldmaster: usage `!shieldmaster <target> <prone|push>`');
    return true;
  }
  const effect = parts[parts.length - 1].toLowerCase();
  if (!['prone', 'push'].includes(effect)) {
    whisperToCaller(c.io, c.ctx, '!shieldmaster: effect must be `prone` or `push`.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!shieldmaster: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'shieldmaster');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /shield\s+master/i)) {
    whisperToCaller(c.io, c.ctx, `!shieldmaster: ${loaded.callerName} doesn't have the Shield Master feat.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!shieldmaster: bonus action already spent.');
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
  // Contested STR (Athletics) vs target STR/DEX.
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const prof = Number(loaded.row?.proficiency_bonus) || 2;
  const atkMod = abilityMod(scores as Record<string, number>, 'str') + prof;
  let defMod = 0;
  let tName = target.name;
  if (target.characterId) {
    const { rows } = await pool.query(
      'SELECT ability_scores, proficiency_bonus, name FROM characters WHERE id = $1',
      [target.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const tscores = typeof row?.ability_scores === 'string'
      ? JSON.parse(row.ability_scores as string)
      : (row?.ability_scores ?? {});
    const str = abilityMod(tscores as Record<string, number>, 'str');
    const dex = abilityMod(tscores as Record<string, number>, 'dex');
    defMod = Math.max(str, dex);
    if (row?.name) tName = row.name as string;
  }
  const atkD20 = Math.floor(Math.random() * 20) + 1;
  const defD20 = Math.floor(Math.random() * 20) + 1;
  const atkTot = atkD20 + atkMod;
  const defTot = defD20 + defMod;
  const win = atkTot > defTot;
  if (win && effect === 'prone') {
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'prone',
      source: `${loaded.callerName} (Shield Master)`,
      casterTokenId: loaded.caller.id,
      appliedRound: currentRound,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }
  const smBreakdown: ActionBreakdown = {
    actor: { name: loaded.callerName, tokenId: loaded.caller.id },
    action: {
      name: `Shield Master (${effect})`,
      category: 'class-feature',
      icon: '🛡',
      cost: 'Bonus action',
    },
    effect: `Athletics contest: atk d20=${atkD20}+${atkMod}=${atkTot} vs ${tName} d20=${defD20}+${defMod}=${defTot} → ${win ? (effect === 'prone' ? 'knocked prone' : 'pushed 5 ft') : 'failed'}.`,
    targets: [{
      name: tName,
      tokenId: target.id,
      effect: win
        ? `FAIL: atk ${atkTot} > def ${defTot} — ${effect === 'prone' ? 'prone' : 'pushed 5 ft'}`
        : `SAVED: def ${defTot} ≥ atk ${atkTot} — no effect`,
      ...(win && effect === 'prone' ? { conditionsApplied: ['prone'] } : {}),
    }],
    notes: [
      `Shield Master feat`,
      `Attacker Athletics: d20=${atkD20} + STR+prof (${atkMod}) = ${atkTot}`,
      `Defender: d20=${defD20} + best(STR, DEX) (${defMod}) = ${defTot}`,
      `Win condition: attacker total > defender total`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🛡 **Shield Master** (${effect}) — ${loaded.callerName}: atk d20=${atkD20}+${atkMod}=${atkTot} vs ${tName} d20=${defD20}+${defMod}=${defTot} → ${win ? (effect === 'prone' ? 'KNOCKED PRONE' : 'pushed 5 ft') : 'failed'}`,
    { actionResult: smBreakdown },
  );
  return true;
}

// ────── Sentinel ───────────────────────────────────
async function handleSentinel(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!sentinel: usage `!sentinel <attacker>` (reaction: adjacent enemy attacks ally)');
    return true;
  }
  const attacker = resolveTargetByName(c.ctx, targetName);
  if (!attacker) {
    whisperToCaller(c.io, c.ctx, `!sentinel: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'sentinel');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /sentinel/i)) {
    whisperToCaller(c.io, c.ctx, `!sentinel: ${loaded.callerName} doesn't have the Sentinel feat.`);
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
  if (economy?.reaction) {
    whisperToCaller(c.io, c.ctx, '!sentinel: reaction already spent.');
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
  broadcastSystem(
    c.io, c.ctx,
    `🗡 **Sentinel** — ${loaded.callerName} uses reaction to melee-attack ${attacker.name} for attacking an ally in reach. (Also: OA dmg = crit? no, crit stops movement; any OA hit with Sentinel reduces target speed to 0)`,
  );
  return true;
}

// ────── Mobile ─────────────────────────────────────
async function handleMobile(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  const loaded = await loadCaller(c, 'mobile');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /\bmobile\b/i)) {
    whisperToCaller(c.io, c.ctx, `!mobile: ${loaded.callerName} doesn't have the Mobile feat.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    targetName
      ? `🏃 **Mobile** — ${loaded.callerName}: +10 speed, no OA from ${targetName} (attacked this turn), difficult terrain ignored when Dashing.`
      : `🏃 **Mobile** — ${loaded.callerName}: +10 speed permanently, difficult terrain ignored when Dashing.`,
  );
  return true;
}

// ────── Savage Attacker ────────────────────────────
async function handleSavageAttacker(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!savageattacker: usage `!savageattacker <dmg1> <dmg2>` (both rolls, I keep the higher)');
    return true;
  }
  const loaded = await loadCaller(c, 'savageattacker');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /savage\s+attacker/i)) {
    whisperToCaller(c.io, c.ctx, `!savageattacker: ${loaded.callerName} doesn't have the Savage Attacker feat.`);
    return true;
  }
  const best = Math.max(...parts);
  broadcastSystem(
    c.io, c.ctx,
    `🪓 **Savage Attacker** — ${loaded.callerName} keeps the higher roll: [${parts.join(' vs ')}] → **${best}** damage. (1/turn)`,
  );
  return true;
}

// ────── War Caster ─────────────────────────────────
async function handleWarCaster(c: ChatCommandContext): Promise<boolean> {
  const mode = c.rest.trim().toLowerCase();
  const loaded = await loadCaller(c, 'warcaster');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /war\s+caster/i)) {
    whisperToCaller(c.io, c.ctx, `!warcaster: ${loaded.callerName} doesn't have the War Caster feat.`);
    return true;
  }
  if (mode === 'oa' || mode === 'spell') {
    const economy = c.ctx.room.actionEconomies.get(loaded.caller.id);
    if (economy?.reaction) {
      whisperToCaller(c.io, c.ctx, '!warcaster: reaction already spent.');
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
    broadcastSystem(
      c.io, c.ctx,
      `🪄 **War Caster** — ${loaded.callerName} casts a spell (1 action casting time, single target) as a **reaction** in place of an opportunity attack.`,
    );
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🪄 **War Caster** — ${loaded.callerName}: advantage on concentration saves; can perform somatic components with hands full; reaction spell in place of OA (\`!warcaster oa\`).`,
  );
  return true;
}

// ────── Inspiring Leader ──────────────────────────
async function handleInspiringLeader(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!inspiringleader: usage `!inspiringleader <t1> [t2 …]` (up to 6 allies, 10-min speech)');
    return true;
  }
  if (parts.length > 6) {
    whisperToCaller(c.io, c.ctx, '!inspiringleader: up to 6 targets.');
    return true;
  }
  const loaded = await loadCaller(c, 'inspiringleader');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /inspiring\s+leader/i)) {
    whisperToCaller(c.io, c.ctx, `!inspiringleader: ${loaded.callerName} doesn't have the Inspiring Leader feat.`);
    return true;
  }
  const scores = typeof loaded.row?.ability_scores === 'string'
    ? JSON.parse(loaded.row.ability_scores as string)
    : (loaded.row?.ability_scores ?? {});
  const chaMod = abilityMod(scores as Record<string, number>, 'cha');
  const lvl = Number(loaded.row?.level) || 1;
  const thp = chaMod + lvl;
  const lines: string[] = [];
  lines.push(`📣 **Inspiring Leader** — ${loaded.callerName}'s 10-minute speech grants **${thp} temp HP** to ${parts.length} allies:`);
  for (const name of parts) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target) { lines.push(`  • ${name}: not found`); continue; }
    if (target.characterId) {
      const { rows } = await pool.query('SELECT temp_hit_points FROM characters WHERE id = $1', [target.characterId]);
      const cur = Number((rows[0] as Record<string, unknown>)?.temp_hit_points) || 0;
      const newThp = Math.max(cur, thp);
      await pool.query('UPDATE characters SET temp_hit_points = $1 WHERE id = $2', [newThp, target.characterId]).catch(() => {});
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: target.characterId,
        changes: { tempHitPoints: newThp },
      });
      lines.push(`  • ${target.name}: ${thp} temp HP (now ${newThp}).`);
    } else {
      lines.push(`  • ${target.name}: ${thp} temp HP (NPC — manual).`);
    }
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── Tavern Brawler ─────────────────────────────
async function handleTavernBrawler(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!tavernbrawler: usage `!tavernbrawler <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!tavernbrawler: no token named "${targetName}".`);
    return true;
  }
  const loaded = await loadCaller(c, 'tavernbrawler');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /tavern\s+brawler/i)) {
    whisperToCaller(c.io, c.ctx, `!tavernbrawler: ${loaded.callerName} doesn't have the Tavern Brawler feat.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🍺 **Tavern Brawler** — ${loaded.callerName} punches ${target.name}: 1d4+STR bludgeoning. On hit, bonus action to grapple target.`,
  );
  return true;
}

// ────── Heavy Armor Master ─────────────────────────
async function handleHeavyArmorMaster(c: ChatCommandContext): Promise<boolean> {
  const dmg = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(dmg) || dmg < 0) {
    whisperToCaller(c.io, c.ctx, '!heavyarmormaster: usage `!heavyarmormaster <incoming-nonmagical-BPS-damage>`');
    return true;
  }
  const loaded = await loadCaller(c, 'heavyarmormaster');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /heavy\s+armor\s+master/i)) {
    whisperToCaller(c.io, c.ctx, `!heavyarmormaster: ${loaded.callerName} doesn't have the Heavy Armor Master feat.`);
    return true;
  }
  const reduced = Math.max(0, dmg - 3);
  broadcastSystem(
    c.io, c.ctx,
    `🛡 **Heavy Armor Master** — ${loaded.callerName} reduces non-magical BPS damage by 3: ${dmg} → **${reduced}**.`,
  );
  return true;
}

// ────── Elemental Adept ────────────────────────────
async function handleElementalAdept(c: ChatCommandContext): Promise<boolean> {
  const type = c.rest.trim().toLowerCase();
  const valid = ['fire', 'cold', 'lightning', 'acid', 'thunder'];
  if (!valid.includes(type)) {
    whisperToCaller(c.io, c.ctx, `!elementaladept: usage \`!elementaladept <${valid.join('|')}>\``);
    return true;
  }
  const loaded = await loadCaller(c, 'elementaladept');
  if (!loaded) return true;
  if (!hasFeat(loaded.row, /elemental\s+adept/i)) {
    whisperToCaller(c.io, c.ctx, `!elementaladept: ${loaded.callerName} doesn't have the Elemental Adept feat.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🔥 **Elemental Adept (${type})** — ${loaded.callerName}'s ${type} spells ignore **resistance** to ${type} damage; any 1 on a damage die is treated as a 2.`,
  );
  return true;
}

registerChatCommand('alert', handleAlert);
registerChatCommand(['crossbowexpert', 'cbe'], handleCrossbowExpert);
registerChatCommand(['shieldmaster', 'smaster'], handleShieldMaster);
registerChatCommand(['sentinel'], handleSentinel);
registerChatCommand(['mobile'], handleMobile);
registerChatCommand(['savageattacker', 'savage'], handleSavageAttacker);
registerChatCommand(['warcaster', 'wc'], handleWarCaster);
registerChatCommand(['inspiringleader', 'ilead'], handleInspiringLeader);
registerChatCommand(['tavernbrawler', 'tb'], handleTavernBrawler);
registerChatCommand(['heavyarmormaster', 'ham'], handleHeavyArmorMaster);
registerChatCommand(['elementaladept', 'eadept'], handleElementalAdept);
