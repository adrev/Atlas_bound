import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Two kinda-orthogonal helpers bundled here:
 *
 *   XP — DMs award XP, characters level up when thresholds crossed.
 *     !xp <target1> [target2 …] <amount>
 *     !xp report                          — whispered party XP / levels
 *     !xp threshold                       — show thresholds + next level
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
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

/**
 * In-memory XP tracker keyed by characterId. The `characters` table
 * doesn't currently have an `experience` column; rather than migrate
 * the schema we keep XP here for this session. Survives across
 * combats but not across server restarts — DMs running a multi-
 * session campaign should note the total between sessions.
 */
const characterXp = new Map<string, number>();

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
    (t) => t.name.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

// ────── !xp ──────────────────────────────────────────────────
async function handleXP(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!xp: usage `!xp <target1> [target2 …] <amount>` | `!xp report` | `!xp threshold`');
    return true;
  }
  const isDM = c.ctx.player.role === 'dm';

  if (parts[0].toLowerCase() === 'threshold') {
    const caller = resolveCallerToken(c.ctx);
    if (!caller?.characterId) {
      whisperToCaller(c.io, c.ctx, '!xp threshold: no owned PC token.');
      return true;
    }
    const { rows } = await pool.query('SELECT level, name FROM characters WHERE id = $1', [caller.characterId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    const level = Number(row?.level) || 1;
    const xp = characterXp.get(caller.characterId) ?? 0;
    const name = (row?.name as string) || caller.name;
    const nextLevel = XP_THRESHOLDS[level] ?? XP_THRESHOLDS[XP_THRESHOLDS.length - 1];
    const toNext = Math.max(0, nextLevel - xp);
    whisperToCaller(
      c.io, c.ctx,
      `⭐ ${name} — Level ${level}, ${xp} XP. ${toNext} XP to level ${level + 1} (threshold ${nextLevel}).`,
    );
    return true;
  }

  if (parts[0].toLowerCase() === 'report') {
    // Show every PC token's XP + level. DM-sees-all.
    const pcs = Array.from(c.ctx.room.tokens.values()).filter(
      (t) => t.characterId && t.ownerUserId,
    );
    const lines: string[] = ['⭐ Party XP report:'];
    for (const pc of pcs) {
      const { rows } = await pool.query('SELECT level, name FROM characters WHERE id = $1', [pc.characterId]);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) continue;
      const level = Number(row.level) || 1;
      const xp = characterXp.get(pc.characterId!) ?? 0;
      const next = XP_THRESHOLDS[level] ?? XP_THRESHOLDS[XP_THRESHOLDS.length - 1];
      lines.push(`  • ${row.name}: L${level}, ${xp} XP (${Math.max(0, next - xp)} to L${level + 1})`);
    }
    whisperToCaller(c.io, c.ctx, lines.join('\n'));
    return true;
  }

  if (!isDM) {
    whisperToCaller(c.io, c.ctx, '!xp: DM only (award XP). Players can run `!xp threshold` for status.');
    return true;
  }

  // Otherwise: !xp <target1> [target2 …] <amount>
  const amount = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999) {
    whisperToCaller(c.io, c.ctx, '!xp: amount must be a non-negative integer.');
    return true;
  }
  const targetNames = parts.slice(0, -1);
  if (targetNames.length === 0) {
    whisperToCaller(c.io, c.ctx, '!xp: at least one target name required.');
    return true;
  }

  const lines: string[] = [];
  lines.push(`⭐ ${c.ctx.player.displayName} awards ${amount} XP to ${targetNames.length} character${targetNames.length === 1 ? '' : 's'}:`);
  for (const name of targetNames) {
    const target = resolveTargetByName(c.ctx, name);
    if (!target?.characterId) { lines.push(`  • ${name}: not found`); continue; }
    const { rows } = await pool.query('SELECT level, name FROM characters WHERE id = $1', [target.characterId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) { lines.push(`  • ${name}: character missing`); continue; }
    const oldLevel = Number(row.level) || 1;
    const oldXp = characterXp.get(target.characterId) ?? 0;
    const newXp = oldXp + amount;
    // Compute new level.
    let newLevel = oldLevel;
    for (let i = oldLevel; i < XP_THRESHOLDS.length; i++) {
      if (newXp >= XP_THRESHOLDS[i]) newLevel = i + 1;
    }
    const levelUp = newLevel > oldLevel;
    characterXp.set(target.characterId, newXp);
    if (levelUp) {
      // Persist the level bump — the characters table has a `level`
      // column — but leave XP in-memory since there's no column.
      await pool.query(
        'UPDATE characters SET level = $1 WHERE id = $2',
        [newLevel, target.characterId],
      ).catch((e) => console.warn('[!xp] level write failed:', e));
      c.io.to(c.ctx.room.sessionId).emit('character:updated', {
        characterId: target.characterId,
        changes: { level: newLevel },
      });
    }
    lines.push(`  • ${row.name}: ${oldXp} → ${newXp} XP${levelUp ? ` 🎉 LEVEL UP! L${oldLevel} → L${newLevel}` : ''}`);
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
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
const wildShapePools = new Map<string, {
  beastName: string;
  beastHp: number;
  beastMax: number;
  beastAc: number | null;
  beastSpeed: number | null;
}>();

async function handleWildShape(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    whisperToCaller(
      c.io, c.ctx,
      '!wildshape: usage `!wildshape <beast-name> <hp> [ac] [speed]`',
    );
    return true;
  }
  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!wildshape: no owned PC token.');
    return true;
  }
  const { rows } = await pool.query(
    'SELECT class, level, name FROM characters WHERE id = $1',
    [caller.characterId],
  );
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
    c.io, c.ctx,
    `🐺 ${druidName} Wild Shapes into a **${beastName}** — HP ${beastHp}/${beastHp}${extras.length > 0 ? `, ${extras.join(', ')}` : ''}. Revert with !revert (Druid's own HP unchanged).`,
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
    c.io, c.ctx,
    `🐺 ${caller.name} reverts from ${pool.beastName} back to Druid form.${pool.beastHp <= 0 ? ' (beast form dropped to 0 HP.)' : ''}`,
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
      c.io, c.ctx,
      `🐺 ${bp.beastName} takes ${amount} damage → ${bp.beastHp}/${bp.beastMax}${bp.beastHp <= 0 ? ' — BEAST DROPS, Druid reverts on excess.' : ''}`,
    );
    if (bp.beastHp <= 0) {
      wildShapePools.delete(caller.characterId);
    }
    return true;
  }
  if (sub === 'heal') {
    bp.beastHp = Math.min(bp.beastMax, bp.beastHp + amount);
    broadcastSystem(c.io, c.ctx, `🐺 ${bp.beastName} heals ${amount} → ${bp.beastHp}/${bp.beastMax}.`);
    return true;
  }
  whisperToCaller(c.io, c.ctx, `!beast: unknown subcommand "${sub}". Use status / dmg / heal.`);
  return true;
}

registerChatCommand(['xp', 'experience'], handleXP);
registerChatCommand(['wildshape', 'ws'], handleWildShape);
registerChatCommand('revert', handleRevert);
registerChatCommand('beast', handleBeast);
