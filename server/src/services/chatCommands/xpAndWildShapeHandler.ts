import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { PoolClient } from 'pg';
import type { Token } from '@dnd-vtt/shared';
import { resolveViewingMapId, type PlayerContext } from '../../utils/roomState.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';

/**
 * Two kinda-orthogonal helpers bundled here:
 *
 *   XP — DMs award XP; characters become *eligible* to level when
 *   thresholds are crossed.
 *     !xp <target1> [target2 …] <amount>   — DM only
 *     !xp report                           — DM only, whispered party XP
 *     !xp threshold                        — caller's own linked character
 *
 *   XP is persisted on `characters.experience` (nonnegative), so totals
 *   survive restarts and stay consistent across instances. Awards are
 *   authoritative and fail closed: every target must resolve on the
 *   DM's current viewing map, targets are deduplicated by character,
 *   and all writes happen in ONE transaction where each character's
 *   selected `version` guards its UPDATE (`WHERE version = <selected>
 *   RETURNING version`). Any DB error, zero-row conflict, unusable
 *   selected/returned version, malformed stored XP, or overflow rolls
 *   the whole award back — no partial multi-target award, no exact-stat
 *   fanout, no public success line. A COMMIT that cannot be confirmed
 *   gets a truthful "verify before retrying" whisper instead of a
 *   success claim. Levels are never mutated automatically: applying a
 *   level without class/subclass choices would produce an invalid 5e
 *   sheet, so crossing a threshold only reports eligibility. Exact
 *   XP/version totals travel only through the dispatcher's stat-scoped
 *   `character:updated` wrapper (DM tabs + owner tabs, widened only by
 *   sharing toggles) and DM-facing whispers; the public line carries
 *   the award amount and eligibility, never exact totals.
 *
 *   Wild Shape (Druid) — announce + HP swap. Full token-replacement
 *   is out of scope; this tracks the beast HP alongside the Druid's
 *   own HP so damage comes off the beast pool first, then the Druid
 *   when it reverts.
 *     !wildshape <beast-name> <hp> [ac] [speed]
 *     !revert
 */

// XP thresholds per character level (PHB p.15).
const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000,
  195000, 225000, 265000, 305000, 355000,
];
const MAX_LEVEL = 20;
const MAX_AWARD = 999999;
// Stored totals stay comfortably inside INT4 even after many max awards.
const MAX_TOTAL_XP = 2_000_000_000;

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

// ────── !xp ──────────────────────────────────────────────────

function asAuthoritativeVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

/**
 * Stored XP must already satisfy the schema's nonnegative-integer
 * invariant. Null/empty is rejected rather than coerced (Number(null)
 * is 0) — a row that predates the migration must fail closed, not
 * silently read as zero.
 */
function asStoredXp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const xp = Number(value);
  return Number.isInteger(xp) && xp >= 0 ? xp : null;
}

/** Strict award parse: digits only, so `100abc` / `1e3` / `2.5` do not pass. */
function parseAwardAmount(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const amount = Number(raw);
  return amount >= 1 && amount <= MAX_AWARD ? amount : null;
}

function asCharacterLevel(value: unknown): number {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1) return 1;
  return Math.min(level, MAX_LEVEL);
}

/** Highest level this XP total qualifies for, capped at 20. */
function eligibleLevelForXp(xp: number): number {
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  }
  return Math.min(level, MAX_LEVEL);
}

/**
 * XP-specific token resolution: only tokens on the map the caller is
 * currently viewing, and (for non-DM callers) only tokens visible to
 * them. A cross-map or hidden token gets the same "not found" as a
 * nonexistent name. Mirrors the potion resolver; the room-wide
 * resolveCallerToken above stays untouched for Wild Shape.
 */
