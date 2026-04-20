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
): Promise<{ mod: number; name: string; race: string | null }> {
  const { rows } = await pool.query(
    'SELECT ability_scores, saving_throws, proficiency_bonus, name, race FROM characters WHERE id = $1',
    [characterId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { mod: 0, name: '', race: null };
  try {
    const scores = typeof row.ability_scores === 'string' ? JSON.parse(row.ability_scores) : (row.ability_scores ?? {});
    const ab = Math.floor((((scores as Record<string, number>)[ability] ?? 10) - 10) / 2);
    const prof = Number(row.proficiency_bonus) || 2;
    const saves = typeof row.saving_throws === 'string' ? JSON.parse(row.saving_throws) : (row.saving_throws ?? []);
    const isProf = Array.isArray(saves) && saves.includes(ability);
    return {
      mod: ab + (isProf ? prof : 0),
      name: (row.name as string) || '',
      race: (row.race as string) ?? null,
    };
  } catch {
    return { mod: 0, name: '', race: null };
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

    let saveMod = 0;
    let tName = target.name;
    let tRace: string | null = null;
    if (target.characterId) {
      const info = await loadSaveMod(target.characterId, ability);
      saveMod = info.mod;
      if (info.name) tName = info.name;
      tRace = info.race;
    }

    // Hand the damage type to computeSaveModifiers as the `savingAgainst`
    // tag so race traits fire (dwarf Resilience vs poison, tiefling vs
    // fire, aasimar vs necrotic/radiant). For save-or-effect commands
    // the DM would run the dedicated spell command which passes its own
    // tag (frightened / charmed / magic).
    const mods = computeSaveModifiers(targetConds, ability, exhaustion, tRace, dmgType || null);

    // Aura of Protection (Paladin L6): when the target or any ally
    // within 10 ft of a Paladin with the aura makes a save, add the
    // Paladin's CHA modifier. Only one aura applies (take the
    // highest), and the Paladin must be conscious (not unconscious
    // or downed). Works on the Paladin themself too.
    let auraBonus = 0;
    let auraSource = '';
    try {
      const gridSize = (c.ctx.room.currentMapId && c.ctx.room.mapGridSizes.get(c.ctx.room.currentMapId)) || 70;
      const tSize = (target as Token).size || 1;
      const tcx = target.x + (gridSize * tSize) / 2;
      const tcy = target.y + (gridSize * tSize) / 2;
      const tIsPC = !!target.ownerUserId;
      for (const pal of c.ctx.room.tokens.values()) {
        if (!pal.characterId) continue;
        const palIsPC = !!pal.ownerUserId;
        if (palIsPC !== tIsPC) continue; // ally side only
        const palConds = (pal.conditions as string[]) || [];
        if (palConds.includes('unconscious') || palConds.includes('incapacitated') || palConds.includes('dead')) continue;
        // Edge-to-edge distance — aura reaches 10 ft (2 cells).
        const pSize = (pal as Token).size || 1;
        const pcx = pal.x + (gridSize * pSize) / 2;
        const pcy = pal.y + (gridSize * pSize) / 2;
        const dx = Math.max(0, Math.abs(pcx - tcx) - (pSize * gridSize) / 2 - (tSize * gridSize) / 2);
        const dy = Math.max(0, Math.abs(pcy - tcy) - (pSize * gridSize) / 2 - (tSize * gridSize) / 2);
        const edge = Math.max(dx, dy);
        if (edge > gridSize * 2 + 1) continue;
        const { rows: prows } = await pool.query(
          'SELECT class, level, features, ability_scores, name FROM characters WHERE id = $1',
          [pal.characterId],
        );
        const prow = prows[0] as Record<string, unknown> | undefined;
        if (!prow) continue;
        const classLower = String(prow.class || '').toLowerCase();
        const palLevel = Number(prow.level) || 1;
        if (!classLower.includes('paladin') || palLevel < 6) continue;
        // Verify the feature is present (auto-populated by level 6
        // but defensively check).
        try {
          const rawF = prow.features;
          const feats = typeof rawF === 'string' ? JSON.parse(rawF) : (rawF ?? []);
          const has = Array.isArray(feats) && feats.some(
            (f: { name?: string }) => typeof f?.name === 'string' && /aura\s+of\s+protection/i.test(f.name),
          );
          // Per PHB, Aura of Protection is automatic at L6 — accept
          // if level matches even when the feature isn't explicitly
          // listed in the imported features.
          if (!has && palLevel < 6) continue;
        } catch { if (palLevel < 6) continue; }
        const scores = typeof prow.ability_scores === 'string' ? JSON.parse(prow.ability_scores) : (prow.ability_scores ?? {});
        const cha = Math.floor((((scores as Record<string, number>).cha ?? 10) - 10) / 2);
        const chaBonus = Math.max(1, cha); // min +1 per RAW
        if (chaBonus > auraBonus) {
          auraBonus = chaBonus;
          auraSource = (prow.name as string) || pal.name;
        }
      }
    } catch { /* aura detection best-effort */ }
    if (auraBonus > 0) {
      saveMod += auraBonus;
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
    const auraLabel = auraBonus > 0 ? ` (incl. +${auraBonus} Aura of Protection from ${auraSource})` : '';

    lines.push(
      `   • ${tName}: d20=${rollsStr}${mods.autoFail ? '' : `${modSign}${saveMod}=${total}`} vs ${dc}${auraLabel} → ${saved ? 'SAVED (half)' : 'FAILED (full)'} — ${dmg}${typeLabel} dmg`,
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
