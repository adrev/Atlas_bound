import type { Token } from '@dnd-vtt/shared';
import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import { computeSaveModifiers } from '@dnd-vtt/shared';
import * as CombatService from '../CombatService.js';
import { applyDamageSideEffects } from '../damageEffects.js';
import pool from '../../db/connection.js';
import type { PlayerContext } from '../../utils/roomState.js';

/**
 * Spell / AoE save resolver. Rolls each target's save against the
 * supplied DC and applies damage — full on fail, half on success.
 * Replaces ~1 minute of "now you roll, now you roll, now subtract…"
 * fiddling with a single chat line.
 *
 *   !save <ability> <dc> <dice>/<type> <target1> [target2 …]
 *
 * Example:
 *   !save dex 15 8d6/fire goblin orc bugbear
 *     → each target: DEX save vs DC 15, take 8d6 fire on fail,
 *       half on success.
 *
 * Damage resistance / immunity / vulnerability from the character's
 * defenses field is NOT applied here (yet) — the DM can manually
 * adjust with !heal / !damage follow-ups. We broadcast each save
 * roll + damage applied so the table sees everything.
 */

const ABILITIES = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha']);

type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

function resolveTarget(ctx: PlayerContext, name: string): Token | null {
  if (!name) return null;
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) => t.name.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

function rollDice(notation: string): { total: number; rolls: number[] } {
  const m = notation.match(/^(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?$/i);
  if (!m) return { total: 0, rolls: [] };
  const count = parseInt(m[1], 10);
  const sides = parseInt(m[2], 10);
  const sign = m[3] === '-' ? -1 : 1;
  const mod = m[4] ? parseInt(m[4], 10) * sign : 0;
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const r = Math.floor(Math.random() * sides) + 1;
    rolls.push(r);
    sum += r;
  }
  return { total: Math.max(0, sum + mod), rolls };
}

