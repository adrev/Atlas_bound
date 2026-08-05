import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import * as CombatService from '../CombatService.js';
import pool from '../../db/connection.js';
import type { Feature, Token } from '@dnd-vtt/shared';
import { resolveViewingMapId, type PlayerContext } from '../../utils/roomState.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';
import { formatSaveTotal, rollTargetSave } from './saveRoll.js';
import {
  checkChannelDivinityAction,
  markChannelDivinityAction,
  resolveChannelDivinityCaller,
  resolveChannelDivinityTarget,
  spendChannelDivinityUse,
} from './channelDivinity.js';

/**
 * Utility commands for common mid-session effects that players
 * otherwise track by hand: healing potions, the Lucky feat, the
 * Medicine-check stabilize rule, Turn Undead, and the two common
 * concentration damage-riders (Hex / Hunter's Mark).
 */

// ────── Helpers ─────────────────────────────────────────────────

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

function resolveTargetByName(ctx: PlayerContext, name: string): Token | null {
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) => t.name.toLowerCase() === needle
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

/**
 * Potion-specific target authorization. Only a token on the map the
 * caller is currently viewing can be resolved, and non-DM callers can
 * only resolve tokens they can actually see under the token-visibility
 * rules (an owned-but-invisible token stays valid for its owner). A
 * hidden or cross-map token gets the same "no target" refusal as a
 * nonexistent name, so the command never confirms it exists. The
 * generic room-wide resolver above is left untouched for the other
 * utility commands.
 */
function resolvePotionTarget(ctx: PlayerContext, name: string): Token | null {
  return resolvePotionToken(ctx, (t) => t.name.toLowerCase() === name.toLowerCase());
}

/**
 * Self-default (`!potion` with no target name): the caller's own token,
 * under the same viewing-map and visibility authorization as a named
 * target. Without the map filter, "newest owned token in the room"
 * could silently mutate a caller-owned character on another map.
 */
function resolvePotionCallerToken(ctx: PlayerContext): Token | null {
  return resolvePotionToken(ctx, (t) => t.ownerUserId === ctx.player.userId);
}

function resolvePotionToken(ctx: PlayerContext, match: (t: Token) => boolean): Token | null {
  const viewingMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
  if (!viewingMapId) return null;
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) =>
      t.mapId === viewingMapId &&
      match(t) &&
      (ctx.player.role === 'dm' || tokenVisibleToPlayer(t, ctx.player.userId))
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

function asAuthoritativeVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function formatSaveNotes(notes: string[]): string {
  return notes.length > 0 ? ` [${notes.join('; ')}]` : '';
}

// ────── !potion <target> [dice] ───────────────────────────────
/**
 * Healing potion. Default 2d4+2 (standard potion). Other types:
 *   potion of greater healing  → 4d4+4
 *   potion of superior healing → 8d4+8
 *   potion of supreme healing  → 10d4+20
 * The optional dice arg is bounded to exactly those four official
 * formulas — anything else that looks like dice notation (partial,
 * custom, or oversized) is rejected before any roll or DB query.
 *
 * The HP write is authoritative and fails closed: the target's
 * `characters.version` is selected, validated, and guards the UPDATE
 * (`WHERE version = <selected> RETURNING version`). A DB error,
 * zero-row conflict, unusable selected version, missing or full-HP
 * target, or invalid command yields only a private whisper — no
 * exact-stat fanout, no public success announcement. If the write
 * commits but RETURNING gives no usable version, the caller is told
 * truthfully to refresh and the handler stops. Exact before/after HP
 * travels only through the dispatcher's stat-scoped wrapper (all DM
 * tabs + owner tabs, widened only by the sharing toggles); the public
 * flavor line states the potion formula and rolled healing without
 * any sheet totals. Both named targets and the no-name self-default
 * resolve only on the caller's viewing map and (for non-DMs) only if
 * visible to the caller — never an owned token on another map; after
 * a committed write, a matching active combatant's HP is synced and
 * the combat state persisted. Inventory consumption is out of scope — the
 * command never claims a potion was removed from anyone's pack.
 */
