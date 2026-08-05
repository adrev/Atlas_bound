import type { ActionEconomy, Feature, Token } from '@dnd-vtt/shared';
import pool from '../../db/connection.js';
import {
  isTokenActionable,
  resolveViewingMapId,
  type PlayerContext,
} from '../../utils/roomState.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';
import { whisperToCaller, type ChatCommandContext } from '../ChatCommands.js';

export type ChannelDivinityActionCost = 'none' | 'action' | 'bonusAction' | 'reaction';

export interface ChannelDivinityEntitlement {
  maximum: number;
  clericLevel: number | null;
  paladinLevel: number | null;
}

export interface ChannelDivinitySpend {
  features: Feature[];
  maximum: number;
  remaining: number;
  version: number;
}

interface ChannelDivinityPool {
  features: Feature[];
  maximum: number;
  remaining: number;
}

interface PreparedChannelDivinity extends ChannelDivinityPool {
  expectedVersion: number;
  entitlement: ChannelDivinityEntitlement;
  row: Record<string, unknown>;
}

export type ChannelDivinityValidator = (
  row: Record<string, unknown>,
  entitlement: ChannelDivinityEntitlement
) => string | null;

function classLevel(className: string, classToFind: string, totalLevel: number): number | null {
  const escaped = classToFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = className.match(
    new RegExp(`(?:^|/)\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s+(\\d+)`, 'i')
  );
  if (match) return Math.max(1, Number(match[1]));
  const singleClass = new RegExp(`^\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s*$`, 'i');
  return singleClass.test(className) ? Math.max(1, totalLevel) : null;
}

export function channelDivinityEntitlement(
  className: string,
  totalLevelValue: unknown
): ChannelDivinityEntitlement | null {
  const totalLevel = Number(totalLevelValue);
  if (!Number.isInteger(totalLevel) || totalLevel < 1 || totalLevel > 20) return null;

  const clericLevel = classLevel(className, 'Cleric', totalLevel);
  const paladinLevel = classLevel(className, 'Paladin', totalLevel);
  if (
    (clericLevel !== null && clericLevel > totalLevel) ||
    (paladinLevel !== null && paladinLevel > totalLevel) ||
    (clericLevel !== null && paladinLevel !== null && clericLevel + paladinLevel > totalLevel)
  ) {
    return null;
  }

  const clericMaximum =
    clericLevel !== null && clericLevel >= 18
      ? 3
      : clericLevel !== null && clericLevel >= 6
        ? 2
        : clericLevel !== null && clericLevel >= 2
          ? 1
          : 0;
  const paladinMaximum = paladinLevel !== null && paladinLevel >= 3 ? 1 : 0;
  return {
    maximum: Math.max(clericMaximum, paladinMaximum),
    clericLevel,
    paladinLevel,
  };
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

function parseVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function channelDivinityPool(features: Feature[], maximum: number): ChannelDivinityPool | null {
  const index = features.findIndex((feature) => /^channel\s+divinity$/i.test(feature.name.trim()));
  if (index < 0) return { features, maximum, remaining: maximum };

  const rawRemaining = features[index].usesRemaining;
  if (rawRemaining === undefined || rawRemaining === null) {
    return { features, maximum, remaining: maximum };
  }
  if (typeof rawRemaining !== 'number' || !Number.isInteger(rawRemaining)) return null;
  return {
    features,
    maximum,
    remaining: Math.max(0, Math.min(maximum, rawRemaining)),
  };
}

function spendChannelDivinity(pool: ChannelDivinityPool): Feature[] {
  const index = pool.features.findIndex((feature) =>
    /^channel\s+divinity$/i.test(feature.name.trim())
  );
  const remaining = pool.remaining - 1;
  if (index < 0) {
    return [
      ...pool.features,
      {
        name: 'Channel Divinity',
        description: 'Invoke a Cleric or Paladin Channel Divinity effect.',
        source: 'Cleric / Paladin',
        sourceType: 'class',
        usesTotal: pool.maximum,
        usesRemaining: remaining,
        resetOn: 'short',
      },
    ];
  }
  return pool.features.map((feature, featureIndex) =>
    featureIndex === index
      ? {
          ...feature,
          usesTotal: pool.maximum,
          usesRemaining: remaining,
          resetOn: 'short',
        }
      : feature
  );
}

export function resolveChannelDivinityCaller(ctx: PlayerContext): Token | null {
  const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
  if (!mapId) return null;
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (token) =>
      token.mapId === mapId &&
      token.ownerUserId === ctx.player.userId &&
      (ctx.player.role === 'dm' || tokenVisibleToPlayer(token, ctx.player.userId))
  );
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0] ?? null;
}

export function resolveChannelDivinityTarget(ctx: PlayerContext, name: string): Token | null {
  const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
  if (!mapId) return null;
  const needle = name.trim().toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (token) =>
      token.mapId === mapId &&
      token.name.toLowerCase() === needle &&
      (ctx.player.role === 'dm' || tokenVisibleToPlayer(token, ctx.player.userId))
  );
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0] ?? null;
}

