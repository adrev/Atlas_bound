import type { Server } from 'socket.io';
import type { Token, ActionBreakdown } from '@dnd-vtt/shared';
import pool from '../../db/connection.js';
import * as CombatService from '../CombatService.js';
import { applyDamageSideEffects } from '../damageEffects.js';
import {
  registerChatCommand,
  whisperToCaller,
  isDM,
  broadcastTokenScopedSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import type { PlayerContext } from '../../utils/roomState.js';
import { emitToTokenStatViewers } from '../../utils/combatBroadcast.js';
import {
  readWildShapeColumn,
  routeWildShapeDamage,
  routeWildShapeHeal,
  serializeWildShapeState,
} from '../../utils/wildShapeState.js';
import { emitWildShapePrivate } from '../../utils/wildShapeSync.js';
import { emitCombatStateSync } from '../../utils/combatStateVisibility.js';

type WildShapeChange = NonNullable<CombatService.HpChangeResult['wildShape']>;

interface DirectHpChange {
  hp: number;
  tempHp: number;
  change: number;
  version?: number;
  wildShape?: WildShapeChange;
}

/**
 * Only a real DB version (integer >= 1) may propagate — the column
 * defaults to 1 and only ever increments. Number(null) is 0, so a
 * null/mocked row would otherwise masquerade as a valid version.
 */
function parseCharacterVersion(row: unknown): number | undefined {
  const version = Number((row as { version?: unknown } | undefined)?.version);
  return Number.isInteger(version) && version >= 1 ? version : undefined;
}

/**
 * Emit a compact ActionResultCard summarising an `!damage` / `!heal`
 * / `!hp` change. Shows actor (DM or whoever ran the command),
 * target name + HP before/after, and a damage/healing block so chat
 * logs a clear record of the manual adjustment.
 */
function emitHpAdjustCard(
  c: ChatCommandContext,
  kind: 'damage' | 'heal' | 'hp-set',
  targetName: string,
  targetTokenId: string,
  hpBefore: number,
  hpAfter: number,
  appliedChange = hpAfter - hpBefore,
  label?: string
): void {
  const delta = appliedChange;
  const verb = kind === 'damage' ? 'takes damage' : kind === 'heal' ? 'is healed' : 'HP set';
  const effect =
    kind === 'damage'
      ? `${targetName} takes ${Math.abs(delta)} damage.`
      : kind === 'heal'
        ? `${targetName} regains ${delta} HP.`
        : `${targetName}'s HP set to ${hpAfter}.`;
  const card: ActionBreakdown = {
    actor: { name: c.ctx.player.displayName },
    action: {
      name: label ?? (kind === 'damage' ? 'Damage' : kind === 'heal' ? 'Healing' : 'HP Set'),
      category: 'other',
      icon: kind === 'damage' ? '\uD83E\uDE78' : kind === 'heal' ? '\uD83D\uDC9A' : '\u2699\uFE0F',
    },
    effect,
    targets: [
      {
        name: targetName,
        tokenId: targetTokenId,
        ...(kind === 'damage' && delta < 0
          ? { damage: { amount: -delta, damageType: 'untyped', hpBefore, hpAfter } }
          : kind === 'heal' && delta > 0
            ? { healing: { amount: delta, hpBefore, hpAfter } }
            : { effect: `${hpBefore} \u2192 ${hpAfter}` }),
      },
    ],
  };
  const text = `${verb === 'HP set' ? '⚙' : kind === 'damage' ? '🩸' : '💚'} ${c.ctx.player.displayName} — ${targetName}: HP ${hpBefore} → ${hpAfter}`;
  broadcastTokenScopedSystem(c.io, c.ctx, targetTokenId, text, { actionResult: card });
}

/**
 * Look up the HP for a character before applying a change so the
 * ActionBreakdown can show before/after. Returns 0 when the row is
 * missing (treated as "just set to the new value").
 */
async function readHpBefore(characterId: string | null | undefined): Promise<number> {
  if (!characterId) return 0;
  try {
    const { rows } = await pool.query('SELECT hit_points FROM characters WHERE id = $1', [
      characterId,
    ]);
    const row = rows[0] as Record<string, unknown> | undefined;
    return Number(row?.hit_points) || 0;
  } catch {
    return 0;
  }
}

/**
 * R1 — HP / attribute chat commands.
 *
 *   !damage <amount> [target]
 *   !heal   <amount> [target]
 *   !hp     <value>  [target]   — absolute ("!hp 25") or relative ("!hp +5" / "!hp -3")
 *   !setattr <target> <attr> <value>   — DM-only, edits the character row
 *
 * Target resolution:
 *   - If `[target]` is supplied, look up a token on the player's current
 *     map by case-insensitive exact name. If multiple match, the newest
 *     wins (R6 auto-numbering already keeps names unique per map).
 *   - If no target, use the caller's own PC token on the current map.
 *   - DMs can target any token; players can only target tokens they own
 *     OR unowned NPC tokens (same rule as combat:damage).
 *
 * In-combat vs out-of-combat:
 *   - During active combat we go through CombatService so the combatant
 *     row, death saves, and turn-state stay consistent.
 *   - Outside combat we write `characters.hit_points` directly and emit
 *     `character:updated`. The token can still be an NPC (no character),
 *     in which case !damage/!heal can only run in combat.
 *
 * `!setattr` is DM-only and writes a whitelisted set of columns:
 *   hp / maxhp / ac / str / dex / con / int / wis / cha.
 */

interface ResolvedTarget {
  token: Token;
  characterId: string | null;
}

function resolveTarget(
  ctx: PlayerContext,
  rest: string
): { target: ResolvedTarget | null; reason?: string } {
  const all = Array.from(ctx.room.tokens.values());
  if (!rest) {
    // Self-target: caller's PC token on the current map.
    const own = all.filter((t) => t.ownerUserId === ctx.player.userId);
    if (own.length === 0) return { target: null, reason: 'no target — specify a token name' };
    // Newest first so the most recently placed PC wins if several exist.
    own.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { target: { token: own[0], characterId: own[0].characterId } };
  }
  const needle = rest.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase() === needle);
  if (matches.length === 0) return { target: null, reason: `no token named “${rest}”` };
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { target: { token: matches[0], characterId: matches[0].characterId } };
}

