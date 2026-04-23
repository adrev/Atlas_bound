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
 * Opposed-check combat maneuvers: grapple + shove. Both resolve a
 * caller's Athletics vs the target's choice of Athletics or
 * Acrobatics. Skill proficiencies + ability mods pull straight from
 * the characters table. Monsters (no characterId) fall back to a
 * flat +0 modifier — the DM can re-roll if their stat block says
 * otherwise.
 */

interface SkillRoll {
  roll: number;
  mod: number;
  total: number;
  skill: 'athletics' | 'acrobatics';
  name: string;
}

async function resolveSkillMod(
  token: Token,
  skill: 'athletics' | 'acrobatics',
): Promise<{ mod: number; name: string }> {
  if (!token.characterId) {
    return { mod: 0, name: token.name };
  }
  const { rows } = await pool.query(
    'SELECT ability_scores, skills, proficiency_bonus, name FROM characters WHERE id = $1',
    [token.characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { mod: 0, name: token.name };
  try {
    const scores = typeof row.ability_scores === 'string'
      ? JSON.parse(row.ability_scores) : (row.ability_scores ?? {});
    const skills = typeof row.skills === 'string'
      ? JSON.parse(row.skills) : (row.skills ?? {});
    const abilityKey = skill === 'athletics' ? 'str' : 'dex';
    const abilityScore = (scores as Record<string, number>)[abilityKey] ?? 10;
    const mod = Math.floor((abilityScore - 10) / 2);
    const prof = ((skills as Record<string, string>)[skill] ?? 'none') as 'none' | 'proficient' | 'expertise';
    const profBonus = (row.proficiency_bonus as number) ?? 2;
    const profAdd = prof === 'expertise' ? 2 * profBonus : prof === 'proficient' ? profBonus : 0;
    return { mod: mod + profAdd, name: (row.name as string) || token.name };
  } catch {
    return { mod: 0, name: token.name };
  }
}

function rollSkill(mod: number): { roll: number; total: number } {
  const roll = Math.floor(Math.random() * 20) + 1;
  return { roll, total: roll + mod };
}

function resolveTargetOrSelf(
  ctx: PlayerContext,
  name: string,
): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  if (!name) {
    const own = all
      .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return own[0] ?? null;
  }
  const needle = name.toLowerCase();
  const matches = all.filter((t) => t.name.toLowerCase() === needle);
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

async function handleGrapple(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!grapple: usage `!grapple <target>`');
    return true;
  }
  const targetName = parts.join(' ');

  // Caller: DM's selected token OR caller's own PC token.
  const caller = resolveTargetOrSelf(c.ctx, '');
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!grapple: no owned token on this map — cannot initiate grapple.');
    return true;
  }
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target || target.id === caller.id) {
    whisperToCaller(c.io, c.ctx, `!grapple: no target named "${targetName}" (or target is you).`);
    return true;
  }

  const callerAth = await resolveSkillMod(caller, 'athletics');
  const targetAth = await resolveSkillMod(target, 'athletics');
  const targetAcr = await resolveSkillMod(target, 'acrobatics');

  const callerRoll = rollSkill(callerAth.mod);
  // Target picks whichever is higher — simulates RAW "target's
  // choice" by auto-selecting the better outcome.
  const tAth = rollSkill(targetAth.mod);
  const tAcr = rollSkill(targetAcr.mod);
  const targetBest: SkillRoll = tAth.total >= tAcr.total
    ? { roll: tAth.roll, mod: targetAth.mod, total: tAth.total, skill: 'athletics', name: targetAth.name }
    : { roll: tAcr.roll, mod: targetAcr.mod, total: tAcr.total, skill: 'acrobatics', name: targetAcr.name };

  const callerWon = callerRoll.total >= targetBest.total;
  const callerModStr = callerAth.mod >= 0 ? `+${callerAth.mod}` : `${callerAth.mod}`;
  const tModStr = targetBest.mod >= 0 ? `+${targetBest.mod}` : `${targetBest.mod}`;

  const lines: string[] = [];
  lines.push(`🤼 ${callerAth.name} grapples ${targetBest.name}`);
  lines.push(`   ${callerAth.name} Athletics: d20=${callerRoll.roll}${callerModStr}=${callerRoll.total}`);
  lines.push(`   ${targetBest.name} ${targetBest.skill}: d20=${targetBest.roll}${tModStr}=${targetBest.total}`);
  lines.push(`   → ${callerWon ? `${callerAth.name} succeeds — ${targetBest.name} is GRAPPLED` : `${targetBest.name} resists`}`);

  if (callerWon) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'grappled',
      source: `${callerAth.name} (!grapple)`,
      appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
      // Stamp the grappler's tokenId so ConditionService can
      // auto-release the grapple when the grappler gets incapacitated.
      casterTokenId: caller.id,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  }

  const grappleCard: ActionBreakdown = {
    actor: { name: callerAth.name, tokenId: caller.id },
    action: { name: 'Grapple', category: 'other', icon: '\uD83E\uDD3C' },
    effect: `${callerAth.name} Athletics d20=${callerRoll.roll}${callerModStr}=${callerRoll.total} vs ${targetBest.name} ${targetBest.skill} d20=${targetBest.roll}${tModStr}=${targetBest.total} — ${callerWon ? 'SUCCESS' : 'RESISTED'}`,
    targets: [{
      name: targetBest.name,
      tokenId: target.id,
      effect: callerWon ? 'grappled' : 'resisted',
      conditionsApplied: callerWon ? ['grappled'] : undefined,
    }],
    notes: [
      `Attacker: STR (Athletics) +${callerAth.mod}`,
      `Defender: max of Athletics/Acrobatics (chose ${targetBest.skill} +${targetBest.mod})`,
    ],
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { actionResult: grappleCard });
  return true;
}

