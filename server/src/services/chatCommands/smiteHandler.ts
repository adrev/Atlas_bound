import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token, SpellCastBreakdown } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * !smite <level> [undead|fiend]
 *   Paladin's Divine Smite. Rolls (level+1)d8 radiant damage —
 *   capped at 5d8 for a 5th-level slot (RAW cap). Optional
 *   `undead` or `fiend` flag adds +1d8 per the enhanced-damage
 *   rider. Consumes a matching spell slot off the caller's
 *   character sheet.
 *
 *   Resolves the caller's token via ownership (first owned PC on
 *   the current map), matching the !rage / !inspire convention.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function handleSmite(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!smite: usage `!smite <level> [undead|fiend] [crit]`');
    return true;
  }
  const level = parseInt(parts[0], 10);
  if (!Number.isFinite(level) || level < 1 || level > 5) {
    whisperToCaller(c.io, c.ctx, '!smite: level must be 1-5 (Divine Smite caps at 5d8).');
    return true;
  }
  const undeadOrFiend = parts.some(p => /^(undead|fiend)$/i.test(p));
  const isCrit = parts.some(p => /^crit$/i.test(p));

  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!smite: no owned token on this map.');
    return true;
  }
  if (!caller.characterId) {
    whisperToCaller(c.io, c.ctx, `!smite: ${caller.name} has no character sheet.`);
    return true;
  }

  // Load character, check Paladin class + slot availability.
  const { rows } = await pool.query(
    'SELECT class, features, spell_slots, name FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!smite: character not found.');
    return true;
  }

  const classLower = String(row.class || '').toLowerCase();
  let hasSmite = classLower.includes('paladin');
  if (!hasSmite) {
    // Multiclass or homebrew — check for the feature by name.
    try {
      const rawFeats = row.features;
      const feats = typeof rawFeats === 'string' ? JSON.parse(rawFeats) : (rawFeats ?? []);
      if (Array.isArray(feats)) {
        hasSmite = feats.some(
          (f: { name?: string }) => typeof f?.name === 'string' && /divine\s+smite/i.test(f.name),
        );
      }
    } catch { /* ignore */ }
  }
  if (!hasSmite) {
    whisperToCaller(c.io, c.ctx, `!smite: ${caller.name} doesn't have Divine Smite.`);
    return true;
  }

  // Slot check + consume.
  let slots: Record<string, { max: number; used: number }> = {};
  try {
    const raw = row.spell_slots;
    slots = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Record<string, { max: number; used: number }>;
  } catch { /* ignore */ }
  const key = String(level);
  const slot = slots[key];
  if (!slot || slot.used >= slot.max) {
    whisperToCaller(c.io, c.ctx, `!smite: no level ${level} slots remaining.`);
    return true;
  }
  slots[key] = { ...slot, used: slot.used + 1 };
  await pool.query(
    'UPDATE characters SET spell_slots = $1 WHERE id = $2',
    [JSON.stringify(slots), caller.characterId],
  ).catch((e) => console.warn('[!smite] slot write failed:', e));
  // Broadcast the slot change so the caller's character sheet re-renders.
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { spellSlots: slots },
  });

  // Damage: base is (level+1)d8, cap at 5d8. Add +1d8 vs undead/fiend.
  // Crit doubles dice per standard 5e critical rules.
  const baseDice = Math.min(5, level + 1);
  const totalDice = baseDice + (undeadOrFiend ? 1 : 0);
  const effectiveDice = isCrit ? totalDice * 2 : totalDice;
  const rolls: number[] = [];
  for (let i = 0; i < effectiveDice; i++) {
    rolls.push(Math.floor(Math.random() * 8) + 1);
  }
  const total = rolls.reduce((s, r) => s + r, 0);
  const callerName = (row.name as string) || caller.name;

  const parts2: string[] = [];
  parts2.push(`✨ ${callerName} invokes Divine Smite (level ${level} slot, ${effectiveDice}d8)`);
  parts2.push(`   Radiant damage: ${effectiveDice}d8 (${rolls.join('+')}) = ${total}${isCrit ? ' [CRIT]' : ''}${undeadOrFiend ? ' [+1d8 vs undead/fiend]' : ''}`);
  parts2.push(`   Slot ${level}: ${slots[key].used}/${slots[key].max} used.`);

  // Structured SpellCastBreakdown — Divine Smite is effectively an
  // auto-damage rider on a successful attack. Single target implied
  // by the attack it rides; resolves as "auto-damage" kind since the
  // paladin has already hit.
  const smiteNotes: string[] = [`Level ${level} slot spent`];
  if (undeadOrFiend) smiteNotes.push('+1d8 vs undead/fiend');
  if (isCrit) smiteNotes.push('Crit — dice doubled');
  const smiteBreakdown: SpellCastBreakdown = {
    caster: { name: callerName, tokenId: caller.id },
    spell: {
      name: 'Divine Smite',
      level,
      kind: 'auto-damage',
      damageType: 'radiant',
    },
    notes: smiteNotes,
    targets: [{
      name: 'on hit',
      kind: 'damage-flat',
      damage: {
        dice: `${effectiveDice}d8`,
        diceRolls: rolls,
        mainRoll: total,
        bonuses: [],
        finalDamage: total,
        targetHpBefore: 0,
        targetHpAfter: 0,
      },
    }],
  };
  broadcastSystem(c.io, c.ctx, parts2.join('\n'), { spellResult: smiteBreakdown });

  return true;
}

registerChatCommand('smite', handleSmite);
