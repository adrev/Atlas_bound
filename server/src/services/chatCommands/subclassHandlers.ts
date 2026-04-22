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
 * Subclass feature helpers that are high-frequency enough to warrant
 * a chat-command shortcut:
 *   Song of Rest       — Bard L2 short-rest healing die bonus
 *   Wild Magic Surge   — Wild Magic Sorcerer chaos table
 *   Arcane Ward        — Abjuration Wizard absorb pool
 *   Aura of Courage    — Paladin L10 group frightened-immunity aura
 *   Sculpt Spells      — Evocation Wizard exempt-allies helper
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

// ────── !songofrest — Bard L2 healing die bonus ───────────
async function handleSongOfRest(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!songofrest: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('bard')) {
    whisperToCaller(c.io, c.ctx, `!songofrest: ${caller.name} isn't a Bard.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  if (lvl < 2) {
    whisperToCaller(c.io, c.ctx, '!songofrest: requires Bard L2.');
    return true;
  }
  // Die scales: d6 (L2), d8 (L9), d10 (L13), d12 (L17)
  const die = lvl >= 17 ? 12 : lvl >= 13 ? 10 : lvl >= 9 ? 8 : 6;
  const roll = Math.floor(Math.random() * die) + 1;
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🎵 ${charName} plays Song of Rest during the short rest — each ally who spends a Hit Die gains +${roll} (d${die}) HP.`,
  );
  return true;
}

