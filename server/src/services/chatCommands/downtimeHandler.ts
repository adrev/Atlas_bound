import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Downtime + variant utility handlers:
 *   !craft <item-name> <value-gp>  — compute crafting days (50 gp/day)
 *   !multiclass <class>            — check 5e multiclass prereqs
 *                                     against the caller's ability scores
 *   !encumbrance [carry-lbs]       — report light / heavy / max
 *                                     thresholds for the caller's STR
 *   !currency <amount>             — convert across cp/sp/ep/gp/pp
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function loadCharacter(c: ChatCommandContext, cmd: string): Promise<{
  caller: Token;
  row: Record<string, unknown>;
  scores: Record<string, number>;
  callerName: string;
} | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name, ability_scores FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: character row missing.`);
    return null;
  }
  const scores = (typeof row.ability_scores === 'string'
    ? JSON.parse(row.ability_scores as string)
    : (row.ability_scores ?? {})) as Record<string, number>;
  return {
    caller,
    row,
    scores,
    callerName: (row.name as string) || caller.name,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Crafting (PHB p.187, XGE ch.2)
// ═══════════════════════════════════════════════════════════════════

async function handleCraft(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx,
      '!craft: usage `!craft <item-name> <value-gp> [helpers]`. PHB: 50 gp of progress per day per proficient crafter; helpers cut the time proportionally.');
    return true;
  }
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const maybeHelpers = lastIsNum ? parseInt(parts[parts.length - 1], 10) : null;
  // Detect: `!craft <item...> <gp> <helpers>` vs `!craft <item...> <gp>`.
  let valueGp: number;
  let helpers: number;
  let nameSlice: string[];
  if (maybeHelpers !== null && parts.length >= 3 && Number.isFinite(parseInt(parts[parts.length - 2], 10))) {
    valueGp = parseInt(parts[parts.length - 2], 10);
    helpers = maybeHelpers;
    nameSlice = parts.slice(0, -2);
  } else if (maybeHelpers !== null) {
    valueGp = maybeHelpers;
    helpers = 0;
    nameSlice = parts.slice(0, -1);
  } else {
    whisperToCaller(c.io, c.ctx, '!craft: last argument must be the item\'s gp value.');
    return true;
  }
  const itemName = nameSlice.join(' ') || 'item';
  if (valueGp <= 0) {
    whisperToCaller(c.io, c.ctx, '!craft: gp value must be positive.');
    return true;
  }
  const loaded = await loadCharacter(c, 'craft');
  if (!loaded) return true;
  const crafters = 1 + Math.max(0, helpers);
  const days = Math.ceil(valueGp / (50 * crafters));
  const raw = valueGp / (50 * crafters);
  const materialCost = Math.floor(valueGp / 2); // PHB: half the item's gp value in raw materials
  broadcastSystem(c.io, c.ctx,
    `🔨 **Craft ${itemName}** (${valueGp} gp item) — ${loaded.callerName}:\n` +
    `   Raw materials cost: **${materialCost} gp** (half the item's price, PHB p.187).\n` +
    `   Progress rate: 50 gp/day per proficient crafter × ${crafters} crafter${crafters === 1 ? '' : 's'} = ${50 * crafters} gp/day.\n` +
    `   Estimated time: **${days} day${days === 1 ? '' : 's'}** (${raw.toFixed(1)} raw).\n` +
    `   Proficiency required in the relevant tool (smith's / leatherworker's / …). XGE chapter 2 has rules for magic-item crafting (takes much longer).`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Multiclass prereqs (PHB p.163)
// ═══════════════════════════════════════════════════════════════════

const MULTICLASS_REQS: Record<string, { need: Array<Array<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'>>; note: string }> = {
  // `need` is a disjunction of conjunctions. Each inner array must be
  // fully satisfied (AND); the outer array is OR. Most classes have
  // a single conjunction (just STR, just CHA, etc.).
  barbarian: { need: [['str']], note: 'STR 13' },
  bard: { need: [['cha']], note: 'CHA 13' },
  cleric: { need: [['wis']], note: 'WIS 13' },
  druid: { need: [['wis']], note: 'WIS 13' },
  fighter: { need: [['str'], ['dex']], note: 'STR 13 OR DEX 13' },
  monk: { need: [['dex', 'wis']], note: 'DEX 13 AND WIS 13' },
  paladin: { need: [['str', 'cha']], note: 'STR 13 AND CHA 13' },
  ranger: { need: [['dex', 'wis']], note: 'DEX 13 AND WIS 13' },
  rogue: { need: [['dex']], note: 'DEX 13' },
  sorcerer: { need: [['cha']], note: 'CHA 13' },
  warlock: { need: [['cha']], note: 'CHA 13' },
  wizard: { need: [['int']], note: 'INT 13' },
  artificer: { need: [['int']], note: 'INT 13 (Eberron / TCE)' },
};

async function handleMulticlass(c: ChatCommandContext): Promise<boolean> {
  const targetClass = c.rest.trim().toLowerCase();
  if (!targetClass) {
    whisperToCaller(c.io, c.ctx,
      '!multiclass: usage `!multiclass <class>`. Checks the caller\'s scores against the PHB p.163 prereqs.');
    return true;
  }
  const req = MULTICLASS_REQS[targetClass];
  if (!req) {
    whisperToCaller(c.io, c.ctx,
      `!multiclass: unknown class "${targetClass}". Valid: ${Object.keys(MULTICLASS_REQS).join(', ')}.`);
    return true;
  }
  const loaded = await loadCharacter(c, 'multiclass');
  if (!loaded) return true;
  const lookup = (k: string): number => Number(loaded.scores?.[k] ?? loaded.scores?.[k.toLowerCase()]) || 0;

  const evaluated = req.need.map((group) => {
    const details = group.map((a) => ({ a, v: lookup(a), ok: lookup(a) >= 13 }));
    return { details, pass: details.every((d) => d.ok) };
  });
  const overallPass = evaluated.some((g) => g.pass);
  const rows = evaluated.map((g) => {
    return g.details.map((d) => `${d.a.toUpperCase()} ${d.v} ${d.ok ? '✓' : '✗'}`).join(' AND ');
  }).join(' OR ');
  broadcastSystem(c.io, c.ctx,
    `🎓 **Multiclass check — ${targetClass}** for ${loaded.callerName}:\n` +
    `   Required: ${req.note}\n` +
    `   Actual: ${rows}\n` +
    `   → **${overallPass ? 'QUALIFIED' : 'DOES NOT QUALIFY'}**${overallPass ? ' — player can take a level in this class on next level-up.' : ' — needs higher scores in the listed abilities first.'}`);
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Encumbrance variant (PHB p.176)
// ═══════════════════════════════════════════════════════════════════

async function handleEncumbrance(c: ChatCommandContext): Promise<boolean> {
  const loaded = await loadCharacter(c, 'encumbrance');
  if (!loaded) return true;
  const str = Number(loaded.scores?.str ?? loaded.scores?.strength) || 10;
  const carried = parseInt(c.rest.trim(), 10);
  const encumberedAt = str * 5;
  const heavyAt = str * 10;
  const maxLift = str * 15;

  const lines: string[] = [];
  lines.push(`🎒 **Encumbrance** for ${loaded.callerName} (STR ${str}, PHB p.176 variant rule):`);
  lines.push(`   • Light load:   up to **${encumberedAt} lb** (no penalty)`);
  lines.push(`   • Encumbered:   **${encumberedAt + 1}–${heavyAt} lb** (speed −10 ft)`);
  lines.push(`   • Heavily enc.: **${heavyAt + 1}–${maxLift} lb** (speed −20 ft, disadvantage on STR / DEX / CON ability checks, attack rolls, and saves)`);
  lines.push(`   • Max lift:     **${maxLift} lb** (PHB standard carrying capacity — no penalties)`);
  if (Number.isFinite(carried) && carried > 0) {
    let status: string;
    if (carried <= encumberedAt) status = 'Light (no penalty)';
    else if (carried <= heavyAt) status = '**Encumbered** (speed −10 ft)';
    else if (carried <= maxLift) status = '**Heavily encumbered** (speed −20 ft + disadvantage)';
    else status = '**Over max** (can drag at 5 ft/turn, nothing else)';
    lines.push(`   Currently carrying **${carried} lb** → ${status}.`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Currency conversion (PHB p.143)
// ═══════════════════════════════════════════════════════════════════

async function handleCurrency(c: ChatCommandContext): Promise<boolean> {
  const amount = c.rest.trim();
  if (!amount) {
    whisperToCaller(c.io, c.ctx,
      '!currency: usage `!currency <amount><unit>`. Examples: `!currency 150gp` → conversion table; `!currency 2500cp` → how much gold that is.');
    return true;
  }
  // Parse e.g. "150gp", "25 sp", "2cp".
  const m = amount.toLowerCase().match(/(\d+)\s*(cp|sp|ep|gp|pp)?/);
  if (!m) {
    whisperToCaller(c.io, c.ctx, `!currency: couldn't parse "${amount}". Try like \`150gp\`.`);
    return true;
  }
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 'gp') as 'cp' | 'sp' | 'ep' | 'gp' | 'pp';
  // Everything into copper-base. 1 gp = 100 cp. 1 pp = 1000 cp. 1 sp = 10 cp. 1 ep = 50 cp.
  const toCp: Record<string, number> = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
  const copperTotal = n * toCp[unit];
  const lines: string[] = [];
  lines.push(`💰 **Currency conversion** — ${n}${unit}:`);
  lines.push(`   • ${copperTotal.toLocaleString()} **cp**`);
  lines.push(`   • ${(copperTotal / 10).toLocaleString()} **sp**`);
  lines.push(`   • ${(copperTotal / 50).toLocaleString()} **ep**`);
  lines.push(`   • ${(copperTotal / 100).toLocaleString()} **gp**`);
  lines.push(`   • ${(copperTotal / 1000).toLocaleString()} **pp**`);
  lines.push(`   Rates: 10 cp = 1 sp · 2 sp = 1 cp coin wait — 10 cp = 1 sp · 5 sp = 1 ep · 2 ep = 1 gp · 10 gp = 1 pp.`);
  whisperToCaller(c.io, c.ctx, lines.join('\n'));
  return true;
}

registerChatCommand('craft', handleCraft);
registerChatCommand(['multiclass', 'mc'], handleMulticlass);
registerChatCommand(['encumbrance', 'carry'], handleEncumbrance);
registerChatCommand(['currency', 'convert'], handleCurrency);
