import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { PoolClient } from 'pg';
import type { Token, ActionEconomy } from '@dnd-vtt/shared';
import { resolveViewingMapId, type PlayerContext } from '../../utils/roomState.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';
import {
  readWildShapeColumn,
  serializeWildShapeState,
  type WildShapeState,
} from '../../utils/wildShapeState.js';
import { emitWildShapePrivate } from '../../utils/wildShapeSync.js';
import { emitCombatStateSync } from '../../utils/combatStateVisibility.js';
import * as CombatService from '../CombatService.js';

/**
 * Two kinda-orthogonal helpers bundled here:
 *
 *   XP — DMs award XP; characters become *eligible* to level when
 *   thresholds are crossed.
 *     !xp <target1> [target2 …] <amount>   — DM only; commas support names with spaces
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
 *   Wild Shape (Druid) — server-authoritative form tracking persisted
 *   on `characters.wild_shape`. See the section comment below.
 *     !wildshape <beast name>
 *     !revert | !beast dmg|heal|status
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
 * nonexistent name. Mirrors the potion resolver; Wild Shape reuses it
 * via resolveWildShapeCaller below.
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
  const amountText = parts[parts.length - 1];
  const targetText = c.rest.trim().slice(0, -amountText.length).trim();
  const wholeTarget = targetText.includes(',')
    ? null
    : resolveXpToken(c.ctx, (t) => t.name.toLowerCase() === targetText.toLowerCase());
  const targetNames = wholeTarget
    ? [targetText]
    : targetText.includes(',')
      ? targetText
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      : parts.slice(0, -1);
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
      '!xp: usage `!xp <target1> [target2 …] <amount>` (comma-separate names containing spaces) | `!xp report` | `!xp threshold`'
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

// ────── !wildshape <beast name> ──────────────────────────────
/**
 * Druid Wild Shape — server-authoritative. The old implementation kept
 * a process-local pool keyed by characterId and trusted the client for
 * the beast's HP/AC/speed; both are gone. Form statistics come only
 * from trusted `compendium_monsters` rows (server-cached SRD/Open5e
 * data — session-created `custom_monsters` are deliberately excluded
 * because players can author those), and the active form persists in
 * `characters.wild_shape` guarded by `characters.version`, so
 * restarts, reconnects, and multiple instances all agree.
 *
 *   !wildshape <beast name>   transform (stats looked up server-side)
 *   !revert                   voluntarily end the form
 *   !beast dmg|heal|status    bookkeeping against the persisted form
 *
 * 2014 rules enforced:
 *   - Owned current-map Druid token, Druid level 2+, 2 uses per short
 *     rest (level 20 Archdruid: unlimited).
 *   - CR gate: L2 max CR 1/4, L4 max 1/2, L8 max 1. Circle of the
 *     Moon: CR 1 at L2, floor(level/3) from L6.
 *   - Movement gate (both circles — Moon's Circle Forms lifts only
 *     the CR column): no swim speed before L4, no fly speed before L8.
 *   - In combat: only on the druid's turn; costs the action (bonus
 *     action with Combat Wild Shape). Reverting costs a bonus action.
 *   - Excess damage past the form's HP carries into the druid and
 *     ends the form atomically (one guarded UPDATE).
 *
 * Privacy: exact form HP and remaining uses travel only via whispers
 * to the caller and the dispatcher's stat-scoped `character:updated`
 * wrapper (DM + owner tabs). Public lines carry the form name/CR and
 * typed amounts, never pool totals.
 */

const WILD_SHAPE_USES = 2;
const ARCHDRUID_LEVEL = 20;
const MAX_BEAST_DMG = 999;

interface Feature {
  name?: unknown;
  usesTotal?: unknown;
  usesRemaining?: unknown;
  resetOn?: unknown;
  [key: string]: unknown;
}

/** Owned token with a character sheet on the caller's current viewing
 *  map — never an off-map or invisible token. */
function resolveWildShapeCaller(ctx: PlayerContext): Token | null {
  return resolveXpToken(ctx, (t) => t.ownerUserId === ctx.player.userId && Boolean(t.characterId));
}

function parseFeatureList(value: unknown): Feature[] | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return null;
    return parsed.every((entry) => entry !== null && typeof entry === 'object')
      ? (parsed as Feature[])
      : null;
  } catch {
    return null;
  }
}

