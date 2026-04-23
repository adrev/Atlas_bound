import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token, ActionBreakdown, SpellCastBreakdown } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Encounter difficulty calculator + Hit Dice spending + a few
 * previously-missing class-feature reroll commands (Indomitable,
 * Reliable Talent, Halfling Lucky) and Paladin Divine Sense.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

// ────── !encounter — PHB encounter-difficulty calculator ────
// PHB p.82 XP-by-CR table.
const CR_TO_XP: Record<string, number> = {
  '0': 10, '1/8': 25, '0.125': 25,
  '1/4': 50, '0.25': 50,
  '1/2': 100, '0.5': 100,
  '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300,
  '7': 2900, '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400,
  '13': 10000, '14': 11500, '15': 13000, '16': 15000, '17': 18000,
  '18': 20000, '19': 22000, '20': 25000, '21': 33000, '22': 41000,
  '23': 50000, '24': 62000, '25': 75000, '26': 90000, '27': 105000,
  '28': 120000, '29': 135000, '30': 155000,
};

// PHB p.82 daily XP-budget thresholds per character level (easy /
// medium / hard / deadly). Per-character; party threshold = sum.
const XP_THRESHOLDS: Record<number, [number, number, number, number]> = {
  1: [25, 50, 75, 100],
  2: [50, 100, 150, 200],
  3: [75, 150, 225, 400],
  4: [125, 250, 375, 500],
  5: [250, 500, 750, 1100],
  6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700],
  8: [450, 900, 1400, 2100],
  9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800],
  11: [800, 1600, 2400, 3600],
  12: [1000, 2000, 3000, 4500],
  13: [1100, 2200, 3400, 5100],
  14: [1250, 2500, 3800, 5700],
  15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200],
  17: [2000, 3900, 5900, 8800],
  18: [2100, 4200, 6300, 9500],
  19: [2400, 4900, 7300, 10900],
  20: [2800, 5700, 8500, 12700],
};

// Encounter multiplier based on monster count (PHB p.82).
function encounterMultiplier(count: number): number {
  if (count === 1) return 1.0;
  if (count === 2) return 1.5;
  if (count >= 3 && count <= 6) return 2.0;
  if (count >= 7 && count <= 10) return 2.5;
  if (count >= 11 && count <= 14) return 3.0;
  return 4.0; // 15+
}