// ────── !surge — Wild Magic Sorcerer chaos table ────────
const WILD_MAGIC_TABLE: Array<{ range: [number, number]; desc: string }> = [
  { range: [1, 2], desc: 'Roll on this table at the start of each of your turns for the next minute, ignoring this result on subsequent rolls.' },
  { range: [3, 4], desc: 'For the next minute, you can see any invisible creature if you have line of sight to it.' },
  { range: [5, 6], desc: 'A modron chosen and controlled by the DM appears in an unoccupied space within 5 ft, then disappears 1 min later.' },
  { range: [7, 8], desc: 'You cast Fireball (DC=yours) as a 3rd-level spell centered on yourself.' },
  { range: [9, 10], desc: 'You cast Magic Missile as a 5th-level spell.' },
  { range: [11, 12], desc: 'Your height changes by 1d4×10 cm (gain or lose, DM chooses).' },
  { range: [13, 14], desc: 'You cast Confusion centered on yourself.' },
  { range: [15, 16], desc: 'For the next minute, you regain 5 HP at the start of each of your turns.' },
  { range: [17, 18], desc: 'You grow a long beard made of feathers that remains until you sneeze — at that point the feathers fly out.' },
  { range: [19, 20], desc: 'You cast Grease centered on yourself.' },
  { range: [21, 22], desc: 'Creatures have disadvantage on saving throws against the next spell you cast in the next minute that involves a save.' },
  { range: [23, 24], desc: 'Your skin turns bright blue for 24 hours; Remove Curse removes it.' },
  { range: [25, 26], desc: 'A 3rd eye appears on your forehead for 1 min — you have advantage on sight-based WIS(Perception) checks.' },
  { range: [27, 28], desc: 'For the next minute, all your spells with a casting time of 1 action become bonus-action spells.' },
  { range: [29, 30], desc: 'You teleport up to 60 ft to an unoccupied space of your choice you can see.' },
  { range: [31, 32], desc: 'You are transported to the Astral Plane until the end of your next turn. Return to the space you occupied (or nearest unoccupied).' },
  { range: [33, 34], desc: 'Maximize the damage of the next damaging spell you cast within the next minute.' },
  { range: [35, 36], desc: 'Roll a d10. Your age changes by that many years; on even, older. On odd, younger (minimum 1).' },
  { range: [37, 38], desc: '1d6 flumphs controlled by the DM appear in unoccupied spaces within 60 ft and are frightened of you. Disappear 1 min later.' },
  { range: [39, 40], desc: 'You regain 2d10 HP.' },
  { range: [41, 42], desc: 'You turn into a potted plant until the start of your next turn. Incapacitated + vulnerable to all damage. If reduced to 0 HP, pot breaks + form returns.' },
  { range: [43, 44], desc: 'For the next minute, you can teleport up to 20 ft as a bonus action on each turn.' },
  { range: [45, 46], desc: 'You cast Levitate on yourself.' },
  { range: [47, 48], desc: 'A unicorn controlled by the DM appears in an unoccupied space within 5 ft, disappears 1 min later.' },
  { range: [49, 50], desc: 'You can\'t speak for the next minute; whenever you try, pink bubbles float out of your mouth.' },
  { range: [51, 52], desc: 'A spectral shield hovers near you for the next minute, granting +2 AC and immune to Magic Missile.' },
  { range: [53, 54], desc: 'You are immune to being intoxicated by alcohol for the next 5d6 days.' },
  { range: [55, 56], desc: 'Your hair falls out — it grows back 24 hours later.' },
  { range: [57, 58], desc: 'For the next minute, any flammable object you touch that isn\'t being worn or carried ignites.' },
  { range: [59, 60], desc: 'You regain your lowest-level expended spell slot.' },
  { range: [61, 62], desc: 'For the next minute, you must shout when you speak.' },
  { range: [63, 64], desc: 'You cast Fog Cloud centered on yourself.' },
  { range: [65, 66], desc: 'Up to three creatures you choose within 30 ft take 4d10 lightning damage.' },
  { range: [67, 68], desc: 'You are frightened by the nearest creature until the end of your next turn.' },
  { range: [69, 70], desc: 'Each creature within 30 ft becomes invisible for the next minute; invisibility ends on attack or cast.' },
  { range: [71, 72], desc: 'You gain resistance to all damage for the next minute.' },
  { range: [73, 74], desc: 'A random creature within 60 ft becomes poisoned for 1d4 hours.' },
  { range: [75, 76], desc: 'You glow with bright light in a 30-ft radius for the next minute. Any creature that ends turn within 5 ft of you is blinded until end of its next turn.' },
  { range: [77, 78], desc: 'You cast Polymorph on yourself. If you fail the WIS save you become a sheep for the duration.' },
  { range: [79, 80], desc: 'Illusory butterflies + flower petals flutter in the air within 10 ft of you for the next minute.' },
  { range: [81, 82], desc: 'You can take one additional action immediately.' },
  { range: [83, 84], desc: 'Each creature within 30 ft takes 1d10 necrotic damage; you regain HP equal to total damage dealt.' },
  { range: [85, 86], desc: 'You cast Mirror Image.' },
  { range: [87, 88], desc: 'You cast Fly on a random creature within 60 ft.' },
  { range: [89, 90], desc: 'You become invisible for the next minute; ends if you attack or cast.' },
  { range: [91, 92], desc: 'If you die within the next minute, you return to life 1 min later with 1 HP as if Reincarnated.' },
  { range: [93, 94], desc: 'Your size changes by one category for the next minute. Roll 1d4: 1 tiny, 2 small, 3 large, 4 huge.' },
  { range: [95, 96], desc: 'You and all creatures within 30 ft gain vulnerability to piercing damage for the next minute.' },
  { range: [97, 98], desc: 'You are surrounded by faint, ethereal music for the next minute.' },
  { range: [99, 100], desc: 'You regain all expended sorcery points.' },
];