/** Druid level from the class string: "Druid" alone = total level,
 *  "Druid 5/Fighter 2" = 5. Unparseable multiclass fails closed. */
function druidLevel(className: string, totalLevel: number): number | null {
  const match = className.match(/(?:^|\/)\s*druid(?:\s*\([^)]*\))?\s+(\d+)/i);
  if (match) return parseInt(match[1], 10);
  if (/^\s*druid(?:\s*\([^)]*\))?\s*$/i.test(className)) return totalLevel;
  return null;
}

function isMoonDruid(className: string, features: Feature[]): boolean {
  if (/moon/i.test(className)) return true;
  return features.some((feature) =>
    /combat\s+wild\s+shape|circle\s+of\s+the\s+moon/i.test(String(feature?.name ?? ''))
  );
}

function wildShapeCrCap(level: number, moon: boolean): number {
  if (moon) return level >= 6 ? Math.floor(level / 3) : 1;
  if (level >= 8) return 1;
  if (level >= 4) return 0.5;
  return 0.25;
}

function formatCr(cr: number): string {
  if (cr === 0.125) return '1/8';
  if (cr === 0.25) return '1/4';
  if (cr === 0.5) return '1/2';
  return String(cr);
}

/** Uses pool from the Wild Shape feature entry. The 2014 feature is
 *  always exactly two uses — imported metadata can't raise the cap. */
function wildShapeUses(features: Feature[]): { index: number; remaining: number } {
  const index = features.findIndex((feature) =>
    /^wild\s*shape$/i.test(String(feature?.name ?? '').trim())
  );
  if (index < 0) return { index, remaining: WILD_SHAPE_USES };
  const raw = Number(features[index].usesRemaining);
  const remaining = Number.isFinite(raw)
    ? Math.max(0, Math.min(WILD_SHAPE_USES, Math.floor(raw)))
    : WILD_SHAPE_USES;
  return { index, remaining };
}

/** Spend one use; seeds the feature (resetOn short so RestService
 *  restores it) when the sheet doesn't carry it yet. */
function spendWildShapeUse(features: Feature[], index: number, remaining: number): Feature[] {
  const nextRemaining = remaining - 1;
  if (index < 0) {
    return [
      ...features,
      {
        name: 'Wild Shape',
        description: 'Magically assume the shape of a beast you have seen before.',
        source: 'Druid',
        sourceType: 'class',
        usesTotal: WILD_SHAPE_USES,
        usesRemaining: nextRemaining,
        resetOn: 'short',
      },
    ];
  }
  return features.map((feature, i) =>
    i === index
      ? {
          ...feature,
          usesTotal: WILD_SHAPE_USES,
          usesRemaining: nextRemaining,
          resetOn: 'short',
        }
      : feature
  );
}

interface TrustedBeast {
  slug: string;
  name: string;
  hp: number;
  ac: number | null;
  speed: Record<string, number>;
  cr: number;
}

/**
 * Trusted-source lookup: only server-cached `compendium_monsters`
 * rows, and only rows whose type is exactly Beast. Every numeric
 * field is bounds-checked — a cache row that fails validation is
 * treated as not found rather than partially trusted.
 */
async function lookupTrustedBeast(input: string): Promise<TrustedBeast | 'not-beast' | null> {
  const lower = input.toLowerCase();
  const slug = lower.replace(/\s+/g, '-');
  const { rows } = await pool.query(
    `SELECT slug, name, type, armor_class, hit_points, speed, cr_numeric
       FROM compendium_monsters
      WHERE slug = $1 OR LOWER(name) = $2
      ORDER BY CASE WHEN slug = $1 THEN 0 ELSE 1 END, slug
      LIMIT 1`,
    [slug, lower]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  if (
    String(row.type ?? '')
      .trim()
      .toLowerCase() !== 'beast'
  )
    return 'not-beast';
  const hp = Number(row.hit_points);
  const cr = Number(row.cr_numeric);
  if (!Number.isInteger(hp) || hp < 1 || hp > 999) return null;
  if (!Number.isFinite(cr) || cr < 0 || cr > 30) return null;
  const acRaw = row.armor_class;
  const ac =
    acRaw === null || acRaw === undefined
      ? null
      : Number.isInteger(Number(acRaw)) && Number(acRaw) >= 1 && Number(acRaw) <= 30
        ? Number(acRaw)
        : null;
  const speed: Record<string, number> = {};
  try {
    const parsed = typeof row.speed === 'string' ? JSON.parse(row.speed) : (row.speed ?? {});
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const feet = Number(value);
        if (Number.isInteger(feet) && feet >= 0 && feet <= 500) speed[key] = feet;
      }
    }
  } catch {
    /* unreadable speed = no movement claims; gates below stay safe */
  }
  return {
    slug: String(row.slug),
    name: String(row.name || input),
    hp,
    ac,
    speed,
    cr,
  };
}

