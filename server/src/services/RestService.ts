import type { PoolClient } from 'pg';
import type { RoomState } from '../utils/roomState.js';

export type RestKind = 'short' | 'long';

export interface RestResult {
  characterId: string;
  name: string;
  updates: Record<string, unknown>;
  changes: string[];
}

export interface SpendHitDieResult {
  characterId: string;
  name: string;
  dieSize: number;
  roll: number;
  conMod: number;
  heal: number;
  oldHp: number;
  newHp: number;
  updates: Record<string, unknown>;
  changes: string[];
}

type SpellSlots = Record<string, { max: number; used: number }>;
type FeatureUse = { name?: string; usesTotal?: number; usesRemaining?: number; resetOn?: string | null };
type HitDicePool = { dieSize: number; total: number; used: number };
type DeathSaves = { successes: number; failures: number };

const REST_FIELD_TO_COLUMN: Record<string, { column: string; json: boolean }> = {
  hitPoints: { column: 'hit_points', json: false },
  tempHitPoints: { column: 'temp_hit_points', json: false },
  spellSlots: { column: 'spell_slots', json: true },
  features: { column: 'features', json: true },
  hitDice: { column: 'hit_dice', json: true },
  deathSaves: { column: 'death_saves', json: true },
  concentratingOn: { column: 'concentrating_on', json: false },
  exhaustionLevel: { column: 'exhaustion_level', json: false },
};

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return (raw ?? fallback) as T;
}

