import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { createCharacterSchema, updateCharacterSchema } from '../utils/validation.js';
import { proficiencyBonusForLevel } from '@dnd-vtt/shared';
import { parseCharacterJSON } from '../services/DndBeyondService.js';
import { getAuthUserId, assertCharacterOwnerOrDM, assertSessionDM } from '../utils/authorization.js';
import { dbRowToCharacter } from '../utils/characterMapper.js';

const router = Router();

// GET /api/characters - List the authenticated user's characters
router.get('/', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  // Defense-in-depth filters beyond user_id='npc':
  //  * class LIKE 'CR %' — EncounterBuilder stamps creatures with e.g.
  //    "CR 1/4". Legacy rows may have leaked onto a real user_id from
  //    before the `isNpc` path existed.
  //  * race='loot' AND class='bag' — the loot-bag drop flow creates
  //    characters that should never show up in a user's hero list.
  const { rows } = await pool.query(
    `SELECT * FROM characters
      WHERE user_id = $1
        AND user_id != 'npc'
        AND (class IS NULL OR class NOT LIKE 'CR %')
        AND NOT (race = 'loot' AND class = 'bag')
      ORDER BY updated_at DESC`,
    [userId],
  );
  res.json(rows.map(dbRowToCharacter));
});

// POST /api/characters - Create a new character
router.post('/', async (req: Request, res: Response) => {
  const authUserId = getAuthUserId(req);
  const parsed = createCharacterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const data = parsed.data;

  // Only a session DM may create a global NPC. Require proof by passing a
  // sessionId in the body; we then verify the caller is DM of that session.
  if (data.isNpc) {
    if (!data.sessionId) {
      res.status(400).json({
        error: 'sessionId is required when creating an NPC (must be DM of that session)',
      });
      return;
    }
    try {
      await assertSessionDM(data.sessionId, authUserId);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 403;
      const message = err instanceof Error ? err.message : 'Not authorized';
      res.status(status).json({ error: message });
      return;
    }
  }

  const userId = data.isNpc ? 'npc' : authUserId;
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

  await pool.query(`
    INSERT INTO characters (
      id, user_id, name, race, class, level, hit_points, max_hit_points,
      armor_class, speed, proficiency_bonus, ability_scores, saving_throws,
      skills, portrait_url, compendium_slug
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  `, [
    id, userId, data.name, data.race, data.class, data.level,
    data.hitPoints, data.maxHitPoints, data.armorClass, data.speed,
    profBonus, JSON.stringify(abilityScores),
    JSON.stringify(data.savingThrows ?? []),
    JSON.stringify(defaultSkills),
    data.portraitUrl ?? null,
    data.compendiumSlug ?? null,
  ]);

  const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [id]);
  res.status(201).json(dbRowToCharacter(rows[0]));
});

// GET /api/characters/:id
router.get('/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  const row = rows[0];

  if (row.user_id === userId) {
    res.json(dbRowToCharacter(row));
    return;
  }

  if (row.user_id === 'npc') {
    // Global NPCs are shared-by-reference — anyone could guess the UUID.
    // Require the caller to share a session with a map/token linked to
    // this NPC character before exposing it.
    const { rows: npcLink } = await pool.query(
      `SELECT 1 FROM tokens t
       JOIN maps m ON t.map_id = m.id
       JOIN session_players sp ON sp.session_id = m.session_id
       WHERE t.character_id = $1 AND sp.user_id = $2
       LIMIT 1`,
      [row.id, userId],
    );
    if (npcLink.length === 0) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
    res.json(dbRowToCharacter(row));
    return;
  }

  // Player-owned character owned by someone else: require the specific
  // character to be linked in a session the caller shares. The old
  // query only checked "do these two users share ANY session", which
  // meant a tablemate from Campaign A could read your characters from
  // Campaign B by guessing the character ID.
  const { rows: shared } = await pool.query(
    `SELECT 1 FROM session_players sp1
     JOIN session_players sp2 ON sp1.session_id = sp2.session_id
     WHERE sp1.user_id = $1 AND sp2.character_id = $2
     LIMIT 1`,
    [userId, req.params.id],
  );
  if (shared.length === 0) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }
  res.json(dbRowToCharacter(row));
});

