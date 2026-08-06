import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Feature, InnateRacialSpell, Token } from '@dnd-vtt/shared';
import { traitsForRace } from '@dnd-vtt/shared';
import { resolveViewingMapId, type PlayerContext } from '../../utils/roomState.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';
import { emitCharacterUpdate } from '../CharacterUpdateService.js';

/**
 * Innate racial spellcasting backed by persisted feature resources.
 * At-will spells need no resource. Per-rest spells store one charge on a
 * `Racial Spell: <name>` feature and refresh through the normal rest flow.
 */

interface LoadedRacialSpells {
  caller: Token;
  characterId: string;
  characterOwnerUserId: string;
  callerName: string;
  race: string;
  spells: InnateRacialSpell[];
  features: Feature[];
  version: number;
}

interface ChargeState {
  featureIndex: number;
  remaining: number;
}

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
  if (!mapId) return null;
  return (
    Array.from(ctx.room.tokens.values())
      .filter(
        (token) =>
          token.mapId === mapId &&
          token.ownerUserId === ctx.player.userId &&
          (ctx.player.role === 'dm' || tokenVisibleToPlayer(token, ctx.player.userId))
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null
  );
}

function parseVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function parseFeatures(value: unknown): Feature[] | null {
  try {
    const parsed = value == null ? [] : typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (feature) =>
          typeof feature !== 'object' ||
          feature === null ||
          typeof (feature as { name?: unknown }).name !== 'string'
      )
    ) {
      return null;
    }
    return parsed as Feature[];
  } catch {
    return null;
  }
}

function resourceFeatureName(spellName: string): string {
  return `Racial Spell: ${spellName}`;
}

function chargeState(features: Feature[], spell: InnateRacialSpell): ChargeState | null {
  const expectedName = resourceFeatureName(spell.name).toLowerCase();
  const featureIndex = features.findIndex(
    (feature) => feature.name.trim().toLowerCase() === expectedName
  );
  if (featureIndex < 0) return { featureIndex, remaining: 1 };
  const remaining = Number(features[featureIndex].usesRemaining);
  const total = Number(features[featureIndex].usesTotal);
  if (
    !Number.isSafeInteger(remaining) ||
    !Number.isSafeInteger(total) ||
    total !== 1 ||
    remaining < 0 ||
    remaining > 1
  ) {
    return null;
  }
  return { featureIndex, remaining };
}

function featuresWithCharge(
  loaded: LoadedRacialSpells,
  spell: InnateRacialSpell,
  state: ChargeState,
  remaining: number
): Feature[] {
  const nextFeature: Feature = {
    ...(state.featureIndex >= 0 ? loaded.features[state.featureIndex] : {}),
    name: resourceFeatureName(spell.name),
    description: spell.notes || `${spell.name} innate racial spell charge.`,
    source: loaded.race,
    sourceType: 'race',
    usesTotal: 1,
    usesRemaining: remaining,
    resetOn: spell.uses === 'per-short' ? 'short' : 'long',
  };
  if (state.featureIndex < 0) return [...loaded.features, nextFeature];
  return loaded.features.map((feature, index) =>
    index === state.featureIndex ? nextFeature : feature
  );
}

