import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token, ActionBreakdown, Feature } from '@dnd-vtt/shared';
import type { PoolClient } from 'pg';
import { resolveViewingMapId, type PlayerContext } from '../../utils/roomState.js';
import * as CombatService from '../CombatService.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';

/**
 * Per-class bonus-action and feature commands that are common enough
 * to deserve a shortcut rather than forcing the player to track
 * everything by hand. Each command:
 *   • Resolves the caller's own token (first owned PC on this map).
 *   • Checks the relevant class / feature marker.
 *   • Rolls / applies / decrements as needed and broadcasts.
 *
 *   !secondwind          Fighter: heal 1d10 + fighter level, 1/short rest.
 *   !actionsurge         Fighter: mark action surge used (2nd action granted).
 *   !cunning <dash|disengage|hide>    Rogue Cunning Action bonus action.
 *   !lay <target> <amt>  Paladin Lay on Hands — spend from the class HP pool.
 *   !channel <name>      Cleric / Paladin Channel Divinity — DM-narrated effect.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function loadCharacter(characterId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
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

function fighterLevel(className: string, totalLevel: number): number {
  const match = className.match(/(?:^|\/)\s*fighter(?:\s*\([^)]*\))?\s+(\d+)/i);
  if (match) return Math.max(1, Number(match[1]));
  return Math.max(1, totalLevel);
}

function classLevel(className: string, classToFind: string, totalLevel: number): number | null {
  const escaped = classToFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = className.match(
    new RegExp(`(?:^|/)\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s+(\\d+)`, 'i')
  );
  if (match) return Math.max(1, Number(match[1]));
  const singleClass = new RegExp(`^\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s*$`, 'i');
  if (singleClass.test(className)) return Math.max(1, totalLevel);
  return null;
}

function resolveCurrentMapToken(
  ctx: PlayerContext,
  predicate: (token: Token) => boolean
): Token | null {
  const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
  if (!mapId) return null;
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (token) =>
      token.mapId === mapId &&
      predicate(token) &&
      (ctx.player.role === 'dm' || tokenVisibleToPlayer(token, ctx.player.userId))
  );
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0] ?? null;
}

interface LayOnHandsPool {
  features: Feature[];
  maximum: number;
  remaining: number;
}

function layOnHandsPool(features: Feature[], maximum: number): LayOnHandsPool {
  const index = features.findIndex((feature) => /^lay\s+on\s+hands$/i.test(feature.name.trim()));
  if (index < 0) return { features, maximum, remaining: maximum };
  const rawRemaining = Number(features[index].usesRemaining);
  const remaining = Number.isFinite(rawRemaining)
    ? Math.max(0, Math.min(maximum, Math.floor(rawRemaining)))
    : maximum;
  return { features, maximum, remaining };
}

function spendLayOnHandsPool(poolState: LayOnHandsPool, amount: number): Feature[] {
  const index = poolState.features.findIndex((feature) =>
    /^lay\s+on\s+hands$/i.test(feature.name.trim())
  );
  const nextRemaining = poolState.remaining - amount;
  if (index < 0) {
    return [
      ...poolState.features,
      {
        name: 'Lay on Hands',
        description: 'Restore hit points from a pool equal to five times Paladin level.',
        source: 'Paladin',
        sourceType: 'class',
        usesTotal: poolState.maximum,
        usesRemaining: nextRemaining,
        resetOn: 'long',
      },
    ];
  }
  return poolState.features.map((feature, featureIndex) =>
    featureIndex === index
      ? {
          ...feature,
          usesTotal: poolState.maximum,
          usesRemaining: nextRemaining,
          resetOn: 'long',
        }
      : feature
  );
}

interface ActionSurgePool {
  maximum: number;
  remaining: number;
  features: Feature[];
}

function actionSurgePool(features: Feature[], maximum: number): ActionSurgePool {
  const index = features.findIndex((feature) => /^action\s+surge$/i.test(feature.name.trim()));
  if (index < 0) return { features, maximum, remaining: maximum };
  const rawRemaining = Number(features[index].usesRemaining);
  const remaining = Number.isFinite(rawRemaining)
    ? Math.max(0, Math.min(maximum, Math.floor(rawRemaining)))
    : maximum;
  return { features, maximum, remaining };
}

function spendActionSurge(poolState: ActionSurgePool): Feature[] {
  const index = poolState.features.findIndex((feature) =>
    /^action\s+surge$/i.test(feature.name.trim())
  );
  const nextRemaining = poolState.remaining - 1;
  if (index < 0) {
    return [
      ...poolState.features,
      {
        name: 'Action Surge',
        description: 'Take one additional action on your turn.',
        source: 'Fighter',
        sourceType: 'class',
        usesTotal: poolState.maximum,
        usesRemaining: nextRemaining,
        resetOn: 'short',
      },
    ];
  }
  return poolState.features.map((feature, featureIndex) =>
    featureIndex === index
      ? {
          ...feature,
          usesTotal: poolState.maximum,
          usesRemaining: nextRemaining,
          resetOn: 'short',
        }
      : feature
  );
}

function spendSecondWind(features: Feature[]): Feature[] | null {
  const index = features.findIndex((feature) => /^second\s+wind$/i.test(feature.name.trim()));
  if (index < 0) {
    return [
      ...features,
      {
        name: 'Second Wind',
        description: 'Bonus action: regain 1d10 + Fighter level hit points.',
        source: 'Fighter',
        sourceType: 'class',
        usesTotal: 1,
        usesRemaining: 0,
        resetOn: 'short',
      },
    ];
  }

  const feature = features[index];
  const total = Number.isFinite(Number(feature.usesTotal))
    ? Math.max(1, Math.floor(Number(feature.usesTotal)))
    : 1;
  const remaining = Number.isFinite(Number(feature.usesRemaining))
    ? Math.max(0, Math.floor(Number(feature.usesRemaining)))
    : total;
  if (remaining <= 0) return null;

  return features.map((item, itemIndex) =>
    itemIndex === index
      ? {
          ...item,
          usesTotal: total,
          usesRemaining: remaining - 1,
          resetOn: item.resetOn ?? 'short',
        }
      : item
  );
}

// ───── !secondwind ─────────────────────────────────────────────
async function handleSecondWind(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!secondwind: no owned PC token on this map.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!secondwind: character not found.');
    return true;
  }
  const classLower = String(row.class || '').toLowerCase();
  if (!classLower.includes('fighter')) {
    whisperToCaller(c.io, c.ctx, `!secondwind: ${caller.name} isn't a Fighter.`);
    return true;
  }
  const level = fighterLevel(String(row.class || ''), Number(row.level) || 1);
  const hp = Number(row.hit_points);
  const maxHp = Number(row.max_hit_points);
  const expectedVersion = parseCharacterVersion(row.version);
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0 || expectedVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!secondwind: could not verify the character sheet state. No use was spent; refresh and try again.'
    );
    return true;
  }
  if (hp >= maxHp) {
    whisperToCaller(c.io, c.ctx, `!secondwind: ${caller.name} is already at maximum HP.`);
    return true;
  }

  const combatState = c.ctx.room.combatState;
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (combatState?.active) {
    const currentCombatant = combatState.combatants[combatState.currentTurnIndex];
    if (currentCombatant?.tokenId !== caller.id) {
      whisperToCaller(
        c.io,
        c.ctx,
        `!secondwind: ${caller.name} can use this bonus action only on their turn.`
      );
      return true;
    }
    if (!economy) {
      whisperToCaller(
        c.io,
        c.ctx,
        '!secondwind: combat action state is unavailable. No use was spent; refresh and try again.'
      );
      return true;
    }
    if (economy.bonusAction) {
      whisperToCaller(
        c.io,
        c.ctx,
        `!secondwind: ${caller.name} has already spent their bonus action this turn.`
      );
      return true;
    }
  }

  const currentFeatures = parseFeatures(row.features);
  if (!currentFeatures) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!secondwind: the character feature data is invalid. No use was spent; refresh or re-sync the character sheet.'
    );
    return true;
  }
  const features = spendSecondWind(currentFeatures);
  if (!features) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!secondwind: ${caller.name} has no Second Wind uses remaining. Take a short rest to refresh it.`
    );
    return true;
  }

  const roll = Math.floor(Math.random() * 10) + 1;
  const heal = roll + level;
  const newHp = Math.min(maxHp, hp + heal);
  let updatedRows: unknown[];
  try {
    ({ rows: updatedRows } = await pool.query(
      `UPDATE characters
          SET hit_points = $1, features = $2
        WHERE id = $3 AND version = $4
        RETURNING version`,
      [newHp, JSON.stringify(features), caller.characterId, expectedVersion]
    ));
  } catch (error) {
    console.warn('[!secondwind] character write failed:', error);
    whisperToCaller(
      c.io,
      c.ctx,
      '!secondwind: saving the heal failed. No use was spent; try again.'
    );
    return true;
  }
  if (updatedRows.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!secondwind: the character sheet changed while processing. No use was spent; refresh and try again.'
    );
    return true;
  }
  const authoritativeVersion = parseCharacterVersion(
    (updatedRows[0] as Record<string, unknown>).version
  );
  if (authoritativeVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!secondwind: the heal and use were saved, but synchronization failed. Refresh the character sheet before retrying.'
    );
    return true;
  }

  if (economy && combatState?.active) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }
  const combatant = combatState?.combatants.find((candidate) => candidate.tokenId === caller.id);
  if (combatant) {
    combatant.hp = newHp;
    CombatService.persistSessionCombatState(c.ctx.room.sessionId);
  }
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { hitPoints: newHp, features, version: authoritativeVersion },
  });
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: caller.id,
    hp: newHp,
    tempHp: Number(row.temp_hit_points) || 0,
    change: newHp - hp,
    type: 'heal',
  });
  const swBreakdown: ActionBreakdown = {
    actor: { name: caller.name, tokenId: caller.id },
    action: {
      name: 'Second Wind',
      category: 'class-feature',
      icon: '💨',
      cost: 'Bonus action',
    },
    effect: `${caller.name} regains ${newHp - hp} HP (rolled ${roll} + Fighter level ${level}).`,
    notes: [
      `Fighter class feature L${level}`,
      `Bonus action, 1/short rest`,
      `Heal formula: 1d10 (${roll}) + fighter level (${level}) = ${heal}`,
    ],
    targets: [
      {
        name: caller.name,
        tokenId: caller.id,
        effect: `Regains ${newHp - hp} HP`,
      },
    ],
  };
  broadcastSystem(
    c.io,
    c.ctx,
    `💨 ${caller.name} uses Second Wind — d10(${roll}) + Fighter level ${level} restores **${newHp - hp} HP**. Bonus action; recharges on a short rest.`,
    { actionResult: swBreakdown }
  );
  return true;
}

// ───── !actionsurge ────────────────────────────────────────────
async function handleActionSurge(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim().toLowerCase();
  if (arg && arg !== 'status') {
    whisperToCaller(c.io, c.ctx, '!actionsurge: usage `!actionsurge` or `!actionsurge status`');
    return true;
  }
  const caller = resolveCurrentMapToken(
    c.ctx,
    (token) => token.ownerUserId === c.ctx.player.userId
  );
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!actionsurge: no owned PC token on this map.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!actionsurge: character not found.');
    return true;
  }
  const level = classLevel(String(row.class || ''), 'Fighter', Number(row.level) || 1);
  if (level === null) {
    whisperToCaller(c.io, c.ctx, `!actionsurge: ${caller.name} isn't a Fighter.`);
    return true;
  }
  if (level < 2) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!actionsurge: Action Surge requires Fighter level 2 (${caller.name} is Fighter level ${level}).`
    );
    return true;
  }
  const features = parseFeatures(row.features);
  const expectedVersion = parseCharacterVersion(row.version);
  if (!features || expectedVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!actionsurge: could not verify the character feature state. No use was spent; refresh or re-sync the character sheet.'
    );
    return true;
  }
  const poolState = actionSurgePool(features, level >= 17 ? 2 : 1);
  if (arg === 'status') {
    whisperToCaller(
      c.io,
      c.ctx,
      `!actionsurge: ${caller.name} has ${poolState.remaining}/${poolState.maximum} uses remaining.`
    );
    return true;
  }
  if (poolState.remaining <= 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!actionsurge: ${caller.name} has no uses remaining. Take a short or long rest to refresh it.`
    );
    return true;
  }

  const combatState = c.ctx.room.combatState;
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (!combatState?.active) {
    whisperToCaller(c.io, c.ctx, '!actionsurge: this command can be used only during combat.');
    return true;
  }
  const currentCombatant = combatState.combatants[combatState.currentTurnIndex];
  if (currentCombatant?.tokenId !== caller.id) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!actionsurge: ${caller.name} can use Action Surge only on their turn.`
    );
    return true;
  }
  if (!economy) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!actionsurge: combat action state is unavailable. No use was spent; refresh and try again.'
    );
    return true;
  }
  if (economy.actionSurgeUsed) {
    whisperToCaller(c.io, c.ctx, '!actionsurge: Action Surge can be used only once on a turn.');
    return true;
  }
  if (!economy.action) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!actionsurge: take your normal action first so the additional action is not wasted.'
    );
    return true;
  }

  const updatedFeatures = spendActionSurge(poolState);
  let updatedRows: unknown[];
  try {
    ({ rows: updatedRows } = await pool.query(
      `UPDATE characters
          SET features = $1
        WHERE id = $2 AND version = $3
        RETURNING version`,
      [JSON.stringify(updatedFeatures), caller.characterId, expectedVersion]
    ));
  } catch (error) {
    console.warn('[!actionsurge] feature write failed:', error);
    whisperToCaller(
      c.io,
      c.ctx,
      '!actionsurge: saving the use failed. No use was spent; try again.'
    );
    return true;
  }
  if (updatedRows.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!actionsurge: the character sheet changed while processing. No use was spent; refresh and try again.'
    );
    return true;
  }
  const authoritativeVersion = parseCharacterVersion(
    (updatedRows[0] as Record<string, unknown>).version
  );
  if (authoritativeVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!actionsurge: the use was saved, but synchronization failed. Refresh the character sheet before retrying.'
    );
    return true;
  }

  economy.action = false;
  economy.actionSurgeUsed = true;
  c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
    tokenId: caller.id,
    actionType: 'action',
    economy,
  });
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { features: updatedFeatures, version: authoritativeVersion },
  });
  broadcastSystem(
    c.io,
    c.ctx,
    `⚡ ${caller.name} uses Action Surge and gains one additional action this turn.`
  );
  return true;
}

// ───── !cunning <kind> ────────────────────────────────────────
async function handleCunning(c: ChatCommandContext): Promise<boolean> {
  const kind = c.rest.trim().toLowerCase();
  const valid = ['dash', 'disengage', 'hide'];
  if (!valid.includes(kind)) {
    whisperToCaller(c.io, c.ctx, `!cunning: usage \`!cunning <dash|disengage|hide>\``);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!cunning: no owned PC token on this map.');
    return true;
  }
  const row = caller.characterId ? await loadCharacter(caller.characterId) : null;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!cunning: ${caller.name} isn't a Rogue.`);
    return true;
  }

  // Spend the bonus action slot + apply the matching condition badge.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy) {
    if (economy.bonusAction) {
      whisperToCaller(
        c.io,
        c.ctx,
        `!cunning: ${caller.name} has already spent their bonus action this turn.`
      );
      return true;
    }
    economy.bonusAction = true;
    // Dash: Cunning Action doubles movement for this turn. Apply the
    // bump here so the single emit below carries both updates.
    if (kind === 'dash') {
      economy.movementRemaining += economy.movementMax;
    }
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }

  // Map kind → existing pseudo-condition badge. Dash has no badge
  // (we just double movement via speed recalc above); Disengage +
  // Hide reuse the existing `disengaged` / `hidden` badges.
  if (kind === 'disengage' || kind === 'hide') {
    const condName = kind === 'disengage' ? 'disengaged' : 'hidden';
    const { applyConditionWithMeta } = await import('../ConditionService.js');
    applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
      name: condName,
      source: `${caller.name} (!cunning ${kind})`,
      appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: caller.id,
      changes: tokenConditionChanges(c.ctx.room, caller.id),
    });
  }

  broadcastSystem(
    c.io,
    c.ctx,
    `🗡 ${caller.name} uses Cunning Action — ${kind.charAt(0).toUpperCase() + kind.slice(1)} (bonus action).`
  );
  return true;
}

// ───── !lay <target> <amount> ────────────────────────────────
async function handleLayOnHands(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCurrentMapToken(
    c.ctx,
    (token) => token.ownerUserId === c.ctx.player.userId
  );
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!lay: no owned PC token on this map.');
    return true;
  }
  const callerRow = await loadCharacter(caller.characterId);
  if (!callerRow) {
    whisperToCaller(c.io, c.ctx, '!lay: character not found.');
    return true;
  }
  const paladinLevel = classLevel(
    String(callerRow.class || ''),
    'Paladin',
    Number(callerRow.level) || 1
  );
  if (paladinLevel === null) {
    whisperToCaller(c.io, c.ctx, `!lay: ${caller.name} isn't a Paladin.`);
    return true;
  }
  const currentFeatures = parseFeatures(callerRow.features);
  const callerVersion = parseCharacterVersion(callerRow.version);
  if (!currentFeatures || callerVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lay: could not verify the character feature state. No points were spent; refresh or re-sync the character sheet.'
    );
    return true;
  }
  const poolState = layOnHandsPool(currentFeatures, 5 * paladinLevel);

  if (c.rest.trim().toLowerCase() === 'status') {
    whisperToCaller(
      c.io,
      c.ctx,
      `!lay: ${caller.name} has ${poolState.remaining}/${poolState.maximum} Lay on Hands points remaining.`
    );
    return true;
  }

  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!lay: usage `!lay <target> <amount>` or `!lay status`');
    return true;
  }
  const amountText = parts[parts.length - 1];
  if (!/^\d+$/.test(amountText)) {
    whisperToCaller(c.io, c.ctx, '!lay: amount must be a positive integer.');
    return true;
  }
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > poolState.maximum) {
    whisperToCaller(c.io, c.ctx, `!lay: amount must be between 1 and ${poolState.maximum}.`);
    return true;
  }
  const targetName = parts.slice(0, -1).join(' ');
  const target = /^(?:me|self)$/i.test(targetName)
    ? caller
    : resolveCurrentMapToken(
        c.ctx,
        (token) => token.name.toLowerCase() === targetName.toLowerCase()
      );
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!lay: no token named "${targetName}".`);
    return true;
  }
  if (!target.characterId) {
    whisperToCaller(c.io, c.ctx, `!lay: ${target.name} isn't a linked character — cannot heal.`);
    return true;
  }
  const selfTarget = target.characterId === caller.characterId;
  const targetRow = selfTarget ? callerRow : await loadCharacter(target.characterId);
  if (!targetRow) {
    whisperToCaller(c.io, c.ctx, '!lay: target character not found.');
    return true;
  }
  const currentHp = Number(targetRow.hit_points);
  const maxHp = Number(targetRow.max_hit_points);
  const targetVersion = parseCharacterVersion(targetRow.version);
  if (
    !Number.isFinite(currentHp) ||
    !Number.isFinite(maxHp) ||
    maxHp <= 0 ||
    targetVersion === null
  ) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lay: could not verify the target character state. No points were spent; refresh and try again.'
    );
    return true;
  }
  if (currentHp >= maxHp) {
    whisperToCaller(c.io, c.ctx, `!lay: ${target.name} is already at maximum HP.`);
    return true;
  }
  if (amount > poolState.remaining) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!lay: only ${poolState.remaining} Lay on Hands points remain. No points were spent.`
    );
    return true;
  }
  const missingHp = maxHp - currentHp;
  if (amount > missingHp) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!lay: ${target.name} is missing only ${missingHp} HP. Choose a smaller amount; no points were spent.`
    );
    return true;
  }

  const combatState = c.ctx.room.combatState;
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (combatState?.active) {
    const currentCombatant = combatState.combatants[combatState.currentTurnIndex];
    if (currentCombatant?.tokenId !== caller.id) {
      whisperToCaller(c.io, c.ctx, `!lay: ${caller.name} can use this action only on their turn.`);
      return true;
    }
    if (!economy) {
      whisperToCaller(
        c.io,
        c.ctx,
        '!lay: combat action state is unavailable. No points were spent; refresh and try again.'
      );
      return true;
    }
    if (economy.action) {
      whisperToCaller(
        c.io,
        c.ctx,
        `!lay: ${caller.name} has already spent their action this turn.`
      );
      return true;
    }
  }

  const nextFeatures = spendLayOnHandsPool(poolState, amount);
  const newHp = currentHp + amount;
  let authoritativeCallerVersion: number | null = null;
  let authoritativeTargetVersion: number | null = null;
  let client: PoolClient | null = null;
  let commitStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    if (selfTarget) {
      const { rows } = await client.query(
        `UPDATE characters
            SET hit_points = $1, features = $2
          WHERE id = $3 AND version = $4
          RETURNING version`,
        [newHp, JSON.stringify(nextFeatures), caller.characterId, callerVersion]
      );
      authoritativeCallerVersion = parseCharacterVersion(rows[0]?.version);
      authoritativeTargetVersion = authoritativeCallerVersion;
    } else {
      const callerResult = await client.query(
        `UPDATE characters
            SET features = $1
          WHERE id = $2 AND version = $3
          RETURNING version`,
        [JSON.stringify(nextFeatures), caller.characterId, callerVersion]
      );
      authoritativeCallerVersion = parseCharacterVersion(callerResult.rows[0]?.version);
      if (authoritativeCallerVersion === null) throw new Error('caller-version-conflict');
      const targetResult = await client.query(
        `UPDATE characters
            SET hit_points = $1
          WHERE id = $2 AND version = $3
          RETURNING version`,
        [newHp, target.characterId, targetVersion]
      );
      authoritativeTargetVersion = parseCharacterVersion(targetResult.rows[0]?.version);
    }
    if (authoritativeCallerVersion === null || authoritativeTargetVersion === null) {
      throw new Error('character-version-conflict');
    }
    commitStarted = true;
    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.warn('[!lay] rollback failed:', rollbackError);
      }
    }
    console.warn('[!lay] character transaction failed:', error);
    whisperToCaller(
      c.io,
      c.ctx,
      commitStarted
        ? '!lay: saving could not be confirmed. Refresh and verify HP and pool totals before retrying.'
        : '!lay: saving failed or a character sheet changed. No points were spent; refresh and try again.'
    );
    return true;
  } finally {
    client?.release();
  }

  if (economy && combatState?.active) {
    economy.action = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'action',
      economy,
    });
  }
  const targetCombatant = combatState?.combatants.find(
    (candidate) => candidate.tokenId === target.id
  );
  if (targetCombatant) {
    targetCombatant.hp = newHp;
    CombatService.persistSessionCombatState(c.ctx.room.sessionId);
  }
  if (selfTarget) {
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: caller.characterId,
      changes: {
        hitPoints: newHp,
        features: nextFeatures,
        version: authoritativeCallerVersion,
      },
    });
  } else {
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: caller.characterId,
      changes: { features: nextFeatures, version: authoritativeCallerVersion },
    });
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: { hitPoints: newHp, version: authoritativeTargetVersion },
    });
  }
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: target.id,
    hp: newHp,
    tempHp: Number(targetRow.temp_hit_points) || 0,
    change: amount,
    type: 'heal',
  });
  const lohBreakdown: ActionBreakdown = {
    actor: { name: caller.name, tokenId: caller.id },
    action: {
      name: `Lay on Hands (+${amount} HP)`,
      category: 'class-feature',
      icon: '🙌',
      cost: 'Action',
    },
    effect: `${target.name} heals **${amount} HP** from the Lay on Hands pool.`,
    targets: [
      {
        name: target.name,
        tokenId: target.id,
        effect: `Regains ${amount} HP`,
      },
    ],
    notes: [`Paladin class feature`, `Action`, `Pool refreshes on a long rest`],
  };
  broadcastSystem(
    c.io,
    c.ctx,
    `🙌 ${caller.name} uses Lay on Hands — ${target.name} regains **${amount} HP**.`,
    { actionResult: lohBreakdown }
  );
  whisperToCaller(
    c.io,
    c.ctx,
    `!lay: ${poolState.remaining - amount}/${poolState.maximum} points remaining.`
  );
  return true;
}

// ───── !channel <name> ────────────────────────────────────────
async function handleChannelDivinity(c: ChatCommandContext): Promise<boolean> {
  const effectName = c.rest.trim();
  if (!effectName) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!channel: usage `!channel <effect name>` (e.g. "Turn Undead", "Sacred Weapon")'
    );
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!channel: no owned PC token on this map.');
    return true;
  }
  const row = caller.characterId ? await loadCharacter(caller.characterId) : null;
  const classLower = String(row?.class || '').toLowerCase();
  if (!(classLower.includes('cleric') || classLower.includes('paladin'))) {
    whisperToCaller(c.io, c.ctx, `!channel: ${caller.name} isn't a Cleric or Paladin.`);
    return true;
  }
  broadcastSystem(
    c.io,
    c.ctx,
    `✨ ${caller.name} invokes Channel Divinity — **${effectName}**. DM narrates / resolves save DC + effect.`
  );
  return true;
}

// ───── !pam <target> — Polearm Master butt-end bonus attack ──
async function handlePolearmButt(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!pam: usage `!pam <target>` — bonus action butt-end strike with your polearm.'
    );
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!pam: no owned PC token on this map.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!pam: character not found.');
    return true;
  }

  // Feat + weapon check.
  let hasFeat = false;
  try {
    const rawF = row.features;
    const feats = typeof rawF === 'string' ? JSON.parse(rawF) : (rawF ?? []);
    hasFeat =
      Array.isArray(feats) &&
      feats.some(
        (f: { name?: string }) =>
          typeof f?.name === 'string' && /^\s*polearm\s+master\s*$/i.test(f.name)
      );
  } catch {
    /* ignore */
  }
  if (!hasFeat) {
    whisperToCaller(c.io, c.ctx, `!pam: ${caller.name} doesn't have the Polearm Master feat.`);
    return true;
  }

  // Find the equipped polearm and pull its ability mod (same one used
  // for the main attack — typically STR).
  let abilityMod = 0;
  let profBonus = 2;
  let weaponName = 'polearm';
  try {
    const rawI = row.inventory;
    const inv = typeof rawI === 'string' ? JSON.parse(rawI) : (rawI ?? []);
    const scoresRaw = row.ability_scores;
    const scores = typeof scoresRaw === 'string' ? JSON.parse(scoresRaw) : (scoresRaw ?? {});
    const strMod = Math.floor(((scores?.str ?? 10) - 10) / 2);
    const dexMod = Math.floor(((scores?.dex ?? 10) - 10) / 2);
    profBonus = Number(row.proficiency_bonus) || 2;
    if (Array.isArray(inv)) {
      for (const item of inv) {
        const name = String((item as Record<string, unknown>)?.name ?? '').toLowerCase();
        if (
          (item as Record<string, unknown>)?.equipped &&
          /glaive|halberd|pike|quarterstaff|spear/.test(name)
        ) {
          weaponName = (item as Record<string, unknown>).name as string;
          const props =
            ((item as Record<string, unknown>)?.properties as string[] | undefined) ?? [];
          const isFinesse = props.some((p) => /finesse/i.test(String(p)));
          abilityMod = isFinesse ? Math.max(strMod, dexMod) : strMod;
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }

  // Spend the bonus action slot.
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.bonusAction) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!pam: ${caller.name} has already spent their bonus action this turn.`
    );
    return true;
  }
  if (economy) {
    economy.bonusAction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'bonusAction',
      economy,
    });
  }

  // Roll to hit + roll damage. We don't have the target's AC in this
  // path (it's adjudicated client-side normally), so the DM applies
  // the hit outcome manually. Still useful to roll both numbers.
  const atkBonus = abilityMod + profBonus;
  const d20 = Math.floor(Math.random() * 20) + 1;
  const atkTotal = d20 + atkBonus;
  const d4 = Math.floor(Math.random() * 4) + 1;
  const dmg = Math.max(0, d4 + abilityMod);
  const atkSign = atkBonus >= 0 ? '+' : '';
  const dmgSign = abilityMod >= 0 ? '+' : '';
  const pamBreakdown: ActionBreakdown = {
    actor: { name: caller.name, tokenId: caller.id },
    action: {
      name: `Polearm Master — Butt-End (${dmg} bludgeoning)`,
      category: 'class-feature',
      icon: '🪙',
      cost: 'Bonus action',
    },
    effect: `Attack: d20=${d20}${atkSign}${atkBonus}=${atkTotal}${d20 === 20 ? ' 💥 CRIT' : d20 === 1 ? ' 💀 fumble' : ''}. Damage: d4 (${d4})${dmgSign}${abilityMod} = **${dmg} bludgeoning**.`,
    targets: [
      {
        name: targetName,
        effect: `Attack ${atkTotal} / Damage ${dmg} bludgeoning`,
        damage: { amount: dmg, damageType: 'bludgeoning' },
      },
    ],
    notes: [
      `Polearm Master feat`,
      `Weapon: ${weaponName}`,
      `Attack: d20=${d20} + ability mod (${abilityMod}) + prof (${profBonus}) = ${atkTotal}`,
      `Damage: 1d4 (${d4}) + ability mod (${abilityMod}) = ${dmg}`,
      `Type: bludgeoning`,
      ...(d20 === 20 ? ['Natural 20 — crit'] : d20 === 1 ? ['Natural 1 — fumble'] : []),
    ],
  };
  broadcastSystem(
    c.io,
    c.ctx,
    `🪙 ${caller.name} butt-ends with ${weaponName} (PAM bonus):\n` +
      `   to hit: d20=${d20}${atkSign}${atkBonus}=${atkTotal}${d20 === 20 ? ' 💥CRIT' : d20 === 1 ? ' 💀fumble' : ''}\n` +
      `   dmg: d4(${d4})${dmgSign}${abilityMod}=${dmg} bludgeoning`,
    { actionResult: pamBreakdown }
  );
  return true;
}

// ───── !uncanny <damage> — Rogue Uncanny Dodge reaction ─────
/**
 * Rogue's Uncanny Dodge (L5): when an attacker you can see hits you
 * with an attack, you can use your reaction to halve the attack's
 * damage against you. Since damage has already been rolled + applied
 * by the time the player realises they want to use it, the simplest
 * model is a "heal back the half" chat command that also burns the
 * reaction slot.
 *
 *   !uncanny <damage-amount>
 *     Example: took 18 damage → `!uncanny 18` heals 9 back and
 *     marks reaction spent.
 */
async function handleUncanny(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim();
  const dmg = parseInt(arg, 10);
  if (!Number.isFinite(dmg) || dmg < 1) {
    whisperToCaller(c.io, c.ctx, '!uncanny: usage `!uncanny <incoming-damage-amount>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!uncanny: no owned PC token.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue')) {
    whisperToCaller(c.io, c.ctx, `!uncanny: ${caller.name} isn't a Rogue.`);
    return true;
  }
  const level = Number(row?.level) || 1;
  if (level < 5) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!uncanny: Uncanny Dodge requires Rogue level 5 (${caller.name} is ${level}).`
    );
    return true;
  }
  const economy = c.ctx.room.actionEconomies.get(caller.id);
  if (economy?.reaction) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!uncanny: ${caller.name} has already used their reaction this round.`
    );
    return true;
  }
  if (economy) {
    economy.reaction = true;
    c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
      tokenId: caller.id,
      actionType: 'reaction',
      economy,
    });
  }

  // Heal back half the damage. Route through CombatService in combat
  // so the tracker + auto-conditions stay in sync.
  const healback = Math.floor(dmg / 2);
  let hpBefore: number | undefined;
  let hpAfter: number | undefined;
  if (c.ctx.room.combatState?.active) {
    const r = await CombatService.applyHeal(c.ctx.room.sessionId, caller.id, healback);
    hpAfter = r.hp;
    hpBefore = r.hp - healback;
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: caller.id,
      hp: r.hp,
      tempHp: r.tempHp,
      change: healback,
      type: 'heal',
    });
    if (r.characterId) {
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: r.characterId,
        changes: { hitPoints: r.hp, tempHitPoints: r.tempHp },
      });
    }
  }
  const udBreakdown: ActionBreakdown = {
    actor: { name: caller.name, tokenId: caller.id },
    action: {
      name: `Uncanny Dodge (-${healback} damage)`,
      category: 'class-feature',
      icon: '🗡',
      cost: 'Reaction',
    },
    effect: `Halves incoming damage: ${dmg} → ${dmg - healback} (heal back ${healback}).`,
    targets: [
      {
        name: caller.name,
        tokenId: caller.id,
        effect: `Damage ${dmg} → ${dmg - healback} (reduced by ${healback})`,
        ...(hpBefore !== undefined && hpAfter !== undefined
          ? { healing: { amount: healback, hpBefore, hpAfter } }
          : {}),
      },
    ],
    notes: [
      `Rogue L${level}`,
      `Incoming damage: ${dmg}`,
      `Reduction: floor(${dmg} / 2) = ${healback}`,
      `Net damage taken: ${dmg - healback}`,
    ],
  };
  broadcastSystem(
    c.io,
    c.ctx,
    `🗡 ${caller.name} uses Uncanny Dodge (reaction) — halves the incoming damage: ${dmg} → ${dmg - healback} (heal back ${healback}).`,
    { actionResult: udBreakdown }
  );
  return true;
}

