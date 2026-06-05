import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import pool from '../../db/connection.js';
import type { PlayerContext } from '../../utils/roomState.js';
import type { Token, Skills } from '@dnd-vtt/shared';
import {
  parseCheckTarget,
  computeCheckModifier,
  resolveCheckAdvantage,
  rollCheck,
  isReliableTalent,
  type Advantage,
} from './checkRoll.js';

/**
 * `!check <skill|ability> [adv|dis] [+N]`
 *
 * Rolls a 5e ability or skill check for the caller's owned character —
 * the first-class "roll a check" path the app was missing. Any player
 * can roll their own check; results broadcast to the table like a normal
 * roll. Honors proficiency, expertise, Bard Jack-of-All-Trades, Rogue
 * Reliable Talent, and condition-driven disadvantage (poisoned /
 * frightened / exhaustion).
 */

const SKILL_LABELS: Record<keyof Skills, string> = {
  acrobatics: 'Acrobatics',
  animalHandling: 'Animal Handling',
  arcana: 'Arcana',
  athletics: 'Athletics',
  deception: 'Deception',
  history: 'History',
  insight: 'Insight',
  intimidation: 'Intimidation',
  investigation: 'Investigation',
  medicine: 'Medicine',
  nature: 'Nature',
  perception: 'Perception',
  performance: 'Performance',
  persuasion: 'Persuasion',
  religion: 'Religion',
  sleightOfHand: 'Sleight of Hand',
  stealth: 'Stealth',
  survival: 'Survival',
};

const ABILITY_LABELS: Record<string, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const own = Array.from(ctx.room.tokens.values())
    .filter((t) => t.ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

async function handleCheck(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!check: usage `!check <skill|ability> [adv|dis] [+N]` — e.g. `!check perception`, `!check stealth adv`, `!check str +2`.'
    );
    return true;
  }

  const target = parseCheckTarget(parts[0]);
  if (!target) {
    whisperToCaller(
      c.io,
      c.ctx,
      `!check: unknown skill/ability "${parts[0]}". Use a skill (perception, stealth, athletics, sleight…) or an ability (str/dex/con/int/wis/cha).`
    );
    return true;
  }

  // Optional flags: adv/dis and a flat ±N situational modifier.
  let explicit: Advantage = 'normal';
  let flat = 0;
  for (const p of parts.slice(1)) {
    const low = p.toLowerCase();
    if (low === 'adv' || low === 'advantage') explicit = 'advantage';
    else if (low === 'dis' || low === 'disadv' || low === 'disadvantage') explicit = 'disadvantage';
    else if (/^[+-]\d+$/.test(p)) flat += parseInt(p, 10);
  }

  const caller = resolveCallerToken(c.ctx);
  if (!caller?.characterId) {
    whisperToCaller(
      c.io,
      c.ctx,
      '!check: no owned character token found — claim a PC token first.'
    );
    return true;
  }

  const { rows } = await pool.query(
    'SELECT ability_scores, skills, proficiency_bonus, class, level, name, exhaustion_level FROM characters WHERE id = $1',
    [caller.characterId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    whisperToCaller(c.io, c.ctx, '!check: character row not found.');
    return true;
  }

  const scores =
    typeof row.ability_scores === 'string'
      ? JSON.parse(row.ability_scores)
      : (row.ability_scores ?? {});
  const skills = typeof row.skills === 'string' ? JSON.parse(row.skills) : (row.skills ?? {});
  const profBonus = Number(row.proficiency_bonus) || 2;
  const className = String(row.class ?? '');
  const level = Number(row.level) || 1;
  const charName = (row.name as string) || caller.name;

  const mod = computeCheckModifier({
    target,
    scores,
    skills,
    profBonus,
    className,
    flatBonus: flat,
  });

  // Exhaustion: prefer live combat state, fall back to the character column.
  const combatant = c.ctx.room.combatState?.combatants.find((cm) => cm.tokenId === caller.id);
  const exhaustion = combatant?.exhaustionLevel ?? (Number(row.exhaustion_level) || 0);
  const conditions = (caller.conditions as string[]) || [];
  const { effective, disadvantageSources } = resolveCheckAdvantage({
    explicit,
    conditions,
    exhaustion,
  });

  const reliableTalent = isReliableTalent(className, level, mod.proficient);
  const rolled = rollCheck({ modifier: mod.total, advantage: effective, reliableTalent });

  const label =
    target.kind === 'skill'
      ? `${SKILL_LABELS[target.skill]} (${target.ability.toUpperCase()})`
      : `${ABILITY_LABELS[target.ability]} check`;
  const breakdown = mod.parts
    .map((p) => `${p.label} ${p.value >= 0 ? '+' : ''}${p.value}`)
    .join(', ');
  const advNote =
    effective === 'advantage'
      ? ' · advantage'
      : effective === 'disadvantage'
        ? ` · disadvantage${disadvantageSources.length ? ` (${disadvantageSources.join(', ')})` : ''}`
        : '';

  broadcastSystem(
    c.io,
    c.ctx,
    `🎲 **${charName}** — ${label}: ${rolled.rollText} → **${rolled.total}**${advNote}\n   ${breakdown}`
  );
  return true;
}

registerChatCommand('check', handleCheck);