function describeSpeed(speed: Record<string, number>): string {
  const parts = Object.entries(speed)
    .filter(([, feet]) => feet > 0)
    .map(([kind, feet]) => `${kind} ${feet} ft`);
  return parts.length > 0 ? parts.join(', ') : 'walk —';
}

interface DruidRow {
  row: Record<string, unknown>;
  name: string;
  version: number;
}

async function loadDruidRow(characterId: string): Promise<DruidRow | null> {
  // The full row: Wild Shape checks need only a handful of columns,
  // but the post-commit combat stat sync derives the baseline AC/speed
  // (armor, inventory, ability scores…) from THIS same version-guarded
  // row, so the whole sheet rides along.
  const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const version = asAuthoritativeVersion(row.version);
  if (version === null) return null;
  return { row, name: String(row.name || 'Druid'), version };
}

type GuardedWrite =
  | { ok: true; version: number }
  | { ok: false; reason: 'error' | 'conflict' | 'version' };

/**
 * The single write path for every Wild Shape mutation: one UPDATE,
 * optimistically guarded on the version selected in the same command,
 * so form HP, the uses pool, and any carried-over druid HP commit
 * atomically or not at all.
 */
async function commitWildShape(
  characterId: string,
  expectedVersion: number,
  sets: { wildShape: WildShapeState | null; features?: Feature[]; hitPoints?: number }
): Promise<GuardedWrite> {
  const clauses = ['wild_shape = $1'];
  const params: unknown[] = [serializeWildShapeState(sets.wildShape)];
  let idx = 2;
  if (sets.features !== undefined) {
    clauses.push(`features = $${idx++}`);
    params.push(JSON.stringify(sets.features));
  }
  if (sets.hitPoints !== undefined) {
    clauses.push(`hit_points = $${idx++}`);
    params.push(sets.hitPoints);
  }
  params.push(characterId, expectedVersion);
  let rows: unknown[];
  try {
    ({ rows } = await pool.query(
      `UPDATE characters SET ${clauses.join(', ')} WHERE id = $${idx} AND version = $${idx + 1} RETURNING version`,
      params
    ));
  } catch (error) {
    console.warn('[!wildshape] guarded write failed:', error);
    return { ok: false, reason: 'error' };
  }
  if (rows.length === 0) return { ok: false, reason: 'conflict' };
  const version = asAuthoritativeVersion((rows[0] as Record<string, unknown>).version);
  if (version === null) return { ok: false, reason: 'version' };
  return { ok: true, version };
}

function whisperGuardFailure(
  c: ChatCommandContext,
  command: string,
  reason: 'error' | 'conflict' | 'version'
): void {
  if (reason === 'version') {
    whisperToCaller(
      c.io,
      c.ctx,
      `${command}: the change was saved but synchronization failed — refresh the character sheet before retrying.`
    );
    return;
  }
  whisperToCaller(
    c.io,
    c.ctx,
    `${command}: nothing was changed — ${
      reason === 'conflict' ? 'the character sheet changed while processing' : 'the save failed'
    }. Refresh and try again.`
  );
}

/**
 * Combat gate: when combat is live and the caller's token is a
 * combatant, Wild Shape actions are legal only on their own turn and
 * cost the appropriate action. Returns the economy to mark AFTER the
 * DB write commits, or an error string. Out of combat (or a token
 * that isn't fighting) passes freely.
 */
