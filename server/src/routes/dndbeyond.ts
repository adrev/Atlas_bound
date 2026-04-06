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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse character JSON';
    res.status(400).json({ error: message });
  }
});

export default router;