const POTION_FORMULAS: Record<string, { label: string; count: number; mod: number }> = {
  '2d4+2': { label: 'Potion of Healing', count: 2, mod: 2 },
  '4d4+4': { label: 'Potion of Greater Healing', count: 4, mod: 4 },
  '8d4+8': { label: 'Potion of Superior Healing', count: 8, mod: 8 },
  '10d4+20': { label: 'Potion of Supreme Healing', count: 10, mod: 20 },
};

/** Anything starting like NdN is a dice-override attempt and must match
 *  an official formula exactly — `2d4+2abc`, `999d4`, `3d6` all refuse. */
const DICE_ATTEMPT = /^\d*d\d/i;

async function handlePotion(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!potion: usage `!potion <target> [dice]` — default 2d4+2 (potion of healing).'
    );
    return true;
  }

  // Last arg is a dice override if it looks like dice notation;
  // everything before is target name. Overrides are bounded to the
  // official potion formulas — reject before rolling or querying.
  let formulaKey = '2d4+2';
  const last = parts[parts.length - 1].toLowerCase();
  if (DICE_ATTEMPT.test(last)) {
    if (!(last in POTION_FORMULAS)) {
      whisperToCaller(
        c.io,
        c.ctx,
        '!potion: dice must be an official potion formula — 2d4+2 (healing), 4d4+4 (greater), 8d4+8 (superior), or 10d4+20 (supreme).'
      );
      return true;
    }
    formulaKey = last;
    parts.pop();
  }
  const targetName = parts.join(' ');
  const target = targetName
    ? resolvePotionTarget(c.ctx, targetName)
    : resolvePotionCallerToken(c.ctx);
  if (!target?.characterId) {
    whisperToCaller(
      c.io,
      c.ctx,
      targetName
        ? `!potion: no target with a character sheet named "${targetName}".`
        : '!potion: no owned token with a character sheet on this map.'
    );
    return true;
  }

  const { rows } = await pool.query(
    'SELECT hit_points, max_hit_points, temp_hit_points, name, version FROM characters WHERE id = $1',
    [target.characterId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!potion: character not found.');
    return true;
  }
  const curHp = Number(row.hit_points) || 0;
  const maxHp = Number(row.max_hit_points) || 0;
  const tempHp = Number(row.temp_hit_points) || 0;
  if (maxHp <= 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!potion: ${target.name}'s sheet has no usable max HP — no HP was changed.`
    );
    return true;
  }
  if (curHp >= maxHp) {
    // Stable-but-unconscious or downed characters (0 HP) may still be
    // administered a potion; only a genuinely full target is a no-op.
    whisperToCaller(
      c.io,
      c.ctx,
      `!potion: ${target.name} is already at full HP — nothing to heal.`
    );
    return true;
  }
  const expectedVersion = asAuthoritativeVersion(row.version);
  if (expectedVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!potion: could not verify the character sheet state — no HP was changed. Try again.'
    );
    return true;
  }

  const formula = POTION_FORMULAS[formulaKey];
  const rolls: number[] = [];
  for (let i = 0; i < formula.count; i++) {
    rolls.push(Math.floor(Math.random() * 4) + 1);
  }
  const heal = rolls.reduce((s, r) => s + r, 0) + formula.mod;
  const newHp = Math.min(maxHp, curHp + heal);

  let updated: unknown[];
  try {
    ({ rows: updated } = await pool.query(
      'UPDATE characters SET hit_points = $1 WHERE id = $2 AND version = $3 RETURNING version',
      [newHp, target.characterId, expectedVersion]
    ));
  } catch (e) {
    console.warn('[!potion] hp write failed:', e);
    whisperToCaller(
      c.io,
      c.ctx,
      '!potion: applying the healing failed — no HP was changed. Try again.'
    );
    return true;
  }
  if (updated.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!potion: the character sheet changed while processing — no HP was changed. Try again.'
    );
    return true;
  }
  const authoritativeVersion = asAuthoritativeVersion(
    (updated[0] as Record<string, unknown>).version
  );
  if (authoritativeVersion === null) {
    // The write committed but RETURNING gave no usable version, so no
    // authoritative payload can be fanned out. Fail closed post-commit:
    // tell the caller the truth and stop — no fanout, no announcement.
    whisperToCaller(
      c.io,
      c.ctx,
      '!potion: the healing was applied but synchronization failed — refresh the character sheet before retrying.'
    );
    return true;
  }

  // Keep an active combat authoritative too: mirror the committed HP
  // into the matching combatant and persist, so a later combat
  // mutation can't reapply or display the stale value. Only reached
  // after the version-guarded write returned a usable version — every
  // failed, conflicted, or unusable path above stops before this.
  const combatant = c.ctx.room.combatState?.combatants.find((cb) => cb.tokenId === target.id);
  if (combatant) {
    combatant.hp = newHp;
    CombatService.persistSessionCombatState(c.ctx.room.sessionId);
  }

  // Exact HP goes only through the dispatcher's stat-scoped wrapper
  // (DM + owner tabs, widened by sharing toggles), with the
  // authoritative post-write version.
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: target.characterId,
    changes: { hitPoints: newHp, version: authoritativeVersion },
  });
  c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
    tokenId: target.id,
    hp: newHp,
    tempHp,
    change: newHp - curHp,
    type: 'heal',
  });
  // Public flavor: formula and rolled healing only — no sheet totals.
  broadcastSystem(
    c.io,
    c.ctx,
    `🧪 ${target.name} drinks a ${formula.label} (${formulaKey}): ${rolls.join('+')} + ${formula.mod} = **${heal}** healing.`
  );
  return true;
}

