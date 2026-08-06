import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token, ActionBreakdown, ActionEconomy, Feature } from '@dnd-vtt/shared';
import {
  isTokenActionable,
  resolveViewingMapId,
  type PlayerContext,
} from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';
import { formatSaveTotal, rollTargetSave } from './saveRoll.js';

/**
 * Monk class features — Ki pool + bonus-action spenders.
 *
 * Ki begins at Monk level 2, maximum = Monk level, and refreshes
 * through the server-owned short/long rest flow. The remaining pool
 * is persisted in characters.features with an optimistic version guard.
 *
 *   !ki              → status
 *   !ki use [n]      → spend n (default 1)
 *   !ki reset        → directs the player to the normal rest flow
 *
 * Bonus-action spenders (each consumes 1 ki + the bonus action):
 *   !flurry               — Flurry of Blows (2 unarmed strikes)
 *   !patient              — Patient Defense (take Dodge)
 *   !stepwind             — Step of the Wind (Dash + Disengage; doubled jump)
 *   !stunstrike <target>  — Stunning Strike on a hit (server-derived CON DC)
 */

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

function resolveTargetByName(ctx: PlayerContext, name: string): Token | null {
  const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
  if (!mapId) return null;
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (token) =>
      token.mapId === mapId &&
      token.name.toLowerCase() === needle &&
      (ctx.player.role === 'dm' || tokenVisibleToPlayer(token, ctx.player.userId))
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

interface KiPoolState {
  features: Feature[];
  maximum: number;
  remaining: number;
}

interface MonkCommandState {
  caller: Token;
  level: number;
  charId: string;
  monkName: string;
  version: number;
  features: Feature[];
  ki: KiPoolState;
  saveDc: number;
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

function monkLevel(className: string, totalLevel: number): number | null {
  const match = className.match(/(?:^|\/)\s*monk(?:\s*\([^)]*\))?\s+(\d+)/i);
  if (match) return Math.max(1, Number(match[1]));
  if (/^\s*monk(?:\s*\([^)]*\))?\s*$/i.test(className)) return Math.max(1, totalLevel);
  return null;
}

function abilityModifier(score: unknown): number {
  const numeric = Number(score);
  return Number.isFinite(numeric) ? Math.floor((numeric - 10) / 2) : 0;
}

function wisdomScore(value: unknown): unknown {
  try {
    const scores = typeof value === 'string' ? JSON.parse(value) : value;
    return scores && typeof scores === 'object'
      ? (scores as Record<string, unknown>).wis
      : undefined;
  } catch {
    return undefined;
  }
}

function kiPool(features: Feature[], level: number): KiPoolState {
  const maximum = level;
  const feature = features.find((candidate) => /^ki(?:\s+points?)?$/i.test(candidate.name.trim()));
  const rawRemaining = Number(feature?.usesRemaining);
  const remaining = Number.isFinite(rawRemaining)
    ? Math.max(0, Math.min(maximum, Math.floor(rawRemaining)))
    : maximum;
  return { features, maximum, remaining };
}

function updateKiFeature(poolState: KiPoolState, remaining: number): Feature[] {
  const index = poolState.features.findIndex((feature) =>
    /^ki(?:\s+points?)?$/i.test(feature.name.trim())
  );
  const normalizedRemaining = Math.max(0, Math.min(poolState.maximum, remaining));
  if (index < 0) {
    return [
      ...poolState.features,
      {
        name: 'Ki Points',
        description: 'Monk resource used for class features.',
        source: 'Monk',
        sourceType: 'class',
        usesTotal: poolState.maximum,
        usesRemaining: normalizedRemaining,
        resetOn: 'short',
      },
    ];
  }
  return poolState.features.map((feature, featureIndex) =>
    featureIndex === index
      ? {
          ...feature,
          usesTotal: poolState.maximum,
          usesRemaining: normalizedRemaining,
          resetOn: 'short',
        }
      : feature
  );
}