async function handleEncounter(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!encounter: usage `!encounter <cr1> [cr2] [cr3] …`\n  e.g. `!encounter 2 2 1/2 1/2`  (two CR 2 + two CR 1/2)',
    );
    return true;
  }

  // Sum monster XP.
  let rawXp = 0;
  const crDisplay: string[] = [];
  for (const cr of parts) {
    const xp = CR_TO_XP[cr.toLowerCase()];
    if (xp === undefined) {
      whisperToCaller(c.io, c.ctx, `!encounter: unknown CR "${cr}".`);
      return true;
    }
    rawXp += xp;
    crDisplay.push(`CR ${cr} (${xp} XP)`);
  }
  const mul = encounterMultiplier(parts.length);
  const adjusted = Math.round(rawXp * mul);

  // Sum party XP thresholds. Walk PC tokens on the current map.
  const pcs = Array.from(c.ctx.room.tokens.values()).filter(
    (t) => t.characterId && t.ownerUserId,
  );
  let easy = 0, medium = 0, hard = 0, deadly = 0;
  const partyDesc: string[] = [];
  for (const pc of pcs) {
    const { rows } = await pool.query('SELECT level, name FROM characters WHERE id = $1', [pc.characterId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) continue;
    const lvl = Math.max(1, Math.min(20, Number(row.level) || 1));
    const th = XP_THRESHOLDS[lvl];
    if (!th) continue;
    easy += th[0]; medium += th[1]; hard += th[2]; deadly += th[3];
    partyDesc.push(`${row.name} L${lvl}`);
  }

  let rating: string;
  if (pcs.length === 0) rating = 'unknown — no PCs on this map';
  else if (adjusted < easy) rating = 'trivial';
  else if (adjusted < medium) rating = 'easy';
  else if (adjusted < hard) rating = 'medium';
  else if (adjusted < deadly) rating = 'hard';
  else rating = 'deadly';

  const lines: string[] = [];
  lines.push(`⚖ Encounter: ${crDisplay.join(', ')}`);
  lines.push(`   Raw XP: ${rawXp}, ×${mul} multiplier (${parts.length} monsters) → **adjusted ${adjusted} XP**`);
  if (pcs.length > 0) {
    lines.push(`   Party: ${partyDesc.join(', ')}`);
    lines.push(`   Thresholds — easy ${easy} / medium ${medium} / hard ${hard} / deadly ${deadly}`);
  }
  lines.push(`   → Rating: **${rating.toUpperCase()}**`);

  whisperToCaller(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── !hd <n> [dieSize] — spend Hit Dice on short rest ──
async function handleHitDice(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!hd: usage `!hd <n>` — roll n Hit Dice, heal ∑rolls + CON-mod × n. Takes from your HD pool on the character sheet.',
    );
    return true;
  }
  const n = parseInt(parts[0], 10);
  if (!Number.isFinite(n) || n < 1 || n > 20) {
    whisperToCaller(c.io, c.ctx, '!hd: <n> must be 1-20.');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!hd: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT hit_points, max_hit_points, ability_scores, hit_dice, name FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!hd: character not found.');
    return true;
  }
  const hp = Number(row.hit_points) || 0;
  const maxHp = Number(row.max_hit_points) || 0;
  const scores = typeof row.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row.ability_scores ?? {});
  const conMod = Math.floor((((scores as Record<string, number>).con ?? 10) - 10) / 2);
  const charName = (row.name as string) || caller.name;

  // Hit dice: array of pools like [{ dieSize: 10, total: 5, used: 2 }]
  const hdRaw = row.hit_dice;
  const hdPools: Array<{ dieSize: number; total: number; used: number }> = typeof hdRaw === 'string'
    ? JSON.parse(hdRaw as string) : (hdRaw ?? []);
  if (!Array.isArray(hdPools) || hdPools.length === 0) {
    // Fallback: if the sheet doesn't track HD, just ask the player for
    // a die size and roll.
    const dieArg = parts[1] || 'd8';
    const match = dieArg.match(/d?(\d+)/i);
    const die = match ? parseInt(match[1], 10) : 8;
    const rolls: number[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(Math.random() * die) + 1;
      rolls.push(r); total += r;
    }
    const heal = total + (conMod * n);
    const newHp = Math.min(maxHp, hp + heal);
    await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [newHp, caller.characterId])
      .catch((e) => console.warn('[!hd] hp write failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: caller.characterId,
      changes: { hitPoints: newHp },
    });
    const hdFallback: SpellCastBreakdown = {
      caster: { name: charName, tokenId: caller.id },
      spell: {
        name: `Hit Dice — ${n}d${die}+CON`,
        level: 0,
        kind: 'heal',
      },
      notes: [
        `Short-rest healing`,
        `HD pool not tracked on sheet (using fallback)`,
        `Dice: ${n}d${die} + ${n}×CON(${conMod})`,
      ],
      targets: [{
        name: charName,
        tokenId: caller.id,
        kind: 'heal',
        healing: {
          dice: `${n}d${die}+${n * conMod}`,
          diceRolls: rolls,
          mainRoll: heal,
          targetHpBefore: hp,
          targetHpAfter: newHp,
        },
      }],
    };
    broadcastSystem(
      c.io, c.ctx,
      `💤 ${charName} spends ${n}d${die} HD — ${n}d${die}(${rolls.join('+')}) + ${n}×CON(${conMod}) = **${heal}** → ${newHp}/${maxHp} HP. (HD tracked manually — no pool on sheet.)`,
      { spellResult: hdFallback },
    );
    return true;
  }

  // Spend from the largest-die pool first.
  hdPools.sort((a, b) => b.dieSize - a.dieSize);
  let remaining = n;
  const rollsDetail: string[] = [];
  let totalRolled = 0;
  for (const pool of hdPools) {
    if (remaining === 0) break;
    const available = pool.total - pool.used;
    const take = Math.min(available, remaining);
    if (take <= 0) continue;
    const rolls: number[] = [];
    for (let i = 0; i < take; i++) {
      const r = Math.floor(Math.random() * pool.dieSize) + 1;
      rolls.push(r); totalRolled += r;
    }
    pool.used += take;
    rollsDetail.push(`${take}d${pool.dieSize}(${rolls.join('+')})`);
    remaining -= take;
  }
  if (remaining > 0) {
    whisperToCaller(c.io, c.ctx, `!hd: only had ${n - remaining} HD left to spend (requested ${n}).`);
  }
  const spent = n - remaining;
  const heal = totalRolled + (conMod * spent);
  const newHp = Math.min(maxHp, hp + heal);
  await pool.query(
    'UPDATE characters SET hit_points = $1, hit_dice = $2 WHERE id = $3',
    [newHp, JSON.stringify(hdPools), caller.characterId],
  ).catch((e) => console.warn('[!hd] write failed:', e));
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { hitPoints: newHp, hitDice: hdPools },
  });
  // Gather all rolled dice across pools for the breakdown.
  const allRolls: number[] = [];
  for (const detail of rollsDetail) {
    const m = detail.match(/\(([^)]+)\)/);
    if (m) for (const v of m[1].split('+')) allRolls.push(parseInt(v, 10));
  }
  const hdBreakdown: SpellCastBreakdown = {
    caster: { name: charName, tokenId: caller.id },
    spell: {
      name: `Hit Dice (${spent} spent)`,
      level: 0,
      kind: 'heal',
    },
    notes: [
      `Short-rest healing`,
      `Dice spent: ${rollsDetail.join(' + ')}`,
      `CON bonus: ${spent}×${conMod} = ${spent * conMod}`,
      ...(remaining > 0 ? [`Requested ${n} but only had ${spent}`] : []),
    ],
    targets: [{
      name: charName,
      tokenId: caller.id,
      kind: 'heal',
      healing: {
        dice: rollsDetail.join(' + '),
        diceRolls: allRolls,
        mainRoll: heal,
        targetHpBefore: hp,
        targetHpAfter: newHp,
      },
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `💤 ${charName} spends ${spent} HD — ${rollsDetail.join(' + ')} + ${spent}×CON(${conMod}) = **${heal}** → ${newHp}/${maxHp} HP.`,
    { spellResult: hdBreakdown },
  );
  return true;
}

// ────── !indomitable — Fighter reroll failed save ───────
const indomitableUsed = new Map<string, number>();

async function handleIndomitable(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!indomitable: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!indomitable: ${caller.name} isn't a Fighter.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  if (lvl < 9) {
    whisperToCaller(c.io, c.ctx, '!indomitable: requires Fighter L9.');
    return true;
  }
  const maxUses = lvl >= 17 ? 3 : lvl >= 13 ? 2 : 1;
  const used = indomitableUsed.get(caller.characterId) ?? 0;
  if (used >= maxUses) {
    whisperToCaller(c.io, c.ctx, `!indomitable: ${maxUses} uses spent. Long rest to refresh.`);
    return true;
  }
  indomitableUsed.set(caller.characterId, used + 1);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const charName = (row?.name as string) || caller.name;
  const indomBreakdown: ActionBreakdown = {
    actor: { name: charName, tokenId: caller.id },
    action: {
      name: `Indomitable reroll (d20 = ${d20})`,
      category: 'class-feature',
      icon: '🛡',
      cost: '1 use (long rest)',
    },
    effect: `Rerolls the failed save: new d20 = **${d20}** (+ save mod). Must use the new roll.`,
    notes: [
      `Fighter L${lvl}`,
      `New d20: ${d20}`,
      `Uses remaining: ${maxUses - (used + 1)}/${maxUses}`,
      `Max uses: ${maxUses} (1 @ L9, 2 @ L13, 3 @ L17)`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🛡 **${charName} uses Indomitable** — rerolls the failed save, new d20 = **${d20}** (+ save mod). (${used + 1}/${maxUses} used; long rest to refresh.)`,
    { actionResult: indomBreakdown },
  );
  return true;
}

// ────── !reliable <roll> — Rogue Reliable Talent (L11) ────
async function handleReliable(c: ChatCommandContext): Promise<boolean> {
  const rollRaw = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(rollRaw) || rollRaw < 1 || rollRaw > 20) {
    whisperToCaller(c.io, c.ctx, '!reliable: usage `!reliable <d20-natural-roll>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!reliable: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!reliable: ${caller.name} isn't a Rogue.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  if (lvl < 11) {
    whisperToCaller(c.io, c.ctx, '!reliable: requires Rogue L11.');
    return true;
  }
  const charName = (row?.name as string) || caller.name;
  if (rollRaw >= 10) {
    whisperToCaller(c.io, c.ctx, `!reliable: d20=${rollRaw} already ≥ 10, no benefit. Keep the roll.`);
    return true;
  }
  broadcastSystem(
    c.io, c.ctx,
    `🎲 **Reliable Talent** — ${charName} treats their d20=${rollRaw} as **10** on proficient check (automatic floor).`,
  );
  return true;
}

// ────── !lucky-racial <rolled-d20> — Halfling Lucky ───────
/**
 * Halfling Lucky racial (distinct from the Lucky feat): when you
 * roll a 1 on an attack, ability check, or saving throw, you can
 * reroll the die and MUST use the new roll. Unlike the feat, this
 * is FREE — no daily pool. Trigger on natural 1s only.
 *
 *   !lucky1 <d20-natural-roll>
 */
async function handleHalflingLucky(c: ChatCommandContext): Promise<boolean> {
  const rollRaw = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(rollRaw) || rollRaw < 1 || rollRaw > 20) {
    whisperToCaller(c.io, c.ctx, '!lucky1: usage `!lucky1 <d20-natural-roll>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!lucky1: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT race, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const raceLower = String(row?.race || '').toLowerCase();
  if (!raceLower.includes('halfling')) {
    whisperToCaller(c.io, c.ctx, `!lucky1: only halflings have the racial Lucky (unrelated to the Lucky feat).`);
    return true;
  }
  if (rollRaw !== 1) {
    whisperToCaller(c.io, c.ctx, `!lucky1: only triggers on a natural 1 (you rolled ${rollRaw}).`);
    return true;
  }
  const newRoll = Math.floor(Math.random() * 20) + 1;
  const charName = (row?.name as string) || caller.name;
  const luckyBreakdown: ActionBreakdown = {
    actor: { name: charName, tokenId: caller.id },
    action: {
      name: `Halfling Lucky (1 \u2192 ${newRoll})`,
      category: 'racial',
      icon: '🍀',
      cost: 'Triggered on natural 1',
    },
    effect: `Rerolled natural 1: new d20 = **${newRoll}** (must use, no choice).`,
    notes: [
      `Halfling racial (unrelated to Lucky feat)`,
      `Original roll: 1`,
      `Reroll: ${newRoll}`,
      `No pool — unlimited uses`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🍀 **Halfling Lucky** — ${charName} rerolls the natural 1, new d20 = **${newRoll}** (must use, no choice).`,
    { actionResult: luckyBreakdown },
  );
  return true;
}

// ────── !divinesense — Paladin Divine Sense ping ───────
async function handleDivineSense(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!divinesense: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, ability_scores, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!divinesense: ${caller.name} isn't a Paladin.`);
    return true;
  }
  const scores = typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores ?? {});
  const chaMod = Math.max(1, Math.floor((((scores as Record<string, number>).cha ?? 10) - 10) / 2) + 1);
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `✨ ${charName} uses Divine Sense (action) — detects celestials / fiends / undead within 60 ft (not behind total cover) + consecrated / desecrated places. Uses/long rest: ${chaMod}.`,
  );
  return true;
}

registerChatCommand(['encounter', 'enc'], handleEncounter);
registerChatCommand(['hd', 'hitdice'], handleHitDice);
registerChatCommand('indomitable', handleIndomitable);
registerChatCommand(['reliable', 'reliabletalent'], handleReliable);
registerChatCommand(['lucky1', 'halflinglucky'], handleHalflingLucky);
registerChatCommand(['divinesense', 'ds'], handleDivineSense);
