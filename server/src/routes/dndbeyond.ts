import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { parseCharacterJSON } from '../services/DndBeyondService.js';
import { buildMergeUpdate } from '../services/ddbMerge.js';
import { getAuthUserId } from '../utils/authorization.js';
import { dbRowToCharacter } from '../utils/characterMapper.js';

const router = Router();

const characterCache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const CACHE_MAX_SIZE = 500;
const CACHE_CLEANUP_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Limits applied to all outbound calls to dndbeyond.com (character fetches and image proxy).
const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_CHARACTER_JSON_BYTES = 5 * 1024 * 1024; // 5MB

async function withCharacterTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch a JSON resource from dndbeyond with a 10s timeout and a 5MB cap.
 * Returns the parsed body on 2xx, or null on any failure (network, non-2xx,
 * oversize, timeout, invalid JSON).
 */
async function fetchDdbJsonWithLimits(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'DnD-VTT/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_CHARACTER_JSON_BYTES) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    let total = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_CHARACTER_JSON_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null;
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Periodic cache cleanup
setInterval(
  () => {
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
  },
  5 * 60 * 1000
); // Run every 5 minutes

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
    const primaryUrl = `https://character-service.dndbeyond.com/character/v5/character/${characterId}`;
    let data: unknown = await fetchDdbJsonWithLimits(primaryUrl);

    if (!data) {
      const fallbackUrl = `https://character-service.dndbeyond.com/character/v5/character/${characterId}/json`;
      data = await fetchDdbJsonWithLimits(fallbackUrl);
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
    const message =
      err instanceof Error ? err.message : 'Failed to fetch character from D&D Beyond';
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
  if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|::1|\[::1\])/i.test(host))
    return null;

  return parsed;
}

// SVG is excluded — it is an XML format that can embed scripts and is an XSS risk
// when proxied and served from our origin.
const ALLOWED_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Stream the response body into a buffer while enforcing a byte cap.
 * Returns null if the body exceeds `maxBytes` or cannot be read.
 */
async function readBodyWithCap(
  resp: globalThis.Response,
  maxBytes: number
): Promise<Buffer | null> {
  const contentLength = resp.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) return null;
  const reader = resp.body?.getReader();
  if (!reader) return null;
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

router.get('/proxy-image', async (req: Request, res: Response) => {
  const imageUrl = String(req.query.url || '');
  const parsed = validateDndbeyondUrl(imageUrl);
  if (!parsed) {
    res.status(400).json({ error: 'Invalid image URL. Must be an HTTPS dndbeyond.com URL.' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Don't follow redirects automatically — they could point to internal hosts
    let resp = await fetch(parsed.href, { redirect: 'manual', signal: controller.signal });

    // If redirected, validate the redirect target
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location || !validateDndbeyondUrl(location)) {
        res.status(403).json({ error: 'Redirect to disallowed host' });
        return;
      }
      // Fetch the validated redirect target (still no auto-follow)
      resp = await fetch(location, { redirect: 'manual', signal: controller.signal });
    }

    if (!resp.ok) {
      res.status(resp.status).end();
      return;
    }

    // Validate content type is an image. Reject SVG explicitly — some servers
    // may return 'image/svg' without the '+xml' suffix, so we check the prefix.
    const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType.startsWith('image/svg')) {
      res.status(403).json({ error: 'SVG images are not permitted' });
      return;
    }
    if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(contentType)) {
      res.status(403).json({ error: 'Response is not an image' });
      return;
    }

    const buffer = await readBodyWithCap(resp, MAX_IMAGE_BYTES);
    if (!buffer) {
      res.status(413).json({ error: 'Image too large' });
      return;
    }

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  } catch {
    res.status(502).json({ error: 'Failed to fetch image' });
  } finally {
    clearTimeout(timeout);
  }
});