// PUT /api/characters/:id - Update a character
router.put('/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const parsed = updateCharacterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  await assertCharacterOwnerOrDM(String(req.params.id), userId);

  const updates = parsed.data;
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (updates.name !== undefined) { setClauses.push(`name = $${paramIdx++}`); params.push(updates.name); }
  if (updates.race !== undefined) { setClauses.push(`race = $${paramIdx++}`); params.push(updates.race); }
  if (updates.class !== undefined) { setClauses.push(`class = $${paramIdx++}`); params.push(updates.class); }
  if (updates.level !== undefined) {
    setClauses.push(`level = $${paramIdx++}`, `proficiency_bonus = $${paramIdx++}`);
    params.push(updates.level, proficiencyBonusForLevel(updates.level));
  }
  if (updates.hitPoints !== undefined) { setClauses.push(`hit_points = $${paramIdx++}`); params.push(updates.hitPoints); }
  if (updates.maxHitPoints !== undefined) { setClauses.push(`max_hit_points = $${paramIdx++}`); params.push(updates.maxHitPoints); }
  if (updates.armorClass !== undefined) { setClauses.push(`armor_class = $${paramIdx++}`); params.push(updates.armorClass); }
  if (updates.speed !== undefined) { setClauses.push(`speed = $${paramIdx++}`); params.push(updates.speed); }
  if (updates.abilityScores !== undefined) { setClauses.push(`ability_scores = $${paramIdx++}`); params.push(JSON.stringify(updates.abilityScores)); }
  if (updates.savingThrows !== undefined) { setClauses.push(`saving_throws = $${paramIdx++}`); params.push(JSON.stringify(updates.savingThrows)); }
  if (updates.portraitUrl !== undefined) { setClauses.push(`portrait_url = $${paramIdx++}`); params.push(updates.portraitUrl); }
  if (updates.background !== undefined) { setClauses.push(`background = $${paramIdx++}`); params.push(JSON.stringify(updates.background)); }
  if (updates.characteristics !== undefined) { setClauses.push(`characteristics = $${paramIdx++}`); params.push(JSON.stringify(updates.characteristics)); }
  if (updates.personality !== undefined) { setClauses.push(`personality = $${paramIdx++}`); params.push(JSON.stringify(updates.personality)); }
  if (updates.notes !== undefined) { setClauses.push(`notes_data = $${paramIdx++}`); params.push(JSON.stringify(updates.notes)); }
  if (updates.proficiencies !== undefined) { setClauses.push(`proficiencies_data = $${paramIdx++}`); params.push(JSON.stringify(updates.proficiencies)); }
  if (updates.senses !== undefined) { setClauses.push(`senses = $${paramIdx++}`); params.push(JSON.stringify(updates.senses)); }
  if (updates.defenses !== undefined) { setClauses.push(`defenses = $${paramIdx++}`); params.push(JSON.stringify(updates.defenses)); }
  if (updates.conditions !== undefined) { setClauses.push(`conditions = $${paramIdx++}`); params.push(JSON.stringify(updates.conditions)); }
  if (updates.currency !== undefined) { setClauses.push(`currency = $${paramIdx++}`); params.push(JSON.stringify(updates.currency)); }
  if (updates.extras !== undefined) { setClauses.push(`extras = $${paramIdx++}`); params.push(JSON.stringify(updates.extras)); }
  if (updates.spellcastingAbility !== undefined) { setClauses.push(`spellcasting_ability = $${paramIdx++}`); params.push(updates.spellcastingAbility); }
  if (updates.spellAttackBonus !== undefined) { setClauses.push(`spell_attack_bonus = $${paramIdx++}`); params.push(updates.spellAttackBonus); }
  if (updates.spellSaveDC !== undefined) { setClauses.push(`spell_save_dc = $${paramIdx++}`); params.push(updates.spellSaveDC); }
  if (updates.initiative !== undefined) { setClauses.push(`initiative = $${paramIdx++}`); params.push(updates.initiative); }
  if (updates.skills !== undefined) { setClauses.push(`skills = $${paramIdx++}`); params.push(JSON.stringify(updates.skills)); }
  if (updates.spellSlots !== undefined) { setClauses.push(`spell_slots = $${paramIdx++}`); params.push(JSON.stringify(updates.spellSlots)); }
  if (updates.spells !== undefined) { setClauses.push(`spells = $${paramIdx++}`); params.push(JSON.stringify(updates.spells)); }
  if (updates.features !== undefined) { setClauses.push(`features = $${paramIdx++}`); params.push(JSON.stringify(updates.features)); }
  if (updates.inventory !== undefined) { setClauses.push(`inventory = $${paramIdx++}`); params.push(JSON.stringify(updates.inventory)); }
  if (updates.deathSaves !== undefined) { setClauses.push(`death_saves = $${paramIdx++}`); params.push(JSON.stringify(updates.deathSaves)); }
  if (updates.tempHitPoints !== undefined) { setClauses.push(`temp_hit_points = $${paramIdx++}`); params.push(updates.tempHitPoints); }
  if (updates.hitDice !== undefined) { setClauses.push(`hit_dice = $${paramIdx++}`); params.push(JSON.stringify(updates.hitDice)); }
  if (updates.concentratingOn !== undefined) { setClauses.push(`concentrating_on = $${paramIdx++}`); params.push(updates.concentratingOn); }

  if (setClauses.length === 0) {
    const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
    res.json(dbRowToCharacter(rows[0]));
    return;
  }

  setClauses.push(`updated_at = NOW()::text`);
  params.push(req.params.id);

  await pool.query(`UPDATE characters SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`, params);

  const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [req.params.id]);
  res.json(dbRowToCharacter(rows[0]));
});