async function handleShove(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(c.io, c.ctx, '!shove: usage `!shove <target> [prone|push]`');
    return true;
  }
  // Parse mode from the END if it's prone/push
  let mode: 'prone' | 'push' = 'prone';
  if (parts.length > 1 && /^(prone|push)$/i.test(parts[parts.length - 1])) {
    mode = parts.pop()!.toLowerCase() as 'prone' | 'push';
  }
  const targetName = parts.join(' ');

  const caller = resolveTargetOrSelf(c.ctx, '');
  if (!caller) {
    whisperToCaller(c.io, c.ctx, '!shove: no owned token on this map — cannot initiate shove.');
    return true;
  }
  const target = resolveTargetOrSelf(c.ctx, targetName);
  if (!target || target.id === caller.id) {
    whisperToCaller(c.io, c.ctx, `!shove: no target named "${targetName}" (or target is you).`);
    return true;
  }

  const callerAth = await resolveSkillMod(caller, 'athletics');
  const targetAth = await resolveSkillMod(target, 'athletics');
  const targetAcr = await resolveSkillMod(target, 'acrobatics');

  const callerRoll = rollSkill(callerAth.mod);
  const tAth = rollSkill(targetAth.mod);
  const tAcr = rollSkill(targetAcr.mod);
  const targetBest: SkillRoll = tAth.total >= tAcr.total
    ? { roll: tAth.roll, mod: targetAth.mod, total: tAth.total, skill: 'athletics', name: targetAth.name }
    : { roll: tAcr.roll, mod: targetAcr.mod, total: tAcr.total, skill: 'acrobatics', name: targetAcr.name };

  const callerWon = callerRoll.total >= targetBest.total;
  const callerModStr = callerAth.mod >= 0 ? `+${callerAth.mod}` : `${callerAth.mod}`;
  const tModStr = targetBest.mod >= 0 ? `+${targetBest.mod}` : `${targetBest.mod}`;

  const lines: string[] = [];
  lines.push(`🛡 ${callerAth.name} shoves ${targetBest.name}${mode === 'prone' ? ' (knock prone)' : ' (push 5 ft)'}`);
  lines.push(`   ${callerAth.name} Athletics: d20=${callerRoll.roll}${callerModStr}=${callerRoll.total}`);
  lines.push(`   ${targetBest.name} ${targetBest.skill}: d20=${targetBest.roll}${tModStr}=${targetBest.total}`);

  if (callerWon && mode === 'prone') {
    lines.push(`   → ${callerAth.name} succeeds — ${targetBest.name} is PRONE`);
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: 'prone',
      source: `${callerAth.name} (!shove)`,
      appliedRound: c.ctx.room.combatState?.roundNumber ?? 0,
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
  } else if (callerWon) {
    lines.push(`   → ${callerAth.name} succeeds — DM, move ${targetBest.name} 5 ft away.`);
  } else {
    lines.push(`   → ${targetBest.name} resists`);
  }

  const shoveCard: ActionBreakdown = {
    actor: { name: callerAth.name, tokenId: caller.id },
    action: {
      name: mode === 'prone' ? 'Shove (knock prone)' : 'Shove (push 5 ft)',
      category: 'other',
      icon: '\uD83D\uDEE1',
    },
    effect: `${callerAth.name} Athletics d20=${callerRoll.roll}${callerModStr}=${callerRoll.total} vs ${targetBest.name} ${targetBest.skill} d20=${targetBest.roll}${tModStr}=${targetBest.total} — ${callerWon ? 'SUCCESS' : 'RESISTED'}`,
    targets: [{
      name: targetBest.name,
      tokenId: target.id,
      effect: callerWon
        ? (mode === 'prone' ? 'knocked prone' : 'pushed 5 ft')
        : 'resisted',
      conditionsApplied: callerWon && mode === 'prone' ? ['prone'] : undefined,
    }],
    notes: [
      `Attacker: STR (Athletics) +${callerAth.mod}`,
      `Defender: max of Athletics/Acrobatics (chose ${targetBest.skill} +${targetBest.mod})`,
    ],
  };
  broadcastSystem(c.io, c.ctx, lines.join('\n'), { actionResult: shoveCard });
  return true;
}

registerChatCommand('grapple', handleGrapple);
registerChatCommand('shove', handleShove);