async function handleSurge(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!surge: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('sorcerer')) {
    whisperToCaller(c.io, c.ctx, `!surge: ${caller.name} isn't a Sorcerer.`);
    return true;
  }
  const roll = Math.floor(Math.random() * 100) + 1;
  const entry = WILD_MAGIC_TABLE.find((e) => roll >= e.range[0] && roll <= e.range[1]);
  const desc = entry?.desc ?? '(roll off table)';
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🌪 **Wild Magic Surge** — ${charName} rolls d100 = **${roll}**:\n   ${desc}`,
  );
  return true;
}

// ────── !ward — Abjuration Wizard Arcane Ward ─────────────
/**
 * Arcane Ward (Wizard Abjuration School L2). First time you cast an
 * abjuration spell of 1st level or higher, gain a magical ward with
 * HP = (2 × wizard level) + INT mod. Ward absorbs damage before you
 * lose HP. Casting another 1st+ abjuration spell recharges by
 * 2 × spell level HP. Resets on long rest.
 *
 *   !ward           status
 *   !ward init      initialise on first abjuration cast (sets to max)
 *   !ward dmg <n>   subtract n from the ward
 *   !ward heal <n>  top up by n (up to max)
 *   !ward reset     long rest — clear ward entirely (next cast re-inits)
 */
const arcaneWards = new Map<string, { current: number; max: number }>();

async function handleWard(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase() || 'status';
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!ward: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, ability_scores, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('wizard')) {
    whisperToCaller(c.io, c.ctx, `!ward: ${caller.name} isn't a Wizard.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  if (lvl < 2) {
    whisperToCaller(c.io, c.ctx, '!ward: Arcane Ward requires Wizard L2 + Abjuration school.');
    return true;
  }
  const scores = typeof row?.ability_scores === 'string' ? JSON.parse(row.ability_scores as string) : (row?.ability_scores ?? {});
  const intMod = Math.floor((((scores as Record<string, number>).int ?? 10) - 10) / 2);
  const wardMax = (2 * lvl) + intMod;
  const charName = (row?.name as string) || caller.name;

  if (sub === 'status' || sub === '') {
    const w = arcaneWards.get(caller.characterId);
    if (!w) {
      whisperToCaller(c.io, c.ctx, `🛡 ${charName} Arcane Ward: not yet summoned. Cast an abjuration 1+ to init (max ${wardMax}).`);
    } else {
      whisperToCaller(c.io, c.ctx, `🛡 ${charName} Arcane Ward: ${w.current}/${w.max}.`);
    }
    return true;
  }
  if (sub === 'reset') {
    arcaneWards.delete(caller.characterId);
    broadcastSystem(c.io, c.ctx, `🛡 ${charName} Arcane Ward dissipates (long rest).`);
    return true;
  }
  if (sub === 'init') {
    const w = { current: wardMax, max: wardMax };
    arcaneWards.set(caller.characterId, w);
    broadcastSystem(c.io, c.ctx, `🛡 ${charName}'s Arcane Ward springs up — ${wardMax}/${wardMax} HP.`);
    return true;
  }
  const n = parseInt(parts[1], 10);
  if (!Number.isFinite(n) || n < 0) {
    whisperToCaller(c.io, c.ctx, '!ward: amount must be a non-negative integer.');
    return true;
  }
  let w = arcaneWards.get(caller.characterId);
  if (!w) { w = { current: wardMax, max: wardMax }; arcaneWards.set(caller.characterId, w); }
  if (sub === 'dmg' || sub === 'damage') {
    const absorbed = Math.min(w.current, n);
    const overflow = n - absorbed;
    w.current = Math.max(0, w.current - absorbed);
    broadcastSystem(
      c.io, c.ctx,
      `🛡 ${charName}'s Arcane Ward absorbs ${absorbed} dmg → ${w.current}/${w.max}.${overflow > 0 ? ` ${overflow} dmg carries through to HP.` : ''}`,
    );
    return true;
  }
  if (sub === 'heal' || sub === 'recharge') {
    const prior = w.current;
    w.current = Math.min(w.max, w.current + n);
    broadcastSystem(c.io, c.ctx, `🛡 ${charName}'s Arcane Ward recharges ${w.current - prior} → ${w.current}/${w.max}.`);
    return true;
  }
  whisperToCaller(c.io, c.ctx, `!ward: unknown subcommand "${sub}".`);
  return true;
}

// ────── !courage — Paladin L10 Aura of Courage ───────────
/**
 * Announces that the caster's 10-ft aura grants frightened immunity
 * to all non-unconscious allies. We don't auto-remove frightened
 * from ally tokens because players might intentionally want to
 * track the condition visually; this just reminds.
 */
