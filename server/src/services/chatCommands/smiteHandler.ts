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
 * !smite <level> [undead|fiend] [crit]
 *   Paladin's Divine Smite. Rolls (level+1)d8 radiant damage —
 *   capped at 5d8 for a 5th-level slot (RAW cap). Optional
 *   `undead` or `fiend` flag adds +1d8 per the enhanced-damage
 *   rider. Consumes a matching spell slot off the caller's
 *   character sheet.
 *
 *   Resolves the caller's token via ownership (first owned PC on
 *   the current map), matching the !rage / !inspire convention.
 *
 * The slot spend is authoritative and fails closed: the level must
 * parse as a strict integer, the selected `characters.version` guards
 * the UPDATE (`WHERE version = <selected> RETURNING version`), and a
 * DB error, zero-row conflict, or unusable version yields only a
 * private whisper — no slot fanout, no damage roll, no success
 * announcement. Pre-write failures whisper a retry; if the write
 * commits but RETURNING gives no usable version, the whisper is
 * truthful (the slot was spent but synchronization failed; refresh
 * before retrying) and the handler stops there. Dice are rolled only
 * after the slot write commits with an authoritative version, and the
 * `character:updated` fanout always carries that post-write version.
 * No-op paths (bad level, missing feature, no slot remaining) never
 * touch the row.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

function asAuthoritativeVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

/** Strict slot-level parse: digits only, so `3abc` does not pass as 3. */
function parseSlotLevel(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const level = Number(raw);
  return level >= 1 && level <= 5 ? level : null;
}

async function handleSmite(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!smite: usage `!smite <level> [undead|fiend] [crit]`');
    return true;
  }
  const level = parseSlotLevel(parts[0]);
  if (level === null) {
    whisperToCaller(c.io, c.ctx, '!smite: level must be 1-5 (Divine Smite caps at 5d8).');
    return true;
  }
  const undeadOrFiend = parts.some((p) => /^(undead|fiend)$/i.test(p));
  const isCrit = parts.some((p) => /^crit$/i.test(p));

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
    'SELECT class, features, spell_slots, name, version FROM characters WHERE id = $1',
    [caller.characterId]
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
          (f: { name?: string }) => typeof f?.name === 'string' && /divine\s+smite/i.test(f.name)
        );
      }
    } catch {
      /* ignore */
    }
  }
  if (!hasSmite) {
    whisperToCaller(c.io, c.ctx, `!smite: ${caller.name} doesn't have Divine Smite.`);
    return true;
  }

  // Slot check.
  let slots: Record<string, { max: number; used: number }> = {};
  try {
    const raw = row.spell_slots;
    slots = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Record<
      string,
      { max: number; used: number }
    >;
  } catch {
    /* ignore */
  }
  const key = String(level);
  const slot = slots[key];
  if (!slot || slot.used >= slot.max) {
    whisperToCaller(c.io, c.ctx, `!smite: no level ${level} slots remaining.`);
    return true;
  }

  // Consume the slot with an optimistic version-guarded write. Nothing
  // is rolled or announced unless this commits.
  const expectedVersion = asAuthoritativeVersion(row.version);
  if (expectedVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!smite: could not verify the character sheet state — no slot was spent. Try again.'
    );
    return true;
  }
  slots[key] = { ...slot, used: slot.used + 1 };
  let updated: unknown[];
  try {
    ({ rows: updated } = await pool.query(
      'UPDATE characters SET spell_slots = $1 WHERE id = $2 AND version = $3 RETURNING version',
      [JSON.stringify(slots), caller.characterId, expectedVersion]
    ));
  } catch (e) {
    console.warn('[!smite] slot write failed:', e);
    whisperToCaller(
      c.io,
      c.ctx,
      '!smite: spending the slot failed — no slot was spent. Try again.'
    );
    return true;
  }
  if (updated.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!smite: the character sheet changed while processing — no slot was spent. Try again.'
    );
    return true;
  }
  const authoritativeVersion = asAuthoritativeVersion(
    (updated[0] as Record<string, unknown>).version
  );
  if (authoritativeVersion === null) {
    // The write committed but RETURNING gave no usable version, so no
    // authoritative payload can be fanned out. Fail closed post-commit:
    // tell the caller the truth and stop — no fanout, roll, or success.
    whisperToCaller(
      c.io,
      c.ctx,
      '!smite: the slot was spent but synchronization failed — refresh your character sheet before retrying.'
    );
    return true;
  }

  // Broadcast the slot change so the caller's character sheet re-renders.
  // The dispatcher's scoped-io wrapper reroutes this through the
  // stat-sharing gate; the payload always carries the authoritative
  // post-write version from RETURNING.
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { spellSlots: slots, version: authoritativeVersion },
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
  parts2.push(
    `   Radiant damage: ${effectiveDice}d8 (${rolls.join('+')}) = ${total}${isCrit ? ' [CRIT]' : ''}${undeadOrFiend ? ' [+1d8 vs undead/fiend]' : ''}`
  );
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
    targets: [
      {
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
      },
    ],
  };
  broadcastSystem(c.io, c.ctx, parts2.join('\n'), { spellResult: smiteBreakdown });

  return true;
}

registerChatCommand('smite', handleSmite);