// ────── !lucky (Lucky feat resource) ──────────────────────────
/**
 * Lucky feat: 3 luck points, all restored by a long rest. Spending a
 * point rolls one extra d20 the player may swap in for an attack
 * roll, ability check, or saving throw. (The advantage-flip variant
 * against attackers is DM-adjudicated and out of scope.)
 *
 * The points are authoritative character state, never module memory:
 * the caller's sheet must carry the actual Lucky *feat* feature
 * (`sourceType: 'feat'`). The Halfling racial trait of the same name
 * rerolls natural 1s and has no point pool, so a racial entry never
 * qualifies, and the feat is never invented for an ineligible sheet.
 * Points persist in that feat entry's `usesTotal`/`usesRemaining`
 * with `resetOn: 'long'` — metadata RestService's long rest already
 * restores (and a short rest correctly does not); missing or
 * malformed resource fields on a real feat entry are normalized on
 * the next spend, only ever inside that entry.
 *
 * `use` fails closed around a version-guarded write: the selected
 * `characters.version` guards the UPDATE (`WHERE version = <selected>
 * RETURNING version`), and a DB error, zero-row conflict, unusable
 * selected/returned version, missing feat, exhausted pool, malformed
 * feature data, off-map token, or bad subcommand produces only a
 * private whisper — no write, no roll, no fanout, no public line.
 * The d20 is rolled and announced only after the commit; the public
 * line reveals the extra d20 but never the remaining pool, which
 * travels only through the dispatcher's stat-scoped wrapper (DM +
 * owner tabs, widened only by the sharing toggles). `status` is a
 * private whisper. The caller's token resolves only on the map they
 * are viewing — no off-map newest-token fallback. The old DM-only
 * `!lucky reset` is removed: `!rest long` is the reset.
 */
const LUCKY_POINTS = 3;

function isLuckyFeat(feature: Feature): boolean {
  return feature?.sourceType === 'feat' && /^lucky$/i.test(String(feature.name ?? '').trim());
}

/** Same viewing-map + visibility authorization as the potion
 *  self-default — never an owned token on another map. */
function resolveLuckyCallerToken(ctx: PlayerContext): Token | null {
  return resolvePotionToken(ctx, (t) => t.ownerUserId === ctx.player.userId);
}

