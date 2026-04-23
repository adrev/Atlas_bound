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
 * Tier 20 — Magic items with charges + common consumables:
 *   !wand <target> <darts>         — Wand of Magic Missiles (7 charges, 1d4+1 each)
 *   !staffheal <target> <spell>    — Staff of Healing (10 charges)
 *   !potionplus <target> <tier>    — Potion of Healing variants
 *   !bagofholding <in|out|weight>  — tracker for contents
 *   !deck                           — Deck of Many Things (d13, summary)
 *   !scroll <spell>                 — consume a scroll
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

async function applyHealToToken(c: ChatCommandContext, target: Token, amount: number): Promise<{ hpBefore: number; newHp: number; maxHp: number }> {
  const combat = c.ctx.room.combatState;
  const combatant = combat?.combatants.find((x) => x.tokenId === target.id);
  if (combatant) {
    const hpBefore = combatant.hp;
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + amount);
    if (combatant.characterId) {
      await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [combatant.hp, combatant.characterId]).catch(() => {});
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: combatant.characterId,
        changes: { hitPoints: combatant.hp },
      });
    }
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: target.id,
      hp: combatant.hp,
      tempHp: combatant.tempHp,
      change: amount,
      type: 'heal',
    });
    return { hpBefore, newHp: combatant.hp, maxHp: combatant.maxHp };
  }
  if (target.characterId) {
    const { rows } = await pool.query('SELECT hit_points, max_hit_points FROM characters WHERE id = $1', [target.characterId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    const curHp = Number(row?.hit_points) || 0;
    const maxHp = Number(row?.max_hit_points) || 0;
    const newHp = Math.min(maxHp, curHp + amount);
    await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [newHp, target.characterId]).catch(() => {});
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { hitPoints: newHp },
    });
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: target.id,
      hp: newHp,
      tempHp: 0,
      change: amount,
      type: 'heal',
    });
    return { hpBefore: curHp, newHp, maxHp };
  }
  return { hpBefore: 0, newHp: 0, maxHp: 0 };
}

/**
 * Per-character charge pools for magic items. Key: `item:<itemName>`.
 * Daily items refresh on dawn per RAW (close enough to long rest).
 */
function getOrSeedItemPool(ctx: PlayerContext, charId: string, key: string, max: number): { max: number; remaining: number } {
  let pools = ctx.room.pointPools.get(charId);
  if (!pools) {
    pools = new Map();
    ctx.room.pointPools.set(charId, pools);
  }
  let p = pools.get(key);
  if (!p) {
    p = { max, remaining: max };
    pools.set(key, p);
  }
  return p;
}

// ────── Wand of Magic Missiles ──────────────────────
async function handleWand(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!wand: usage `!wand <target> <darts>` | `!wand recharge`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!wand: no owned PC token.');
    return true;
  }
  if (parts[0].toLowerCase() === 'recharge' || parts[0].toLowerCase() === 'reset') {
    const pool_ = getOrSeedItemPool(c.ctx, caller.characterId, 'item:wandofmm', 7);
    // 1d6+1 recharge per dawn.
    const regen = Math.floor(Math.random() * 6) + 2;
    pool_.remaining = Math.min(pool_.max, pool_.remaining + regen);
    broadcastSystem(c.io, c.ctx, `🪄 Wand of Magic Missiles: regen 1d6+1 = **${regen}** charges → ${pool_.remaining}/${pool_.max}.`);
    return true;
  }
  const darts = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(darts) || darts < 1 || darts > 3) {
    whisperToCaller(c.io, c.ctx, '!wand: darts must be 1-3 (costs that many charges).');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!wand: no token named "${targetName}".`);
    return true;
  }
  const pool_ = getOrSeedItemPool(c.ctx, caller.characterId, 'item:wandofmm', 7);
  if (pool_.remaining < darts) {
    whisperToCaller(c.io, c.ctx, `!wand: only ${pool_.remaining} charges left.`);
    return true;
  }
  pool_.remaining -= darts;
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < darts; i++) {
    const r = Math.floor(Math.random() * 4) + 2;
    rolls.push(r - 1);
    total += r;
  }
  const wandBreakdown: SpellCastBreakdown = {
    caster: { name: caller.name, tokenId: caller.id },
    spell: {
      name: `Wand of Magic Missiles (${darts} missile${darts > 1 ? 's' : ''})`,
      level: darts,
      kind: 'auto-damage',
      damageType: 'force',
    },
    notes: [
      `Charges spent: ${darts} (1 per missile)`,
      `Charges remaining: ${pool_.remaining}/${pool_.max}`,
      `Per-missile damage: 1d4+1`,
      `Auto-hit (no attack roll)`,
    ],
    targets: [{
      name: target.name,
      tokenId: target.id,
      kind: 'damage-flat',
      damage: {
        dice: `${darts}d4+${darts}`,
        diceRolls: rolls,
        mainRoll: total,
        bonuses: [],
        finalDamage: total,
        targetHpBefore: 0,
        targetHpAfter: 0,
      },
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🪄 **Wand of Magic Missiles** — ${darts} missile${darts > 1 ? 's' : ''} → ${target.name}: [${rolls.map((r) => `${r}+1`).join(', ')}] = **${total} force** (auto-hit). Charges ${pool_.remaining}/${pool_.max}.`,
    { spellResult: wandBreakdown },
  );
  return true;
}

