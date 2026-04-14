import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { parseCharacterJSON } from '../services/DndBeyondService.js';
import { getAuthUserId, assertCharacterOwnerOrDM } from '../utils/authorization.js';
import { dbRowToCharacter } from '../utils/characterMapper.js';

const router = Router();

const characterCache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const CACHE_MAX_SIZE = 500;
const CACHE_CLEANUP_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of characterCache) {
    if (now - entry.fetchedAt > CACHE_CLEANUP_TTL_MS) {
      characterCache.delete(key);
    }
  }
  // Hard cap: if still over max, delete oldest entries
  if (characterCache.size > CACHE_MAX_SIZE) {
    const entries = [...characterCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const toDelete = entries.slice(0, entries.length - CACHE_MAX_SIZE);
    for (const [key] of toDelete) characterCache.delete(key);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

router.get('/character/:characterId', async (req: Request, res: Response) => {
  const characterId = String(req.params.characterId);

  if (!characterId || !/^\d+$/.test(characterId)) {
    res.status(400).json({ error: 'Invalid character ID. Must be a numeric ID.' });
    return;
  }

  const cached = characterCache.get(characterId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(cached.data);
    return;
  }

  try {
    let data: unknown = null;
    const primaryUrl = `https://character-service.dndbeyond.com/character/v5/character/${characterId}`;
    try {
      const response = await fetch(primaryUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'DnD-VTT/1.0' } });
      if (response.ok) data = await response.json();
    } catch { /* primary failed */ }

    if (!data) {
      const fallbackUrl = `https://character-service.dndbeyond.com/character/v5/character/${characterId}/json`;
      try {
        const response = await fetch(fallbackUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'DnD-VTT/1.0' } });
        if (response.ok) data = await response.json();
      } catch { /* fallback failed */ }
    }

    if (!data) {
      res.status(404).json({ error: 'Character not found or not publicly shared.' });
      return;
    }

    characterCache.set(characterId, { data, fetchedAt: Date.now() });
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch character from D&D Beyond';
    res.status(502).json({ error: message });
  }
});

/** Validate that a URL is a safe dndbeyond.com image URL (prevents SSRF). */
function validateDndbeyondUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // Only allow HTTPS
  if (parsed.protocol !== 'https:') return null;

  // Reject URLs with userinfo (e.g. https://dndbeyond.com@evil.com)
  if (parsed.username || parsed.password) return null;

  // Hostname must be exactly dndbeyond.com or a subdomain of it
  const host = parsed.hostname.toLowerCase();
  if (host !== 'dndbeyond.com' && !host.endsWith('.dndbeyond.com')) return null;

  // Reject hostnames that look like IPs or localhost
  if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|::1|\[::1\])/i.test(host)) return null;

  return parsed;
}

const ALLOWED_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

router.get('/proxy-image', async (req: Request, res: Response) => {
  const imageUrl = String(req.query.url || '');
  const parsed = validateDndbeyondUrl(imageUrl);
  if (!parsed) {
    res.status(400).json({ error: 'Invalid image URL. Must be an HTTPS dndbeyond.com URL.' });
    return;
  }

  try {
    // Don't follow redirects automatically — they could point to internal hosts
    const resp = await fetch(parsed.href, { redirect: 'manual' });

    // If redirected, validate the redirect target
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location || !validateDndbeyondUrl(location)) {
        res.status(403).json({ error: 'Redirect to disallowed host' });
        return;
      }
      // Fetch the validated redirect target (still no auto-follow)
      const redirectResp = await fetch(location, { redirect: 'manual' });
      if (!redirectResp.ok) { res.status(redirectResp.status).end(); return; }
      const redirectCt = (redirectResp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(redirectCt)) {
        res.status(403).json({ error: 'Response is not an image' });
        return;
      }
      res.set('Content-Type', redirectCt);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('X-Content-Type-Options', 'nosniff');
      const buf = Buffer.from(await redirectResp.arrayBuffer());
      res.send(buf);
      return;
    }

    if (!resp.ok) { res.status(resp.status).end(); return; }

    // Validate content type is an image
    const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(contentType)) {
      res.status(403).json({ error: 'Response is not an image' });
      return;
    }

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).json({ error: 'Failed to fetch image' });
  }
});