async function handleCourage(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!courage: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('paladin')) {
    whisperToCaller(c.io, c.ctx, `!courage: ${caller.name} isn't a Paladin.`);
    return true;
  }
  const lvl = Number(row?.level) || 1;
  if (lvl < 10) {
    whisperToCaller(c.io, c.ctx, '!courage: Aura of Courage requires Paladin L10.');
    return true;
  }
  const radius = lvl >= 18 ? 30 : 10;
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `🦁 **Aura of Courage** — ${charName} and allies within ${radius} ft can't be frightened while ${charName} is conscious.`,
  );
  // Also clear frightened from any ally within radius.
  const gridSize = (c.ctx.room.currentMapId && c.ctx.room.mapGridSizes.get(c.ctx.room.currentMapId)) || 70;
  const cSize = (caller as Token).size || 1;
  const ccx = caller.x + (gridSize * cSize) / 2;
  const ccy = caller.y + (gridSize * cSize) / 2;
  const isPC = !!caller.ownerUserId;
  const radiusPx = (radius / 5) * gridSize;
  const cleared: string[] = [];
  for (const ally of c.ctx.room.tokens.values()) {
    const allyIsPC = !!ally.ownerUserId;
    if (allyIsPC !== isPC) continue; // only same side
    if (!(ally.conditions as string[]).includes('frightened')) continue;
    const aSize = (ally as Token).size || 1;
    const acx = ally.x + (gridSize * aSize) / 2;
    const acy = ally.y + (gridSize * aSize) / 2;
    const dx = Math.max(0, Math.abs(acx - ccx) - (aSize * gridSize) / 2 - (cSize * gridSize) / 2);
    const dy = Math.max(0, Math.abs(acy - ccy) - (aSize * gridSize) / 2 - (cSize * gridSize) / 2);
    if (Math.max(dx, dy) > radiusPx + 1) continue;
    ConditionService.removeCondition(c.ctx.room.sessionId, ally.id, 'frightened');
    cleared.push(ally.name);
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: ally.id,
      changes: tokenConditionChanges(c.ctx.room, ally.id),
    });
  }
  if (cleared.length > 0) {
    broadcastSystem(c.io, c.ctx, `   → Cleared Frightened from: ${cleared.join(', ')}`);
  }
  return true;
}

// ────── !sculpt — Evocation Wizard exempt-allies helper ──
/**
 * Sculpt Spells (Wizard Evocation L2). Whenever you cast an
 * evocation that deals damage, you can protect some of the creatures
 * it affects — number = 1 + spell level. Those creatures take no
 * damage from the spell.
 *
 *   !sculpt <spell-level>  — announces how many allies can be
 *                            exempted; DM excludes those from !save.
 */
async function handleSculpt(c: ChatCommandContext): Promise<boolean> {
  const lvl = parseInt(c.rest.trim(), 10);
  if (!Number.isFinite(lvl) || lvl < 1 || lvl > 9) {
    whisperToCaller(c.io, c.ctx, '!sculpt: usage `!sculpt <spell-level>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!sculpt: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name, features FROM characters WHERE id = $1', [caller.characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('wizard')) {
    whisperToCaller(c.io, c.ctx, `!sculpt: ${caller.name} isn't a Wizard.`);
    return true;
  }
  // Feature check
  let hasSculpt = false;
  try {
    const rawF = row?.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF as string) : (rawF ?? []);
    hasSculpt = Array.isArray(feats) && feats.some(
      (f: { name?: string }) => typeof f?.name === 'string' && /sculpt\s+spells/i.test(f.name),
    );
  } catch { /* ignore */ }
  if (!hasSculpt) {
    whisperToCaller(c.io, c.ctx, `!sculpt: ${caller.name} doesn't have Sculpt Spells (requires School of Evocation).`);
    return true;
  }
  const exempt = 1 + lvl;
  const charName = (row?.name as string) || caller.name;
  broadcastSystem(
    c.io, c.ctx,
    `✨ **Sculpt Spells** — ${charName} protects up to ${exempt} creatures from their level-${lvl} evocation damage. Those creatures automatically succeed on the save + take no damage.`,
  );
  return true;
}

registerChatCommand(['songofrest', 'sor'], handleSongOfRest);
registerChatCommand(['surge', 'wildmagic'], handleSurge);
registerChatCommand('ward', handleWard);
registerChatCommand(['courage', 'auraofcourage'], handleCourage);
registerChatCommand('sculpt', handleSculpt);
