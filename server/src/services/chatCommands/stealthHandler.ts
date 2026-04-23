import type { Token, ActionBreakdown } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Stealth check with passive-Perception comparison. Rolls the
 * caller's Stealth, then checks the result against every opposing
 * token's passive Perception (character.senses.passivePerception).
 * DM gets a detailed whisper showing exactly who sees the caller
 * and who doesn't; broadcast shows just the Stealth result.
 *
 *   !stealth              roll the caller's Stealth, compare to all visible enemies
 *   !stealth hide         same, plus auto-apply the `hidden` pseudo-condition
 *                         if ≥ every opposing token's PP
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function loadStealthMod(characterId: string): Promise<{ mod: number; name: string }> {
  const { rows } = await pool.query(
    'SELECT ability_scores, skills, proficiency_bonus, name FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { mod: 0, name: '' };
  try {
    const scores = typeof row.ability_scores === 'string' ? JSON.parse(row.ability_scores) : (row.ability_scores ?? {});
    const dexMod = Math.floor((((scores as Record<string, number>).dex ?? 10) - 10) / 2);
    const prof = Number(row.proficiency_bonus) || 2;
    const skills = typeof row.skills === 'string' ? JSON.parse(row.skills) : (row.skills ?? {});
    const stealthProf = (skills as Record<string, string>)?.stealth ?? 'none';
    const profAdd = stealthProf === 'expertise' ? 2 * prof : stealthProf === 'proficient' ? prof : 0;
    return { mod: dexMod + profAdd, name: (row.name as string) || '' };
  } catch {
    return { mod: 0, name: '' };
  }
}

async function loadPassivePerception(characterId: string): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT senses FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  try {
    const senses = typeof row.senses === 'string' ? JSON.parse(row.senses) : (row.senses ?? {});
    const pp = (senses as { passivePerception?: number })?.passivePerception;
    return typeof pp === 'number' && pp > 0 ? pp : null;
  } catch {
    return null;
  }
}

async function handleStealth(c: ChatCommandContext): Promise<boolean> {
  const arg = c.rest.trim().toLowerCase();
  const autoApply = arg === 'hide' || arg === 'apply';

  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(c.io, c.ctx, '!stealth: no owned PC token on this map.');
    return true;
  }

  const { mod, name } = await loadStealthMod(caller.characterId);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + mod;
  const modSign = mod >= 0 ? '+' : '';
  const displayName = name || caller.name;

  // Compare against every opposing-faction visible token that has a
  // character with passive perception. Two-team model: PCs vs NPCs
  // where PC = ownerUserId non-null.
  const callerIsPC = !!caller.ownerUserId;
  const visibleEnemies: Token[] = [];
  for (const tok of c.ctx.room.tokens.values()) {
    if (tok.id === caller.id) continue;
    if (!tok.visible) continue;
    const tIsPC = !!tok.ownerUserId;
    if (tIsPC === callerIsPC) continue;
    visibleEnemies.push(tok);
  }

  const seenBy: string[] = [];
  const hiddenFrom: string[] = [];
  const stealthTargets: NonNullable<ActionBreakdown['targets']> = [];
  for (const enemy of visibleEnemies) {
    let pp: number | null = null;
    if (enemy.characterId) pp = await loadPassivePerception(enemy.characterId);
    const usedDefault = pp === null;
    if (pp === null) {
      // Unknown PP — conservative: assume 10, the 5e baseline.
      pp = 10;
    }
    const hidden = total > pp;
    if (hidden) hiddenFrom.push(`${enemy.name} (PP ${pp})`);
    else seenBy.push(`${enemy.name} (PP ${pp})`);
    stealthTargets.push({
      name: enemy.name,
      tokenId: enemy.id,
      effect: hidden
        ? `HIDDEN: Stealth ${total} > PP ${pp}${usedDefault ? ' (default)' : ''}`
        : `SEEN: Stealth ${total} ≤ PP ${pp}${usedDefault ? ' (default)' : ''}`,
    });
  }

  const broadcastLines: string[] = [];
  broadcastLines.push(
    `👤 ${displayName} rolls Stealth: d20=${d20}${modSign}${mod}=${total}`,
  );
  const stealthBreakdown: ActionBreakdown = {
    actor: { name: displayName, tokenId: caller.id },
    action: {
      name: `Stealth (d20=${d20}+${mod}=${total})`,
      category: 'other',
      icon: '👤',
      cost: arg === 'hide' ? 'Action (Hide)' : 'Check',
    },
    effect: visibleEnemies.length === 0
      ? `Rolled Stealth ${total} — no opposing tokens in sight.`
      : `Stealth ${total} vs passive Perception: hidden from ${hiddenFrom.length}, seen by ${seenBy.length}.`,
    ...(stealthTargets.length > 0 ? { targets: stealthTargets } : {}),
    notes: [
      `Roller: ${displayName}`,
      `Stealth roll: d20=${d20} ${modSign}${mod} = ${total}`,
      `Compared against each visible enemy's passive Perception`,
      ...(autoApply ? ['Requested `hide` auto-apply'] : []),
    ],
  };
  broadcastSystem(c.io, c.ctx, broadcastLines.join('\n'), { actionResult: stealthBreakdown });

  // Whisper the detailed per-enemy comparison to the DM + caller —
  // this is DM-only info normally; the caller seeing their own
  // result is fine.
  const detailLines: string[] = [];
  detailLines.push(`Stealth ${total} vs passive Perception:`);
  if (hiddenFrom.length > 0) detailLines.push(`  ✓ Hidden from: ${hiddenFrom.join(', ')}`);
  if (seenBy.length > 0) detailLines.push(`  ✗ Seen by: ${seenBy.join(', ')}`);
  if (hiddenFrom.length === 0 && seenBy.length === 0) {
    detailLines.push('  (no opposing tokens in sight range)');
  }
  whisperToCaller(c.io, c.ctx, detailLines.join('\n'));

  if (autoApply) {
    if (seenBy.length > 0) {
      whisperToCaller(
        c.io, c.ctx,
        `!stealth hide: not auto-applying — ${seenBy.length} enemy(ies) still see you.`,
      );
    } else if (hiddenFrom.length === 0) {
      whisperToCaller(c.io, c.ctx, '!stealth hide: no enemies to hide from.');
    } else {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, caller.id, {
        name: 'hidden',
        source: `${displayName} (!stealth hide)`,
        appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: caller.id,
        changes: tokenConditionChanges(c.ctx.room, caller.id),
      });
      broadcastSystem(c.io, c.ctx, `👤 ${displayName} slips into hiding.`);
    }
  }

  return true;
}

registerChatCommand(['stealth', 'hide'], handleStealth);