function wildShapeCombatGate(
  c: ChatCommandContext,
  tokenId: string,
  cost: 'action' | 'bonusAction'
): { economy: ActionEconomy | null } | { error: string } {
  const combatState = c.ctx.room.combatState;
  if (!combatState?.active) return { economy: null };
  const combatant = combatState.combatants.find((entry) => entry.tokenId === tokenId);
  if (!combatant) return { economy: null };
  const current = combatState.combatants[combatState.currentTurnIndex];
  if (current?.tokenId !== tokenId) {
    return { error: 'only on your own turn while in combat.' };
  }
  const economy = c.ctx.room.actionEconomies.get(tokenId);
  if (!economy) {
    return { error: 'combat action state is unavailable — nothing was spent; refresh and retry.' };
  }
  if (cost === 'action' && economy.action) {
    return { error: 'your action is already spent this turn.' };
  }
  if (cost === 'bonusAction' && economy.bonusAction) {
    return { error: 'your bonus action is already spent this turn.' };
  }
  return { economy };
}

/**
 * After a committed transform/revert/form-drop, re-point the live
 * combatant at the authoritative post-write AC/speed and fan the
 * tracker out through the redacting combat:state-sync — bystanders
 * without stat access still receive zeroed AC/speed. `effective` is
 * computed from the same validated row the guarded write was checked
 * against (plus the validated form for a transform), so the stat
 * transition is deterministic — no follow-up read can fail and leave
 * the combatant stranded on the old numbers. No-op out of combat or
 * for non-combatants.
 */
function syncCombatFormStats(
  c: ChatCommandContext,
  characterId: string,
  effective: { ac: number; speed: number }
): void {
  const changed = CombatService.syncWildShapeCombatStats(
    c.ctx.room.sessionId,
    characterId,
    effective
  );
  if (changed) emitCombatStateSync(c.io, c.ctx.room);
}

function markEconomy(
  c: ChatCommandContext,
  tokenId: string,
  economy: ActionEconomy | null,
  cost: 'action' | 'bonusAction'
): void {
  if (!economy) return;
  if (cost === 'action') economy.action = true;
  else economy.bonusAction = true;
  c.io.to(c.ctx.room.sessionId).emit('combat:action-used', {
    tokenId,
    actionType: cost,
    economy,
  });
}