// ────── Staff of Healing ────────────────────────────
async function handleStaffHeal(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!staffheal: usage `!staffheal <target> <cure|lesser|mass> [slot]` | `!staffheal recharge`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!staffheal: no owned PC token.');
    return true;
  }
  if (parts[0].toLowerCase() === 'recharge') {
    const pool_ = getOrSeedItemPool(c.ctx, caller.characterId, 'item:staffofhealing', 10);
    const regen = Math.floor(Math.random() * 6) + 2;
    pool_.remaining = Math.min(pool_.max, pool_.remaining + regen);
    broadcastSystem(c.io, c.ctx, `🌿 Staff of Healing: regen 1d6+1 = **${regen}** charges → ${pool_.remaining}/${pool_.max}.`);
    return true;
  }
  // spell name is the second-to-last or last arg, depending on slot presence
  const lastIsNum = Number.isFinite(parseInt(parts[parts.length - 1], 10));
  const slot = lastIsNum ? parseInt(parts[parts.length - 1], 10) : 1;
  const spellName = (lastIsNum ? parts[parts.length - 2] : parts[parts.length - 1]).toLowerCase();
  const targetName = parts.slice(0, lastIsNum ? parts.length - 2 : parts.length - 1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!staffheal: no token named "${targetName}".`);
    return true;
  }
  const pool_ = getOrSeedItemPool(c.ctx, caller.characterId, 'item:staffofhealing', 10);
  let cost = 1;
  let dice = 1;
  let label = 'Cure Wounds';
  if (spellName === 'lesser' || spellName === 'lesserrestoration') {
    cost = 2; dice = 0; label = 'Lesser Restoration';
  } else if (spellName === 'mass' || spellName === 'masscure') {
    cost = 5; dice = 3; label = 'Mass Cure Wounds';
  } else {
    // Cure Wounds at slot level
    cost = slot;
    dice = slot;
    label = `Cure Wounds (L${slot})`;
  }
  if (pool_.remaining < cost) {
    whisperToCaller(c.io, c.ctx, `!staffheal: need ${cost} charges (have ${pool_.remaining}).`);
    return true;
  }
  pool_.remaining -= cost;
  if (dice > 0) {
    const rolls: number[] = [];
    let total = 3; // +caster mod, assume +3 for simplicity at table
    for (let i = 0; i < dice; i++) {
      const r = Math.floor(Math.random() * 8) + 1;
      rolls.push(r);
      total += r;
    }
    const { hpBefore, newHp, maxHp } = await applyHealToToken(c, target, total);
    const shBreakdown: SpellCastBreakdown = {
      caster: { name: caller.name, tokenId: caller.id },
      spell: {
        name: `Staff of Healing — ${label}`,
        level: slot,
        kind: 'heal',
      },
      notes: [
        `Magic item charge cost: ${cost}`,
        `Charges remaining: ${pool_.remaining}/${pool_.max}`,
        `Heal formula: ${dice}d8 + caster spell mod (assumed +3)`,
      ],
      targets: [{
        name: target.name,
        tokenId: target.id,
        kind: 'heal',
        healing: {
          dice: `${dice}d8+3`,
          diceRolls: rolls,
          mainRoll: total,
          targetHpBefore: hpBefore,
          targetHpAfter: newHp,
        },
      }],
    };
    broadcastSystem(
      c.io, c.ctx,
      `🌿 **Staff of Healing — ${label}** → ${target.name}: ${dice}d8+mod [${rolls.join(',')}] = **${total}**${maxHp ? ` (${newHp}/${maxHp})` : ''}. Charges ${pool_.remaining}/${pool_.max}.`,
      { spellResult: shBreakdown },
    );
  } else {
    // Lesser Restoration — no dice, but structured action card.
    const lrBreakdown: ActionBreakdown = {
      actor: { name: caller.name, tokenId: caller.id },
      action: {
        name: `Staff of Healing — ${label}`,
        category: 'magic-item',
        icon: '🌿',
        cost: `${cost} charges`,
      },
      effect: `${target.name} is cured of one non-exhaustion, non-disease condition.`,
      targets: [{
        name: target.name,
        tokenId: target.id,
        effect: 'One condition cured',
      }],
      notes: [
        `Staff of Healing`,
        `Charges spent: ${cost}`,
        `Charges remaining: ${pool_.remaining}/${pool_.max}`,
      ],
    };
    broadcastSystem(
      c.io, c.ctx,
      `🌿 **Staff of Healing — ${label}** → ${target.name}: cures a non-exhaustion, non-disease condition. Charges ${pool_.remaining}/${pool_.max}.`,
      { actionResult: lrBreakdown },
    );
  }
  return true;
}

// ────── Potion variants ────────────────────────────
const POTION_TIERS: Record<string, { dice: number; die: number; flat: number; rarity: string }> = {
  healing: { dice: 2, die: 4, flat: 2, rarity: 'Common' },
  greater: { dice: 4, die: 4, flat: 4, rarity: 'Uncommon' },
  superior: { dice: 8, die: 4, flat: 8, rarity: 'Rare' },
  supreme: { dice: 10, die: 4, flat: 20, rarity: 'Very Rare' },
};

async function handlePotionPlus(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!potionplus: usage `!potionplus <target> <healing|greater|superior|supreme>`');
    return true;
  }
  const tier = parts[parts.length - 1].toLowerCase();
  const cfg = POTION_TIERS[tier];
  if (!cfg) {
    whisperToCaller(c.io, c.ctx, '!potionplus: tier must be healing|greater|superior|supreme.');
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!potionplus: no token named "${targetName}".`);
    return true;
  }
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < cfg.dice; i++) {
    const r = Math.floor(Math.random() * cfg.die) + 1;
    rolls.push(r);
    sum += r;
  }
  const total = sum + cfg.flat;
  const { hpBefore, newHp, maxHp } = await applyHealToToken(c, target, total);
  const caller = resolveCallerToken(c.ctx);
  const potionBreakdown: SpellCastBreakdown = {
    caster: { name: caller?.name ?? 'Someone', tokenId: caller?.id },
    spell: {
      name: `Potion of ${tier.charAt(0).toUpperCase() + tier.slice(1)} Healing`,
      level: 0,
      kind: 'heal',
    },
    notes: [
      `Magic item (${cfg.rarity})`,
      `Heal formula: ${cfg.dice}d${cfg.die}+${cfg.flat} = ${total}`,
      `Action: use consumable`,
    ],
    targets: [{
      name: target.name,
      tokenId: target.id,
      kind: 'heal',
      healing: {
        dice: `${cfg.dice}d${cfg.die}+${cfg.flat}`,
        diceRolls: rolls,
        mainRoll: total,
        targetHpBefore: hpBefore,
        targetHpAfter: newHp,
      },
    }],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🧪 **Potion of ${tier.charAt(0).toUpperCase() + tier.slice(1)} Healing** (${cfg.rarity}) → ${target.name}: ${cfg.dice}d${cfg.die}+${cfg.flat} [${rolls.join(',')}]+${cfg.flat} = **${total}**${maxHp ? ` (${newHp}/${maxHp})` : ''}.`,
    { spellResult: potionBreakdown },
  );
  return true;
}

// ────── Bag of Holding ─────────────────────────────
async function handleBagOfHolding(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    whisperToCaller(c.io, c.ctx, '!bagofholding: usage `!bagofholding <in|out|weight|check> [item] [lbs]`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!bagofholding: no owned PC token.');
    return true;
  }
  const sub = parts[0].toLowerCase();
  const pool_ = getOrSeedItemPool(c.ctx, caller.characterId, 'item:bagofholding', 500);
  // remaining = lbs still available (capacity 500 lbs)
  if (sub === 'in' || sub === 'insert') {
    const weight = parseInt(parts[parts.length - 1], 10);
    const item = parts.slice(1, -1).join(' ') || 'unnamed item';
    if (!Number.isFinite(weight) || weight < 0) {
      whisperToCaller(c.io, c.ctx, '!bagofholding in: usage `!bagofholding in <item> <lbs>`');
      return true;
    }
    if (pool_.remaining < weight) {
      whisperToCaller(c.io, c.ctx, `!bagofholding: over capacity. ${pool_.remaining}/${pool_.max} lbs free.`);
      return true;
    }
    pool_.remaining -= weight;
    broadcastSystem(c.io, c.ctx, `🧳 Stored **${item}** (${weight} lbs) in Bag of Holding. Free: ${pool_.remaining}/${pool_.max} lbs.`);
    return true;
  }
  if (sub === 'out' || sub === 'remove') {
    const weight = parseInt(parts[parts.length - 1], 10);
    const item = parts.slice(1, -1).join(' ') || 'unnamed item';
    if (!Number.isFinite(weight) || weight < 0) {
      whisperToCaller(c.io, c.ctx, '!bagofholding out: usage `!bagofholding out <item> <lbs>`');
      return true;
    }
    pool_.remaining = Math.min(pool_.max, pool_.remaining + weight);
    broadcastSystem(c.io, c.ctx, `🧳 Retrieved **${item}** (${weight} lbs) from Bag of Holding. Free: ${pool_.remaining}/${pool_.max} lbs.`);
    return true;
  }
  whisperToCaller(c.io, c.ctx, `🧳 Bag of Holding: ${pool_.remaining}/${pool_.max} lbs free. Max item size: Medium / 500 lbs total.`);
  return true;
}

// ────── Deck of Many Things ────────────────────────
const DOMT_13: Array<{ card: string; effect: string }> = [
  { card: 'Balance', effect: 'Your alignment changes (CG ↔ LE, LG ↔ CE, etc.) — DM decides axis.' },
  { card: 'Comet', effect: 'If you single-handedly defeat the next hostile monster encountered, gain XP for next level. Otherwise no effect.' },
  { card: 'Donjon', effect: 'You vanish. Magically imprisoned until greater restoration / wish / etc. frees you.' },
  { card: 'Euryale', effect: 'Medusa curse: -2 to all saving throws permanently (removed by remove curse from good-aligned cleric L15+).' },
  { card: 'Fates', effect: 'Rewrite reality — reroll any event. Keep the card to use later.' },
  { card: 'Flames', effect: 'A devil is jealous. Hostile devil seeks to ruin you.' },
  { card: 'Fool', effect: 'Lose 10,000 XP (drop a level if it would drop you). Must then draw 2 more cards.' },
  { card: 'Gem', effect: 'Gain 25 pieces of jewelry worth 2,000 gp each or 50 gems worth 100 gp each.' },
  { card: 'Idiot', effect: 'Permanently reduce INT by 1d4+1. Draw 1 additional card.' },
  { card: 'Jester', effect: 'Gain 10,000 XP, or draw 2 additional cards.' },
  { card: 'Key', effect: 'A rare magic weapon appears in your hands — DM chooses.' },
  { card: 'Knight', effect: 'Gain services of a 4th-level Fighter (loyal, until death).' },
  { card: 'Moon', effect: '1d3 wish spells granted — can be used within 30 days.' },
];

async function handleDeck(c: ChatCommandContext): Promise<boolean> {
  const roll = Math.floor(Math.random() * DOMT_13.length);
  const chosen = DOMT_13[roll];
  const caller = resolveCallerToken(c.ctx);
  const callerName = caller?.name ?? 'Someone';
  const deckBreakdown: ActionBreakdown = {
    actor: { name: callerName, tokenId: caller?.id },
    action: {
      name: `Deck of Many Things — ${chosen.card}`,
      category: 'magic-item',
      icon: '🎴',
      cost: '1 draw',
    },
    effect: chosen.effect,
    notes: [
      `Card drawn: ${chosen.card}`,
      `Table entry: ${roll + 1} of ${DOMT_13.length}`,
      `DM adjudicates consequences`,
    ],
  };
  broadcastSystem(
    c.io, c.ctx,
    `🎴 **Deck of Many Things** — ${callerName} draws **${chosen.card}**:\n   ${chosen.effect}`,
    { actionResult: deckBreakdown },
  );
  return true;
}

// ────── Scroll ─────────────────────────────────────
async function handleScroll(c: ChatCommandContext): Promise<boolean> {
  const spell = c.rest.trim() || 'unspecified spell';
  const caller = resolveCallerToken(c.ctx);
  const callerName = caller?.name ?? 'Someone';
  broadcastSystem(
    c.io, c.ctx,
    `📜 **Spell Scroll** — ${callerName} unfurls and casts **${spell}** from the scroll. Scroll is consumed. (If not on your class list: DC 10+spell-level INT check or spell fails.)`,
  );
  return true;
}

registerChatCommand('wand', handleWand);
registerChatCommand(['staffheal', 'staffofhealing'], handleStaffHeal);
registerChatCommand(['potionplus', 'healpotionplus'], handlePotionPlus);
registerChatCommand(['bagofholding', 'bag'], handleBagOfHolding);
registerChatCommand(['deck', 'domt'], handleDeck);
registerChatCommand(['scroll'], handleScroll);