function resolveXpToken(ctx: PlayerContext, match: (t: Token) => boolean): Token | null {
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

/**
 * The caller's own character for `!xp threshold`: the session-linked
 * character first, else the caller's owned PC token on their current
 * viewing map. Never another player's character, never an off-map
 * token.
 */
function resolveOwnCharacterId(ctx: PlayerContext): string | null {
  if (ctx.player.characterId) return ctx.player.characterId;
  const own = resolveXpToken(
    ctx,
    (t) => t.ownerUserId === ctx.player.userId && Boolean(t.characterId)
  );
  return own?.characterId ?? null;
}

async function handleXpThreshold(c: ChatCommandContext): Promise<boolean> {
  const characterId = resolveOwnCharacterId(c.ctx);
  if (!characterId) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!xp threshold: no linked character or owned PC token on your current map.'
    );
    return true;
  }
  const { rows } = await pool.query(
    'SELECT name, level, experience FROM characters WHERE id = $1',
    [characterId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!xp threshold: character not found.');
    return true;
  }
  const level = asCharacterLevel(row.level);
  const xp = asStoredXp(row.experience);
  if (xp === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!xp threshold: stored XP is unreadable — refresh the character sheet.'
    );
    return true;
  }
  const name = String(row.name || 'Your character');
  if (level >= MAX_LEVEL) {
    whisperToCaller(
      c.io,
      c.ctx,
      `⭐ ${name} — Level ${MAX_LEVEL}, ${xp} XP. Maximum level reached.`
    );
    return true;
  }
  const nextThreshold = XP_THRESHOLDS[level];
  const toNext = Math.max(0, nextThreshold - xp);
  const eligible = eligibleLevelForXp(xp);
  const eligibleNote =
    eligible > level ? ` 🎉 Eligible for level ${eligible} — apply it on the character sheet.` : '';
  whisperToCaller(
    c.io,
    c.ctx,
    `⭐ ${name} — Level ${level}, ${xp} XP. ${toNext} XP to level ${level + 1} (threshold ${nextThreshold}).${eligibleNote}`
  );
  return true;
}

async function handleXpReport(c: ChatCommandContext): Promise<boolean> {
  // Exact party totals are DM information; the whisper goes only to
  // the requesting DM tab.
  const viewingMapId = resolveViewingMapId(c.ctx.room, c.ctx.player.userId, c.ctx.player.role);
  const pcs = Array.from(c.ctx.room.tokens.values()).filter(
    (t) => t.characterId && t.ownerUserId && t.mapId === viewingMapId
  );
  const seen = new Set<string>();
  const lines: string[] = ['⭐ Party XP report (current map):'];
  for (const pc of pcs) {
    if (seen.has(pc.characterId!)) continue;
    seen.add(pc.characterId!);
    const { rows } = await pool.query(
      'SELECT name, level, experience FROM characters WHERE id = $1',
      [pc.characterId]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) continue;
    const level = asCharacterLevel(row.level);
    const xp = asStoredXp(row.experience);
    if (xp === null) {
      lines.push(`  • ${row.name}: L${level}, stored XP unreadable`);
      continue;
    }
    if (level >= MAX_LEVEL) {
      lines.push(`  • ${row.name}: L${MAX_LEVEL}, ${xp} XP (max level)`);
      continue;
    }
    const next = XP_THRESHOLDS[level];
    const eligible = eligibleLevelForXp(xp);
    lines.push(
      `  • ${row.name}: L${level}, ${xp} XP (${Math.max(0, next - xp)} to L${level + 1})${eligible > level ? ` — eligible for L${eligible}` : ''}`
    );
  }
  if (lines.length === 1) lines.push('  • no PC tokens on this map.');
  whisperToCaller(c.io, c.ctx, lines.join('\n'));
  return true;
}

interface XpAward {
  characterId: string;
  name: string;
  level: number;
  newXp: number;
  eligibleLevel: number;
  version: number;
}