async function requireMonk(
  c: ChatCommandContext,
  cmdName: string
): Promise<MonkCommandState | null> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: no owned PC token on this map.`);
    return null;
  }
  const { rows } = await pool.query(
    `SELECT class, level, name, features, version, ability_scores, proficiency_bonus
       FROM characters WHERE id = $1`,
    [caller.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: character not found.`);
    return null;
  }
  const level = monkLevel(String(row.class || ''), Number(row.level) || 1);
  if (level === null) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: ${caller.name} isn't a Monk.`);
    return null;
  }
  if (level < 2) {
    whisperToCaller(c.io, c.ctx, `!${cmdName}: Ki requires Monk level 2 (${caller.name} is level ${level}).`);
    return null;
  }
  const features = parseFeatures(row.features);
  const version = parseCharacterVersion(row.version);
  if (!features || version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${cmdName}: Ki resource data is unavailable. No points were spent; refresh or re-sync the character sheet.`
    );
    return null;
  }
  const proficiencyBonus = Number(row.proficiency_bonus);
  const saveDc =
    8 +
    (Number.isFinite(proficiencyBonus) ? Math.max(0, Math.floor(proficiencyBonus)) : 2) +
    abilityModifier(wisdomScore(row.ability_scores));
  return {
    caller,
    level,
    charId: caller.characterId,
    monkName: (row.name as string) || caller.name,
    version,
    features,
    ki: kiPool(features, level),
    saveDc,
  };
}

async function commitKiSpend(
  c: ChatCommandContext,
  monk: MonkCommandState,
  amount: number,
  command: string
): Promise<boolean> {
  if (monk.ki.remaining < amount) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: not enough Ki (${monk.ki.remaining}/${monk.ki.maximum}).`
    );
    return false;
  }
  const features = updateKiFeature(monk.ki, monk.ki.remaining - amount);
  let rows: unknown[];
  try {
    ({ rows } = await pool.query(
      `UPDATE characters
          SET features = $1
        WHERE id = $2 AND version = $3
        RETURNING version`,
      [JSON.stringify(features), monk.charId, monk.version]
    ));
  } catch (error) {
    console.warn(`[!${command}] Ki write failed:`, error);
    whisperToCaller(c.io, c.ctx, `!${command}: saving the Ki spend failed. No points were spent; try again.`);
    return false;
  }
  if (rows.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: the character sheet changed while processing. No points were spent; refresh and try again.`
    );
    return false;
  }
  const version = parseCharacterVersion((rows[0] as Record<string, unknown>).version);
  if (version === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: the Ki spend was saved, but synchronization failed. Refresh the character sheet before retrying.`
    );
    monk.features = features;
    monk.ki = kiPool(features, monk.level);
    return true;
  }
  monk.features = features;
  monk.version = version;
  monk.ki = kiPool(features, monk.level);
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: monk.charId,
    changes: { features, version },
  });
  return true;
}

