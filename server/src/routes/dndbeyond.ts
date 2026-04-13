import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import { parseCharacterJSON } from '../services/DndBeyondService.js';

const router = Router();

// In-memory cache for fetched characters (characterId -> { data, fetchedAt })
const characterCache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * GET /api/dndbeyond/character/:characterId
 * Proxy to D&D Beyond's character JSON endpoint.
 * Works for publicly shared characters.
 */
router.get('/character/:characterId', async (req: Request, res: Response) => {
  const characterId = String(req.params.characterId);

  if (!characterId || !/^\d+$/.test(characterId)) {
    res.status(400).json({ error: 'Invalid character ID. Must be a numeric ID.' });
    return;
  }

  // Check cache
  const cached = characterCache.get(characterId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(cached.data);
    return;
  }

  try {
    // Try the character service endpoint first
    let data: unknown = null;
    const primaryUrl = `https://character-service.dndbeyond.com/character/v5/character/${characterId}`;

    try {
      const response = await fetch(primaryUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'DnD-VTT/1.0',
        },
      });

      if (response.ok) {
        data = await response.json();
      }
    } catch {
      // Primary endpoint failed, try fallback
    }

    // Fallback: try the public sharing endpoint
    if (!data) {
      const fallbackUrl = `https://character-service.dndbeyond.com/character/v5/character/${characterId}/json`;
      try {
        const response = await fetch(fallbackUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'DnD-VTT/1.0',
          },
        });

        if (response.ok) {
          data = await response.json();
        }
      } catch {
        // Fallback also failed
      }
    }

    if (!data) {
      res.status(404).json({
        error: 'Character not found or not publicly shared. Make sure the character is set to public on D&D Beyond.',
      });
      return;
    }

    // Cache the result
    characterCache.set(characterId, { data, fetchedAt: Date.now() });

    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch character from D&D Beyond';
    res.status(502).json({ error: message });
  }
});

/**
 * GET /api/dndbeyond/proxy-image?url=...
 * Proxy an image from D&D Beyond to avoid CORS issues on the canvas.
 */
router.get('/proxy-image', async (req: Request, res: Response) => {
  const imageUrl = String(req.query.url || '');
  if (!imageUrl || !imageUrl.includes('dndbeyond.com')) {
    res.status(400).json({ error: 'Invalid image URL' });
    return;
  }
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) { res.status(resp.status).end(); return; }
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).json({ error: 'Failed to fetch image' });
  }
});

/**
 * POST /api/dndbeyond/import
 * Accept raw D&D Beyond JSON, parse it, and save to the database.
 */