function parseArray<T>(raw: unknown): T[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function parseRecord<T>(raw: unknown): Record<string, T> {
  const parsed = parseJson<unknown>(raw, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, T>
    : {};
}

function finiteNumber(raw: unknown, fallback = 0): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function computeLongRest(row: Record<string, unknown>): RestResult {
  const changes: string[] = [];
  const updates: Record<string, unknown> = {};
  const name = String(row.name ?? 'Character');
  const hitPoints = finiteNumber(row.hit_points);
  const maxHitPoints = finiteNumber(row.max_hit_points);
  const tempHitPoints = finiteNumber(row.temp_hit_points);

  if (hitPoints < maxHitPoints) {
    updates.hitPoints = maxHitPoints;
    changes.push(`HP restored (${hitPoints} -> ${maxHitPoints})`);
  }

  if (tempHitPoints > 0) {
    updates.tempHitPoints = 0;
    changes.push('Temporary HP cleared');
  }

  const slots = parseRecord<{ max: number; used: number }>(row.spell_slots);
  const updatedSlots: SpellSlots = {};
  const restoredLevels: string[] = [];
  for (const [level, slot] of Object.entries(slots)) {
    const max = finiteNumber(slot?.max);
    const used = finiteNumber(slot?.used);
    if (used > 0) restoredLevels.push(level);
    updatedSlots[level] = { max, used: 0 };
  }
  if (restoredLevels.length > 0) {
    updates.spellSlots = updatedSlots;
    changes.push(`Spell slots restored (level${restoredLevels.length === 1 ? '' : 's'} ${restoredLevels.join(', ')})`);
  }

  const features = parseArray<FeatureUse>(row.features);
  let restoredFeatures = 0;
  const updatedFeatures = features.map((feature) => {
    const total = finiteNumber(feature.usesTotal, NaN);
    const remaining = finiteNumber(feature.usesRemaining, total);
    if (Number.isFinite(total) && total > 0 && remaining < total) {
      restoredFeatures += 1;
      return { ...feature, usesRemaining: total };
    }
    return feature;
  });
  if (restoredFeatures > 0) {
    updates.features = updatedFeatures;
    changes.push(`${restoredFeatures} feature${restoredFeatures === 1 ? '' : 's'} restored`);
  }

  const hitDice = parseArray<HitDicePool>(row.hit_dice);
  let restoredHitDice = 0;
  const totalHitDice = hitDice.reduce((sum, pool) => sum + Math.max(0, finiteNumber(pool.total)), 0);
  let remainingRecovery = totalHitDice > 0 ? Math.max(1, Math.ceil(totalHitDice / 2)) : 0;
  const updatedHitDice = hitDice.map((pool) => {
    const used = finiteNumber(pool.used);
    if (used <= 0 || remainingRecovery <= 0) return pool;
    const recovered = Math.min(used, remainingRecovery);
    remainingRecovery -= recovered;
    restoredHitDice += recovered;
    const newUsed = used - recovered;
    return { ...pool, used: newUsed };
  });
  if (restoredHitDice > 0) {
    updates.hitDice = updatedHitDice;
    changes.push(`Recovered ${restoredHitDice} Hit Dice`);
  }

  const deathSaves = parseJson<DeathSaves>(row.death_saves, { successes: 0, failures: 0 });
  if (finiteNumber(deathSaves.successes) > 0 || finiteNumber(deathSaves.failures) > 0) {
    updates.deathSaves = { successes: 0, failures: 0 };
    changes.push('Death saves cleared');
  }

  if (row.concentrating_on) {
    updates.concentratingOn = null;
    changes.push(`Concentration on ${String(row.concentrating_on)} dropped`);
  }

  const exhaustion = finiteNumber(row.exhaustion_level);
  if (exhaustion > 0) {
    updates.exhaustionLevel = Math.max(0, exhaustion - 1);
    changes.push(`Exhaustion ${exhaustion} -> ${updates.exhaustionLevel}`);
  }

  if (changes.length === 0) changes.push('Already fully rested');
  return { characterId: String(row.id), name, updates, changes };
}

function computeShortRest(row: Record<string, unknown>): RestResult {
  const changes: string[] = [];
  const updates: Record<string, unknown> = {};
  const name = String(row.name ?? 'Character');

  const features = parseArray<FeatureUse>(row.features);
  let restoredFeatures = 0;
  const updatedFeatures = features.map((feature) => {
    const total = finiteNumber(feature.usesTotal, NaN);
    const remaining = finiteNumber(feature.usesRemaining, total);
    if (feature.resetOn === 'short' && Number.isFinite(total) && total > 0 && remaining < total) {
      restoredFeatures += 1;
      return { ...feature, usesRemaining: total };
    }
    return feature;
  });
  if (restoredFeatures > 0) {
    updates.features = updatedFeatures;
    changes.push(`${restoredFeatures} short-rest feature${restoredFeatures === 1 ? '' : 's'} restored`);
  }

  if (String(row.class ?? '').toLowerCase().includes('warlock')) {
    const slots = parseRecord<{ max: number; used: number }>(row.spell_slots);
    const updatedSlots: SpellSlots = {};
    let restoredSlots = 0;
    for (const [level, slot] of Object.entries(slots)) {
      const max = finiteNumber(slot?.max);
      const used = finiteNumber(slot?.used);
      if (used > 0) restoredSlots += 1;
      updatedSlots[level] = { max, used: 0 };
    }
    if (restoredSlots > 0) {
      updates.spellSlots = updatedSlots;
      changes.push('Warlock spell slots restored');
    }
  }

  if (changes.length === 0) changes.push('Already refreshed');
  return { characterId: String(row.id), name, updates, changes };
}

export function computeRest(row: Record<string, unknown>, kind: RestKind): RestResult {
  return kind === 'long' ? computeLongRest(row) : computeShortRest(row);
}

export function computeSpendHitDie(
  row: Record<string, unknown>,
  dieSize: number,
  roll = Math.floor(Math.random() * dieSize) + 1,
): SpendHitDieResult {
  const characterId = String(row.id);
  const name = String(row.name ?? 'Character');
  const hitPoints = finiteNumber(row.hit_points);
  const maxHitPoints = finiteNumber(row.max_hit_points);
  const hitDice = parseArray<HitDicePool>(row.hit_dice);
  const abilityScores = parseRecord<number>(row.ability_scores);
  const con = finiteNumber(abilityScores.con ?? abilityScores.constitution, 10);
  const conMod = Math.floor((con - 10) / 2);
  const poolIdx = hitDice.findIndex((pool) => finiteNumber(pool.dieSize) === dieSize);

  if (poolIdx < 0) {
    return {
      characterId, name, dieSize, roll, conMod, heal: 0, oldHp: hitPoints, newHp: hitPoints,
      updates: {}, changes: [`No d${dieSize} Hit Dice available`],
    };
  }

  const pool = hitDice[poolIdx];
  if (finiteNumber(pool.used) >= finiteNumber(pool.total)) {
    return {
      characterId, name, dieSize, roll, conMod, heal: 0, oldHp: hitPoints, newHp: hitPoints,
      updates: {}, changes: [`No d${dieSize} Hit Dice remaining`],
    };
  }

  if (hitPoints >= maxHitPoints) {
    return {
      characterId, name, dieSize, roll, conMod, heal: 0, oldHp: hitPoints, newHp: hitPoints,
      updates: {}, changes: ['Already at maximum HP'],
    };
  }

  const heal = Math.max(1, roll + conMod);
  const newHp = Math.min(maxHitPoints, hitPoints + heal);
  const updatedHitDice = hitDice.map((poolItem, idx) => (
    idx === poolIdx ? { ...poolItem, used: finiteNumber(poolItem.used) + 1 } : poolItem
  ));
  return {
    characterId,
    name,
    dieSize,
    roll,
    conMod,
    heal,
    oldHp: hitPoints,
    newHp,
    updates: { hitPoints: newHp, hitDice: updatedHitDice },
    changes: [`Rolled ${roll}${conMod >= 0 ? '+' : ''}${conMod} = ${heal} HP (HP ${hitPoints} -> ${newHp})`],
  };
}

export async function persistRestUpdates(
  client: PoolClient,
  characterId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    const field = REST_FIELD_TO_COLUMN[key];
    if (!field) continue;
    setClauses.push(`${field.column} = $${idx++}`);
    params.push(field.json ? JSON.stringify(value) : value);
  }

  if (setClauses.length === 0) return;
  setClauses.push('updated_at = NOW()::text');
  params.push(characterId);
  await client.query(`UPDATE characters SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
}

export function syncRestToCombatants(
  room: RoomState,
  characterId: string,
  updates: Record<string, unknown>,
): void {
  const combatants = room.combatState?.combatants ?? [];
  for (const combatant of combatants) {
    if (combatant.characterId !== characterId) continue;
    if (typeof updates.hitPoints === 'number') combatant.hp = updates.hitPoints;
    if (typeof updates.tempHitPoints === 'number') combatant.tempHp = updates.tempHitPoints;
    if (updates.deathSaves && typeof updates.deathSaves === 'object') {
      combatant.deathSaves = updates.deathSaves as { successes: number; failures: number };
    }
    if (typeof updates.exhaustionLevel === 'number') {
      combatant.exhaustionLevel = updates.exhaustionLevel;
    }
  }
}
