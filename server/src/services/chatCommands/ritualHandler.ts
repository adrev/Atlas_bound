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
 * Ritual casting + component-gating checks.
 *
 * RITUAL (`!ritual <spell-name>`):
 *   Some spells have the ritual tag. Those can be cast without
 *   consuming a slot if the caster spends 10 extra minutes and has
 *   the Ritual Casting feature (Cleric / Druid / Wizard / Bard / etc.)
 *   OR has the spell prepared (Cleric, Druid) / in their spellbook
 *   (Wizard).
 *
 *   We broadcast the intent; slot consumption is skipped. Time cost
 *   is narrative — the DM adjudicates whether 10 min is safe.
 *
 * COMPONENTS (`!components <spell-name>`):
 *   Whispers back a concise "what this spell needs":
 *     • Verbal — blocked if you're silenced / gagged
 *     • Somatic — blocked if you have no free hand (check shield + 2H weapon)
 *     • Material — listed in full; consumed flag + GP cost if known
 *   Lets players check BEFORE they try to cast that their hands + voice
 *   are free.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function findSpellOnCaster(
  characterId: string,
  spellName: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    'SELECT spells, extras FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  try {
    const rawSpells = row.spells;
    const spells = typeof rawSpells === 'string' ? JSON.parse(rawSpells) : (rawSpells ?? []);
    if (Array.isArray(spells)) {
      const needle = spellName.trim().toLowerCase();
      for (const s of spells as Array<Record<string, unknown>>) {
        const n = String(s?.name ?? '').toLowerCase();
        if (n === needle) return s;
        if (n.includes(needle) || needle.includes(n)) return s;
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function handleRitual(c: ChatCommandContext): Promise<boolean> {
  const spellName = c.rest.trim();
  if (!spellName) {
    whisperToCaller(c.io, c.ctx, '!ritual: usage `!ritual <spell-name>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!ritual: no owned PC token on this map.');
    return true;
  }
  const spell = await findSpellOnCaster(caller.characterId, spellName);
  if (!spell) {
    whisperToCaller(c.io, c.ctx, `!ritual: ${caller.name} doesn't know "${spellName}".`);
    return true;
  }
  // Ritual detection: look for a boolean `ritual` flag or a `tags` /
  // `components` field that includes "ritual". The Open5e import
  // typically sets spell.ritual = true.
  const isRitual =
    spell?.ritual === true ||
    (Array.isArray(spell?.tags) && (spell.tags as string[]).some((t) => /ritual/i.test(t)));
  if (!isRitual) {
    whisperToCaller(c.io, c.ctx, `!ritual: "${spell.name}" isn't a ritual spell.`);
    return true;
  }

  broadcastSystem(
    c.io, c.ctx,
    `🕰 ${caller.name} casts **${spell.name}** as a ritual (10 extra minutes, no slot spent). DM: adjudicate whether 10 min is safe here.`,
  );
  return true;
}

async function handleComponents(c: ChatCommandContext): Promise<boolean> {
  const spellName = c.rest.trim();
  if (!spellName) {
    whisperToCaller(c.io, c.ctx, '!components: usage `!components <spell-name>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!components: no owned PC token.');
    return true;
  }
  const spell = await findSpellOnCaster(caller.characterId, spellName);
  if (!spell) {
    whisperToCaller(c.io, c.ctx, `!components: ${caller.name} doesn't know "${spellName}".`);
    return true;
  }

  // Inspect the spell's components field. Open5e uses string "V, S, M"
  // plus a separate "material" field listing the component specifics.
  const componentsStr = String(spell?.components ?? '').toUpperCase();
  const material = String(spell?.material ?? '').trim();
  const needsV = /\bV\b/.test(componentsStr);
  const needsS = /\bS\b/.test(componentsStr);
  const needsM = /\bM\b/.test(componentsStr);

  // Caster-side checks:
  //   silenced → V blocked
  //   hands-full check — iterate inventory for equipped shield +
  //     two-handed weapon. A hand is free if either:
  //       • No shield AND no two-handed weapon equipped, OR
  //       • War Caster feat (bypass somatic-with-hands-full rule).
  const callerConds = (caller.conditions as string[]) || [];
  const silenced = callerConds.includes('silenced') || callerConds.includes('gagged');

  let hasShield = false;
  let hasTwoHanded = false;
  let hasWarCaster = false;
  try {
    const { rows } = await pool.query(
      'SELECT inventory, features FROM characters WHERE id = $1',
      [caller.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row) {
      const rawInv = row.inventory;
      const inv = typeof rawInv === 'string' ? JSON.parse(rawInv) : (rawInv ?? []);
      if (Array.isArray(inv)) {
        for (const i of inv as Array<Record<string, unknown>>) {
          if (!i?.equipped) continue;
          const type = String(i?.type || '').toLowerCase();
          const name = String(i?.name || '').toLowerCase();
          if (type === 'shield' || name.includes('shield')) hasShield = true;
          const props = (i?.properties as string[] | undefined) ?? [];
          if (props.some((p) => /two-?handed/i.test(String(p)))) hasTwoHanded = true;
        }
      }
      const rawF = row.features;
      const feats = typeof rawF === 'string' ? JSON.parse(rawF) : (rawF ?? []);
      hasWarCaster = Array.isArray(feats) && feats.some(
        (f: { name?: string }) => typeof f?.name === 'string' && /war\s+caster/i.test(f.name),
      );
    }
  } catch { /* inventory unparseable */ }

  const somaticBlocked = needsS && hasShield && hasTwoHanded && !hasWarCaster;

  const lines: string[] = [];
  lines.push(`🪄 ${spell.name} — components: ${componentsStr || '?'}`);
  if (needsV) {
    lines.push(
      `  V (verbal): ${silenced ? '❌ BLOCKED — you are silenced / gagged' : '✓ ok'}`,
    );
  }
  if (needsS) {
    let sLine = `  S (somatic): `;
    if (somaticBlocked) sLine += '❌ BLOCKED — both hands occupied (shield + two-handed weapon), no War Caster';
    else if (hasShield && hasTwoHanded) sLine += '⚠ both hands occupied but War Caster bypasses ✓';
    else sLine += '✓ ok (free hand available)';
    lines.push(sLine);
  }
  if (needsM) {
    lines.push(`  M (material): ${material || '(check spell description)'}`);
  }
  if (!needsV && !needsS && !needsM) {
    lines.push('  (no components)');
  }
  whisperToCaller(c.io, c.ctx, lines.join('\n'));
  return true;
}

registerChatCommand('ritual', handleRitual);
registerChatCommand(['components', 'comp'], handleComponents);