// ───── !evasion <damage> — Rogue Evasion (L7) ───────────────
/**
 * Rogue's Evasion (L7): when subjected to an effect that allows a
 * DEX save for half damage, you take no damage on success + half on
 * fail. Because the DM is already routing saves through !save, this
 * helper heals back the full or half depending on what the DM
 * passes — but in practice this is just a "half the damage again"
 * or "take zero" wrapper.
 *
 *   !evasion pass <damage>   — saved; heal back ALL applied damage
 *   !evasion fail <damage>   — failed; heal back HALF applied damage
 */
async function handleEvasion(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!evasion: usage `!evasion <pass|fail> <damage-applied>`');
    return true;
  }
  const outcome = parts[0].toLowerCase();
  const dmg = parseInt(parts[1], 10);
  if ((outcome !== 'pass' && outcome !== 'fail') || !Number.isFinite(dmg) || dmg < 1) {
    whisperToCaller(c.io, c.ctx, '!evasion: usage `!evasion <pass|fail> <damage-applied>`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!evasion: no owned PC token.');
    return true;
  }
  const row = await loadCharacter(caller.characterId);
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('rogue') && !classLower.includes('monk')) {
    whisperToCaller(c.io, c.ctx, `!evasion: ${caller.name} isn't a Rogue or Monk.`);
    return true;
  }
  const level = Number(row?.level) || 1;
  if (level < 7) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!evasion: Evasion requires Rogue/Monk level 7 (${caller.name} is ${level}).`
    );
    return true;
  }
  // pass = full save means ZERO damage, but the DM already applied
  //         full/half. Refund everything.
  // fail = half-damage means take half, but the DM may have applied
  //         full. Refund half.
  const refund = outcome === 'pass' ? dmg : Math.floor(dmg / 2);
  let hpBefore: number | undefined;
  let hpAfter: number | undefined;
  if (c.ctx.room.combatState?.active) {
    const r = await CombatService.applyHeal(c.ctx.room.sessionId, caller.id, refund);
    hpAfter = r.hp;
    hpBefore = r.hp - refund;
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: caller.id,
      hp: r.hp,
      tempHp: r.tempHp,
      change: refund,
      type: 'heal',
    });
    if (r.characterId) {
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: r.characterId,
        changes: { hitPoints: r.hp, tempHitPoints: r.tempHp },
      });
    }
  }
  const evBreakdown: ActionBreakdown = {
    actor: { name: caller.name, tokenId: caller.id },
    action: {
      name: `Evasion (${outcome.toUpperCase()}) — refund ${refund} HP`,
      category: 'class-feature',
      icon: '💨',
      cost: 'Passive (DEX save effect)',
    },
    effect:
      outcome === 'pass'
        ? `Saved: takes 0 damage. Refund full ${refund} HP.`
        : `Failed: takes half. Refund other half (${refund} HP).`,
    targets: [
      {
        name: caller.name,
        tokenId: caller.id,
        effect: `Refund ${refund} HP`,
        ...(hpBefore !== undefined && hpAfter !== undefined
          ? { healing: { amount: refund, hpBefore, hpAfter } }
          : {}),
      },
    ],
    notes: [
      `Rogue/Monk L${level}`,
      `Outcome: ${outcome}`,
      `Damage applied: ${dmg}`,
      `Refund: ${outcome === 'pass' ? 'full' : 'half'} = ${refund}`,
    ],
  };
  broadcastSystem(
    c.io,
    c.ctx,
    `💨 ${caller.name} uses Evasion (${outcome}) — ${outcome === 'pass' ? 'takes 0 damage (refund full)' : 'takes half (refund other half)'}: +${refund} HP.`,
    { actionResult: evBreakdown }
  );
  return true;
}

registerChatCommand(['secondwind', 'sw'], handleSecondWind);
registerChatCommand(['actionsurge', 'surge'], handleActionSurge);
registerChatCommand('cunning', handleCunning);
registerChatCommand(['lay', 'layonhands', 'loh'], handleLayOnHands);
registerChatCommand(['channel', 'cd'], handleChannelDivinity);
registerChatCommand(['pam', 'buttend'], handlePolearmButt);
registerChatCommand(['uncanny', 'uncannydodge'], handleUncanny);
registerChatCommand('evasion', handleEvasion);