async function handleXpAward(c: ChatCommandContext, parts: string[]): Promise<boolean> {
  const amount = parseAwardAmount(parts[parts.length - 1]);
  if (amount === null) {
    whisperToCaller(c.io, c.ctx, `!xp: amount must be a whole number from 1 to ${MAX_AWARD}.`);
    return true;
  }
  const targetNames = parts.slice(0, -1);
  if (targetNames.length === 0) {
    whisperToCaller(c.io, c.ctx, '!xp: at least one target name required.');
    return true;
  }

  // Resolve every target on the DM's current viewing map BEFORE any
  // write; one bad name fails the whole award (no partial multi-target
  // award). Duplicate names / tokens collapsing to one character are
  // awarded once.
  const characterIds: string[] = [];
  const seen = new Set<string>();
  const misses: string[] = [];
  for (const name of targetNames) {
    const target = resolveXpToken(c.ctx, (t) => t.name.toLowerCase() === name.toLowerCase());
    if (!target?.characterId) {
      misses.push(name);
      continue;
    }
    if (seen.has(target.characterId)) continue;
    seen.add(target.characterId);
    characterIds.push(target.characterId);
  }
  if (misses.length > 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!xp: no XP was awarded — not a character token on your current map: ${misses.join(', ')}.`
    );
    return true;
  }

  const awards: XpAward[] = [];
  let client: PoolClient | null = null;
  let commitStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    for (const characterId of characterIds) {
      const { rows } = await client.query(
        'SELECT name, level, experience, version FROM characters WHERE id = $1',
        [characterId]
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error('character-missing');
      const expectedVersion = asAuthoritativeVersion(row.version);
      if (expectedVersion === null) throw new Error('character-version-unreadable');
      const oldXp = asStoredXp(row.experience);
      if (oldXp === null) throw new Error('character-xp-unreadable');
      const newXp = oldXp + amount;
      if (newXp > MAX_TOTAL_XP) throw new Error('character-xp-overflow');
      const { rows: updated } = await client.query(
        'UPDATE characters SET experience = $1 WHERE id = $2 AND version = $3 RETURNING version',
        [newXp, characterId, expectedVersion]
      );
      const authoritativeVersion = asAuthoritativeVersion(
        (updated[0] as Record<string, unknown> | undefined)?.version
      );
      if (authoritativeVersion === null) throw new Error('character-version-conflict');
      awards.push({
        characterId,
        name: String(row.name || characterId),
        level: asCharacterLevel(row.level),
        newXp,
        eligibleLevel: eligibleLevelForXp(newXp),
        version: authoritativeVersion,
      });
    }
    commitStarted = true;
    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.warn('[!xp] rollback failed:', rollbackError);
      }
    }
    console.warn('[!xp] award transaction failed:', error);
    whisperToCaller(
      c.io,
      c.ctx,
      commitStarted
        ? '!xp: the award could not be confirmed — refresh the character sheets and verify XP before retrying.'
        : '!xp: no XP was awarded — the save failed or a character sheet changed. Try again.'
    );
    return true;
  } finally {
    client?.release();
  }

  // Exact totals + versions fan out only through the dispatcher's
  // stat-scoped wrapper (DM tabs + each owner's tabs, widened only by
  // sharing toggles). Payload always carries the post-write RETURNING
  // version; `level` is never included — leveling stays a manual
  // sheet decision.
  for (const award of awards) {
    c.io.to(c.ctx.room.sessionId).emit('character:updated', {
      characterId: award.characterId,
      changes: { experience: award.newXp, version: award.version },
    });
  }

  // DM-only command, so exact new totals may be whispered back to the
  // caller. The public line carries amount + eligibility only.
  const dmLines = [`⭐ Awarded ${amount} XP:`];
  for (const award of awards) {
    dmLines.push(
      `  • ${award.name}: ${award.newXp} XP total${award.eligibleLevel > award.level ? ` — eligible for L${award.eligibleLevel}` : ''}`
    );
  }
  whisperToCaller(c.io, c.ctx, dmLines.join('\n'));

  const publicLines = [
    `⭐ ${c.ctx.player.displayName} awards ${amount} XP to ${awards.map((a) => a.name).join(', ')}.`,
  ];
  for (const award of awards) {
    if (award.eligibleLevel > award.level) {
      publicLines.push(
        `   🎉 ${award.name} is now eligible for level ${award.eligibleLevel} — apply it on the character sheet.`
      );
    }
  }
  broadcastSystem(c.io, c.ctx, publicLines.join('\n'));
  return true;
}

async function handleXP(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!xp: usage `!xp <target1> [target2 …] <amount>` | `!xp report` | `!xp threshold`'
    );
    return true;
  }
  const isDM = c.ctx.player.role === 'dm';

  if (parts[0].toLowerCase() === 'threshold') {
    return handleXpThreshold(c);
  }

  if (parts[0].toLowerCase() === 'report') {
    if (!isDM) {
      whisperToCaller(
        c.io,
        c.ctx,
        '!xp report: DM only. Players can run `!xp threshold` for their own status.'
      );
      return true;
    }
    return handleXpReport(c);
  }

  if (!isDM) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!xp: DM only (award XP). Players can run `!xp threshold` for status.'
    );
    return true;
  }

  return handleXpAward(c, parts);
}

// ────── !wildshape <beast> <hp> [ac] [speed] ────────────────
/**
 * Druid Wild Shape. We don't swap the token; instead we track the
 * beast's HP pool in memory and apply damage to it first, falling
 * through to the Druid when the beast drops to 0. On !revert we
 * restore the Druid's state and drop the beast tracking.
 *
 * Keep in room state — wildShapes: Map<characterId, { beastName, beastHp, beastMax, beastAc, beastSpeed, druidHpAtShift }>.
 * When damage is applied, !wildshape-aware handler subtracts from
 * beastHp first. Full pipe wiring is complex so this is announce +
 * HP pool mostly for the player to reference; the DM can apply
 * damage to the beast pool via a normal HP adjustment flow.
 */
const wildShapePools = new Map<
  string,
  {
    beastName: string;
    beastHp: number;
    beastMax: number;
    beastAc: number | null;
    beastSpeed: number | null;
  }
>();

async function handleWildShape(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(c.io, c.ctx, '!wildshape: usage `!wildshape <beast-name> <hp> [ac] [speed]`');
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!wildshape: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query('SELECT class, level, name FROM characters WHERE id = $1', [
    caller.characterId,
  ]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const classLower = String(row?.class || '').toLowerCase();
  if (!classLower.includes('druid')) {
    whisperToCaller(c.io, c.ctx, `!wildshape: ${caller.name} isn't a Druid.`);
    return true;
  }
  const druidName = (row?.name as string) || caller.name;

  // Beast name can have spaces; hp is the last numeric token, ac is
  // the penultimate number, speed is the antepenultimate. Parse from
  // the right.
  const nums: number[] = [];
  let nameParts = [...parts];
  while (nameParts.length > 0 && /^\d+$/.test(nameParts[nameParts.length - 1])) {
    nums.unshift(parseInt(nameParts.pop()!, 10));
    if (nums.length >= 3) break;
  }
  if (nums.length < 1) {
    whisperToCaller(c.io, c.ctx, '!wildshape: beast HP required.');
    return true;
  }
  const beastName = nameParts.join(' ');
  const beastHp = nums[0];
  const beastAc = nums.length > 1 ? nums[1] : null;
  const beastSpeed = nums.length > 2 ? nums[2] : null;

  wildShapePools.set(caller.characterId, {
    beastName,
    beastHp,
    beastMax: beastHp,
    beastAc,
    beastSpeed,
  });
  const extras: string[] = [];
  if (beastAc !== null) extras.push(`AC ${beastAc}`);
  if (beastSpeed !== null) extras.push(`${beastSpeed} ft speed`);
  broadcastSystem(
    c.io,
    c.ctx,
    `🐺 ${druidName} Wild Shapes into a **${beastName}** — HP ${beastHp}/${beastHp}${extras.length > 0 ? `, ${extras.join(', ')}` : ''}. Revert with !revert (Druid's own HP unchanged).`
  );
  return true;
}