async function prepareChannelDivinity(
  c: ChatCommandContext,
  caller: Token,
  command: string
): Promise<PreparedChannelDivinity | null> {
  if (!caller.characterId) {
    whisperToCaller(c.io, c.ctx, `${command}: no owned PC token on this map.`);
    return null;
  }

  let row: Record<string, unknown> | undefined;
  try {
    const result = await pool.query('SELECT * FROM characters WHERE id = $1', [caller.characterId]);
    row = result.rows[0] as Record<string, unknown> | undefined;
  } catch (error) {
    console.warn(`[${command}] character read failed:`, error);
    whisperToCaller(c.io, c.ctx, `${command}: the character could not be verified. Try again.`);
    return null;
  }
  if (!row) {
    whisperToCaller(c.io, c.ctx, `${command}: character not found.`);
    return null;
  }

  const entitlement = channelDivinityEntitlement(String(row.class || ''), row.level);
  if (!entitlement) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: could not verify the character class levels. No use was spent; refresh or re-sync the character sheet.`
    );
    return null;
  }
  if (entitlement.clericLevel === null && entitlement.paladinLevel === null) {
    whisperToCaller(c.io, c.ctx, `${command}: ${caller.name} isn't a Cleric or Paladin.`);
    return null;
  }
  if (entitlement.maximum === 0) {
    const requirement = entitlement.clericLevel !== null ? 'Cleric level 2' : 'Paladin level 3';
    whisperToCaller(c.io, c.ctx, `${command}: Channel Divinity requires ${requirement}.`);
    return null;
  }

  const features = parseFeatures(row.features);
  const expectedVersion = parseVersion(row.version);
  if (!features || expectedVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: could not verify the character feature state. No use was spent; refresh or re-sync the character sheet.`
    );
    return null;
  }
  const poolState = channelDivinityPool(features, entitlement.maximum);
  if (!poolState) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: Channel Divinity resource data is invalid. No use was spent; refresh or re-sync the character sheet.`
    );
    return null;
  }
  return { ...poolState, expectedVersion, entitlement, row };
}

export async function reportChannelDivinityStatus(
  c: ChatCommandContext,
  caller: Token,
  command: string
): Promise<boolean> {
  const prepared = await prepareChannelDivinity(c, caller, command);
  if (!prepared) return false;
  whisperToCaller(
    c.io,
    c.ctx,
    `${command}: ${caller.name} has ${prepared.remaining}/${prepared.maximum} uses remaining.`
  );
  return true;
}

export async function spendChannelDivinityUse(
  c: ChatCommandContext,
  caller: Token,
  command: string,
  validate?: ChannelDivinityValidator
): Promise<ChannelDivinitySpend | null> {
  const prepared = await prepareChannelDivinity(c, caller, command);
  if (!prepared || !caller.characterId) return null;
  const validationError = validate?.(prepared.row, prepared.entitlement) ?? null;
  if (validationError) {
    whisperToCaller(c.io, c.ctx, `${command}: ${validationError}`);
    return null;
  }
  if (prepared.remaining <= 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: ${caller.name} has no uses remaining. Take a short or long rest to refresh it.`
    );
    return null;
  }

  const features = spendChannelDivinity(prepared);
  let rows: unknown[];
  try {
    ({ rows } = await pool.query(
      `UPDATE characters
          SET features = $1
        WHERE id = $2 AND version = $3
        RETURNING version`,
      [JSON.stringify(features), caller.characterId, prepared.expectedVersion]
    ));
  } catch (error) {
    console.warn(`[${command}] Channel Divinity write failed:`, error);
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: saving the use failed. No effect was invoked; try again.`
    );
    return null;
  }
  if (rows.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: the character sheet changed while processing. No effect was invoked; refresh and try again.`
    );
    return null;
  }
  const version = parseVersion((rows[0] as Record<string, unknown>).version);
  if (version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: the use was saved, but synchronization failed. Refresh the character sheet before retrying.`
    );
    return null;
  }

  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { features, version },
  });
  return {
    features,
    maximum: prepared.maximum,
    remaining: prepared.remaining - 1,
    version,
  };
}

export function checkChannelDivinityAction(
  c: ChatCommandContext,
  caller: Token,
  command: string,
  cost: ChannelDivinityActionCost
): { economy: ActionEconomy | null } | null {
  if (cost === 'none') return { economy: null };
  const combat = c.ctx.room.combatState;
  if (!combat?.active) return { economy: null };
  const combatant = combat.combatants.find((entry) => entry.tokenId === caller.id);
  if (!combatant) return { economy: null };
  if (!isTokenActionable(c.ctx, caller.id)) {
    whisperToCaller(c.io, c.ctx, `${command}: ${caller.name} cannot act in their current state.`);
    return null;
  }
  if (cost !== 'reaction') {
    const current = combat.combatants[combat.currentTurnIndex];
    if (current?.tokenId !== caller.id) {
      whisperToCaller(c.io, c.ctx, `${command}: this can only be used on your turn.`);
      return null;
    }
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (!economy) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: combat action state is unavailable; refresh and retry.`
    );
    return null;
  }
  if (economy[cost]) {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: ${cost === 'bonusAction' ? 'bonus action' : cost} already spent.`
    );
    return null;
  }
  return { economy };
}

export function markChannelDivinityAction(
  c: ChatCommandContext,
  caller: Token,
  cost: ChannelDivinityActionCost,
  economy: ActionEconomy | null
): void {
  if (cost === 'none' || !economy) return;
  economy[cost] = true;
  c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
    tokenId: caller.id,
    actionType: cost,
    economy,
  });
}