function canMutateTarget(ctx: PlayerContext, token: Token): boolean {
  if (isDM(ctx)) return true;
  if (!token.ownerUserId) return true;
  return token.ownerUserId === ctx.player.userId;
}

function parseAmount(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
  return n;
}

function requireSelectedVersion(row: Record<string, unknown>): number {
  const version = parseCharacterVersion(row);
  if (version === undefined) {
    throw new Error('could not verify the character state — nothing was changed.');
  }
  return version;
}

function requireCommittedVersion(row: unknown): number {
  const version = parseCharacterVersion(row);
  if (version === undefined) {
    throw new Error('nothing was applied — the character changed mid-action. Retry.');
  }
  return version;
}

function broadcastHpChange(
  io: Server,
  ctx: PlayerContext,
  tokenId: string,
  characterId: string | null,
  hp: number,
  tempHp: number,
  change: number,
  type: 'damage' | 'heal',
  version?: number,
  wildShape?: WildShapeChange
): void {
  // Exact numbers are gated by the room's sharing toggles — DM tabs and
  // the owner's tabs always receive them; other players only when the
  // matching share toggle permits. `emitToTokenViewers` scopes by token
  // visibility alone and would leak precise HP the snapshots redact.
  emitToTokenStatViewers(io, ctx.room, tokenId, 'combat:hp-changed', {
    tokenId,
    hp,
    tempHp,
    change,
    type,
  });
  if (characterId) {
    const changes: Record<string, unknown> = { hitPoints: hp, tempHitPoints: tempHp };
    // Final post-write characters.version (the DB trigger bumps it on
    // every UPDATE). Without it the owner's next sheet edit sends a
    // stale expectedVersion and gets a false character:update-conflict.
    if (version !== undefined) {
      changes.version = version;
    }
    emitToTokenStatViewers(io, ctx.room, tokenId, 'character:updated', {
      characterId,
      changes,
    });
    // Exact form HP is owner/DM material — never the toggle-widened
    // stat channel above, which can include bystanders.
    if (wildShape) {
      emitWildShapePrivate(io, ctx.room, characterId, {
        wildShape: wildShape.state,
        ...(version !== undefined ? { version } : {}),
      });
      // A form dropped by combat-path damage already had its AC/speed
      // restored on the combatant inside CombatService — re-fan the
      // tracker (redacted per viewer) so clients pick that up.
      if (wildShape.ended && ctx.room.combatState?.active) emitCombatStateSync(io, ctx.room);
    }
  }
}

const UNREADABLE_WILD_SHAPE =
  'the stored Wild Shape state is unreadable — run `!revert` to clear it before changing HP.';

/**
 * Out-of-combat direct HP change, Wild Shape aware: while transformed
 * the same authoritative routing as the combat pipeline applies —
 * damage consumes temp HP first, then the form (excess carries into
 * the druid and ends the form), all in one version-guarded UPDATE;
 * healing restores the form and leaves temp HP alone. Unreadable
 * state and version conflicts fail closed by throwing; nothing is
 * written.
 */
