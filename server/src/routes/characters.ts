import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import { createCharacterSchema, updateCharacterSchema } from '../utils/validation.js';
import { proficiencyBonusForLevel } from '@dnd-vtt/shared';
import { parseCharacterJSON } from '../services/DndBeyondService.js';

const router = Router();

function safeJsonParse(value: unknown, fallback: unknown = null): unknown {
  if (value == null) return fallback;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function dbRowToCharacter(row: Record<string, unknown>) {
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
    characteristics: safeJsonParse(row.characteristics, { alignment: '', gender: '', eyes: '', hair: '', skin: '', height: '', weight: '', age: '', faith: '', size: 'Medium' }),
    personality: safeJsonParse(row.personality, { traits: '', ideals: '', bonds: '', flaws: '' }),
    notes: safeJsonParse(row.notes_data, { organizations: '', allies: '', enemies: '', backstory: '', other: '' }),
    proficiencies: safeJsonParse(row.proficiencies_data, { armor: [], weapons: [], tools: [], languages: [] }),
    senses: safeJsonParse(row.senses, { passivePerception: 10, passiveInvestigation: 10, passiveInsight: 10, darkvision: 0 }),
    defenses: safeJsonParse(row.defenses, { resistances: [], immunities: [], vulnerabilities: [] }),
    conditions: safeJsonParse(row.conditions, []),
    currency: safeJsonParse(row.currency, { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }),
    extras: safeJsonParse(row.extras, []),
    spellcastingAbility: row.spellcasting_ability ?? '',
    spellAttackBonus: row.spell_attack_bonus ?? 0,
    spellSaveDC: row.spell_save_dc ?? 10,
    initiative: row.initiative ?? 0,
    compendiumSlug: row.compendium_slug ?? null,
    portraitUrl: row.portrait_url,
    dndbeyondId: row.dndbeyond_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/characters?userId=XXX - List characters owned by a user.
// Used by the Hero sidebar tab so the player can pick which imported
// character to activate. Excludes NPC records (userId === 'npc') and
// loot bag placeholders.
router.get('/', (req: Request, res: Response) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
  const rows = (userId
    ? db.prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
    : db.prepare("SELECT * FROM characters WHERE user_id != 'npc' ORDER BY updated_at DESC").all()
  ) as Record<string, unknown>[];
  res.json(rows.map(dbRowToCharacter));
});

// POST /api/characters - Create a new character
router.post('/', (req: Request, res: Response) => {
  const parsed = createCharacterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const data = parsed.data;
  const id = uuidv4();
  const profBonus = proficiencyBonusForLevel(data.level);
  const abilityScores = data.abilityScores ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  const defaultSkills = {
    acrobatics: 'none', animalHandling: 'none', arcana: 'none', athletics: 'none',
    deception: 'none', history: 'none', insight: 'none', intimidation: 'none',
    investigation: 'none', medicine: 'none', nature: 'none', perception: 'none',
    performance: 'none', persuasion: 'none', religion: 'none', sleightOfHand: 'none',
    stealth: 'none', survival: 'none',
  };

  db.prepare(`
    INSERT INTO characters (
      id, user_id, name, race, class, level, hit_points, max_hit_points,
      armor_class, speed, proficiency_bonus, ability_scores, saving_throws,
      skills, portrait_url, compendium_slug
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.userId, data.name, data.race, data.class, data.level,
    data.hitPoints, data.maxHitPoints, data.armorClass, data.speed,
    profBonus, JSON.stringify(abilityScores),
    JSON.stringify(data.savingThrows ?? []),
    JSON.stringify(defaultSkills),
    data.portraitUrl ?? null,
    data.compendiumSlug ?? null,
  );

  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(dbRowToCharacter(row));
});

// GET /api/characters/mine - List characters owned by the authenticated user
router.get('/mine', (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.json([]); return; }

  const rows = db.prepare(`
    SELECT * FROM characters
    WHERE user_id = ? AND user_id != 'npc'
    ORDER BY updated_at DESC
  `).all(userId) as Record<string, unknown>[];

  res.json(rows.map(dbRowToCharacter));
});

// GET /api/characters/:id - Get a character
router.get('/:id', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  res.json(dbRowToCharacter(row));
});

// PUT /api/characters/:id - Update a character
router.put('/:id', (req: Request, res: Response) => {
  const parsed = updateCharacterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const existing = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }

  const updates = parsed.data;
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
  if (updates.race !== undefined) { setClauses.push('race = ?'); params.push(updates.race); }
  if (updates.class !== undefined) { setClauses.push('class = ?'); params.push(updates.class); }
  if (updates.level !== undefined) {
    setClauses.push('level = ?', 'proficiency_bonus = ?');
    params.push(updates.level, proficiencyBonusForLevel(updates.level));
  }
  if (updates.hitPoints !== undefined) { setClauses.push('hit_points = ?'); params.push(updates.hitPoints); }
  if (updates.maxHitPoints !== undefined) { setClauses.push('max_hit_points = ?'); params.push(updates.maxHitPoints); }
  if (updates.armorClass !== undefined) { setClauses.push('armor_class = ?'); params.push(updates.armorClass); }
  if (updates.speed !== undefined) { setClauses.push('speed = ?'); params.push(updates.speed); }
  if (updates.abilityScores !== undefined) { setClauses.push('ability_scores = ?'); params.push(JSON.stringify(updates.abilityScores)); }
  if (updates.savingThrows !== undefined) { setClauses.push('saving_throws = ?'); params.push(JSON.stringify(updates.savingThrows)); }
  if (updates.portraitUrl !== undefined) { setClauses.push('portrait_url = ?'); params.push(updates.portraitUrl); }
  if (updates.background !== undefined) { setClauses.push('background = ?'); params.push(JSON.stringify(updates.background)); }
  if (updates.characteristics !== undefined) { setClauses.push('characteristics = ?'); params.push(JSON.stringify(updates.characteristics)); }
  if (updates.personality !== undefined) { setClauses.push('personality = ?'); params.push(JSON.stringify(updates.personality)); }
  if (updates.notes !== undefined) { setClauses.push('notes_data = ?'); params.push(JSON.stringify(updates.notes)); }
  if (updates.proficiencies !== undefined) { setClauses.push('proficiencies_data = ?'); params.push(JSON.stringify(updates.proficiencies)); }
  if (updates.senses !== undefined) { setClauses.push('senses = ?'); params.push(JSON.stringify(updates.senses)); }
  if (updates.defenses !== undefined) { setClauses.push('defenses = ?'); params.push(JSON.stringify(updates.defenses)); }
  if (updates.conditions !== undefined) { setClauses.push('conditions = ?'); params.push(JSON.stringify(updates.conditions)); }
  if (updates.currency !== undefined) { setClauses.push('currency = ?'); params.push(JSON.stringify(updates.currency)); }
  if (updates.extras !== undefined) { setClauses.push('extras = ?'); params.push(JSON.stringify(updates.extras)); }
  if (updates.spellcastingAbility !== undefined) { setClauses.push('spellcasting_ability = ?'); params.push(updates.spellcastingAbility); }
  if (updates.spellAttackBonus !== undefined) { setClauses.push('spell_attack_bonus = ?'); params.push(updates.spellAttackBonus); }
  if (updates.spellSaveDC !== undefined) { setClauses.push('spell_save_dc = ?'); params.push(updates.spellSaveDC); }
  if (updates.initiative !== undefined) { setClauses.push('initiative = ?'); params.push(updates.initiative); }
  if (updates.skills !== undefined) { setClauses.push('skills = ?'); params.push(JSON.stringify(updates.skills)); }
  if (updates.spellSlots !== undefined) { setClauses.push('spell_slots = ?'); params.push(JSON.stringify(updates.spellSlots)); }
  if (updates.spells !== undefined) { setClauses.push('spells = ?'); params.push(JSON.stringify(updates.spells)); }
  if (updates.features !== undefined) { setClauses.push('features = ?'); params.push(JSON.stringify(updates.features)); }
  if (updates.inventory !== undefined) { setClauses.push('inventory = ?'); params.push(JSON.stringify(updates.inventory)); }
  if (updates.deathSaves !== undefined) { setClauses.push('death_saves = ?'); params.push(JSON.stringify(updates.deathSaves)); }
  if (updates.tempHitPoints !== undefined) { setClauses.push('temp_hit_points = ?'); params.push(updates.tempHitPoints); }
  if (updates.hitDice !== undefined) { setClauses.push('hit_dice = ?'); params.push(JSON.stringify(updates.hitDice)); }
  if (updates.concentratingOn !== undefined) { setClauses.push('concentrating_on = ?'); params.push(updates.concentratingOn); }

  if (setClauses.length === 0) {
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json(dbRowToCharacter(row));
    return;
  }

  setClauses.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE characters SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(dbRowToCharacter(row));
});

// DELETE /api/characters/:id - Delete a character (with ownership check)
router.delete('/:id', (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  const char = db.prepare('SELECT user_id FROM characters WHERE id = ?').get(req.params.id) as { user_id: string } | undefined;
  if (!char) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  if (char.user_id !== userId && char.user_id !== 'npc') {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  db.prepare('DELETE FROM characters WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/characters/import-json - Import from D&D Beyond JSON
router.post('/import-json', (req: Request, res: Response) => {
  const { userId, characterJson } = req.body;
  if (!userId || !characterJson) {
    res.status(400).json({ error: 'userId and characterJson are required' });
    return;
  }

  try {
    const character = parseCharacterJSON(characterJson);
    const id = uuidv4();

    db.prepare(`
      INSERT INTO characters (
        id, user_id, name, race, class, level, hit_points, max_hit_points,
        temp_hit_points, armor_class, speed, proficiency_bonus,
        ability_scores, saving_throws, skills, spell_slots, spells,
        features, inventory, death_saves, portrait_url,
        dndbeyond_id, dndbeyond_json, source,
        background, characteristics, personality, notes_data,
        proficiencies_data, senses, defenses, conditions, currency, extras,
        spellcasting_ability, spell_attack_bonus, spell_save_dc, initiative,
        hit_dice
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, character.name, character.race, character.class,
      character.level, character.hitPoints, character.maxHitPoints,
      character.tempHitPoints, character.armorClass, character.speed,
      character.proficiencyBonus,
      JSON.stringify(character.abilityScores),
      JSON.stringify(character.savingThrows),
      JSON.stringify(character.skills),
      JSON.stringify(character.spellSlots),
      JSON.stringify(character.spells),
      JSON.stringify(character.features),
      JSON.stringify(character.inventory),
      JSON.stringify(character.deathSaves),
      character.portraitUrl,
      character.dndbeyondId,
      JSON.stringify(characterJson),
      'dndbeyond_import',
      JSON.stringify(character.background),
      JSON.stringify(character.characteristics),
      JSON.stringify(character.personality),
      JSON.stringify(character.notes),
      JSON.stringify(character.proficiencies),
      JSON.stringify(character.senses),
      JSON.stringify(character.defenses),
      JSON.stringify(character.conditions),
      JSON.stringify(character.currency),
      JSON.stringify(character.extras),
      character.spellcastingAbility,
      character.spellAttackBonus,
      character.spellSaveDC,
      character.initiative,
      JSON.stringify(character.hitDice ?? []),
    );

    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json(dbRowToCharacter(row));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse character JSON';
    res.status(400).json({ error: message });
  }
});

export default router;