function requireCombatTurn(
  c: ChatCommandContext,
  monk: MonkCommandState,
  command: string
): ActionEconomy | null {
  const combat = c.ctx.room.combatState;
  if (!combat?.active) {
    whisperToCaller(c.io, c.ctx, `!${command}: this feature can be used only during combat.`);
    return null;
  }
  const current = combat.combatants[combat.currentTurnIndex];
  if (current?.tokenId !== monk.caller.id) {
    whisperToCaller(c.io, c.ctx, `!${command}: ${monk.monkName} can use this feature only on their turn.`);
    return null;
  }
  if (!isTokenActionable(c.ctx, monk.caller.id)) {
    whisperToCaller(c.io, c.ctx, `!${command}: ${monk.monkName} cannot act right now.`);
    return null;
  }
  const economy = c.ctx.room.actionEconomies.get(monk.caller.id);
  if (!economy) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!${command}: combat action state is unavailable. No Ki was spent; refresh and try again.`
    );
    return null;
  }
  return economy;
}

function requireBonusActionTurn(
  c: ChatCommandContext,
  monk: MonkCommandState,
  command: string
): ActionEconomy | null {
  const economy = requireCombatTurn(c, monk, command);
  if (!economy) return null;
  if (economy.bonusAction) {
    whisperToCaller(c.io, c.ctx, `!${command}: bonus action already spent this turn.`);
    return null;
  }
  return economy;
}

function saveNotesLabel(notes: string[]): string {
  return notes.length > 0 ? ` [${notes.join(', ')}]` : '';
}

// ────── !ki status | use [n] | reset ────────────────────────
async function handleKi(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const monk = await requireMonk(c, 'ki');
  if (!monk) return true;
  const sub = parts[0]?.toLowerCase() || 'status';

  if (sub === 'status' || sub === '') {
    whisperToCaller(
      c.io,
      c.ctx,
      `🧘 ${monk.monkName} Ki: ${monk.ki.remaining}/${monk.ki.maximum}.`
    );
    return true;
  }

  if (sub === 'reset' || sub === 'refresh') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!ki reset: use the Short Rest or Long Rest flow so every eligible resource refreshes together.'
    );
    return true;
  }

  if (sub === 'use' || sub === 'spend') {
    if (parts.length > 2) {
      whisperToCaller(c.io, c.ctx, '!ki use: usage `!ki use <amount>` with an integer from 1-20.');
      return true;
    }
    const amountText = parts[1] ?? '1';
    if (!/^\d+$/.test(amountText)) {
      whisperToCaller(c.io, c.ctx, '!ki use: amount must be an integer from 1-20.');
      return true;
    }
    const amount = Number(amountText);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 20) {
      whisperToCaller(c.io, c.ctx, '!ki use: amount must be an integer from 1-20.');
      return true;
    }
    if (!(await commitKiSpend(c, monk, amount, 'ki'))) return true;
    broadcastSystem(c.io, c.ctx, `🧘 ${monk.monkName} spends ${amount} Ki.`);
    return true;
  }

  whisperToCaller(c.io, c.ctx, `!ki: unknown subcommand "${sub}".`);
  return true;
}

// ────── !flurry ──────────────────────────────────────────────
async function handleFlurry(c: ChatCommandContext): Promise<boolean> {
  const monk = await requireMonk(c, 'flurry');
  if (!monk) return true;
  const economy = requireBonusActionTurn(c, monk, 'flurry');
  if (!economy) return true;
  // 2014 PHB: Flurry is available only immediately after the Attack action.
  // We can prove the normal action was spent, though the current economy does
  // not yet retain its subtype; the public line remains a manual attack helper.
  if (!economy.action) {
    whisperToCaller(c.io, c.ctx, '!flurry: take the Attack action before using Flurry of Blows.');
    return true;
  }
  if (!(await commitKiSpend(c, monk, 1, 'flurry'))) return true;
  economy.bonusAction = true;
  c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
    tokenId: monk.caller.id,
    actionType: 'bonusAction',
    economy,
  });
  broadcastSystem(
    c.io, c.ctx,
    `👊 ${monk.monkName} uses Flurry of Blows — 2 unarmed strikes as a bonus action.`,
  );
  return true;
}

// ────── !patient ─────────────────────────────────────────────
async function handlePatient(c: ChatCommandContext): Promise<boolean> {
  const monk = await requireMonk(c, 'patient');
  if (!monk) return true;
  const economy = requireBonusActionTurn(c, monk, 'patient');
  if (!economy) return true;
  if (!(await commitKiSpend(c, monk, 1, 'patient'))) return true;
  economy.bonusAction = true;
  c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
    tokenId: monk.caller.id,
    actionType: 'bonusAction',
    economy,
  });
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, monk.caller.id, {
    name: 'dodging',
    source: `${monk.monkName} (Patient Defense)`,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: monk.caller.id,
    changes: tokenConditionChanges(c.ctx.room, monk.caller.id),
  });
  broadcastSystem(
    c.io, c.ctx,
    `🧘 ${monk.monkName} takes Patient Defense (Dodge) as a bonus action.`,
  );
  return true;
}

// ────── !stepwind <dash|disengage> ──────────────────────────
async function handleStepWind(c: ChatCommandContext): Promise<boolean> {
  const kind = (c.rest.trim().toLowerCase() || 'dash');
  if (kind !== 'dash' && kind !== 'disengage') {
    whisperToCaller(c.io, c.ctx, '!stepwind: usage `!stepwind <dash|disengage>`');
    return true;
  }
  const monk = await requireMonk(c, 'stepwind');
  if (!monk) return true;
  const economy = requireBonusActionTurn(c, monk, 'stepwind');
  if (!economy) return true;
  if (!(await commitKiSpend(c, monk, 1, 'stepwind'))) return true;
  economy.bonusAction = true;
  if (kind === 'dash') economy.movementRemaining += economy.movementMax;
  c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
    tokenId: monk.caller.id,
    actionType: 'bonusAction',
    economy,
  });
  if (kind === 'disengage') {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, monk.caller.id, {
      name: 'disengaged',
      source: `${monk.monkName} (Step of the Wind)`,
      appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: monk.caller.id,
      changes: tokenConditionChanges(c.ctx.room, monk.caller.id),
    });
  }
  broadcastSystem(
    c.io, c.ctx,
    `🪶 ${monk.monkName} uses Step of the Wind — ${kind === 'dash' ? 'Dash (double movement)' : 'Disengage (no OA)'}, jump distance doubled.`,
  );
  return true;
}

// ────── !stunstrike <target> ────────────────────────────────
async function handleStunStrike(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!stunstrike: usage `!stunstrike <target>` (after landing a melee weapon hit)');
    return true;
  }
  const monk = await requireMonk(c, 'stunstrike');
  if (!monk) return true;
  if (monk.level < 5) {
    whisperToCaller(c.io, c.ctx, `!stunstrike: requires Monk level 5 (${monk.monkName} is ${monk.level}).`);
    return true;
  }
  if (!requireCombatTurn(c, monk, 'stunstrike')) return true;
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!stunstrike: no visible token named "${targetName}" on this map.`);
    return true;
  }
  if (target.id === monk.caller.id) {
    whisperToCaller(c.io, c.ctx, '!stunstrike: choose another creature.');
    return true;
  }
  if (!(await commitKiSpend(c, monk, 1, 'stunstrike'))) return true;

  const dc = monk.saveDc;
  const saveResult = await rollTargetSave(c, target, 'con', dc, 'stunned');
  const tName = saveResult.displayName;
  const saveText = formatSaveTotal(saveResult);
  const notesText = saveNotesLabel(saveResult.notes);

  const lines: string[] = [];
  lines.push(`👊 ${monk.monkName} uses Stunning Strike on ${tName}! (CON DC ${dc})`);
  lines.push(`   CON save: ${saveText} → ${saveResult.saved ? 'SAVED' : 'STUNNED (until end of next turn)'}${notesText}`);
  if (!saveResult.saved) {
    const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'stunned',
      source: `${monk.monkName} (Stunning Strike)`,
      casterTokenId: monk.caller.id,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + 1,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }
  const ssBreakdown: ActionBreakdown = {
    actor: { name: monk.monkName, tokenId: monk.caller.id },
    action: {
      name: `Stunning Strike (CON DC ${dc})`,
      category: 'class-feature',
      icon: '👊',
      cost: '1 ki + rider on melee hit',
    },
    effect: `${tName} CON save ${saveText} vs DC ${dc} → ${saveResult.saved ? 'SAVED' : 'STUNNED until end of next turn'}.${notesText}`,
    targets: [{
      name: tName,
      tokenId: target.id,
      effect: saveResult.saved
        ? `SAVED (${saveResult.total} ≥ ${dc})`
        : `FAILED (${saveResult.total} < ${dc}) — stunned until end of next turn`,
      ...(saveResult.saved ? {} : { conditionsApplied: ['stunned'] }),
    }],
    notes: [
      `Monk L${monk.level}`,
      `Save: CON ${saveText} vs DC ${dc}`,
      ...saveResult.notes,
    ],
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { actionResult: ssBreakdown });
  return true;
}

registerChatCommand('ki', handleKi);
registerChatCommand('flurry', handleFlurry);
registerChatCommand(['patient', 'patientdefense'], handlePatient);
registerChatCommand(['stepwind', 'step'], handleStepWind);
registerChatCommand(['stunstrike', 'stun'], handleStunStrike);