async function applyDirectHp(characterId: string, delta: number): Promise<DirectHpChange | null> {
  const { rows } = await pool.query(
    'SELECT hit_points, max_hit_points, temp_hit_points, wild_shape, version FROM characters WHERE id = $1',
    [characterId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const curHp = Number(row.hit_points);
  const maxHp = Number(row.max_hit_points);
  const tempHp = Number(row.temp_hit_points ?? 0);
  const column = readWildShapeColumn(row.wild_shape);
  if (column.status === 'invalid') throw new Error(UNREADABLE_WILD_SHAPE);
  if (column.status === 'active') {
    const expectedVersion = parseCharacterVersion(row);
    if (expectedVersion === undefined) {
      throw new Error('could not verify the character state — nothing was changed.');
    }
    const state = column.state;
    if (delta === 0) {
      return {
        hp: curHp,
        tempHp,
        change: 0,
        version: expectedVersion,
        wildShape: { formName: state.formName, ended: false, state },
      };
    }
    // Same order as the combat pipeline: temp HP soaks before the
    // form does, and only what remains reaches the form/druid.
    const tempAbsorbed = delta < 0 ? Math.min(tempHp, -delta) : 0;
    const nextTempHp = tempHp - tempAbsorbed;
    const route =
      delta < 0
        ? routeWildShapeDamage(state, -delta - tempAbsorbed)
        : { ...routeWildShapeHeal(state, delta), absorbed: undefined, carryover: 0, ended: false };
    const nextHp = Math.max(0, Math.min(maxHp, curHp - route.carryover));
    // One guarded UPDATE: the form write plus the druid's HP / temp HP
    // only when this change actually touches them — a conflict leaves
    // every pool unchanged.
    const clauses = ['wild_shape = $1'];
    const params: unknown[] = [serializeWildShapeState(route.nextState)];
    if (nextHp !== curHp) {
      params.push(nextHp);
      clauses.push(`hit_points = $${params.length}`);
    }
    if (nextTempHp !== tempHp) {
      params.push(nextTempHp);
      clauses.push(`temp_hit_points = $${params.length}`);
    }
    params.push(characterId, expectedVersion);
    const { rows: versionRows } = await pool.query(
      `UPDATE characters SET ${clauses.join(', ')} WHERE id = $${params.length - 1} AND version = $${params.length} RETURNING version`,
      params
    );
    const version = parseCharacterVersion(versionRows[0]);
    if (version === undefined) {
      throw new Error('nothing was applied — the character changed mid-action. Retry.');
    }
    return {
      hp: nextHp,
      tempHp: nextTempHp,
      change: delta < 0 ? delta : (route as { healed: number }).healed,
      version,
      wildShape: {
        formName: state.formName,
        ...(delta < 0
          ? { absorbed: route.absorbed }
          : { healed: (route as { healed: number }).healed }),
        ended: route.ended,
        state: route.nextState,
      },
    };
  }
  // Untransformed: same authority rules as the transformed path —
  // damage consumes temp HP before base HP, healing tops up base HP
  // and leaves temp HP alone, and every changed pool lands in one
  // version-guarded UPDATE. A conflict leaves every pool unchanged.
  const expectedVersion = parseCharacterVersion(row);
  if (
    expectedVersion === undefined ||
    !Number.isInteger(curHp) ||
    curHp < 0 ||
    curHp > 9999 ||
    !Number.isInteger(maxHp) ||
    maxHp < 1 ||
    maxHp > 9999 ||
    curHp > maxHp ||
    !Number.isInteger(tempHp) ||
    tempHp < 0 ||
    tempHp > 9999
  ) {
    throw new Error('could not verify the character state — nothing was changed.');
  }
  const tempAbsorbed = delta < 0 ? Math.min(tempHp, -delta) : 0;
  const nextTempHp = tempHp - tempAbsorbed;
  const nextHp = Math.max(0, Math.min(maxHp, curHp + delta + tempAbsorbed));
  // No-op keeps the row untouched: no UPDATE, no version-trigger bump.
  if (nextHp === curHp && nextTempHp === tempHp) {
    return { hp: curHp, tempHp, change: 0, version: expectedVersion };
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (nextHp !== curHp) {
    params.push(nextHp);
    clauses.push(`hit_points = $${params.length}`);
  }
  if (nextTempHp !== tempHp) {
    params.push(nextTempHp);
    clauses.push(`temp_hit_points = $${params.length}`);
  }
  params.push(characterId, expectedVersion);
  const { rows: versionRows } = await pool.query(
    `UPDATE characters SET ${clauses.join(', ')} WHERE id = $${params.length - 1} AND version = $${params.length} RETURNING version`,
    params
  );
  const version = parseCharacterVersion(versionRows[0]);
  if (version === undefined) {
    throw new Error('nothing was applied — the character changed mid-action. Retry.');
  }
  return {
    hp: nextHp,
    tempHp: nextTempHp,
    change: delta < 0 ? delta : nextHp - curHp,
    version,
  };
}

async function setDirectHp(
  characterId: string,
  value: number
): Promise<{ hp: number; tempHp: number; version?: number } | null> {
  const { rows } = await pool.query(
    'SELECT hit_points, max_hit_points, temp_hit_points, wild_shape, version FROM characters WHERE id = $1',
    [characterId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const expectedVersion = requireSelectedVersion(row);
  const column = readWildShapeColumn(row.wild_shape);
  if (column.status === 'invalid') throw new Error(UNREADABLE_WILD_SHAPE);
  if (column.status === 'active') {
    // Fail closed: an absolute set is ambiguous while transformed
    // (form HP vs druid HP). The relative commands route correctly.
    throw new Error(
      `target is wild-shaped (${column.state.formName}) — use \`!damage\`/\`!heal\` (routed through the form) or \`!revert\` first.`
    );
  }
  const currentHp = Number(row.hit_points);
  const maxHp = Number(row.max_hit_points);
  const tempHp = Number(row.temp_hit_points ?? 0);
  if (
    !Number.isInteger(currentHp) ||
    currentHp < 0 ||
    !Number.isInteger(maxHp) ||
    maxHp < 1 ||
    maxHp > 9999 ||
    currentHp > maxHp ||
    !Number.isInteger(tempHp) ||
    tempHp < 0 ||
    tempHp > 9999
  ) {
    throw new Error('could not verify the character state — nothing was changed.');
  }
  const nextHp = Math.max(0, Math.min(maxHp, value));
  if (nextHp === currentHp) {
    return { hp: currentHp, tempHp, version: expectedVersion };
  }
  const { rows: versionRows } = await pool.query(
    'UPDATE characters SET hit_points = $1 WHERE id = $2 AND version = $3 RETURNING version',
    [nextHp, characterId, expectedVersion]
  );
  return { hp: nextHp, tempHp, version: requireCommittedVersion(versionRows[0]) };
}

/**
 * Set temp HP to `value`, but only if it's greater than the current
 * (RAW: "If you have temporary hit points and receive more of them,
 * you decide whether to keep the ones you have or to gain the new
 * ones"). Passing 0 always clears. Returns the final values and
 * whether the write actually replaced anything.
 */
async function applyDirectTempHp(
  characterId: string,
  value: number
): Promise<{ hp: number; tempHp: number; replaced: boolean; version?: number } | null> {
  const { rows } = await pool.query(
    'SELECT hit_points, temp_hit_points, version FROM characters WHERE id = $1',
    [characterId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const expectedVersion = requireSelectedVersion(row);
  const hp = Number(row.hit_points);
  const current = Number(row.temp_hit_points ?? 0);
  if (
    !Number.isInteger(hp) ||
    hp < 0 ||
    hp > 9999 ||
    !Number.isInteger(current) ||
    current < 0 ||
    current > 9999
  ) {
    throw new Error('could not verify the character state — nothing was changed.');
  }
  // 0 always clears; otherwise keep the better value.
  const next = value === 0 ? 0 : Math.max(current, value);
  const replaced = next !== current;
  // No-op keeps the row untouched: no UPDATE, no version-trigger bump,
  // and no version in the result (a fabricated one would desync owners).
  let version: number | undefined;
  if (replaced) {
    const { rows: versionRows } = await pool.query(
      'UPDATE characters SET temp_hit_points = $1 WHERE id = $2 AND version = $3 RETURNING version',
      [next, characterId, expectedVersion]
    );
    version = requireCommittedVersion(versionRows[0]);
  }
  return { hp, tempHp: next, replaced, version };
}

async function handleDamage(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/);
  const amountRaw = parts.shift() ?? '';
  const target = parts.join(' ').trim();
  const amount = parseAmount(amountRaw);
  if (amount === null) {
    whisperToCaller(c.io, c.ctx, '!damage: usage `!damage <amount> [target]`');
    return true;
  }
  const res = resolveTarget(c.ctx, target);
  if (!res.target) {
    whisperToCaller(c.io, c.ctx, `!damage: ${res.reason}`);
    return true;
  }
  if (!canMutateTarget(c.ctx, res.target.token)) {
    whisperToCaller(c.io, c.ctx, '!damage: you cannot target that token.');
    return true;
  }

  try {
    let hpBefore = 0;
    let hpAfter = 0;
    let appliedChange = 0;
    if (c.ctx.room.combatState?.active) {
      const combatant = c.ctx.room.combatState.combatants.find(
        (x) => x.tokenId === res.target!.token.id
      );
      hpBefore = combatant?.hp ?? (await readHpBefore(res.target.characterId));
      const r = await CombatService.applyDamage(c.ctx.room.sessionId, res.target.token.id, amount);
      hpAfter = r.hp;
      appliedChange = r.change;
      broadcastHpChange(
        c.io,
        c.ctx,
        res.target.token.id,
        r.characterId,
        r.hp,
        r.tempHp,
        r.change,
        'damage',
        r.version,
        r.wildShape
      );
    } else if (res.target.characterId) {
      hpBefore = await readHpBefore(res.target.characterId);
      const r = await applyDirectHp(res.target.characterId, -amount);
      if (!r) {
        whisperToCaller(c.io, c.ctx, '!damage: character not found');
        return true;
      }
      hpAfter = r.hp;
      appliedChange = r.change;
      broadcastHpChange(
        c.io,
        c.ctx,
        res.target.token.id,
        res.target.characterId,
        r.hp,
        r.tempHp,
        r.change,
        'damage',
        r.version,
        r.wildShape
      );
    } else {
      whisperToCaller(
        c.io,
        c.ctx,
        '!damage: this token has no character and combat is not active.'
      );
      return true;
    }
    emitHpAdjustCard(
      c,
      'damage',
      res.target.token.name,
      res.target.token.id,
      hpBefore,
      hpAfter,
      appliedChange
    );
    // R2: concentration save + endsOnDamage / saveOnDamage side effects.
    await applyDamageSideEffects(c.io, c.ctx.room, res.target.token.id, amount);
  } catch (err) {
    whisperToCaller(c.io, c.ctx, `!damage: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return true;
}

async function handleHeal(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/);
  const amountRaw = parts.shift() ?? '';
  const target = parts.join(' ').trim();
  const amount = parseAmount(amountRaw);
  if (amount === null) {
    whisperToCaller(c.io, c.ctx, '!heal: usage `!heal <amount> [target]`');
    return true;
  }
  const res = resolveTarget(c.ctx, target);
  if (!res.target) {
    whisperToCaller(c.io, c.ctx, `!heal: ${res.reason}`);
    return true;
  }
  if (!canMutateTarget(c.ctx, res.target.token)) {
    whisperToCaller(c.io, c.ctx, '!heal: you cannot target that token.');
    return true;
  }

  try {
    let hpBefore = 0;
    let hpAfter = 0;
    let appliedChange = 0;
    if (c.ctx.room.combatState?.active) {
      const combatant = c.ctx.room.combatState.combatants.find(
        (x) => x.tokenId === res.target!.token.id
      );
      hpBefore = combatant?.hp ?? (await readHpBefore(res.target.characterId));
      const r = await CombatService.applyHeal(c.ctx.room.sessionId, res.target.token.id, amount);
      hpAfter = r.hp;
      appliedChange = r.change;
      broadcastHpChange(
        c.io,
        c.ctx,
        res.target.token.id,
        r.characterId,
        r.hp,
        r.tempHp,
        r.change,
        'heal',
        r.version,
        r.wildShape
      );
    } else if (res.target.characterId) {
      hpBefore = await readHpBefore(res.target.characterId);
      const r = await applyDirectHp(res.target.characterId, amount);
      if (!r) {
        whisperToCaller(c.io, c.ctx, '!heal: character not found');
        return true;
      }
      hpAfter = r.hp;
      appliedChange = r.change;
      broadcastHpChange(
        c.io,
        c.ctx,
        res.target.token.id,
        res.target.characterId,
        r.hp,
        r.tempHp,
        r.change,
        'heal',
        r.version,
        r.wildShape
      );
    } else {
      whisperToCaller(c.io, c.ctx, '!heal: this token has no character and combat is not active.');
      return true;
    }
    emitHpAdjustCard(
      c,
      'heal',
      res.target.token.name,
      res.target.token.id,
      hpBefore,
      hpAfter,
      appliedChange
    );
  } catch (err) {
    whisperToCaller(c.io, c.ctx, `!heal: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return true;
}

async function handleHp(c: ChatCommandContext): Promise<boolean> {
  // Accepts absolute (`!hp 25`), or signed-relative (`!hp +5`, `!hp -3`).
  // Signed form delegates to the same damage/heal path so combat-state
  // bookkeeping runs. Absolute form writes a set value — in combat this
  // goes through CombatService indirectly by computing the delta.
  const parts = c.rest.split(/\s+/);
  const valueRaw = parts.shift() ?? '';
  const target = parts.join(' ').trim();

  if (!valueRaw) {
    whisperToCaller(c.io, c.ctx, '!hp: usage `!hp <value|+N|-N> [target]`');
    return true;
  }

  const signed = /^[+-]/.test(valueRaw);
  if (!/^[+-]?\d+$/.test(valueRaw)) {
    whisperToCaller(c.io, c.ctx, '!hp: value must be a number.');
    return true;
  }
  const num = Number(valueRaw);

  const res = resolveTarget(c.ctx, target);
  if (!res.target) {
    whisperToCaller(c.io, c.ctx, `!hp: ${res.reason}`);
    return true;
  }
  if (!canMutateTarget(c.ctx, res.target.token)) {
    whisperToCaller(c.io, c.ctx, '!hp: you cannot target that token.');
    return true;
  }

  try {
    if (signed) {
      const delta = num;
      if (c.ctx.room.combatState?.active) {
        const r =
          delta >= 0
            ? await CombatService.applyHeal(c.ctx.room.sessionId, res.target.token.id, delta)
            : await CombatService.applyDamage(c.ctx.room.sessionId, res.target.token.id, -delta);
        broadcastHpChange(
          c.io,
          c.ctx,
          res.target.token.id,
          r.characterId,
          r.hp,
          r.tempHp,
          r.change,
          delta >= 0 ? 'heal' : 'damage',
          r.version,
          r.wildShape
        );
      } else if (res.target.characterId) {
        const r = await applyDirectHp(res.target.characterId, delta);
        if (!r) {
          whisperToCaller(c.io, c.ctx, '!hp: character not found');
          return true;
        }
        broadcastHpChange(
          c.io,
          c.ctx,
          res.target.token.id,
          res.target.characterId,
          r.hp,
          r.tempHp,
          r.change,
          delta >= 0 ? 'heal' : 'damage',
          r.version,
          r.wildShape
        );
      } else {
        whisperToCaller(c.io, c.ctx, '!hp: this token has no character and combat is not active.');
        return true;
      }
      // R2: treat `!hp -N` as a damage event. `!hp +N` is a heal so no
      // concentration check. `!hp 20` (absolute) is administrative
      // hand-editing — not routed through side effects on purpose.
      if (delta < 0) {
        await applyDamageSideEffects(c.io, c.ctx.room, res.target.token.id, -delta);
      }
      return true;
    }

    // Absolute set.
    if (num < 0 || num > 9999) {
      whisperToCaller(c.io, c.ctx, '!hp: value out of range.');
      return true;
    }
    if (c.ctx.room.combatState?.active) {
      const combatant = c.ctx.room.combatState.combatants.find(
        (k) => k.tokenId === res.target!.token.id
      );
      if (combatant) {
        const target = Math.max(0, Math.min(combatant.maxHp, num));
        const delta = target - combatant.hp;
        const r =
          delta >= 0
            ? await CombatService.applyHeal(c.ctx.room.sessionId, res.target.token.id, delta)
            : await CombatService.applyDamage(c.ctx.room.sessionId, res.target.token.id, -delta);
        broadcastHpChange(
          c.io,
          c.ctx,
          res.target.token.id,
          r.characterId,
          r.hp,
          r.tempHp,
          r.change,
          delta >= 0 ? 'heal' : 'damage',
          r.version,
          r.wildShape
        );
        return true;
      }
    }
    if (res.target.characterId) {
      const r = await setDirectHp(res.target.characterId, num);
      if (!r) {
        whisperToCaller(c.io, c.ctx, '!hp: character not found');
        return true;
      }
      broadcastHpChange(
        c.io,
        c.ctx,
        res.target.token.id,
        res.target.characterId,
        r.hp,
        r.tempHp,
        0,
        'heal',
        r.version
      );
    } else {
      whisperToCaller(c.io, c.ctx, '!hp: this token has no character and combat is not active.');
    }
  } catch (err) {
    whisperToCaller(c.io, c.ctx, `!hp: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return true;
}

const ATTR_COLUMNS: Record<
  string,
  { column: string; min: number; max: number; abilityKey?: string }
> = {
  hp: { column: 'hit_points', min: 0, max: 9999 },
  maxhp: { column: 'max_hit_points', min: 1, max: 9999 },
  ac: { column: 'armor_class', min: 0, max: 99 },
  str: { column: 'ability_scores', min: 1, max: 30, abilityKey: 'str' },
  dex: { column: 'ability_scores', min: 1, max: 30, abilityKey: 'dex' },
  con: { column: 'ability_scores', min: 1, max: 30, abilityKey: 'con' },
  int: { column: 'ability_scores', min: 1, max: 30, abilityKey: 'int' },
  wis: { column: 'ability_scores', min: 1, max: 30, abilityKey: 'wis' },
  cha: { column: 'ability_scores', min: 1, max: 30, abilityKey: 'cha' },
};

const DEFAULT_ABILITY_SCORES: Record<string, number> = {
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
};

function readAbilityScores(raw: unknown): Record<string, number> {
  if (raw === null || raw === undefined || raw === '') return { ...DEFAULT_ABILITY_SCORES };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('stored ability scores are unreadable — nothing was changed.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stored ability scores are unreadable — nothing was changed.');
  }
  const scores = { ...DEFAULT_ABILITY_SCORES, ...(parsed as Record<string, number>) };
  for (const ability of Object.keys(DEFAULT_ABILITY_SCORES)) {
    const score = Number(scores[ability]);
    if (!Number.isInteger(score) || score < 1 || score > 30) {
      throw new Error('stored ability scores are unreadable — nothing was changed.');
    }
    scores[ability] = score;
  }
  return scores;
}

async function handleSetattr(c: ChatCommandContext): Promise<boolean> {
  if (!isDM(c.ctx)) {
    whisperToCaller(c.io, c.ctx, '!setattr: DM only.');
    return true;
  }
  // Syntax: `!setattr <target> <attr> <value>`. Target may contain spaces,
  // so parse from the right: last two tokens are attr + value; everything
  // else is the target name.
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    whisperToCaller(c.io, c.ctx, '!setattr: usage `!setattr <target> <attr> <value>`');
    return true;
  }
  const valueRaw = parts.pop()!;
  const attr = parts.pop()!.toLowerCase();
  const target = parts.join(' ');

  const spec = ATTR_COLUMNS[attr];
  if (!spec) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!setattr: unknown attr “${attr}”. Allowed: ${Object.keys(ATTR_COLUMNS).join(', ')}`
    );
    return true;
  }
  const value = /^\d+$/.test(valueRaw) ? Number(valueRaw) : Number.NaN;
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    whisperToCaller(c.io, c.ctx, `!setattr: value out of range [${spec.min}, ${spec.max}]`);
    return true;
  }

  const res = resolveTarget(c.ctx, target);
  if (!res.target) {
    whisperToCaller(c.io, c.ctx, `!setattr: ${res.reason}`);
    return true;
  }
  if (!res.target.characterId) {
    whisperToCaller(c.io, c.ctx, '!setattr: token has no character row to edit.');
    return true;
  }

  try {
    const { rows } = await pool.query(
      `SELECT ability_scores, hit_points, max_hit_points, armor_class,
              wild_shape, version
         FROM characters WHERE id = $1`,
      [res.target.characterId]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      whisperToCaller(c.io, c.ctx, '!setattr: character not found.');
      return true;
    }
    const expectedVersion = requireSelectedVersion(row);
    const changes: Record<string, unknown> = {};
    let version = expectedVersion;

    if (spec.abilityKey) {
      const scores = readAbilityScores(row.ability_scores);
      if (scores[spec.abilityKey] !== value) {
        scores[spec.abilityKey] = value;
        const { rows: versionRows } = await pool.query(
          'UPDATE characters SET ability_scores = $1 WHERE id = $2 AND version = $3 RETURNING version',
          [JSON.stringify(scores), res.target.characterId, expectedVersion]
        );
        version = requireCommittedVersion(versionRows[0]);
      }
      changes.abilityScores = scores;
    } else {
      if (spec.column === 'hit_points' || spec.column === 'max_hit_points') {
        const currentHp = Number(row.hit_points);
        const currentMaxHp = Number(row.max_hit_points);
        if (
          !Number.isInteger(currentHp) ||
          currentHp < 0 ||
          !Number.isInteger(currentMaxHp) ||
          currentMaxHp < 1 ||
          currentMaxHp > 9999 ||
          currentHp > currentMaxHp
        ) {
          throw new Error('could not verify the character state — nothing was changed.');
        }
        if (spec.column === 'hit_points') {
          const wildShape = readWildShapeColumn(row.wild_shape);
          if (wildShape.status === 'invalid') throw new Error(UNREADABLE_WILD_SHAPE);
          if (wildShape.status === 'active') {
            throw new Error(
              `target is wild-shaped (${wildShape.state.formName}) — use \`!damage\`/\`!heal\` or \`!revert\` first.`
            );
          }
          const nextHp = Math.min(currentMaxHp, value);
          if (nextHp !== currentHp) {
            const { rows: versionRows } = await pool.query(
              'UPDATE characters SET hit_points = $1 WHERE id = $2 AND version = $3 RETURNING version',
              [nextHp, res.target.characterId, expectedVersion]
            );
            version = requireCommittedVersion(versionRows[0]);
          }
          changes.hitPoints = nextHp;
        } else {
          const nextHp = Math.min(currentHp, value);
          if (value !== currentMaxHp) {
            const { rows: versionRows } = await pool.query(
              `UPDATE characters
                  SET max_hit_points = $1, hit_points = LEAST(hit_points, $1)
                WHERE id = $2 AND version = $3
                RETURNING version, hit_points`,
              [value, res.target.characterId, expectedVersion]
            );
            version = requireCommittedVersion(versionRows[0]);
            const committedHp = Number(versionRows[0]?.hit_points);
            if (!Number.isInteger(committedHp) || committedHp < 0 || committedHp > value) {
              throw new Error('the character update returned invalid HP — refresh before editing.');
            }
            changes.hitPoints = committedHp;
          } else {
            changes.hitPoints = nextHp;
          }
          changes.maxHitPoints = value;
        }
      } else {
        const currentAc = Number(row.armor_class);
        if (!Number.isInteger(currentAc) || currentAc < 0 || currentAc > 99) {
          throw new Error('could not verify the character state — nothing was changed.');
        }
        if (currentAc !== value) {
          const { rows: versionRows } = await pool.query(
            'UPDATE characters SET armor_class = $1 WHERE id = $2 AND version = $3 RETURNING version',
            [value, res.target.characterId, expectedVersion]
          );
          version = requireCommittedVersion(versionRows[0]);
        }
        changes.armorClass = value;
      }
    }
    changes.version = version;
    // Exact sheet numbers: scope by the target token through the
    // sharing toggles instead of the room-wide channel.
    emitToTokenStatViewers(c.io, c.ctx.room, res.target.token.id, 'character:updated', {
      characterId: res.target.characterId,
      changes,
    });
    whisperToCaller(c.io, c.ctx, `!setattr: ${res.target.token.name} ${attr} = ${value}`);
  } catch (err) {
    whisperToCaller(c.io, c.ctx, `!setattr: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return true;
}

async function handleThp(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/);
  const amountRaw = parts.shift() ?? '';
  const target = parts.join(' ').trim();
  const amount = parseAmount(amountRaw);
  if (amount === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!thp: usage `!thp <amount> [target]` — 0 clears, higher replaces, lower keeps existing.'
    );
    return true;
  }
  const res = resolveTarget(c.ctx, target);
  if (!res.target) {
    whisperToCaller(c.io, c.ctx, `!thp: ${res.reason}`);
    return true;
  }
  if (!canMutateTarget(c.ctx, res.target.token)) {
    whisperToCaller(c.io, c.ctx, '!thp: you cannot target that token.');
    return true;
  }

  try {
    const combatState = c.ctx.room.combatState;
    if (combatState?.active) {
      const combatant = combatState.combatants.find((cm) => cm.tokenId === res.target!.token.id);
      if (combatant) {
        const prior = combatant.tempHp;
        const next = amount === 0 ? 0 : Math.max(prior, amount);
        let version: number | undefined;
        if (res.target.characterId) {
          // Commit the optimistic-locking character write before changing
          // live combat state. A conflict must leave memory and clients alone.
          const result = await applyDirectTempHp(res.target.characterId, amount);
          if (!result) {
            whisperToCaller(c.io, c.ctx, '!thp: character not found');
            return true;
          }
          combatant.tempHp = result.tempHp;
          version = result.version;
        } else {
          combatant.tempHp = next;
        }
        if (combatant.tempHp !== prior) {
          CombatService.persistSessionCombatState(c.ctx.room.sessionId);
        }
        broadcastHpChange(
          c.io,
          c.ctx,
          res.target.token.id,
          res.target.characterId,
          combatant.hp,
          combatant.tempHp,
          combatant.tempHp - prior,
          'heal',
          version
        );
      }
    } else if (res.target.characterId) {
      const r = await applyDirectTempHp(res.target.characterId, amount);
      if (!r) {
        whisperToCaller(c.io, c.ctx, '!thp: character not found');
        return true;
      }
      broadcastHpChange(
        c.io,
        c.ctx,
        res.target.token.id,
        res.target.characterId,
        r.hp,
        r.tempHp,
        0,
        'heal',
        r.version
      );
    } else {
      whisperToCaller(c.io, c.ctx, '!thp: this token has no character and combat is not active.');
      return true;
    }
  } catch (err) {
    whisperToCaller(c.io, c.ctx, `!thp: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return true;
}

registerChatCommand('damage', handleDamage);
registerChatCommand('heal', handleHeal);
registerChatCommand('hp', handleHp);
registerChatCommand(['thp', 'temphp'], handleThp);
registerChatCommand('setattr', handleSetattr);
