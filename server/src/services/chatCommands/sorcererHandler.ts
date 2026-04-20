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
 * Sorcerer features — Sorcery Points + Flexible Casting + Metamagic.
 *
 * Sorcery Points per RAW = Sorcerer level (default). Refreshes on a
 * long rest.
 *
 *   !sp [status | use <n> | reset | set <n>]
 *
 * Flexible Casting — convert slots ↔ sorcery points:
 *   Create slot  1st=2sp / 2nd=3sp / 3rd=5sp / 4th=6sp / 5th=7sp
 *   Burn slot    return points equal to the slot level (max 5)
 *   !flexible slot<->point <level>
 *
 * Metamagic (!meta <name>) — just burns the cost + announces:
 *   careful (1)   allies succeed saves vs your save spells
 *   distant (1)   double range / reach
 *   empowered (1) reroll damage dice (up to CHA mod)
 *   extended (1)  double duration
 *   heightened (3) target has disadv on first save
 *   quickened (2) cast as bonus action
 *   seeking (2)   reroll missed spell attack
 *   subtle (1)    no V + S components
 *   twinned (N)   cost = spell level (0 for cantrip), second target
 */

const METAMAGIC_COSTS: Record<string, number> = {
  careful: 1,
  distant: 1,
  empowered: 1,
  extended: 1,
  heightened: 3,
  quickened: 2,
  seeking: 2,
  subtle: 1,
  // twinned is variable — pass spell level as the second arg.
};
const METAMAGIC_EFFECTS: Record<string, string> = {
  careful: "allies auto-succeed saves vs this save-spell",
  distant: "double range (ranged) or reach (touch → 30 ft)",
  empowered: "reroll up to CHA mod damage dice — keep the new roll",
  extended: "double duration (max 24 h)",
  heightened: "one target: disadvantage on first save against the spell",
  quickened: "cast as a bonus action (1-action spells only)",
  seeking: "reroll a missed spell attack roll",
  subtle: "cast without verbal + somatic components",
  twinned: "target a second creature at the same level (single-target spell)",
};

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function requireSorc(c: ChatCommandContext, cmdName: string): Promise<{ caller: Token; level: number; charId: string; sorcName: string } | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('sorcerer')) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: ${caller.name} isn't a Sorcerer.`);
    return null;
  }
  return {
    caller,
    level: Number(row?.level) || 1,
    charId: caller.characterId,
    sorcName: (row?.name as string) || caller.name,
  };
}

function getOrSeedSP(ctx: PlayerContext, charId: string, level: number): { max: number; remaining: number } {
  let pools = ctx.room.pointPools.get(charId);
  if (!pools) {
    pools = new Map();
    ctx.room.pointPools.set(charId, pools);
  }
  let sp = pools.get('sp');
  if (!sp) {
    sp = { max: level, remaining: level };
    pools.set('sp', sp);
  }
  return sp;
}