async function handleWildShape(c: ChatCommandContext): Promise<boolean> {
  const input = c.rest.trim();
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: usage `!wildshape <beast name>` — form statistics come from the compendium.'
    );
    return true;
  }
  // The old syntax let the caller declare HP/AC/speed. Those numbers
  // are no longer accepted from the client, full stop.
  if (parts.some((part) => /^\d+$/.test(part))) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: form statistics are no longer typed in — usage `!wildshape <beast name>` and the server looks the beast up in the compendium.'
    );
    return true;
  }
  const caller = resolveWildShapeCaller(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: no owned token with a character sheet on your current map.'
    );
    return true;
  }
  const loaded = await loadDruidRow(caller.characterId);
  if (!loaded) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: could not verify the character state. Nothing was changed.'
    );
    return true;
  }
  const { row, name: druidName, version } = loaded;
  const className = String(row.class || '');
  if (!className.toLowerCase().includes('druid')) {
    whisperToCaller(c.io, c.ctx, `!wildshape: ${druidName} isn't a Druid.`);
    return true;
  }
  const level = druidLevel(className, Number(row.level) || 1);
  if (level === null) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: could not determine the Druid class level from the sheet (use e.g. "Druid 5/Fighter 2" for multiclass).'
    );
    return true;
  }
  if (level < 2) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!wildshape: Wild Shape requires Druid level 2 (${druidName} is Druid level ${level}).`
    );
    return true;
  }
  const hp = Number(row.hit_points);
  if (!Number.isFinite(hp) || hp <= 0) {
    whisperToCaller(c.io, c.ctx, `!wildshape: ${druidName} is at 0 HP and cannot use Wild Shape.`);
    return true;
  }
  const column = readWildShapeColumn(row.wild_shape);
  if (column.status === 'active') {
    whisperToCaller(
      c.io,
      c.ctx,
      `!wildshape: already transformed into ${column.state.formName} — \`!revert\` first.`
    );
    return true;
  }
  if (column.status === 'invalid') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: the stored Wild Shape state is unreadable — run `!revert` to clear it first.'
    );
    return true;
  }
  const features = parseFeatureList(row.features);
  if (!features) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: the character feature data is invalid — nothing was spent. Refresh or re-sync the sheet.'
    );
    return true;
  }
  const moon = isMoonDruid(className, features);
  const unlimited = level >= ARCHDRUID_LEVEL;
  const uses = wildShapeUses(features);
  if (!unlimited && uses.remaining <= 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!wildshape: no uses remaining — Wild Shape refreshes on a short or long rest.'
    );
    return true;
  }

  const beast = await lookupTrustedBeast(input);
  if (beast === 'not-beast') {
    whisperToCaller(
      c.io,
      c.ctx,
      `!wildshape: "${input}" isn't a beast — Wild Shape only allows beast forms.`
    );
    return true;
  }
  if (!beast) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!wildshape: "${input}" isn't in the trusted compendium cache. Look the beast up in the compendium browser first, then retry.`
    );
    return true;
  }
  const crCap = wildShapeCrCap(level, moon);
  if (beast.cr > crCap) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!wildshape: ${beast.name} is CR ${formatCr(beast.cr)} — your maximum is CR ${formatCr(crCap)}${moon ? ' (Circle of the Moon)' : ''} at Druid level ${level}.`
    );
    return true;
  }
  if ((beast.speed.fly ?? 0) > 0 && level < 8) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!wildshape: ${beast.name} has a flying speed — that requires Druid level 8.`
    );
    return true;
  }
  if ((beast.speed.swim ?? 0) > 0 && level < 4) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!wildshape: ${beast.name} has a swimming speed — that requires Druid level 4.`
    );
    return true;
  }

  // Moon druids transform as a bonus action (Combat Wild Shape);
  // everyone else spends their action.
  const cost: 'action' | 'bonusAction' = moon ? 'bonusAction' : 'action';
  const gate = wildShapeCombatGate(c, caller.id, cost);
  if ('error' in gate) {
    whisperToCaller(c.io, c.ctx, `!wildshape: ${gate.error}`);
    return true;
  }

  const newState: WildShapeState = {
    formSlug: beast.slug,
    formName: beast.name,
    formHp: beast.hp,
    formMaxHp: beast.hp,
    formAc: beast.ac,
    formSpeed: beast.speed,
    formCr: beast.cr,
    moon,
  };
  const updatedFeatures = unlimited
    ? undefined
    : spendWildShapeUse(features, uses.index, uses.remaining);
  const write = await commitWildShape(caller.characterId, version, {
    wildShape: newState,
    ...(updatedFeatures !== undefined ? { features: updatedFeatures } : {}),
  });
  if (!write.ok) {
    whisperGuardFailure(c, '!wildshape', write.reason);
    return true;
  }

  markEconomy(c, caller.id, gate.economy, cost);
  // Transforming mid-fight immediately swaps the combatant to the
  // form's AC and walking speed (movement already spent stays spent).
  syncCombatFormStats(c, caller.characterId, CombatService.computeEffectiveAcSpeed(row, newState));
  // Exact form stats + the uses pool are owner/DM material. The
  // dispatcher's stat-scoped wrapper widens under sharing toggles, so
  // active-form payloads go through the strictly private channel.
  emitWildShapePrivate(c.io, c.ctx.room, caller.characterId, {
    wildShape: newState,
    ...(updatedFeatures !== undefined ? { features: updatedFeatures } : {}),
    version: write.version,
  });
  const remainingText = unlimited
    ? 'unlimited (Archdruid)'
    : `${uses.remaining - 1}/${WILD_SHAPE_USES}`;
  whisperToCaller(
    c.io,
    c.ctx,
    `🐺 ${beast.name}: form HP ${beast.hp}/${beast.hp}${beast.ac !== null ? `, AC ${beast.ac}` : ''}, speed ${describeSpeed(beast.speed)}. Wild Shape uses left: ${remainingText} (short rest).`
  );
  broadcastSystem(
    c.io,
    c.ctx,
    `🐺 ${druidName} Wild Shapes into a **${beast.name}** (CR ${formatCr(beast.cr)})${gate.economy ? ` — ${cost === 'bonusAction' ? 'bonus action' : 'action'} spent` : ''}. Revert with \`!revert\`.`
  );
  return true;
}