function parseLuckyFeatures(value: unknown): Feature[] | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? (parsed as Feature[]) : null;
  } catch {
    return null;
  }
}

function normalizeLuckyPool(feature: Feature): { total: number; remaining: number } {
  // The 2014 Lucky feat always grants exactly three points. Treat
  // imported resource metadata as state to repair, not permission to
  // increase the rules-defined maximum.
  const total = LUCKY_POINTS;
  const remaining = Number.isFinite(Number(feature.usesRemaining))
    ? Math.min(total, Math.max(0, Math.floor(Number(feature.usesRemaining))))
    : total;
  return { total, remaining };
}

async function handleLucky(c: ChatCommandContext): Promise<boolean> {
  const args = c.rest.split(/\s+/).filter(Boolean);
  const sub = args.length === 0 ? 'status' : args[0].toLowerCase();
  if (args.length > 1 || !['use', 'spend', 'status', 'reset'].includes(sub)) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky: usage `!lucky use` | `!lucky status` — luck points refresh on a long rest.'
    );
    return true;
  }
  if (sub === 'reset') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky reset was removed — luck points are restored by a long rest (`!rest long`).'
    );
    return true;
  }

  const caller = resolveLuckyCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!lucky: no owned token with a character sheet on this map.');
    return true;
  }

  const { rows } = await pool.query('SELECT features, version FROM characters WHERE id = $1', [
    caller.characterId,
  ]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!lucky: character not found.');
    return true;
  }
  const features = parseLuckyFeatures(row.features);
  if (!features) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky: the character feature data is invalid — no luck point was spent. Refresh or re-sync the character sheet.'
    );
    return true;
  }
  const featIndex = features.findIndex(isLuckyFeat);
  if (featIndex < 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!lucky: ${caller.name} doesn't have the Lucky feat. (The Halfling racial trait rerolls natural 1s on its own and has no luck points.)`
    );
    return true;
  }
  const { total, remaining } = normalizeLuckyPool(features[featIndex]);

  if (sub === 'status') {
    whisperToCaller(
      c.io,
      c.ctx,
      `🍀 Lucky (feat): ${remaining}/${total} luck points. Refreshes on a long rest.`
    );
    return true;
  }

  // use / spend
  if (remaining <= 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky: no luck points remaining. Take a long rest to refresh them.'
    );
    return true;
  }
  const expectedVersion = asAuthoritativeVersion(row.version);
  if (expectedVersion === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky: could not verify the character sheet state — no luck point was spent. Try again.'
    );
    return true;
  }
  const updatedFeatures = features.map((feature, index) =>
    index === featIndex
      ? { ...feature, usesTotal: total, usesRemaining: remaining - 1, resetOn: 'long' as const }
      : feature
  );

  let updated: unknown[];
  try {
    ({ rows: updated } = await pool.query(
      'UPDATE characters SET features = $1 WHERE id = $2 AND version = $3 RETURNING version',
      [JSON.stringify(updatedFeatures), caller.characterId, expectedVersion]
    ));
  } catch (e) {
    console.warn('[!lucky] feature write failed:', e);
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky: saving the spend failed — no luck point was spent. Try again.'
    );
    return true;
  }
  if (updated.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky: the character sheet changed while processing — no luck point was spent. Try again.'
    );
    return true;
  }
  const authoritativeVersion = asAuthoritativeVersion(
    (updated[0] as Record<string, unknown>).version
  );
  if (authoritativeVersion === null) {
    // The write committed but RETURNING gave no usable version, so no
    // authoritative payload can be fanned out. Fail closed post-commit:
    // tell the caller the truth and stop — no roll, no announcement.
    whisperToCaller(
      c.io,
      c.ctx,
      '!lucky: the luck point was spent, but synchronization failed — refresh the character sheet before retrying.'
    );
    return true;
  }

  // Exact remaining pool goes only through the dispatcher's
  // stat-scoped wrapper (DM + owner tabs, widened by sharing
  // toggles), with the authoritative post-write version.
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { features: updatedFeatures, version: authoritativeVersion },
  });
  // Rolled only after the commit; the public line reveals the extra
  // d20 but never the remaining pool.
  const d20 = Math.floor(Math.random() * 20) + 1;
  broadcastSystem(
    c.io,
    c.ctx,
    `🍀 ${caller.name} spends a luck point (Lucky feat) — extra d20 = **${d20}**. Use either this roll or the original.`
  );
  return true;
}