// DELETE /api/characters/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user?.id;
  const { rows } = await pool.query('SELECT user_id FROM characters WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  if (rows[0].user_id === 'npc') {
    // NPCs aren't user-scoped; block deletion from this endpoint
    res.status(403).json({ error: 'Not authorized to delete NPC characters' });
    return;
  }
  if (rows[0].user_id !== userId) {
    res.status(403).json({ error: 'Not authorized' });
    return;
  }

  await pool.query('DELETE FROM characters WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// POST /api/characters/import-json
router.post('/import-json', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { characterJson } = req.body;
  if (!characterJson) {
    res.status(400).json({ error: 'characterJson is required' });
    return;
  }

  try {
    const character = parseCharacterJSON(characterJson);

    // Merge-instead-of-duplicate: if this user already has a character
    // linked to the same DDB id, UPDATE that row and preserve their
    // session state (HP, conditions, concentration, slot/feature usage
    // counts) instead of creating a second copy. Without this, each
    // re-import after a level-up would leave the user with 'Liraya (1)',
    // 'Liraya (2)', ... accumulating forever.
    if (character.dndbeyondId) {
      const { rows: existingRows } = await pool.query(
        'SELECT * FROM characters WHERE user_id = $1 AND dndbeyond_id = $2',
        [userId, character.dndbeyondId],
      );
      if (existingRows.length > 0) {
        const existing = existingRows[0];
        const { buildMergeUpdate } = await import('../services/ddbMerge.js');
        const { columns, values } = buildMergeUpdate({
          existing,
          incoming: character as unknown as Record<string, unknown>,
          raw: characterJson,
        });
        const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
        values.push(existing.id);
        await pool.query(
          `UPDATE characters SET ${setClause} WHERE id = $${values.length}`,
          values,
        );
        const { rows: updated } = await pool.query('SELECT * FROM characters WHERE id = $1', [existing.id]);
        res.json({ ...dbRowToCharacter(updated[0]), merged: true });
        return;
      }
    }

    const id = uuidv4();

    await pool.query(`
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
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
    `, [
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
    ]);

    const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [id]);
    res.status(201).json(dbRowToCharacter(rows[0]));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse character JSON';
    res.status(400).json({ error: message });
  }
});

export default router;