async function handleRevert(c: ChatCommandContext): Promise<boolean> {
  const caller = resolveWildShapeCaller(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!revert: no owned token with a character sheet on your current map.'
    );
    return true;
  }
  const loaded = await loadDruidRow(caller.characterId);
  if (!loaded) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!revert: could not verify the character state. Nothing was changed.'
    );
    return true;
  }
  const column = readWildShapeColumn(loaded.row.wild_shape);
  if (column.status === 'none') {
    whisperToCaller(c.io, c.ctx, '!revert: not currently wild-shaped.');
    return true;
  }

  // A readable active form follows the rules: reverting in combat is a
  // bonus action on your own turn. Clearing an unreadable state is the
  // recovery path and skips the gate — it can't be replayed for value.
  let economy: ActionEconomy | null = null;
  if (column.status === 'active') {
    const gate = wildShapeCombatGate(c, caller.id, 'bonusAction');
    if ('error' in gate) {
      whisperToCaller(c.io, c.ctx, `!revert: ${gate.error}`);
      return true;
    }
    economy = gate.economy;
  }

  const write = await commitWildShape(caller.characterId, loaded.version, { wildShape: null });
  if (!write.ok) {
    whisperGuardFailure(c, '!revert', write.reason);
    return true;
  }
  if (column.status === 'active') markEconomy(c, caller.id, economy, 'bonusAction');
  // Reverting (including clearing an unreadable state) restores the
  // character's own AC/speed on the live combatant immediately.
  syncCombatFormStats(
    c,
    caller.characterId,
    CombatService.computeEffectiveAcSpeed(loaded.row, null)
  );
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { wildShape: null, version: write.version },
  });
  if (column.status === 'invalid') {
    whisperToCaller(c.io, c.ctx, '!revert: cleared an unreadable Wild Shape state.');
    return true;
  }
  broadcastSystem(
    c.io,
    c.ctx,
    `🐺 ${loaded.name} reverts from **${column.state.formName}** to their normal form.${economy ? ' (bonus action)' : ''}`
  );
  return true;
}

// ────── !beast dmg|heal|status ─────────────────────────────
/**
 * Bookkeeping against the persisted form. `dmg` is bounded and
 * authoritative: damage past the form's remaining HP carries into the
 * druid's own HP and ends the form in the same guarded UPDATE. Temp
 * HP is not consumed here — the in-combat pipeline (CombatService
 * damage, which is Wild-Shape-aware) owns that interaction.
 */