async function handleRevert(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!revert: no owned PC token.');
    return true;
  }
  const pool = wildShapePools.get(caller.characterId);
  if (!pool) {
    whisperToCaller(c.io, c.ctx, '!revert: not currently wild-shaped.');
    return true;
  }
  wildShapePools.delete(caller.characterId);
  broadcastSystem(
    c.io,
    c.ctx,
    `🐺 ${caller.name} reverts from ${pool.beastName} back to Druid form.${pool.beastHp <= 0 ? ' (beast form dropped to 0 HP.)' : ''}`
  );
  return true;
}

// ────── !beast hp <amount> ─────────────────────────────────
/**
 * Apply damage / healing to the beast HP pool of the caller's active
 * Wild Shape. Used like !damage on the Druid but against the beast
 * pool instead of the Druid's own HP.
 *
 *   !beast dmg <amount>
 *   !beast heal <amount>
 *   !beast status
 */
async function handleBeast(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase() || 'status';
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!beast: no owned PC token.');
    return true;
  }
  const bp = wildShapePools.get(caller.characterId);
  if (!bp) {
    whisperToCaller(c.io, c.ctx, '!beast: not currently wild-shaped. Run !wildshape first.');
    return true;
  }
  if (sub === 'status') {
    whisperToCaller(c.io, c.ctx, `🐺 ${bp.beastName}: ${bp.beastHp}/${bp.beastMax} HP.`);
    return true;
  }
  const amount = parseInt(parts[1], 10);
  if (!Number.isFinite(amount) || amount < 0) {
    whisperToCaller(c.io, c.ctx, '!beast: amount must be a non-negative integer.');
    return true;
  }
  if (sub === 'dmg' || sub === 'damage') {
    bp.beastHp = Math.max(0, bp.beastHp - amount);
    broadcastSystem(
      c.io,
      c.ctx,
      `🐺 ${bp.beastName} takes ${amount} damage → ${bp.beastHp}/${bp.beastMax}${bp.beastHp <= 0 ? ' — BEAST DROPS, Druid reverts on excess.' : ''}`
    );
    if (bp.beastHp <= 0) {
      wildShapePools.delete(caller.characterId);
    }
    return true;
  }
  if (sub === 'heal') {
    bp.beastHp = Math.min(bp.beastMax, bp.beastHp + amount);
    broadcastSystem(
      c.io,
      c.ctx,
      `🐺 ${bp.beastName} heals ${amount} → ${bp.beastHp}/${bp.beastMax}.`
    );
    return true;
  }
  whisperToCaller(c.io, c.ctx, `!beast: unknown subcommand "${sub}". Use status / dmg / heal.`);
  return true;
}

registerChatCommand(['xp', 'experience'], handleXP);
registerChatCommand(['wildshape', 'ws'], handleWildShape);
registerChatCommand('revert', handleRevert);
registerChatCommand('beast', handleBeast);
