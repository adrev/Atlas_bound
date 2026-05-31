import { computeSaveModifiers, type AttackBreakdownModifier, type Token } from '@dnd-vtt/shared';
import pool from '../../db/connection.js';
import type { ChatCommandContext } from '../ChatCommands.js';

export type SaveAbility = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export interface RolledSave {
  d20: number;
  d20Rolls?: number[];
  advantage: 'normal' | 'advantage' | 'disadvantage';
  modifiers: AttackBreakdownModifier[];
  total: number;
  saved: boolean;
  autoFailed?: boolean;
  displayName: string;
  notes: string[];
  rollText: string;
  totalMod: number;
}

function abilityMod(scores: Record<string, number> | undefined, ability: SaveAbility): number {
  const raw = (scores ?? {})[ability] ?? 10;
  return Math.floor((raw - 10) / 2);
}

export async function loadTargetSaveMod(
  target: Token,
  ability: SaveAbility,
): Promise<{ mod: number; displayName: string; race: string | null }> {
  if (!target.characterId) return { mod: 0, displayName: target.name, race: null };
  try {
    const { rows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus, name, race FROM characters WHERE id = $1',
      [target.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const scores = typeof row?.ability_scores === 'string'
      ? JSON.parse(row.ability_scores as string)
      : (row?.ability_scores ?? {});
    const prof = Number(row?.proficiency_bonus) || 2;
    const saves = typeof row?.saving_throws === 'string'
      ? JSON.parse(row.saving_throws as string)
      : (row?.saving_throws ?? []);
    const mod = abilityMod(scores as Record<string, number>, ability) +
      (Array.isArray(saves) && saves.includes(ability) ? prof : 0);
    return { mod, displayName: (row?.name as string) || target.name, race: (row?.race as string) ?? null };
  } catch {
    return { mod: 0, displayName: target.name, race: null };
  }
}

export async function rollTargetSave(
  c: ChatCommandContext,
  target: Token,
  ability: SaveAbility,
  dc: number,
  savingAgainst: string | readonly string[] | null,
): Promise<RolledSave> {
  const { mod, displayName, race } = await loadTargetSaveMod(target, ability);
  const conditions = (target.conditions as string[]) || [];
  const combatant = c.ctx.room.combatState?.combatants.find((cm) => cm.tokenId === target.id);
  const exhaustion = combatant?.exhaustionLevel ?? 0;
  const mods = computeSaveModifiers(conditions, ability, exhaustion, race, savingAgainst);
  const totalMod = mod + mods.flatModifier;

  let d20 = 1;
  let d20Rolls: number[] | undefined;
  let rollText = 'auto-fail';
  if (!mods.autoFail) {
    if (mods.effectiveAdvantage === 'advantage') {
      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      d20 = Math.max(r1, r2);
      d20Rolls = [r1, r2];
      rollText = `[${r1},${r2}] adv keep ${d20}`;
    } else if (mods.effectiveAdvantage === 'disadvantage') {
      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      d20 = Math.min(r1, r2);
      d20Rolls = [r1, r2];
      rollText = `[${r1},${r2}] disadv keep ${d20}`;
    } else {
      d20 = Math.floor(Math.random() * 20) + 1;
      rollText = `${d20}`;
    }
  }

  const total = mods.autoFail ? 0 : d20 + totalMod;
  const modifiers: AttackBreakdownModifier[] = [];
  if (mod !== 0) {
    modifiers.push({ label: `${ability.toUpperCase()} save mod`, value: mod, source: 'ability' });
  }
  if (mods.flatModifier !== 0) {
    modifiers.push({
      label: mods.flatModifier > 0 ? 'Cover / condition' : 'Slow / condition',
      value: mods.flatModifier,
      source: 'condition',
    });
  }

  return {
    d20,
    d20Rolls,
    advantage: mods.effectiveAdvantage,
    modifiers,
    total,
    saved: !mods.autoFail && total >= dc,
    autoFailed: mods.autoFail || undefined,
    displayName,
    notes: mods.notes,
    rollText,
    totalMod,
  };
}

export function formatSaveTotal(save: RolledSave): string {
  if (save.autoFailed) return 'auto-fail';
  const sign = save.totalMod >= 0 ? '+' : '';
  return `d20=${save.rollText}${sign}${save.totalMod}=${save.total}`;
}