// ────── !stabilize <target> ───────────────────────────────────
/**
 * Medicine DC 10 check to stabilize a creature at 0 HP. On a
 * success, the creature doesn't have to make death saves any
 * more (HP stays at 0; condition effectively "stable"). On a
 * failure, nothing changes.
 *
 * We roll the caller's WIS + proficiency-if-proficient, broadcast
 * the result, and if it succeeds we clear the death-save counter
 * and apply a `stable` pseudo-condition.
 */
async function handleStabilize(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!stabilize: usage `!stabilize <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target?.characterId) {
    whisperToCaller(c.io, c.ctx, `!stabilize: no character named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!stabilize: no owned PC token.');
    return true;
  }
  const targetCombatant = c.ctx.room.combatState?.combatants.find(
    (combatant) => combatant.tokenId === target.id
  );
  const targetHpFromCombat = targetCombatant?.hp;
  if (targetHpFromCombat !== undefined && targetHpFromCombat > 0) {
    whisperToCaller(c.io, c.ctx, `!stabilize: ${target.name} is not at 0 HP.`);
    return true;
  }
  if (targetHpFromCombat === undefined) {
    const targetRows = await pool.query('SELECT hit_points FROM characters WHERE id = $1', [
      target.characterId,
    ]);
    const targetHp =
      Number((targetRows.rows[0] as Record<string, unknown> | undefined)?.hit_points) || 0;
    if (targetHp > 0) {
      whisperToCaller(c.io, c.ctx, `!stabilize: ${target.name} is not at 0 HP.`);
      return true;
    }
  }
  const { rows } = await pool.query(
    'SELECT ability_scores, skills, proficiency_bonus FROM characters WHERE id = $1',
    [caller.characterId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  let wisMod = 0,
    prof = 2,
    hasProf = false;
  try {
    const scores =
      typeof row?.ability_scores === 'string'
        ? JSON.parse(row.ability_scores as string)
        : (row?.ability_scores ?? {});
    wisMod = Math.floor((((scores as Record<string, number>).wis ?? 10) - 10) / 2);
    prof = Number(row?.proficiency_bonus) || 2;
    const sk =
      typeof row?.skills === 'string' ? JSON.parse(row.skills as string) : (row?.skills ?? {});
    const medicineProf = (sk as Record<string, string>)?.medicine ?? 'none';
    hasProf = medicineProf === 'proficient' || medicineProf === 'expertise';
  } catch {
    /* ignore */
  }
  const bonus = wisMod + (hasProf ? prof : 0);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + bonus;
  const dc = 10;
  const success = total >= dc;
  const sign = bonus >= 0 ? '+' : '';
  const lines: string[] = [];
  lines.push(`🩹 ${caller.name} tries to Stabilize ${target.name}`);
  lines.push(
    `   Medicine (WIS${hasProf ? ' + prof' : ''}): d20=${d20}${sign}${bonus}=${total} vs DC ${dc} → ${success ? 'SUCCESS' : 'FAIL'}`
  );
  if (success) {
    let characterVersion: number | undefined;
    if (targetCombatant) {
      const stableResult = await CombatService.markStable(c.ctx.room.sessionId, target.id);
      characterVersion = stableResult.version;
    } else {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'unconscious',
        source: `${caller.name} (!stabilize)`,
        appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
      });
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'stable',
        source: `${caller.name} (!stabilize)`,
        appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
      });
      const { rows: versionRows } = await pool.query(
        'UPDATE characters SET hit_points = 0, death_saves = $1 WHERE id = $2 RETURNING version',
        [JSON.stringify({ successes: 0, failures: 0 }), target.characterId]
      );
      const version = Number(versionRows[0]?.version);
      if (Number.isInteger(version) && version >= 1) characterVersion = version;
    }
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
    const characterChanges: Record<string, unknown> = {
      hitPoints: 0,
      deathSaves: { successes: 0, failures: 0 },
    };
    if (characterVersion !== undefined) characterChanges.version = characterVersion;
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: target.characterId,
      changes: characterChanges,
    });
    lines.push(`   → ${target.name} is STABLE (no more death saves; HP stays at 0).`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ────── !hex / !unhex <target> ──────────────────────────────
/**
 * Warlock's Hex cantrip. Deals +1d6 necrotic when the caster hits
 * the hexed target with an attack. Concentration spell — the
 * caster moves the hex on death. We track via the `hexed` pseudo-
 * condition with casterTokenId set so the attack resolver can
 * match "the hex caster is also the current attacker".
 *
 * Also imposes disadvantage on one ability check (caster's choice)
 * — out of scope here, DM adjudicates.
 */
async function handleHex(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!hex: usage `!hex <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!hex: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!hex: no owned PC token.');
    return true;
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'hexed',
    source: `${caller.name} (Hex)`,
    casterTokenId: caller.id,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io,
    c.ctx,
    `🕷 ${caller.name} hexes ${target.name} — caster's attacks against this target deal +1d6 necrotic.`
  );
  return true;
}