router.post('/import', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { characterJson } = req.body;
  if (!characterJson) { res.status(400).json({ error: 'characterJson is required' }); return; }

  try {
    const character = parseCharacterJSON(characterJson);

    let existing: { id: string } | undefined;
    if (character.dndbeyondId) {
      const { rows } = await pool.query('SELECT id FROM characters WHERE dndbeyond_id = $1 AND user_id = $2', [character.dndbeyondId, userId]);
      existing = rows[0];
    }

    if (existing) {
      await pool.query(`
        UPDATE characters SET
          name = $1, race = $2, class = $3, level = $4, hit_points = $5, max_hit_points = $6,
          temp_hit_points = $7, armor_class = $8, speed = $9, proficiency_bonus = $10,
          ability_scores = $11, saving_throws = $12, skills = $13, spell_slots = $14, spells = $15,
          features = $16, inventory = $17, death_saves = $18, portrait_url = $19,
          dndbeyond_json = $20, source = $21, updated_at = NOW()::text
        WHERE id = $22
      `, [
        character.name, character.race, character.class,
        character.level, character.hitPoints, character.maxHitPoints,
        character.tempHitPoints, character.armorClass, character.speed,
        character.proficiencyBonus,
        JSON.stringify(character.abilityScores), JSON.stringify(character.savingThrows),
        JSON.stringify(character.skills), JSON.stringify(character.spellSlots),
        JSON.stringify(character.spells), JSON.stringify(character.features),
        JSON.stringify(character.inventory), JSON.stringify(character.deathSaves),
        character.portraitUrl, JSON.stringify(characterJson), 'dndbeyond_import',
        existing.id,
      ]);
      res.json({ id: existing.id, name: character.name, updated: true });
    } else {
      const id = uuidv4();
      await pool.query(`
        INSERT INTO characters (
          id, user_id, name, race, class, level, hit_points, max_hit_points,
          temp_hit_points, armor_class, speed, proficiency_bonus,
          ability_scores, saving_throws, skills, spell_slots, spells,
          features, inventory, death_saves, portrait_url,
          dndbeyond_id, dndbeyond_json, source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      `, [
        id, userId, character.name, character.race, character.class,
        character.level, character.hitPoints, character.maxHitPoints,
        character.tempHitPoints, character.armorClass, character.speed,
        character.proficiencyBonus,
        JSON.stringify(character.abilityScores), JSON.stringify(character.savingThrows),
        JSON.stringify(character.skills), JSON.stringify(character.spellSlots),
        JSON.stringify(character.spells), JSON.stringify(character.features),
        JSON.stringify(character.inventory), JSON.stringify(character.deathSaves),
        character.portraitUrl, character.dndbeyondId, JSON.stringify(characterJson),
        'dndbeyond_import',
      ]);
      res.status(201).json({ id, name: character.name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse character JSON';
    res.status(400).json({ error: message });
  }
});

router.post('/sync/:characterId', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const characterId = String(req.params.characterId);

  await assertCharacterOwnerOrDM(characterId, userId);

  const { rows: rowArr } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  const row = rowArr[0] as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Character not found' }); return; }

  const ddbId = row.dndbeyond_id as string | null;
  if (!ddbId) { res.status(400).json({ error: 'Character was not imported from D&D Beyond.' }); return; }

  let ddbJson: unknown = null;
  const primaryUrl = `https://character-service.dndbeyond.com/character/v5/character/${ddbId}`;
  try {
    const response = await fetch(primaryUrl, { headers: { Accept: 'application/json', 'User-Agent': 'DnD-VTT/1.0' } });
    if (response.ok) ddbJson = await response.json();
  } catch { /* primary failed */ }

  if (!ddbJson) {
    const fallbackUrl = `https://character-service.dndbeyond.com/character/v5/character/${ddbId}/json`;
    try {
      const response = await fetch(fallbackUrl, { headers: { Accept: 'application/json', 'User-Agent': 'DnD-VTT/1.0' } });
      if (response.ok) ddbJson = await response.json();
    } catch { /* fallback failed */ }
  }

  if (!ddbJson) { res.status(502).json({ error: 'Failed to fetch character from D&D Beyond.' }); return; }

  let fresh: ReturnType<typeof parseCharacterJSON>;
  try {
    fresh = parseCharacterJSON(ddbJson as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to parse DDB data' });
    return;
  }

  const preservedHitPoints = row.hit_points as number;
  const preservedTempHp = row.temp_hit_points as number;
  const preservedDeathSaves = row.death_saves as string;
  const preservedConcentrating = row.concentrating_on as string | null;
  const preservedConditions = row.conditions as string;
  const preservedHitDice = row.hit_dice as string;

  await pool.query(`
    UPDATE characters SET
      name=$1,race=$2,class=$3,level=$4,max_hit_points=$5,hit_points=$6,temp_hit_points=$7,
      armor_class=$8,speed=$9,proficiency_bonus=$10,ability_scores=$11,saving_throws=$12,skills=$13,
      spell_slots=$14,spells=$15,features=$16,inventory=$17,death_saves=$18,portrait_url=$19,
      background=$20,characteristics=$21,personality=$22,notes_data=$23,proficiencies_data=$24,senses=$25,
      defenses=$26,conditions=$27,currency=$28,extras=$29,spellcasting_ability=$30,spell_attack_bonus=$31,
      spell_save_dc=$32,initiative=$33,hit_dice=$34,concentrating_on=$35,dndbeyond_json=$36,
      updated_at=NOW()::text
    WHERE id=$37
  `, [
    fresh.name, fresh.race, fresh.class, fresh.level, fresh.maxHitPoints,
    Math.min(preservedHitPoints, fresh.maxHitPoints), preservedTempHp,
    fresh.armorClass, fresh.speed, fresh.proficiencyBonus,
    JSON.stringify(fresh.abilityScores), JSON.stringify(fresh.savingThrows),
    JSON.stringify(fresh.skills), JSON.stringify(fresh.spellSlots),
    JSON.stringify(fresh.spells), JSON.stringify(fresh.features),
    JSON.stringify(fresh.inventory), preservedDeathSaves, fresh.portraitUrl,
    JSON.stringify(fresh.background), JSON.stringify(fresh.characteristics),
    JSON.stringify(fresh.personality), JSON.stringify(fresh.notes),
    JSON.stringify(fresh.proficiencies), JSON.stringify(fresh.senses),
    JSON.stringify(fresh.defenses), preservedConditions,
    JSON.stringify(fresh.currency), JSON.stringify(fresh.extras),
    fresh.spellcastingAbility, fresh.spellAttackBonus, fresh.spellSaveDC,
    fresh.initiative, preservedHitDice, preservedConcentrating,
    JSON.stringify(ddbJson), characterId,
  ]);

  characterCache.delete(ddbId);

  const { rows: updatedRows } = await pool.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  const updatedRow = updatedRows[0] as Record<string, unknown>;

  res.json(dbRowToCharacter(updatedRow));
});

export default router;
