import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import db from '../db/connection.js';
import { getPlayerBySocketId } from '../utils/roomState.js';

const characterUpdateSchema = z.object({
  characterId: z.string().min(1),
  changes: z.record(z.unknown()),
});

const characterSyncRequestSchema = z.object({
  characterId: z.string().min(1),
});

// Map from camelCase field names to DB column names and whether the value needs JSON.stringify
const FIELD_TO_COLUMN: Record<string, { col: string; json: boolean }> = {
  name: { col: 'name', json: false },
  race: { col: 'race', json: false },
  class: { col: 'class', json: false },
  level: { col: 'level', json: false },
  hitPoints: { col: 'hit_points', json: false },
  maxHitPoints: { col: 'max_hit_points', json: false },
  tempHitPoints: { col: 'temp_hit_points', json: false },
  armorClass: { col: 'armor_class', json: false },
  speed: { col: 'speed', json: false },
  abilityScores: { col: 'ability_scores', json: true },
  savingThrows: { col: 'saving_throws', json: true },
  skills: { col: 'skills', json: true },
  spellSlots: { col: 'spell_slots', json: true },
  spells: { col: 'spells', json: true },
  features: { col: 'features', json: true },
  inventory: { col: 'inventory', json: true },
  deathSaves: { col: 'death_saves', json: true },
  portraitUrl: { col: 'portrait_url', json: false },
  conditions: { col: 'conditions', json: true },
  spellcastingAbility: { col: 'spellcasting_ability', json: false },
  spellAttackBonus: { col: 'spell_attack_bonus', json: false },
  spellSaveDC: { col: 'spell_save_dc', json: false },
  initiative: { col: 'initiative', json: false },
  currency: { col: 'currency', json: true },
  background: { col: 'background', json: true },
  characteristics: { col: 'characteristics', json: true },
  personality: { col: 'personality', json: true },
  notes: { col: 'notes_data', json: true },
  proficiencies: { col: 'proficiencies_data', json: true },
  senses: { col: 'senses', json: true },
  defenses: { col: 'defenses', json: true },
  extras: { col: 'extras', json: true },
  hitDice: { col: 'hit_dice', json: true },
  concentratingOn: { col: 'concentrating_on', json: false },
};

function safeJsonParse(value: unknown, fallback: unknown = null): unknown {
  if (value == null) return fallback;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function dbRowToCharacter(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    race: row.race,
    class: row.class,
    level: row.level,
    hitPoints: row.hit_points,
    maxHitPoints: row.max_hit_points,
    tempHitPoints: row.temp_hit_points,
    armorClass: row.armor_class,
    speed: row.speed,
    proficiencyBonus: row.proficiency_bonus,
    abilityScores: safeJsonParse(row.ability_scores, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }),
    savingThrows: safeJsonParse(row.saving_throws, []),
    skills: safeJsonParse(row.skills, {}),
    spellSlots: safeJsonParse(row.spell_slots, {}),
    spells: safeJsonParse(row.spells, []),
    features: safeJsonParse(row.features, []),
    inventory: safeJsonParse(row.inventory, []),
    deathSaves: safeJsonParse(row.death_saves, { successes: 0, failures: 0 }),
    hitDice: safeJsonParse(row.hit_dice, []),
    concentratingOn: row.concentrating_on ?? null,
    background: safeJsonParse(row.background, { name: '', description: '', feature: '' }),
    characteristics: safeJsonParse(row.characteristics, {}),
    personality: safeJsonParse(row.personality, {}),
    notes: safeJsonParse(row.notes_data, {}),
    proficiencies: safeJsonParse(row.proficiencies_data, {}),
    senses: safeJsonParse(row.senses, {}),
    defenses: safeJsonParse(row.defenses, {}),
    conditions: safeJsonParse(row.conditions, []),
    currency: safeJsonParse(row.currency, { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }),
    extras: safeJsonParse(row.extras, []),
    spellcastingAbility: row.spellcasting_ability ?? '',
    spellAttackBonus: row.spell_attack_bonus ?? 0,
    spellSaveDC: row.spell_save_dc ?? 10,
    initiative: row.initiative ?? 0,
    portraitUrl: row.portrait_url,
    dndbeyondId: row.dndbeyond_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerCharacterEvents(io: Server, socket: Socket): void {

  socket.on('character:update', (data) => {
    const parsed = characterUpdateSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { characterId, changes } = parsed.data;

    // Verify the character exists
    const existing = db.prepare('SELECT id, user_id FROM characters WHERE id = ?').get(characterId) as Record<string, unknown> | undefined;
    if (!existing) return;

    // Build the DB update
    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(changes)) {
      const mapping = FIELD_TO_COLUMN[key];
      if (!mapping) continue; // Skip unknown fields
      setClauses.push(`${mapping.col} = ?`);
      params.push(mapping.json ? JSON.stringify(value) : value);
    }

    if (setClauses.length > 0) {
      setClauses.push("updated_at = datetime('now')");
      params.push(characterId);
      db.prepare(`UPDATE characters SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    }

    // Broadcast to all players in the room (except the sender)
    socket.to(ctx.room.sessionId).emit('character:updated', { characterId, changes });
  });

  socket.on('character:sync-request', (data) => {
    const parsed = characterSyncRequestSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { characterId } = parsed.data;

    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as Record<string, unknown> | undefined;
    if (!row) return;

    socket.emit('character:synced', { character: dbRowToCharacter(row) });
  });
}
