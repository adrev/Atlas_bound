import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { ActionEconomy, Feature, Token } from '@dnd-vtt/shared';
import {
  isTokenActionable,
  resolveViewingMapId,
  type PlayerContext,
} from '../../utils/roomState.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';

/**
 * Sorcerer features -- Sorcery Points, Flexible Casting, and Metamagic.
 *
 * Sorcery Points begin at Sorcerer level 2, maximum = Sorcerer level,
 * and refresh through the server-owned long-rest flow. The remaining
 * pool is persisted on the Font of Magic feature with a version guard.
 *
 *   !sp [status | use <n> | reset]
 *   !flexible slot2sp|sp2slot <level>
 *   !meta <name> [spell-level-for-twinned]
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
};

const METAMAGIC_EFFECTS: Record<string, string> = {
  careful: 'allies auto-succeed saves vs this save-spell',
  distant: 'double range (ranged) or reach (touch -> 30 ft)',
  empowered: 'reroll up to CHA mod damage dice -- keep the new roll',
  extended: 'double duration (max 24 h)',
  heightened: 'one target: disadvantage on first save against the spell',
  quickened: 'cast as a bonus action (1-action spells only)',
  seeking: 'reroll a missed spell attack roll',
  subtle: 'cast without verbal + somatic components',
  twinned: 'target a second creature at the same level (single-target spell)',
};

const SP_TO_SLOT_COST: Record<number, number> = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7 };

interface SpellSlotState {
  max: number;
  used: number;
}

type SpellSlots = Record<string, SpellSlotState>;

interface SorceryPointPool {
  features: Feature[];
  maximum: number;
  remaining: number;
}

interface SorcererState {
  caller: Token;
  level: number;
  charId: string;
  sorcName: string;
  version: number;
  points: SorceryPointPool;
  slots: SpellSlots;
}

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
  if (!mapId) return null;
  const own = Array.from(ctx.room.tokens.values())
    .filter(
      (token) =>
        token.mapId === mapId &&
        token.ownerUserId === ctx.player.userId &&
        (ctx.player.role === 'dm' || tokenVisibleToPlayer(token, ctx.player.userId))
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

function parseCharacterVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function parseFeatures(value: unknown): Feature[] | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
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

function parseSpellSlots(value: unknown): SpellSlots | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const slots: SpellSlots = {};
    for (const [level, rawSlot] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^\d+$/.test(level) || Number(level) < 1 || Number(level) > 9) return null;
      if (typeof rawSlot !== 'object' || rawSlot === null || Array.isArray(rawSlot)) return null;
      const max = Number((rawSlot as Record<string, unknown>).max);
      const used = Number((rawSlot as Record<string, unknown>).used);
      if (
        !Number.isSafeInteger(max) ||
        !Number.isSafeInteger(used) ||
        max < 0 ||
        used < 0 ||
        used > max
      ) {
        return null;
      }
      slots[level] = { max, used };
    }
    return slots;
  } catch {
    return null;
  }
}

export function sorcererLevel(className: string, totalLevel: number): number | null {
  const match = className.match(/(?:^|\/)\s*sorcerer(?:\s*\([^)]*\))?\s+(\d+)/i);
  if (match) return Math.max(1, Number(match[1]));
  if (/^\s*sorcerer(?:\s*\([^)]*\))?\s*$/i.test(className)) return Math.max(1, totalLevel);
  return null;
}

function pointFeatureIndex(features: Feature[]): number {
  return features.findIndex((feature) =>
    /^(?:font\s+of\s+magic|sorcery\s+points?)$/i.test(feature.name.trim())
  );
}

function sorceryPointPool(features: Feature[], level: number): SorceryPointPool {
  const maximum = level;
  const index = pointFeatureIndex(features);
  const rawRemaining = Number(index >= 0 ? features[index].usesRemaining : undefined);
  const remaining = Number.isFinite(rawRemaining)
    ? Math.max(0, Math.min(maximum, Math.floor(rawRemaining)))
    : maximum;
  return { features, maximum, remaining };
}

function updatePointFeature(poolState: SorceryPointPool, remaining: number): Feature[] {
  const index = pointFeatureIndex(poolState.features);
  const normalizedRemaining = Math.max(0, Math.min(poolState.maximum, remaining));
  if (index < 0) {
    return [
      ...poolState.features,
      {
        name: 'Font of Magic',
        description: 'Sorcery Points used for Flexible Casting and Metamagic.',
        source: 'Sorcerer',
        sourceType: 'class',
        usesTotal: poolState.maximum,
        usesRemaining: normalizedRemaining,
        resetOn: 'long',
      },
    ];
  }
  return poolState.features.map((feature, featureIndex) =>
    featureIndex === index
      ? {
          ...feature,
          usesTotal: poolState.maximum,
          usesRemaining: normalizedRemaining,
          resetOn: 'long',
        }
      : feature
  );
}

async function requireSorcerer(
  c: ChatCommandContext,
  command: string,
  minimumLevel: number
): Promise<SorcererState | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${command}: no owned PC token on this map.`);
    return null;
  }

  let row: Record<string, unknown> | undefined;
  try {
    const result = await pool.query(
      `SELECT class, level, name, features, spell_slots, version
         FROM characters WHERE id = $1`,
      [caller.characterId]
    );
    row = result.rows[0] as Record<string, unknown> | undefined;
  } catch (error) {
    console.warn(`[!${command}] Sorcerer read failed:`, error);
    whisperToCaller(c.io, c.ctx, `!${command}: the character could not be verified. Try again.`);
    return null;
  }
  if (!row) {
    whisperToCaller(c.io, c.ctx, `!${command}: character not found.`);
    return null;
  }

  const level = sorcererLevel(String(row.class || ''), Number(row.level) || 1);
  if (level === null) {
    whisperToCaller(c.io, c.ctx, `!${command}: ${caller.name} isn't a Sorcerer.`);
    return null;
  }
  if (level < minimumLevel) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: requires Sorcerer level ${minimumLevel} (${caller.name} is level ${level}).`
    );
    return null;
  }

  const features = parseFeatures(row.features);
  const slots = parseSpellSlots(row.spell_slots);
  const version = parseCharacterVersion(row.version);
  if (!features || !slots || version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: Sorcerer resource data is unavailable. No resources were changed; refresh or re-sync the character sheet.`
    );
    return null;
  }
  return {
    caller,
    level,
    charId: caller.characterId,
    sorcName: (row.name as string) || caller.name,
    version,
    points: sorceryPointPool(features, level),
    slots,
  };
}

async function commitSorcererResources(
  c: ChatCommandContext,
  sorcerer: SorcererState,
  command: string,
  remaining: number,
  slots?: SpellSlots
): Promise<boolean> {
  const features = updatePointFeature(sorcerer.points, remaining);
  let rows: unknown[];
  try {
    if (slots) {
      ({ rows } = await pool.query(
        `UPDATE characters
            SET features = $1, spell_slots = $2
          WHERE id = $3 AND version = $4
          RETURNING version`,
        [JSON.stringify(features), JSON.stringify(slots), sorcerer.charId, sorcerer.version]
      ));
    } else {
      ({ rows } = await pool.query(
        `UPDATE characters
            SET features = $1
          WHERE id = $2 AND version = $3
          RETURNING version`,
        [JSON.stringify(features), sorcerer.charId, sorcerer.version]
      ));
    }
  } catch (error) {
    console.warn(`[!${command}] Sorcerer resource write failed:`, error);
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: saving the resource change failed. Nothing was changed; try again.`
    );
    return false;
  }
  if (rows.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: the character sheet changed while processing. Nothing was changed; refresh and try again.`
    );
    return false;
  }

  sorcerer.points = sorceryPointPool(features, sorcerer.level);
  if (slots) sorcerer.slots = slots;
  const version = parseCharacterVersion((rows[0] as Record<string, unknown>).version);
  if (version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: the change was saved, but synchronization failed. Refresh the character sheet before retrying.`
    );
    return true;
  }

  sorcerer.version = version;
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: sorcerer.charId,
    changes: {
      features,
      ...(slots ? { spellSlots: slots } : {}),
      version,
    },
  });
  return true;
}

export async function spendPersistedSorceryPoints(
  c: ChatCommandContext,
  caller: Token,
  command: string,
  amount: number,
  loadedRow?: Record<string, unknown>
): Promise<boolean> {
  if (!caller.characterId || !Number.isSafeInteger(amount) || amount < 1) {
    whisperToCaller(c.io, c.ctx, `!${command}: Sorcery Point spend is invalid.`);
    return false;
  }
  let row = loadedRow;
  if (!row) {
    try {
      const result = await pool.query(
        'SELECT class, level, name, features, version FROM characters WHERE id = $1',
        [caller.characterId]
      );
      row = result.rows[0] as Record<string, unknown> | undefined;
    } catch (error) {
      console.warn(`[!${command}] Sorcery Point read failed:`, error);
      whisperToCaller(c.io, c.ctx, `!${command}: Sorcery Points could not be verified. Try again.`);
      return false;
    }
  }
  if (!row) {
    whisperToCaller(c.io, c.ctx, `!${command}: character not found.`);
    return false;
  }
  const level = sorcererLevel(String(row.class || ''), Number(row.level) || 1);
  const features = parseFeatures(row.features);
  const version = parseCharacterVersion(row.version);
  if (level === null || level < 2 || !features || version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: Sorcery Point state is unavailable. Nothing was changed; refresh or re-sync the character sheet.`
    );
    return false;
  }
  const points = sorceryPointPool(features, level);
  if (points.remaining < amount) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: requires ${amount} Sorcery Points; ${points.remaining} remain.`
    );
    return false;
  }
  return commitSorcererResources(
    c,
    {
      caller,
      level,
      charId: caller.characterId,
      sorcName: (row.name as string) || caller.name,
      version,
      points,
      slots: {},
    },
    command,
    points.remaining - amount
  );
}

function prepareFlexibleAction(
  c: ChatCommandContext,
  sorcerer: SorcererState
): { economy: ActionEconomy | null } | null {
  const combat = c.ctx.room.combatState;
  if (!combat?.active) return { economy: null };
  const current = combat.combatants[combat.currentTurnIndex];
  if (current?.tokenId !== sorcerer.caller.id) {
    whisperToCaller(c.io, c.ctx, `!flexible: ${sorcerer.sorcName} can convert only on their turn.`);
    return null;
  }
  if (!isTokenActionable(c.ctx, sorcerer.caller.id)) {
    whisperToCaller(c.io, c.ctx, `!flexible: ${sorcerer.sorcName} cannot act right now.`);
    return null;
  }
  const economy = c.ctx.room.actionEconomies.get(sorcerer.caller.id);
  if (!economy) {
    whisperToCaller(c.io, c.ctx, '!flexible: combat action state is unavailable. Nothing was changed.');
    return null;
  }
  if (economy.bonusAction) {
    whisperToCaller(c.io, c.ctx, '!flexible: bonus action already spent this turn.');
    return null;
  }
  return { economy };
}

function consumeFlexibleAction(c: ChatCommandContext, sorcerer: SorcererState, economy: ActionEconomy | null): void {
  if (!economy) return;
  economy.bonusAction = true;
  c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
    tokenId: sorcerer.caller.id,
    actionType: 'bonusAction',
    economy,
  });
}

async function handleSorceryPoints(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sorcerer = await requireSorcerer(c, 'sp', 2);
  if (!sorcerer) return true;
  const subcommand = parts[0]?.toLowerCase() || 'status';

  if (subcommand === 'status') {
    whisperToCaller(
      c.io,
      c.ctx,
      `Sorcery Points: ${sorcerer.points.remaining}/${sorcerer.points.maximum}.`
    );
    return true;
  }
  if (subcommand === 'reset' || subcommand === 'refresh') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!sp reset: use the Long Rest flow so every eligible resource refreshes together.'
    );
    return true;
  }
  if (subcommand === 'use' || subcommand === 'spend') {
    if (parts.length > 2 || !/^\d+$/.test(parts[1] ?? '1')) {
      whisperToCaller(c.io, c.ctx, '!sp use: usage `!sp use <amount>` with an integer from 1-20.');
      return true;
    }
    const amount = Number(parts[1] ?? '1');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 20) {
      whisperToCaller(c.io, c.ctx, '!sp use: amount must be an integer from 1-20.');
      return true;
    }
    if (sorcerer.points.remaining < amount) {
      whisperToCaller(
        c.io,
        c.ctx,
        `!sp: not enough Sorcery Points (${sorcerer.points.remaining}/${sorcerer.points.maximum}).`
      );
      return true;
    }
    if (
      !(await commitSorcererResources(
        c,
        sorcerer,
        'sp',
        sorcerer.points.remaining - amount
      ))
    ) {
      return true;
    }
    broadcastSystem(c.io, c.ctx, `${sorcerer.sorcName} spends ${amount} Sorcery Points.`);
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!sp: unknown subcommand "${subcommand}".`);
  return true;
}

async function handleMetamagic(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!meta: usage `!meta <name>` -- careful / distant / empowered / extended / heightened / quickened / seeking / subtle / twinned <level>'
    );
    return true;
  }
  const name = parts[0].toLowerCase();
  let cost: number;
  if (name === 'twinned') {
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) {
      whisperToCaller(c.io, c.ctx, '!meta twinned: second argument is the spell level (0 for cantrip).');
      return true;
    }
    const level = Number(parts[1]);
    if (!Number.isSafeInteger(level) || level < 0 || level > 9) {
      whisperToCaller(c.io, c.ctx, '!meta twinned: spell level must be 0-9.');
      return true;
    }
    cost = Math.max(1, level);
  } else if (name in METAMAGIC_COSTS && parts.length === 1) {
    cost = METAMAGIC_COSTS[name];
  } else if (name in METAMAGIC_COSTS) {
    whisperToCaller(c.io, c.ctx, `!meta ${name}: no additional argument is expected.`);
    return true;
  } else {
    whisperToCaller(c.io, c.ctx, `!meta: unknown metamagic "${name}".`);
    return true;
  }

  const sorcerer = await requireSorcerer(c, 'meta', 3);
  if (!sorcerer) return true;
  if (sorcerer.points.remaining < cost) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!meta ${name}: needs ${cost} Sorcery Points; ${sorcerer.points.remaining} remain.`
    );
    return true;
  }
  if (
    !(await commitSorcererResources(
      c,
      sorcerer,
      'meta',
      sorcerer.points.remaining - cost
    ))
  ) {
    return true;
  }

  const effect = METAMAGIC_EFFECTS[name] ?? 'metamagic applied';
  const label = `${name.charAt(0).toUpperCase()}${name.slice(1)} Spell`;
  broadcastSystem(
    c.io,
    c.ctx,
    `${sorcerer.sorcName} uses ${label} (${cost} SP) -- ${effect}.`
  );
  return true;
}

function slotToPointReturn(level: number): number {
  return Math.max(0, level);
}

async function handleFlexible(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!flexible: usage `!flexible slot2sp <level>` | `!flexible sp2slot <level>`'
    );
    return true;
  }
  const direction = parts[0].toLowerCase();
  if (direction !== 'slot2sp' && direction !== 'sp2slot') {
    whisperToCaller(c.io, c.ctx, `!flexible: unknown direction "${direction}". Use slot2sp or sp2slot.`);
    return true;
  }
  if (!/^\d+$/.test(parts[1])) {
    whisperToCaller(c.io, c.ctx, '!flexible: level must be an integer from 1-9.');
    return true;
  }
  const level = Number(parts[1]);
  if (!Number.isSafeInteger(level) || level < 1 || level > 9) {
    whisperToCaller(c.io, c.ctx, '!flexible: level must be an integer from 1-9.');
    return true;
  }

  const sorcerer = await requireSorcerer(c, 'flexible', 2);
  if (!sorcerer) return true;
  const key = String(level);
  const slot = sorcerer.slots[key];

  if (direction === 'slot2sp') {
    if (!slot || slot.used >= slot.max) {
      whisperToCaller(c.io, c.ctx, `!flexible: no level ${level} slot is available to convert.`);
      return true;
    }
    if (sorcerer.points.remaining >= sorcerer.points.maximum) {
      whisperToCaller(c.io, c.ctx, '!flexible: Sorcery Points are already full.');
      return true;
    }
    const prepared = prepareFlexibleAction(c, sorcerer);
    if (!prepared) return true;
    const nextSlots = { ...sorcerer.slots, [key]: { ...slot, used: slot.used + 1 } };
    const nextPoints = Math.min(
      sorcerer.points.maximum,
      sorcerer.points.remaining + slotToPointReturn(level)
    );
    const gainedPoints = nextPoints - sorcerer.points.remaining;
    if (
      !(await commitSorcererResources(
        c,
        sorcerer,
        'flexible',
        nextPoints,
        nextSlots
      ))
    ) {
      return true;
    }
    consumeFlexibleAction(c, sorcerer, prepared.economy);
    broadcastSystem(
      c.io,
      c.ctx,
      `${sorcerer.sorcName} converts a level ${level} slot into ${gainedPoints} Sorcery Points.`
    );
    return true;
  }

  const cost = SP_TO_SLOT_COST[level];
  if (cost === undefined) {
    whisperToCaller(c.io, c.ctx, '!flexible sp2slot: can restore only 1st-5th level slots.');
    return true;
  }
  if (sorcerer.points.remaining < cost) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!flexible: needs ${cost} Sorcery Points; ${sorcerer.points.remaining} remain.`
    );
    return true;
  }
  if (!slot) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!flexible: no level ${level} slot track exists. Temporary slots above the normal maximum are not automated yet.`
    );
    return true;
  }
  if (slot.used === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!flexible: all normal level ${level} slots are available. Temporary slots above the normal maximum are not automated yet.`
    );
    return true;
  }
  const prepared = prepareFlexibleAction(c, sorcerer);
  if (!prepared) return true;
  const nextSlots = { ...sorcerer.slots, [key]: { ...slot, used: slot.used - 1 } };
  if (
    !(await commitSorcererResources(
      c,
      sorcerer,
      'flexible',
      sorcerer.points.remaining - cost,
      nextSlots
    ))
  ) {
    return true;
  }
  consumeFlexibleAction(c, sorcerer, prepared.economy);
  broadcastSystem(
    c.io,
    c.ctx,
    `${sorcerer.sorcName} converts ${cost} Sorcery Points to restore a level ${level} slot.`
  );
  return true;
}

registerChatCommand(['sp', 'sorcerypoints'], handleSorceryPoints);
registerChatCommand(['meta', 'metamagic'], handleMetamagic);
registerChatCommand(['flexible', 'flex'], handleFlexible);