async function loadCasterRacialSpells(
  c: ChatCommandContext,
  command: string
): Promise<LoadedRacialSpells | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${command}: no owned PC token on this map.`);
    return null;
  }

  let row: Record<string, unknown> | undefined;
  try {
    const result = await pool.query(
      'SELECT name, level, race, features, version, user_id FROM characters WHERE id = $1',
      [caller.characterId]
    );
    row = result.rows[0] as Record<string, unknown> | undefined;
  } catch (error) {
    console.warn(`[!${command}] racial spell read failed:`, error);
    whisperToCaller(c.io, c.ctx, `!${command}: racial spell resources could not be verified.`);
    return null;
  }
  if (!row) {
    whisperToCaller(c.io, c.ctx, `!${command}: character not found.`);
    return null;
  }

  const race = String(row.race || '').trim();
  const level = Number(row.level) || 1;
  const spells = (traitsForRace(race)?.innateSpells ?? []).filter(
    (spell) => (spell.availableFromCharLevel ?? 1) <= level
  );
  if (spells.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: ${String(row.name || caller.name)} (${race || 'race unknown'}) has no innate racial spells.`
    );
    return null;
  }

  const features = parseFeatures(row.features);
  const version = parseVersion(row.version);
  if (!features || version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: racial spell resource data is unavailable. Nothing was changed; refresh or re-sync the character sheet.`
    );
    return null;
  }
  return {
    caller,
    characterId: caller.characterId,
    characterOwnerUserId: String(row.user_id || caller.ownerUserId),
    callerName: String(row.name || caller.name),
    race,
    spells,
    features,
    version,
  };
}

async function spendCharge(
  c: ChatCommandContext,
  loaded: LoadedRacialSpells,
  spell: InnateRacialSpell,
  state: ChargeState
): Promise<boolean> {
  const features = featuresWithCharge(loaded, spell, state, 0);
  let rows: unknown[];
  try {
    ({ rows } = await pool.query(
      `UPDATE characters
          SET features = $1
        WHERE id = $2 AND version = $3
        RETURNING version`,
      [JSON.stringify(features), loaded.characterId, loaded.version]
    ));
  } catch (error) {
    console.warn('[!racial] racial spell charge write failed:', error);
    whisperToCaller(
      c.io,
      c.ctx,
      `!racial: saving the ${spell.name} charge failed. Nothing was changed; try again.`
    );
    return false;
  }
  if (rows.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!racial: the character sheet changed while casting ${spell.name}. Nothing was changed; refresh and try again.`
    );
    return false;
  }

  const version = parseVersion((rows[0] as Record<string, unknown>).version);
  loaded.features = features;
  if (version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!racial: ${spell.name} was spent, but synchronization failed. Refresh the character sheet before retrying.`
    );
    return true;
  }
  loaded.version = version;
  emitCharacterUpdate(
    c.io,
    c.ctx.room,
    loaded.characterId,
    loaded.characterOwnerUserId,
    { features, version }
  );
  return true;
}

function findSpell(spells: InnateRacialSpell[], query: string): InnateRacialSpell | undefined {
  const normalized = query.toLowerCase();
  return (
    spells.find((spell) => spell.name.toLowerCase() === normalized) ??
    spells.find((spell) => spell.name.toLowerCase().startsWith(normalized)) ??
    spells.find((spell) => spell.name.toLowerCase().includes(normalized))
  );
}

async function handleRacial(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] || 'list').toLowerCase();
  const loaded = await loadCasterRacialSpells(c, 'racial');
  if (!loaded) return true;

  if (subcommand === 'list' || subcommand === 'ls') {
    const lines = [`✨ **${loaded.callerName}** (${loaded.race}) innate racial spells:`];
    for (const spell of loaded.spells) {
      const ability = spell.castingAbility
        ? ` (${spell.castingAbility.toUpperCase()})`
        : '';
      if (spell.uses === 'at-will') {
        lines.push(`  • **${spell.name}** — at-will${ability}`);
        continue;
      }
      const state = chargeState(loaded.features, spell);
      if (!state) {
        whisperToCaller(
          c.io,
          c.ctx,
          `!racial: ${spell.name} charge data is malformed. Refresh or re-sync the character sheet.`
        );
        return true;
      }
      lines.push(
        `  • **${spell.name}** — ${spell.uses === 'per-short' ? '1/short rest' : '1/long rest'} (${state.remaining}/1)${ability}${spell.notes ? ` — ${spell.notes}` : ''}`
      );
    }
    whisperToCaller(c.io, c.ctx, lines.join('\n'));
    return true;
  }

  if (subcommand === 'reset' || subcommand === 'refresh') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!racial reset: use the Long Rest flow so all eligible resources refresh together.'
    );
    return true;
  }
  if (subcommand === 'resetshort') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!racial resetshort: use the Short Rest flow so all eligible resources refresh together.'
    );
    return true;
  }

  const castOffset = subcommand === 'cast' ? 1 : 0;
  const spellQuery = parts.slice(castOffset).join(' ');
  if (!spellQuery) {
    whisperToCaller(c.io, c.ctx, '!racial: usage `!racial [cast] <spell-name>` | `!racial list`');
    return true;
  }
  const spell = findSpell(loaded.spells, spellQuery);
  if (!spell) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!racial: "${spellQuery}" isn't a racial spell for ${loaded.race}. Run \`!racial list\`.`
    );
    return true;
  }

  if (spell.uses === 'at-will') {
    broadcastSystem(
      c.io,
      c.ctx,
      `✨ **${loaded.callerName}** casts racial **${spell.name}** (at-will, ${spell.castingAbility?.toUpperCase() ?? 'CHA'}).${spell.notes ? `\n   ${spell.notes}` : ''}`
    );
    return true;
  }

  const state = chargeState(loaded.features, spell);
  if (!state) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!racial: ${spell.name} charge data is malformed. Nothing was changed; refresh or re-sync the character sheet.`
    );
    return true;
  }
  if (state.remaining < 1) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!racial: ${spell.name} already used this ${spell.uses === 'per-short' ? 'short' : 'long'} rest.`
    );
    return true;
  }
  if (!(await spendCharge(c, loaded, spell, state))) return true;

  whisperToCaller(
    c.io,
    c.ctx,
    `${spell.name}: 0/1 charge remaining until your next ${spell.uses === 'per-short' ? 'short' : 'long'} rest.`
  );
  broadcastSystem(
    c.io,
    c.ctx,
    `✨ **${loaded.callerName}** casts racial **${spell.name}** (${spell.uses === 'per-short' ? 'short-rest' : 'long-rest'} feature, ${spell.castingAbility?.toUpperCase() ?? 'CHA'}).${spell.notes ? `\n   ${spell.notes}` : ''}`
  );
  return true;
}

registerChatCommand('racial', handleRacial);