async function loadSaveMod(
  characterId: string,
  ability: Ability,
): Promise<{ mod: number; name: string }> {
  const { rows } = await pool.query(
    'SELECT ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { mod: 0, name: '' };
  try {
    const scores = typeof row.ability_scores === 'string' ? JSON.parse(row.ability_scores) : (row.ability_scores ?? {});
    const ab = Math.floor((((scores as Record<string, number>)[ability] ?? 10) - 10) / 2);
    const prof = Number(row.proficiency_bonus) || 2;
    const saves = typeof row.saving_throws === 'string' ? JSON.parse(row.saving_throws) : (row.saving_throws ?? []);
    const isProf = Array.isArray(saves) && saves.includes(ability);
    return { mod: ab + (isProf ? prof : 0), name: (row.name as string) || '' };
  } catch {
    return { mod: 0, name: '' };
  }
}

async function handleSave(c: ChatCommandContext): Promise<boolean> {
  if (c.ctx.player.role !== 'dm') {
    whisperToCaller(c.io, c.ctx, '!save: DM only — resolves a spell save + damage against multiple targets.');
    return true;
  }
  const parts = c.rest.split(/\s+/).filter(Boolean);
  if (parts.length < 4) {
    whisperToCaller(
      c.io, c.ctx,
      '!save: usage `!save <ability> <dc> <dice>/<type> <target1> [target2 …]`\n  e.g. `!save dex 15 8d6/fire goblin orc bugbear`',
    );
    return true;
  }

  const abilityRaw = parts.shift()!.toLowerCase();
  if (!ABILITIES.has(abilityRaw)) {
    whisperToCaller(c.io, c.ctx, `!save: unknown ability "${abilityRaw}". Use str/dex/con/int/wis/cha.`);
    return true;
  }
  const ability = abilityRaw as Ability;

  const dcRaw = parts.shift()!;
  const dc = parseInt(dcRaw, 10);
  if (!Number.isFinite(dc) || dc < 1 || dc > 40) {
    whisperToCaller(c.io, c.ctx, `!save: DC must be a number 1-40. Got "${dcRaw}".`);
    return true;
  }

  const dmgSpec = parts.shift()!;
  // Split on the LAST '/' so damage types with slashes (uncommon) are
  // still parseable; accept just "8d6" as shorthand for untyped damage.
  const slash = dmgSpec.lastIndexOf('/');
  const dmgNotation = slash >= 0 ? dmgSpec.slice(0, slash) : dmgSpec;
  const dmgType = slash >= 0 ? dmgSpec.slice(slash + 1).toLowerCase() : '';
  if (!/^\d+d\d+(\s*[+-]\s*\d+)?$/i.test(dmgNotation)) {
    whisperToCaller(c.io, c.ctx, `!save: damage notation must be NdN[+M], got "${dmgNotation}".`);
    return true;
  }

  const targetNames = parts;
  if (targetNames.length === 0) {
    whisperToCaller(c.io, c.ctx, '!save: at least one target name required.');
    return true;
  }

  // Roll damage ONCE per 5e RAW (same roll applies to all targets).
  const { total: fullDmg, rolls: dmgRolls } = rollDice(dmgNotation);
  const halfDmg = Math.floor(fullDmg / 2);

  const lines: string[] = [];
  const typeLabel = dmgType ? ` ${dmgType}` : '';
  lines.push(
    `🎯 ${c.ctx.player.displayName} resolves save: **${ability.toUpperCase()} DC ${dc}**, damage ${dmgNotation}${typeLabel} (${dmgRolls.join('+')} = ${fullDmg})`,
  );

  for (const name of targetNames) {
    const target = resolveTarget(c.ctx, name);
    if (!target) {
      lines.push(`   • ${name}: not found`);
      continue;
    }

    // Roll save. Apply condition advantage / auto-fail via the
    // shared computeSaveModifiers helper so pseudo-conditions
    // (paralyzed, hasted, restrained, etc.) fold into the roll.
    const targetConds = (target.conditions as string[]) || [];
    // Exhaustion level lookup — combatant row carries it, else default.
    const combatant = c.ctx.room.combatState?.combatants.find((cm) => cm.tokenId === target.id);
    const exhaustion = combatant?.exhaustionLevel ?? 0;
    const mods = computeSaveModifiers(targetConds, ability, exhaustion);

    let saveMod = 0;
    let tName = target.name;
    if (target.characterId) {
      const info = await loadSaveMod(target.characterId, ability);
      saveMod = info.mod;
      if (info.name) tName = info.name;
    }

    let d20: number;
    let rollsStr: string;
    if (mods.autoFail) {
      d20 = 1; // show as 1 for visual cue
      rollsStr = `auto-fail (${targetConds.filter((c2) => c2 === 'paralyzed' || c2 === 'stunned' || c2 === 'unconscious' || c2 === 'petrified').join('+')})`;
    } else if (mods.effectiveAdvantage === 'advantage') {
      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      d20 = Math.max(r1, r2);
      rollsStr = `[${r1},${r2}] (adv)`;
    } else if (mods.effectiveAdvantage === 'disadvantage') {
      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      d20 = Math.min(r1, r2);
      rollsStr = `[${r1},${r2}] (disadv)`;
    } else {
      d20 = Math.floor(Math.random() * 20) + 1;
      rollsStr = `${d20}`;
    }
    const modSign = saveMod >= 0 ? '+' : '';
    const total = mods.autoFail ? 0 : d20 + saveMod;
    const saved = !mods.autoFail && total >= dc;
    const dmg = saved ? halfDmg : fullDmg;

    lines.push(
      `   • ${tName}: d20=${rollsStr}${mods.autoFail ? '' : `${modSign}${saveMod}=${total}`} vs ${dc} → ${saved ? 'SAVED (half)' : 'FAILED (full)'} — ${dmg}${typeLabel} dmg`,
    );

    // Apply damage. Use CombatService.applyDamage when in combat
    // (runs death-save / unconscious auto-apply). Out of combat, write
    // hp directly.
    if (dmg > 0) {
      try {
        if (c.ctx.room.combatState?.active) {
          const r = await CombatService.applyDamage(c.ctx.room.sessionId, target.id, dmg);
          c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
            tokenId: target.id,
            hp: r.hp,
            tempHp: r.tempHp,
            change: r.change,
            type: 'damage',
          });
          if (r.characterId) {
            c.io.to(c.ctx.room.sessionId).emit('character:updated', {
              characterId: r.characterId,
              changes: { hitPoints: r.hp, tempHitPoints: r.tempHp },
            });
          }
          // Run side effects (concentration save, endsOnDamage clears)
          await applyDamageSideEffects(c.io, c.ctx.room, target.id, dmg);
        } else if (target.characterId) {
          const { rows } = await pool.query(
            'SELECT hit_points, max_hit_points, temp_hit_points FROM characters WHERE id = $1',
            [target.characterId],
          );
          const row = rows[0] as Record<string, unknown> | undefined;
          if (row) {
            const curHp = Number(row.hit_points) || 0;
            const tempHp = Number(row.temp_hit_points) || 0;
            // Temp HP absorbs first.
            let remaining = dmg;
            let newTempHp = tempHp;
            if (tempHp > 0) {
              const absorbed = Math.min(tempHp, remaining);
              newTempHp = tempHp - absorbed;
              remaining -= absorbed;
            }
            const newHp = Math.max(0, curHp - remaining);
            await pool.query(
              'UPDATE characters SET hit_points = $1, temp_hit_points = $2 WHERE id = $3',
              [newHp, newTempHp, target.characterId],
            );
            c.io.to(c.ctx.room.sessionId).emit('character:updated', {
              characterId: target.characterId,
              changes: { hitPoints: newHp, tempHitPoints: newTempHp },
            });
            c.io.to(c.ctx.room.sessionId).emit('combat:hp-changed', {
              tokenId: target.id,
              hp: newHp,
              tempHp: newTempHp,
              change: -(curHp - newHp),
              type: 'damage',
            });
          }
        }
      } catch (err) {
        console.warn('[!save] damage apply failed for', target.name, err);
      }
    }
  }

  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

registerChatCommand('save', handleSave);
