import type { Server } from 'socket.io';
import type { Token } from '@dnd-vtt/shared';
import pool from '../../db/connection.js';
import * as CombatService from '../CombatService.js';
import {
  registerChatCommand,
  whisperToCaller,
  isDM,
  type ChatCommandContext,
} from '../ChatCommands.js';
import type { PlayerContext } from '../../utils/roomState.js';

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
  rest: string,
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
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 9999) return null;
  return n;
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
): void {
  io.to(ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId,
    hp,
    tempHp,
    change,
    type,
  });
  if (characterId) {
    io.to(ctx.room.sessionId).emit('character:updated', {
      characterId,
      changes: { hitPoints: hp, tempHitPoints: tempHp },
    });
  }
}

async function applyDirectHp(
  characterId: string,
  delta: number,
): Promise<{ hp: number; tempHp: number } | null> {
  // Outside combat: mutate the character row directly. Clamp to [0, max].
  const { rows } = await pool.query(
    'SELECT hit_points, max_hit_points, temp_hit_points FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const curHp = Number(row.hit_points);
  const maxHp = Number(row.max_hit_points);
  const tempHp = Number(row.temp_hit_points ?? 0);
  const nextHp = Math.max(0, Math.min(maxHp, curHp + delta));
  await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [nextHp, characterId]);
  return { hp: nextHp, tempHp };
}