router.post('/import', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { characterJson } = req.body;
  if (!characterJson) {
    res.status(400).json({ error: 'characterJson is required' });
    return;
  }

  try {
    const character = parseCharacterJSON(characterJson);

    const result = await withCharacterTransaction(async (client) => {
      const existingRow = character.dndbeyondId
        ? (
            await client.query(
              'SELECT * FROM characters WHERE dndbeyond_id = $1 AND user_id = $2 FOR UPDATE',
              [character.dndbeyondId, userId]
            )
          ).rows[0]
        : undefined;

      if (existingRow) {
        const { columns, values } = buildMergeUpdate({
          existing: existingRow,
          incoming: character as unknown as Record<string, unknown>,
          raw: characterJson,
        });
        columns.push('source');
        values.push('dndbeyond_import');
        const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
        values.push(existingRow.id);
        await client.query(
          `UPDATE characters SET ${setClause}, updated_at = NOW()::text WHERE id = $${values.length}`,
          values
        );
        return {
          status: 200,
          body: { id: existingRow.id, name: character.name, updated: true, merged: true },
        };
      }

      const id = uuidv4();
      await client.query(
        `
        INSERT INTO characters (
          id, user_id, name, race, class, level, hit_points, max_hit_points,
          temp_hit_points, armor_class, speed, proficiency_bonus,
          ability_scores, saving_throws, skills, spell_slots, spells,
          features, inventory, death_saves, portrait_url,
          dndbeyond_id, dndbeyond_json, source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      `,
        [
          id,
          userId,
          character.name,
          character.race,
          character.class,
          character.level,
          character.hitPoints,
          character.maxHitPoints,
          character.tempHitPoints,
          character.armorClass,
          character.speed,
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
        ]
      );
      return { status: 201, body: { id, name: character.name } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse character JSON';
    res.status(400).json({ error: message });
  }
});

router.post('/sync/:characterId', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const characterId = String(req.params.characterId);

  const { rows: rowArr } = await pool.query('SELECT * FROM characters WHERE id = $1', [
    characterId,
  ]);
  const row = rowArr[0] as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  if (row.user_id !== userId) {
    res.status(403).json({ error: 'Only the character owner can sync from D&D Beyond.' });
    return;
  }

  const ddbId = row.dndbeyond_id as string | null;
  if (!ddbId) {
    res.status(400).json({ error: 'Character was not imported from D&D Beyond.' });
    return;
  }

  const primaryUrl = `https://character-service.dndbeyond.com/character/v5/character/${ddbId}`;
  let ddbJson: unknown = await fetchDdbJsonWithLimits(primaryUrl);

  if (!ddbJson) {
    const fallbackUrl = `https://character-service.dndbeyond.com/character/v5/character/${ddbId}/json`;
    ddbJson = await fetchDdbJsonWithLimits(fallbackUrl);
  }

  if (!ddbJson) {
    res.status(502).json({ error: 'Failed to fetch character from D&D Beyond.' });
    return;
  }

  let fresh: ReturnType<typeof parseCharacterJSON>;
  try {
    fresh = parseCharacterJSON(ddbJson as Record<string, unknown>);
  } catch (err) {
    res
      .status(400)
      .json({ error: err instanceof Error ? err.message : 'Failed to parse DDB data' });
    return;
  }

  const result = await withCharacterTransaction(async (client) => {
    const { rows: lockedRows } = await client.query(
      'SELECT * FROM characters WHERE id = $1 FOR UPDATE',
      [characterId]
    );
    const lockedRow = lockedRows[0] as Record<string, unknown> | undefined;
    if (!lockedRow) return { status: 404, body: { error: 'Character not found' } };
    if (lockedRow.user_id !== userId) {
      return { status: 403, body: { error: 'Only the character owner can sync from D&D Beyond.' } };
    }
    if (lockedRow.dndbeyond_id !== ddbId) {
      return { status: 409, body: { error: 'Character D&D Beyond link changed while syncing.' } };
    }

    const lockedUpdate = buildMergeUpdate({
      existing: lockedRow,
      incoming: fresh as unknown as Record<string, unknown>,
      raw: ddbJson,
    });
    const lockedSetClause = lockedUpdate.columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
    lockedUpdate.values.push(characterId);
    await client.query(
      `UPDATE characters SET ${lockedSetClause}, updated_at = NOW()::text WHERE id = $${lockedUpdate.values.length}`,
      lockedUpdate.values
    );

    const { rows: updatedRows } = await client.query('SELECT * FROM characters WHERE id = $1', [
      characterId,
    ]);
    return { status: 200, body: dbRowToCharacter(updatedRows[0] as Record<string, unknown>) };
  });

  if (result.status === 200) characterCache.delete(ddbId);
  res.status(result.status).json(result.body);
});

export default router;