async function handleUnhex(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!unhex: usage `!unhex <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!unhex: no token named "${targetName}".`);
    return true;
  }
  if (!(target.conditions as string[]).some((x) => x.toLowerCase() === 'hexed')) {
    whisperToCaller(c.io, c.ctx, `!unhex: ${target.name} isn't hexed.`);
    return true;
  }
  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'hexed');
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `🕷 Hex lifted from ${target.name}.`);
  return true;
}

// ────── !mark / !unmark <target> (Hunter's Mark) ──────────
/**
 * Ranger's Hunter's Mark. Adds +1d6 to weapon damage when the
 * caster hits the marked target. Concentration; caster can move
 * it as a bonus action. Also grants adv on WIS(Perception) and
 * WIS(Survival) checks to find the target — DM adjudicates those.
 */
async function handleMark(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  if (!targetName) {
    whisperToCaller(c.io, c.ctx, '!mark: usage `!mark <target>`');
    return true;
  }
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!mark: no token named "${targetName}".`);
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!mark: no owned PC token.');
    return true;
  }
  ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
    name: 'marked',
    source: `${caller.name} (Hunter's Mark)`,
    casterTokenId: caller.id,
    appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
  });
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(
    c.io,
    c.ctx,
    `🏹 ${caller.name} marks ${target.name} (Hunter's Mark) — +1d6 weapon damage from caster.`
  );
  return true;
}

async function handleUnmark(c: ChatCommandContext): Promise<boolean> {
  const targetName = c.rest.trim();
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!unmark: no token named "${targetName}".`);
    return true;
  }
  if (!(target.conditions as string[]).some((x) => x.toLowerCase() === 'marked')) {
    whisperToCaller(c.io, c.ctx, `!unmark: ${target.name} isn't marked.`);
    return true;
  }
  ConditionService.removeCondition(c.ctx.room.sessionId, target.id, 'marked');
  c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
    tokenId: target.id,
    changes: tokenConditionChanges(c.ctx.room, target.id),
  });
  broadcastSystem(c.io, c.ctx, `🏹 Hunter's Mark lifted from ${target.name}.`);
  return true;
}

// ────── !turnundead ─────────────────────────────────────────
/**
 * Cleric's Turn Undead Channel Divinity. Each undead within 30 ft
 * that can see or hear you must make a WIS save (DC = your spell
 * save DC). On a failure, they're Frightened of you for 1 minute
 * (10 rounds) and must spend movement to move away from you each
 * turn.
 *
 * We don't auto-detect "undead" creature type or 30-ft range — DM
 * decides who's in range. The command just rolls the save for each
 * target the DM passes.
 *
 *   !turnundead <target> [target2] [...]    DC = caller's spell save DC
 */