async function setDirectHp(
  characterId: string,
  value: number,
): Promise<{ hp: number; tempHp: number } | null> {
  const { rows } = await pool.query(
    'SELECT max_hit_points, temp_hit_points FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const maxHp = Number(row.max_hit_points);
  const tempHp = Number(row.temp_hit_points ?? 0);
  const nextHp = Math.max(0, Math.min(maxHp, value));
  await pool.query('UPDATE characters SET hit_points = $1 WHERE id = $2', [nextHp, characterId]);
  return { hp: nextHp, tempHp };
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
    if (c.ctx.room.combatState?.active) {
      const r = await CombatService.applyDamage(c.ctx.room.sessionId, res.target.token.id, amount);
      broadcastHpChange(c.io, c.ctx, res.target.token.id, r.characterId, r.hp, r.tempHp, r.change, 'damage');
    } else if (res.target.characterId) {
      const r = await applyDirectHp(res.target.characterId, -amount);
      if (!r) { whisperToCaller(c.io, c.ctx, '!damage: character not found'); return true; }
      broadcastHpChange(c.io, c.ctx, res.target.token.id, res.target.characterId, r.hp, r.tempHp, -amount, 'damage');
    } else {
      whisperToCaller(c.io, c.ctx, '!damage: this token has no character and combat is not active.');
      return true;
    }
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
    if (c.ctx.room.combatState?.active) {
      const r = await CombatService.applyHeal(c.ctx.room.sessionId, res.target.token.id, amount);
      broadcastHpChange(c.io, c.ctx, res.target.token.id, r.characterId, r.hp, r.tempHp, r.change, 'heal');
    } else if (res.target.characterId) {
      const r = await applyDirectHp(res.target.characterId, amount);
      if (!r) { whisperToCaller(c.io, c.ctx, '!heal: character not found'); return true; }
      broadcastHpChange(c.io, c.ctx, res.target.token.id, res.target.characterId, r.hp, r.tempHp, amount, 'heal');
    } else {
      whisperToCaller(c.io, c.ctx, '!heal: this token has no character and combat is not active.');
      return true;
    }
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
  const num = parseInt(valueRaw, 10);
  if (!Number.isFinite(num)) {
    whisperToCaller(c.io, c.ctx, '!hp: value must be a number.');
    return true;
  }

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
        const r = delta >= 0
          ? await CombatService.applyHeal(c.ctx.room.sessionId, res.target.token.id, delta)
          : await CombatService.applyDamage(c.ctx.room.sessionId, res.target.token.id, -delta);
        broadcastHpChange(c.io, c.ctx, res.target.token.id, r.characterId, r.hp, r.tempHp, r.change, delta >= 0 ? 'heal' : 'damage');
      } else if (res.target.characterId) {
        const r = await applyDirectHp(res.target.characterId, delta);
        if (!r) { whisperToCaller(c.io, c.ctx, '!hp: character not found'); return true; }
        broadcastHpChange(c.io, c.ctx, res.target.token.id, res.target.characterId, r.hp, r.tempHp, delta, delta >= 0 ? 'heal' : 'damage');
      } else {
        whisperToCaller(c.io, c.ctx, '!hp: this token has no character and combat is not active.');
      }
      return true;
    }

    // Absolute set.
    if (num < 0 || num > 9999) {
      whisperToCaller(c.io, c.ctx, '!hp: value out of range.');
      return true;
    }
    if (c.ctx.room.combatState?.active) {
      const combatant = c.ctx.room.combatState.combatants.find((k) => k.tokenId === res.target!.token.id);
      if (combatant) {
        const target = Math.max(0, Math.min(combatant.maxHp, num));
        const delta = target - combatant.hp;
        const r = delta >= 0
          ? await CombatService.applyHeal(c.ctx.room.sessionId, res.target.token.id, delta)
          : await CombatService.applyDamage(c.ctx.room.sessionId, res.target.token.id, -delta);
        broadcastHpChange(c.io, c.ctx, res.target.token.id, r.characterId, r.hp, r.tempHp, r.change, delta >= 0 ? 'heal' : 'damage');
        return true;
      }
    }
    if (res.target.characterId) {
      const r = await setDirectHp(res.target.characterId, num);
      if (!r) { whisperToCaller(c.io, c.ctx, '!hp: character not found'); return true; }
      broadcastHpChange(c.io, c.ctx, res.target.token.id, res.target.characterId, r.hp, r.tempHp, 0, 'heal');
    } else {
      whisperToCaller(c.io, c.ctx, '!hp: this token has no character and combat is not active.');
    }
  } catch (err) {
    whisperToCaller(c.io, c.ctx, `!hp: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return true;
}

const ATTR_COLUMNS: Record<string, { column: string; min: number; max: number; abilityKey?: string }> = {
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
    whisperToCaller(c.io, c.ctx, `!setattr: unknown attr “${attr}”. Allowed: ${Object.keys(ATTR_COLUMNS).join(', ')}`);
    return true;
  }
  const value = parseInt(valueRaw, 10);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
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
    if (spec.abilityKey) {
      const { rows } = await pool.query(
        'SELECT ability_scores FROM characters WHERE id = $1',
        [res.target.characterId],
      );
      const raw = rows[0]?.ability_scores as string | undefined;
      let scores: Record<string, number> = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
      if (raw) {
        try { scores = { ...scores, ...JSON.parse(raw) }; } catch { /* keep defaults */ }
      }
      scores[spec.abilityKey] = value;
      await pool.query(
        'UPDATE characters SET ability_scores = $1 WHERE id = $2',
        [JSON.stringify(scores), res.target.characterId],
      );
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: res.target.characterId,
        changes: { abilityScores: scores },
      });
    } else {
      await pool.query(
        `UPDATE characters SET ${spec.column} = $1 WHERE id = $2`,
        [value, res.target.characterId],
      );
      const changes: Record<string, number> = {};
      if (spec.column === 'hit_points') changes.hitPoints = value;
      else if (spec.column === 'max_hit_points') changes.maxHitPoints = value;
      else if (spec.column === 'armor_class') changes.armorClass = value;
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: res.target.characterId,
        changes,
      });
    }
    whisperToCaller(c.io, c.ctx, `!setattr: ${res.target.token.name} ${attr} = ${value}`);
  } catch (err) {
    whisperToCaller(c.io, c.ctx, `!setattr: ${err instanceof Error ? err.message : 'failed'}`);
  }
  return true;
}

registerChatCommand('damage', handleDamage);
registerChatCommand('heal', handleHeal);
registerChatCommand('hp', handleHp);
registerChatCommand('setattr', handleSetattr);