async function handleBeast(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase() || 'status';
  const caller = resolveWildShapeCaller(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!beast: no owned token with a character sheet on your current map.'
    );
    return true;
  }
  const loaded = await loadDruidRow(caller.characterId);
  if (!loaded) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!beast: could not verify the character state. Nothing was changed.'
    );
    return true;
  }
  const column = readWildShapeColumn(loaded.row.wild_shape);
  if (column.status === 'invalid') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!beast: the stored Wild Shape state is unreadable — run `!revert` to clear it.'
    );
    return true;
  }
  if (column.status === 'none') {
    whisperToCaller(
      c.io,
      c.ctx,
      '!beast: not currently wild-shaped. Use `!wildshape <beast name>` first.'
    );
    return true;
  }
  const state = column.state;

  if (sub === 'status') {
    const features = parseFeatureList(loaded.row.features);
    const level = druidLevel(String(loaded.row.class || ''), Number(loaded.row.level) || 1);
    const usesText =
      level !== null && level >= ARCHDRUID_LEVEL
        ? 'unlimited (Archdruid)'
        : features
          ? `${wildShapeUses(features).remaining}/${WILD_SHAPE_USES}`
          : 'unreadable';
    whisperToCaller(
      c.io,
      c.ctx,
      `🐺 ${state.formName}: form HP ${state.formHp}/${state.formMaxHp}${state.formAc !== null ? `, AC ${state.formAc}` : ''}, speed ${describeSpeed(state.formSpeed)}. Uses left: ${usesText}.`
    );
    return true;
  }

  if (sub !== 'dmg' && sub !== 'damage' && sub !== 'heal') {
    whisperToCaller(c.io, c.ctx, `!beast: unknown subcommand "${sub}". Use status / dmg / heal.`);
    return true;
  }
  const amountRaw = parts[1] ?? '';
  if (!/^\d+$/.test(amountRaw)) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!beast ${sub}: amount must be a whole number from 1 to ${MAX_BEAST_DMG}.`
    );
    return true;
  }
  const amount = Number(amountRaw);
  if (amount < 1 || amount > MAX_BEAST_DMG) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!beast ${sub}: amount must be a whole number from 1 to ${MAX_BEAST_DMG}.`
    );
    return true;
  }

  if (sub === 'heal') {
    const newFormHp = Math.min(state.formMaxHp, state.formHp + amount);
    const nextState: WildShapeState = { ...state, formHp: newFormHp };
    const write = await commitWildShape(caller.characterId, loaded.version, {
      wildShape: nextState,
    });
    if (!write.ok) {
      whisperGuardFailure(c, '!beast heal', write.reason);
      return true;
    }
    emitWildShapePrivate(c.io, c.ctx.room, caller.characterId, {
      wildShape: nextState,
      version: write.version,
    });
    whisperToCaller(c.io, c.ctx, `🐺 ${state.formName}: form HP ${newFormHp}/${state.formMaxHp}.`);
    broadcastSystem(
      c.io,
      c.ctx,
      `🐺 ${loaded.name}'s ${state.formName} form regains ${newFormHp - state.formHp} HP.`
    );
    return true;
  }

  // Damage. Bounded by the persisted form HP; the excess (if any)
  // carries into the druid and ends the form in the same UPDATE.
  if (amount < state.formHp) {
    const nextState: WildShapeState = { ...state, formHp: state.formHp - amount };
    const write = await commitWildShape(caller.characterId, loaded.version, {
      wildShape: nextState,
    });
    if (!write.ok) {
      whisperGuardFailure(c, '!beast dmg', write.reason);
      return true;
    }
    emitWildShapePrivate(c.io, c.ctx.room, caller.characterId, {
      wildShape: nextState,
      version: write.version,
    });
    whisperToCaller(
      c.io,
      c.ctx,
      `🐺 ${state.formName}: form HP ${nextState.formHp}/${state.formMaxHp}.`
    );
    broadcastSystem(
      c.io,
      c.ctx,
      `🐺 ${loaded.name}'s ${state.formName} form takes ${amount} damage.`
    );
    return true;
  }

  const excess = amount - state.formHp;
  const druidHp = Number(loaded.row.hit_points);
  if (!Number.isInteger(druidHp) || druidHp < 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!beast dmg: the stored character HP is unreadable — nothing was changed. Refresh the sheet.'
    );
    return true;
  }
  const newDruidHp = Math.max(0, druidHp - excess);
  const write = await commitWildShape(caller.characterId, loaded.version, {
    wildShape: null,
    hitPoints: newDruidHp,
  });
  if (!write.ok) {
    whisperGuardFailure(c, '!beast dmg', write.reason);
    return true;
  }
  // Keep a live combat tracker in sync with the committed HP.
  const combatant = c.ctx.room.combatState?.active
    ? c.ctx.room.combatState.combatants.find((entry) => entry.characterId === caller.characterId)
    : undefined;
  if (combatant) {
    combatant.hp = newDruidHp;
    CombatService.persistSessionCombatState(c.ctx.room.sessionId);
    // The form dropped from damage — restore the druid's own AC/speed.
    syncCombatFormStats(
      c,
      caller.characterId,
      CombatService.computeEffectiveAcSpeed(loaded.row, null)
    );
    c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
      tokenId: combatant.tokenId,
      hp: newDruidHp,
      tempHp: combatant.tempHp,
      change: newDruidHp - druidHp,
      type: 'damage',
    });
  }
  c.io.to(c.ctx.room.sessionId).emit('character:updated', {
    characterId: caller.characterId,
    changes: { wildShape: null, hitPoints: newDruidHp, version: write.version },
  });
  whisperToCaller(
    c.io,
    c.ctx,
    `🐺 ${state.formName} form drops (${excess} excess damage carried over). ${loaded.name}: ${newDruidHp} HP.${newDruidHp <= 0 ? ' You are at 0 HP.' : ''}`
  );
  broadcastSystem(
    c.io,
    c.ctx,
    `🐺 ${loaded.name}'s ${state.formName} form takes ${amount} damage and drops — ${loaded.name} reverts${excess > 0 ? ' with damage carrying over' : ''}.${newDruidHp <= 0 ? ` ${loaded.name} falls to 0 HP!` : ''}`
  );
  return true;
}

registerChatCommand(['xp', 'experience'], handleXP);
registerChatCommand(['wildshape', 'ws'], handleWildShape);
registerChatCommand('revert', handleRevert);
registerChatCommand('beast', handleBeast);
