import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token, InnateRacialSpell } from '@dnd-vtt/shared';
import { traitsForRace } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Innate racial spellcasting handler — turns RACE_TRAITS.innateSpells
 * into per-rest castable abilities.
 *
 *   !racial list                — whisper back this character's
 *                                 innate racial spells + remaining
 *                                 uses.
 *   !racial cast <spell-name>   — spend a use (if per-long / per-
 *                                 short) and broadcast the cast.
 *                                 At-will spells never consume.
 *   !racial reset               — DM-only, reset all per-long charges
 *                                 on this character (long rest).
 *   !racial resetshort          — reset per-short charges only.
 *
 * Per-rest charges live in `room.pointPools.get(characterId)` under
 * the key `racial:<lowercased-spell-name>`. The pool holds
 * `{ max: 1, remaining: 0|1 }` for each per-rest spell.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function loadCasterRacialSpells(
  c: ChatCommandContext, cmd: string,
): Promise<{
  caller: Token;
  characterId: string;
  callerName: string;
  level: number;
  race: string;
  spells: InnateRacialSpell[];
} | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: no owned PC token.`);
    return null;
  }
  const { rows } = await pool.query(
    'SELECT name, level, race FROM characters WHERE id = $1',
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const race = String(row?.race || '').trim();
  const level = Number(row?.level) || 1;
  const callerName = (row?.name as string) || caller.name;
  const traits = traitsForRace(race);
  const all = traits?.innateSpells ?? [];
  // Filter to level-available entries.
  const available = all.filter((s) => (s.availableFromCharLevel ?? 1) <= level);
  if (available.length === 0) {
    whisperToCaller(c.io, c.ctx, `!${cmd}: ${callerName} (${race || 'race unknown'}) has no innate racial spells.`);
    return null;
  }
  return {
    caller,
    characterId: caller.characterId,
    callerName,
    level,
    race,
    spells: available,
  };
}

function poolKey(spellName: string): string {
  return `racial:${spellName.toLowerCase()}`;
}

function getOrSeedCharge(
  ctx: PlayerContext,
  characterId: string,
  spell: InnateRacialSpell,
): { max: number; remaining: number } | null {
  if (spell.uses === 'at-will') return null; // no tracking
  let pools = ctx.room.pointPools.get(characterId);
  if (!pools) {
    pools = new Map();
    ctx.room.pointPools.set(characterId, pools);
  }
  let entry = pools.get(poolKey(spell.name));
  if (!entry) {
    entry = { max: 1, remaining: 1 };
    pools.set(poolKey(spell.name), entry);
  }
  return entry;
}

async function handleRacial(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = (parts[0] || 'list').toLowerCase();

  if (sub === 'list' || sub === 'ls') {
    const loaded = await loadCasterRacialSpells(c, 'racial');
    if (!loaded) return true;
    const lines: string[] = [];
    lines.push(`✨ **${loaded.callerName}** (${loaded.race}) innate racial spells:`);
    for (const s of loaded.spells) {
      if (s.uses === 'at-will') {
        lines.push(`  • **${s.name}** — at-will${s.castingAbility ? ` (${s.castingAbility.toUpperCase()})` : ''}`);
      } else {
        const entry = getOrSeedCharge(c.ctx, loaded.characterId, s);
        const left = entry?.remaining ?? 1;
        const max = entry?.max ?? 1;
        lines.push(`  • **${s.name}** — ${s.uses === 'per-short' ? '1/short rest' : '1/long rest'} (${left}/${max})${s.castingAbility ? ` [${s.castingAbility.toUpperCase()}]` : ''}${s.notes ? ` — ${s.notes}` : ''}`);
      }
    }
    whisperToCaller(c.io, c.ctx, lines.join('\n'));
    return true;
  }

  if (sub === 'reset') {
    if (c.ctx.player.role !== 'dm') {
      whisperToCaller(c.io, c.ctx, '!racial reset: DM only.');
      return true;
    }
    const loaded = await loadCasterRacialSpells(c, 'racial');
    if (!loaded) return true;
    const pools = c.ctx.room.pointPools.get(loaded.characterId);
    let reset = 0;
    if (pools) {
      for (const s of loaded.spells) {
        if (s.uses === 'at-will') continue;
        const entry = pools.get(poolKey(s.name));
        if (entry) { entry.remaining = entry.max; reset++; }
      }
    }
    broadcastSystem(c.io, c.ctx, `🌙 ${loaded.callerName} long-rests — ${reset} racial charge${reset === 1 ? '' : 's'} restored.`);
    return true;
  }

  if (sub === 'resetshort') {
    if (c.ctx.player.role !== 'dm') {
      whisperToCaller(c.io, c.ctx, '!racial resetshort: DM only.');
      return true;
    }
    const loaded = await loadCasterRacialSpells(c, 'racial');
    if (!loaded) return true;
    const pools = c.ctx.room.pointPools.get(loaded.characterId);
    let reset = 0;
    if (pools) {
      for (const s of loaded.spells) {
        if (s.uses !== 'per-short') continue;
        const entry = pools.get(poolKey(s.name));
        if (entry) { entry.remaining = entry.max; reset++; }
      }
    }
    broadcastSystem(c.io, c.ctx, `⏳ ${loaded.callerName} short-rests — ${reset} per-short racial charge${reset === 1 ? '' : 's'} restored.`);
    return true;
  }

  // Default / 'cast' path: first arg (or after 'cast') is the spell name.
  const castOffset = sub === 'cast' ? 1 : 0;
  const spellQuery = parts.slice(castOffset).join(' ').toLowerCase();
  if (!spellQuery) {
    whisperToCaller(c.io, c.ctx, '!racial: usage `!racial [cast] <spell-name>` | `!racial list` | `!racial reset` | `!racial resetshort`');
    return true;
  }
  const loaded = await loadCasterRacialSpells(c, 'racial');
  if (!loaded) return true;
  const spell = loaded.spells.find((s) => s.name.toLowerCase() === spellQuery)
    ?? loaded.spells.find((s) => s.name.toLowerCase().startsWith(spellQuery))
    ?? loaded.spells.find((s) => s.name.toLowerCase().includes(spellQuery));
  if (!spell) {
    whisperToCaller(c.io, c.ctx, `!racial: "${parts.slice(castOffset).join(' ')}" isn't a racial spell for ${loaded.race}. Run \`!racial list\`.`);
    return true;
  }
  if (spell.uses === 'at-will') {
    broadcastSystem(
      c.io, c.ctx,
      `✨ **${loaded.callerName}** casts racial **${spell.name}** (at-will, ${spell.castingAbility?.toUpperCase() ?? 'cha'}).${spell.notes ? `\n   ${spell.notes}` : ''}`,
    );
    return true;
  }
  const entry = getOrSeedCharge(c.ctx, loaded.characterId, spell);
  if (!entry || entry.remaining < 1) {
    whisperToCaller(c.io, c.ctx, `!racial: ${spell.name} already used this ${spell.uses === 'per-short' ? 'short' : 'long'} rest. Rest to refresh (DM: \`!racial ${spell.uses === 'per-short' ? 'resetshort' : 'reset'}\`).`);
    return true;
  }
  entry.remaining -= 1;
  broadcastSystem(
    c.io, c.ctx,
    `✨ **${loaded.callerName}** casts racial **${spell.name}** (${spell.uses === 'per-short' ? '1/short' : '1/long'} rest, ${spell.castingAbility?.toUpperCase() ?? 'cha'}). Charges: ${entry.remaining}/${entry.max}.${spell.notes ? `\n   ${spell.notes}` : ''}`,
  );
  return true;
}

registerChatCommand('racial', handleRacial);