async function handleTurnUndead(c: ChatCommandContext): Promise<boolean> {
  const rawTargets = c.rest.trim();
  if (!rawTargets) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!turnundead: usage `!turnundead <target>` or `!turnundead <target one>, <target two>`'
    );
    return true;
  }
  const caller = resolveChannelDivinityCaller(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!turnundead: no owned PC token on this map.');
    return true;
  }
  const exactTarget = resolveChannelDivinityTarget(c.ctx, rawTargets);
  const targetNames = exactTarget
    ? [rawTargets]
    : rawTargets.includes(',')
      ? rawTargets
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      : rawTargets.split(/\s+/).filter(Boolean);
  const normalizedNames = targetNames.map((name) => name.toLowerCase());
  if (
    targetNames.length === 0 ||
    targetNames.length > 50 ||
    new Set(normalizedNames).size !== normalizedNames.length
  ) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!turnundead: provide 1-50 unique visible targets, separated by commas for multiword names.'
    );
    return true;
  }
  const targets = targetNames.map((name) => resolveChannelDivinityTarget(c.ctx, name));
  const missingIndex = targets.findIndex((target) => target === null);
  if (missingIndex >= 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!turnundead: no visible token named "${targetNames[missingIndex]}" on this map; no use was spent.`
    );
    return true;
  }
  const action = checkChannelDivinityAction(c, caller, '!turnundead', 'action');
  if (!action) return true;
  let dc = 0;
  const spend = await spendChannelDivinityUse(c, caller, '!turnundead', (row, entitlement) => {
    if ((entitlement.clericLevel ?? 0) < 2) return 'Turn Undead requires Cleric level 2.';
    const parsedDc = Number(row.spell_save_dc);
    if (!Number.isInteger(parsedDc) || parsedDc < 1 || parsedDc > 40) {
      return 'spell save DC is unreadable; no use was spent.';
    }
    dc = parsedDc;
    return null;
  });
  if (!spend) return true;
  markChannelDivinityAction(c, caller, 'action', action.economy);

  const lines: string[] = [];
  lines.push(
    `⚱ ${caller.name} presents their holy symbol and speaks — Turn Undead (DC ${dc} WIS save)`
  );
  for (const target of targets as Token[]) {
    // Roll target's WIS save. If they have a character, use the shared save
    // resolver; otherwise the DM rolls externally and applies.
    if (!target.characterId) {
      lines.push(`   • ${target.name}: no character sheet — DM rolls WIS save externally.`);
      continue;
    }
    const saveResult = await rollTargetSave(c, target, 'wis', dc, 'frightened');
    const saved = saveResult.saved;
    lines.push(
      `   • ${saveResult.displayName} WIS save: ${formatSaveTotal(saveResult)} → ${saved ? 'SAVED' : 'FAILED'}${formatSaveNotes(saveResult.notes)}`
    );
    if (!saved) {
      const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: 'frightened',
        source: `${caller.name} (Turn Undead)`,
        casterTokenId: caller.id,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 10,
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
      lines.push(`     → Frightened for 1 min; must Dash away.`);
    }
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  whisperToCaller(c.io, c.ctx, `!turnundead: ${spend.remaining}/${spend.maximum} uses remaining.`);
  return true;
}

registerChatCommand(['potion', 'drink'], handlePotion);
registerChatCommand('lucky', handleLucky);
registerChatCommand(['stabilize', 'stabilise'], handleStabilize);
registerChatCommand('hex', handleHex);
registerChatCommand('unhex', handleUnhex);
registerChatCommand(['mark', 'huntersmark'], handleMark);
registerChatCommand('unmark', handleUnmark);
registerChatCommand(['turnundead', 'turn'], handleTurnUndead);