router.post('/import', (req: Request, res: Response) => {
  const { characterJson, userId } = req.body;

  if (!characterJson) {
    res.status(400).json({ error: 'characterJson is required' });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  try {
    const character = parseCharacterJSON(characterJson);

    // Check for existing character with the same dndbeyond_id for this user (deduplication)
    const existing = character.dndbeyondId
      ? db.prepare('SELECT id FROM characters WHERE dndbeyond_id = ? AND user_id = ?')
          .get(character.dndbeyondId, userId) as { id: string } | undefined
      : undefined;

    if (existing) {
      // UPDATE existing record instead of creating a duplicate
      db.prepare(`
        UPDATE characters SET
          name = ?, race = ?, class = ?, level = ?, hit_points = ?, max_hit_points = ?,
          temp_hit_points = ?, armor_class = ?, speed = ?, proficiency_bonus = ?,
          ability_scores = ?, saving_throws = ?, skills = ?, spell_slots = ?, spells = ?,
          features = ?, inventory = ?, death_saves = ?, portrait_url = ?,
          dndbeyond_json = ?, source = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        character.name, character.race, character.class,
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
        JSON.stringify(characterJson),
        'dndbeyond_import',
        existing.id,
      );

      res.json({ id: existing.id, name: character.name, updated: true });
    } else {
      // No existing record — INSERT new
      const id = uuidv4();

      db.prepare(`
        INSERT INTO characters (
          id, user_id, name, race, class, level, hit_points, max_hit_points,
          temp_hit_points, armor_class, speed, proficiency_bonus,
          ability_scores, saving_throws, skills, spell_slots, spells,
          features, inventory, death_saves, portrait_url,
          dndbeyond_id, dndbeyond_json, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );

      res.status(201).json({ id, name: character.name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse character JSON';
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/dndbeyond/sync/:characterId
 * Re-import a character from D&D Beyond, smart-merging the fresh data
 * while preserving local-only fields (current HP, temp HP, death saves,
 * concentratingOn, conditions, hit-dice usage).
 */
router.post('/sync/:characterId', async (req: Request, res: Response) => {
  const characterId = String(req.params.characterId);

  // 1. Look up the existing character record
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }

  const ddbId = row.dndbeyond_id as string | null;
  if (!ddbId) {
    res.status(400).json({ error: 'Character was not imported from D&D Beyond — nothing to sync.' });
    return;
  }

  // 2. Fetch fresh data from DDB
  let ddbJson: unknown = null;
  const primaryUrl = `https://character-service.dndbeyond.com/character/v5/character/${ddbId}`;
  try {
    const response = await fetch(primaryUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'DnD-VTT/1.0' },
    });
    if (response.ok) ddbJson = await response.json();
  } catch { /* primary failed */ }

  if (!ddbJson) {
    const fallbackUrl = `https://character-service.dndbeyond.com/character/v5/character/${ddbId}/json`;
    try {
      const response = await fetch(fallbackUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'DnD-VTT/1.0' },
      });
      if (response.ok) ddbJson = await response.json();
    } catch { /* fallback failed */ }
  }

  if (!ddbJson) {
    res.status(502).json({ error: 'Failed to fetch character from D&D Beyond. Is it still public?' });
    return;
  }

  // 3. Parse fresh data through the same service used for initial import
  let fresh: ReturnType<typeof parseCharacterJSON>;
  try {
    fresh = parseCharacterJSON(ddbJson as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse DDB character data';
    res.status(400).json({ error: message });
    return;
  }

  // 4. SMART MERGE — preserve local-only values
  const preservedHitPoints = row.hit_points as number;
  const preservedTempHp = row.temp_hit_points as number;
  const preservedDeathSaves = row.death_saves as string;
  const preservedConcentrating = row.concentrating_on as string | null;
  const preservedConditions = row.conditions as string;
  // Preserve hit dice *usage* — merge used counts from local into the
  // fresh pools so total dice update but used stays the same.
  const preservedHitDice = row.hit_dice as string;

  db.prepare(`
    UPDATE characters SET
      name = ?, race = ?, class = ?, level = ?,
      max_hit_points = ?, hit_points = ?, temp_hit_points = ?,
      armor_class = ?, speed = ?, proficiency_bonus = ?,
      ability_scores = ?, saving_throws = ?, skills = ?,
      spell_slots = ?, spells = ?, features = ?, inventory = ?,
      death_saves = ?, portrait_url = ?,
      background = ?, characteristics = ?, personality = ?,
      notes_data = ?, proficiencies_data = ?, senses = ?,
      defenses = ?, conditions = ?, currency = ?, extras = ?,
      spellcasting_ability = ?, spell_attack_bonus = ?,
      spell_save_dc = ?, initiative = ?, hit_dice = ?,
      concentrating_on = ?,
      dndbeyond_json = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    fresh.name,
    fresh.race,
    fresh.class,
    fresh.level,
    fresh.maxHitPoints,
    // Preserve current HP — but clamp it to the new max if the old
    // value would exceed it (e.g. if max went down on re-spec)
    Math.min(preservedHitPoints, fresh.maxHitPoints),
    preservedTempHp,
    fresh.armorClass,
    fresh.speed,
    fresh.proficiencyBonus,
    JSON.stringify(fresh.abilityScores),
    JSON.stringify(fresh.savingThrows),
    JSON.stringify(fresh.skills),
    JSON.stringify(fresh.spellSlots),
    JSON.stringify(fresh.spells),
    JSON.stringify(fresh.features),
    JSON.stringify(fresh.inventory),
    preservedDeathSaves,       // keep local death saves
    fresh.portraitUrl,
    JSON.stringify(fresh.background),
    JSON.stringify(fresh.characteristics),
    JSON.stringify(fresh.personality),
    JSON.stringify(fresh.notes),
    JSON.stringify(fresh.proficiencies),
    JSON.stringify(fresh.senses),
    JSON.stringify(fresh.defenses),
    preservedConditions,       // keep local conditions
    JSON.stringify(fresh.currency),
    JSON.stringify(fresh.extras),
    fresh.spellcastingAbility,
    fresh.spellAttackBonus,
    fresh.spellSaveDC,
    fresh.initiative,
    preservedHitDice,          // keep local hit dice usage
    preservedConcentrating,    // keep local concentration
    JSON.stringify(ddbJson),
    characterId,
  );

  // Invalidate DDB character cache so future fetches see fresh data
  characterCache.delete(ddbId);

  // 5. Read back the updated record and return it in the same shape
  //    as GET /api/characters/:id
  const updatedRow = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as Record<string, unknown>;
  // Re-use the same row→object helper from the characters route
  const safeJsonParse = (value: unknown, fallback: unknown = null): unknown => {
    if (value == null) return fallback;
    if (typeof value !== 'string') return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };

  const character = {
    id: updatedRow.id,
    userId: updatedRow.user_id,
    name: updatedRow.name,
    race: updatedRow.race,
    class: updatedRow.class,
    level: updatedRow.level,
    hitPoints: updatedRow.hit_points,
    maxHitPoints: updatedRow.max_hit_points,
    tempHitPoints: updatedRow.temp_hit_points,
    armorClass: updatedRow.armor_class,
    speed: updatedRow.speed,
    proficiencyBonus: updatedRow.proficiency_bonus,
    abilityScores: safeJsonParse(updatedRow.ability_scores, {}),
    savingThrows: safeJsonParse(updatedRow.saving_throws, []),
    skills: safeJsonParse(updatedRow.skills, {}),
    spellSlots: safeJsonParse(updatedRow.spell_slots, {}),
    spells: safeJsonParse(updatedRow.spells, []),
    features: safeJsonParse(updatedRow.features, []),
    inventory: safeJsonParse(updatedRow.inventory, []),
    deathSaves: safeJsonParse(updatedRow.death_saves, { successes: 0, failures: 0 }),
    hitDice: safeJsonParse(updatedRow.hit_dice, []),
    concentratingOn: updatedRow.concentrating_on ?? null,
    background: safeJsonParse(updatedRow.background, {}),
    characteristics: safeJsonParse(updatedRow.characteristics, {}),
    personality: safeJsonParse(updatedRow.personality, {}),
    notes: safeJsonParse(updatedRow.notes_data, {}),
    proficiencies: safeJsonParse(updatedRow.proficiencies_data, {}),
    senses: safeJsonParse(updatedRow.senses, {}),
    defenses: safeJsonParse(updatedRow.defenses, {}),
    conditions: safeJsonParse(updatedRow.conditions, []),
    currency: safeJsonParse(updatedRow.currency, {}),
    extras: safeJsonParse(updatedRow.extras, []),
    spellcastingAbility: updatedRow.spellcasting_ability ?? '',
    spellAttackBonus: updatedRow.spell_attack_bonus ?? 0,
    spellSaveDC: updatedRow.spell_save_dc ?? 10,
    initiative: updatedRow.initiative ?? 0,
    compendiumSlug: updatedRow.compendium_slug ?? null,
    portraitUrl: updatedRow.portrait_url,
    dndbeyondId: updatedRow.dndbeyond_id,
    source: updatedRow.source,
    createdAt: updatedRow.created_at,
    updatedAt: updatedRow.updated_at,
  };

  res.json(character);
});

export default router;