// ────── !sp [status | use <n> | reset | set <n>] ───────────
async function handleSP(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sorc = await requireSorc(c, 'sp');
  if (!sorc) return true;
  const sp = getOrSeedSP(c.ctx, sorc.charId, sorc.level);

  const sub = parts[0]?.toLowerCase() || 'status';

  if (sub === 'status' || sub === '') {
    whisperToCaller(c.io, c.ctx, `💠 ${sorc.sorcName} Sorcery Points: ${sp.remaining}/${sp.max}.`);
    return true;
  }

  if (sub === 'set') {
    if (c.ctx.player.role !== 'dm') {
      whisperToCaller(c.io, c.ctx, '!sp set: DM only.');
      return true;
    }
    const n = parseInt(parts[1], 10);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      whisperToCaller(c.io, c.ctx, '!sp set: max must be 0-20.');
      return true;
    }
    sp.max = n;
    sp.remaining = Math.min(sp.remaining, sp.max);
    broadcastSystem(c.io, c.ctx, `💠 ${sorc.sorcName} Sorcery Point pool set to ${sp.max}.`);
    return true;
  }

  if (sub === 'reset') {
    sp.remaining = sp.max;
    broadcastSystem(c.io, c.ctx, `💠 ${sorc.sorcName} Sorcery Points refreshed to ${sp.max}/${sp.max}.`);
    return true;
  }

  if (sub === 'use' || sub === 'spend') {
    const n = parseInt(parts[1], 10) || 1;
    if (sp.remaining < n) {
      whisperToCaller(c.io, c.ctx, `!sp: not enough (${sp.remaining}/${sp.max}).`);
      return true;
    }
    sp.remaining -= n;
    broadcastSystem(c.io, c.ctx, `💠 ${sorc.sorcName} spends ${n} SP (${sp.remaining}/${sp.max} left).`);
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!sp: unknown subcommand "${sub}".`);
  return true;
}

// ────── !meta <name> [spell-level-for-twinned] ─────────────
async function handleMetamagic(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io, c.ctx,
      '!meta: usage `!meta <name>` — careful / distant / empowered / extended / heightened / quickened / seeking / subtle / twinned <lvl>',
    );
    return true;
  }
  const name = parts[0].toLowerCase();
  const sorc = await requireSorc(c, 'meta');
  if (!sorc) return true;
  const sp = getOrSeedSP(c.ctx, sorc.charId, sorc.level);

  let cost: number;
  if (name === 'twinned') {
    const lvl = parseInt(parts[1], 10);
    if (!Number.isFinite(lvl) || lvl < 0 || lvl > 9) {
      whisperToCaller(c.io, c.ctx, '!meta twinned: second arg = spell level (0 for cantrip).');
      return true;
    }
    cost = Math.max(1, lvl); // cantrip = 1, else spell level
  } else if (name in METAMAGIC_COSTS) {
    cost = METAMAGIC_COSTS[name];
  } else {
    whisperToCaller(c.io, c.ctx, `!meta: unknown metamagic "${name}".`);
    return true;
  }

  if (sp.remaining < cost) {
    whisperToCaller(c.io, c.ctx, `!meta ${name}: need ${cost} SP, have ${sp.remaining}.`);
    return true;
  }
  sp.remaining -= cost;
  const effect = METAMAGIC_EFFECTS[name] ?? 'metamagic applied';
  broadcastSystem(
    c.io, c.ctx,
    `💠 ${sorc.sorcName} uses **${name.charAt(0).toUpperCase() + name.slice(1)} Spell** (${cost} SP) — ${effect}. (${sp.remaining}/${sp.max} SP left)`,
  );
  return true;
}

// ────── !flexible slot2sp|sp2slot <lvl> ────────────────────
/**
 * Flexible Casting conversions. Points required to CREATE a slot:
 *   1st=2 / 2nd=3 / 3rd=5 / 4th=6 / 5th=7
 * BURNING a slot yields points equal to the slot level (max 5 for
 * higher-level slots by RAW; 5 for anything ≥ 5th).
 */
const SP_TO_SLOT_COST: Record<number, number> = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7 };
function slotToSpReturn(level: number): number {
  if (level <= 0) return 0;
  return Math.min(5, level);
}

async function handleFlexible(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(
      c.io, c.ctx,
      '!flexible: usage `!flexible slot2sp <level>` | `!flexible sp2slot <level>`',
    );
    return true;
  }
  const direction = parts[0].toLowerCase();
  const lvl = parseInt(parts[1], 10);
  if (!Number.isFinite(lvl) || lvl < 1 || lvl > 9) {
    whisperToCaller(c.io, c.ctx, '!flexible: level must be 1-9.');
    return true;
  }
  const sorc = await requireSorc(c, 'flexible');
  if (!sorc) return true;
  const sp = getOrSeedSP(c.ctx, sorc.charId, sorc.level);

  // Load slots from the character row.
  const { rows } = await pool.query(
    'SELECT spell_slots FROM characters WHERE id = $1',
    [sorc.charId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  let slots: Record<string, { max: number; used: number }> = {};
  try {
    const raw = row?.spell_slots;
    slots = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Record<string, { max: number; used: number }>;
  } catch { /* ignore */ }
  const key = String(lvl);
  const slot = slots[key];

  if (direction === 'slot2sp') {
    if (!slot || slot.used >= slot.max) {
      whisperToCaller(c.io, c.ctx, `!flexible: no level ${lvl} slot to burn.`);
      return true;
    }
    const gain = slotToSpReturn(lvl);
    slots[key] = { ...slot, used: slot.used + 1 };
    sp.remaining = Math.min(sp.max, sp.remaining + gain);
    await pool.query('UPDATE characters SET spell_slots = $1 WHERE id = $2',
      [JSON.stringify(slots), sorc.charId],
    ).catch((e) => console.warn('[flexible] slot write failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: sorc.charId,
      changes: { spellSlots: slots },
    });
    broadcastSystem(
      c.io, c.ctx,
      `💠 ${sorc.sorcName} burns a level ${lvl} slot — gains ${gain} SP (${sp.remaining}/${sp.max}).`,
    );
    return true;
  }

  if (direction === 'sp2slot') {
    const cost = SP_TO_SLOT_COST[lvl];
    if (cost === undefined) {
      whisperToCaller(c.io, c.ctx, '!flexible sp2slot: can only create 1st-5th level slots.');
      return true;
    }
    if (sp.remaining < cost) {
      whisperToCaller(c.io, c.ctx, `!flexible: need ${cost} SP to create a level ${lvl} slot (${sp.remaining}/${sp.max}).`);
      return true;
    }
    if (!slot) {
      whisperToCaller(
        c.io, c.ctx,
        `!flexible: ${sorc.sorcName} has no level ${lvl} slot row to refill. Sorcerers can only create slots of levels they already have.`,
      );
      return true;
    }
    if (slot.used === 0) {
      whisperToCaller(c.io, c.ctx, `!flexible: level ${lvl} slot is already full.`);
      return true;
    }
    sp.remaining -= cost;
    slots[key] = { ...slot, used: slot.used - 1 };
    await pool.query('UPDATE characters SET spell_slots = $1 WHERE id = $2',
      [JSON.stringify(slots), sorc.charId],
    ).catch((e) => console.warn('[flexible] slot refill failed:', e));
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: sorc.charId,
      changes: { spellSlots: slots },
    });
    broadcastSystem(
      c.io, c.ctx,
      `💠 ${sorc.sorcName} converts ${cost} SP → level ${lvl} slot. (${sp.remaining}/${sp.max} SP left)`,
    );
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!flexible: unknown direction "${direction}". Use slot2sp or sp2slot.`);
  return true;
}

registerChatCommand(['sp', 'sorcerypoints'], handleSP);
registerChatCommand(['meta', 'metamagic'], handleMetamagic);
registerChatCommand('flexible', handleFlexible);
