import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { mapUpload, validateAndSaveUpload, saveMapThumbnail } from './uploads.js';
import { createMapSchema } from '../utils/validation.js';
import { getAuthUserId, assertSessionDM, assertSessionMember } from '../utils/authorization.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { rowToToken } from '../utils/tokenMapper.js';

const router = Router();

// POST /api/sessions/:sessionId/maps
router.post(
  '/sessions/:sessionId/maps',
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      // `image` = full-resolution map. `thumbnail` = optional 480-px JPEG
      // generated client-side; if absent we just skip thumbnail storage
      // and the Scene Manager falls back to the full image. fields()
      // gives us req.files keyed by field name instead of req.file.
      mapUpload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 },
      ])(req, res, next);
    } else {
      next();
    }
  },
  async (req: Request, res: Response) => {
    const userId = getAuthUserId(req);
    const sessionId = String(req.params.sessionId);

    const { rows: sessionRows } = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    if (sessionRows.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await assertSessionDM(sessionId, userId);

    const parsed = createMapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { name, width, height, gridSize, gridType, prebuiltKey } = parsed.data;

    if (prebuiltKey) {
      const { rows: existingRows } = await pool.query(
        'SELECT * FROM maps WHERE session_id = $1 AND name = $2 LIMIT 1',
        [sessionId, name],
      );
      const existing = existingRows[0] as Record<string, unknown> | undefined;
      if (existing) {
        res.status(200).json({
          id: existing.id,
          sessionId: existing.session_id,
          name: existing.name,
          imageUrl: existing.image_url,
          thumbnailUrl: existing.thumbnail_url,
          width: existing.width,
          height: existing.height,
          gridSize: existing.grid_size,
          gridType: existing.grid_type,
          gridOffsetX: existing.grid_offset_x,
          gridOffsetY: existing.grid_offset_y,
          walls: safeParseJSON<unknown[]>(existing.walls, [], 'maps.walls'),
          fogState: safeParseJSON<unknown[]>(existing.fog_state, [], 'maps.fog_state'),
          createdAt: existing.created_at,
          reused: true,
        });
        return;
      }
    }

    const mapId = uuidv4();
    let imageUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    // multer.fields() puts files in req.files keyed by field name.
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
    const imageFile = files.image?.[0];
    const thumbnailFile = files.thumbnail?.[0];
    if (imageFile) {
      try {
        const filename = validateAndSaveUpload(imageFile, 'maps');
        imageUrl = `/uploads/maps/${filename}`;
        // Pair the thumbnail with the original by reusing its UUID
        // stem so the auth middleware can lift one from the other if
        // needed. Thumbnail save failures never block the upload —
        // worst case the Scene Manager falls back to the full PNG.
        if (thumbnailFile) {
          try {
            const baseUuid = path.parse(filename).name;
            const thumbName = saveMapThumbnail(thumbnailFile, baseUuid);
            thumbnailUrl = `/uploads/maps/thumbnails/${thumbName}`;
          } catch (err) {
            console.warn('[maps:create] thumbnail save failed:', err);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid image file';
        res.status(400).json({ error: msg });
        return;
      }
    }

    await pool.query(`
      INSERT INTO maps (id, session_id, name, image_url, thumbnail_url, width, height, grid_size, grid_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [mapId, sessionId, name, imageUrl, thumbnailUrl, width, height, gridSize, gridType]);

    const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1', [mapId]);
    const map = mapRows[0] as Record<string, unknown>;

    res.status(201).json({
      id: map.id,
      sessionId: map.session_id,
      name: map.name,
      imageUrl: map.image_url,
      thumbnailUrl: map.thumbnail_url,
      width: map.width,
      height: map.height,
      gridSize: map.grid_size,
      gridType: map.grid_type,
      gridOffsetX: map.grid_offset_x,
      gridOffsetY: map.grid_offset_y,
      walls: safeParseJSON<unknown[]>(map.walls, [], 'maps.walls'),
      fogState: safeParseJSON<unknown[]>(map.fog_state, [], 'maps.fog_state'),
      createdAt: map.created_at,
      reused: false,
    });
  },
);

// GET /api/sessions/:sessionId/maps
router.get('/sessions/:sessionId/maps', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.sessionId);

  await assertSessionMember(sessionId, userId);

  // Check whether the caller is the DM of this session. Players should
  // only ever see the map(s) they are currently on — never DM prep
  // scenes or preview maps.
  const { rows: roleRows } = await pool.query(
    'SELECT role FROM session_players WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  const isDM = roleRows[0]?.role === 'dm';

  let maps: Array<Record<string, unknown>>;
  if (isDM) {
    const { rows } = await pool.query(`
      SELECT id, session_id, name, image_url, thumbnail_url, width, height, grid_size, grid_type, created_at
      FROM maps WHERE session_id = $1
      ORDER BY created_at DESC
    `, [sessionId]);
    maps = rows;
  } else {
    const { rows: sessionRows } = await pool.query(
      'SELECT player_map_id FROM sessions WHERE id = $1',
      [sessionId],
    );
    // Players get the ribbon map only — never `current_map_id`,
    // which on legacy sessions can still be pointing at a DM preview
    // from before the preview-isolation fix shipped. If the ribbon
    // has never been set, players simply see an empty list and
    // wait for the DM to "Move Players Here".
    const playerMapId =
      (sessionRows[0]?.player_map_id as string | null | undefined) ?? null;
    if (!playerMapId) {
      res.json([]);
      return;
    }
    const { rows } = await pool.query(`
      SELECT id, session_id, name, image_url, width, height, grid_size, grid_type, created_at
      FROM maps WHERE id = $1 AND session_id = $2
    `, [playerMapId, sessionId]);
    maps = rows;
  }

  res.json(
    maps.map(m => ({
      id: m.id,
      sessionId: m.session_id,
      name: m.name,
      imageUrl: m.image_url,
      thumbnailUrl: m.thumbnail_url,
      width: m.width,
      height: m.height,
      gridSize: m.grid_size,
      gridType: m.grid_type,
      createdAt: m.created_at,
    })),
  );
});

// GET /api/maps/:id
router.get('/maps/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1', [id]);
  if (mapRows.length === 0) {
    res.status(404).json({ error: 'Map not found' });
    return;
  }
  const map = mapRows[0] as Record<string, unknown>;

  const mapSessionId = String(map.session_id);
  await assertSessionMember(mapSessionId, userId);

  // Players must only see the map currently active for the players —
  // never a DM's prep/preview scene.
  const { rows: roleRows } = await pool.query(
    'SELECT role FROM session_players WHERE session_id = $1 AND user_id = $2',
    [mapSessionId, userId],
  );
  const isDM = roleRows[0]?.role === 'dm';
  if (!isDM) {
    const { rows: sessionRows } = await pool.query(
      'SELECT player_map_id FROM sessions WHERE id = $1',
      [mapSessionId],
    );
    // Players must see only the ribbon map. The legacy fallback to
    // `current_map_id` used to leak DM prep scenes on sessions that
    // pre-date the preview isolation split.
    const activeMapId =
      (sessionRows[0]?.player_map_id as string | null | undefined) ?? null;
    if (!activeMapId || activeMapId !== id) {
      res.status(403).json({ error: 'Not authorized to view this map' });
      return;
    }
  }

  const { rows: tokens } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [id]);

  res.json({
    id: map.id,
    sessionId: map.session_id,
    name: map.name,
    imageUrl: map.image_url,
    thumbnailUrl: map.thumbnail_url,
    width: map.width,
    height: map.height,
    gridSize: map.grid_size,
    gridType: map.grid_type,
    gridOffsetX: map.grid_offset_x,
    gridOffsetY: map.grid_offset_y,
    walls: safeParseJSON<unknown[]>(map.walls, [], 'maps.walls'),
    fogState: safeParseJSON<unknown[]>(map.fog_state, [], 'maps.fog_state'),
    createdAt: map.created_at,
    tokens: tokens.map(rowToToken),
  });
});

// DELETE /api/maps/:id
router.delete('/maps/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  const { rows } = await pool.query('SELECT id, session_id FROM maps WHERE id = $1', [id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'Map not found' });
    return;
  }

  await assertSessionDM(rows[0].session_id, userId);

  await pool.query('DELETE FROM tokens WHERE map_id = $1', [id]);
  await pool.query('DELETE FROM maps WHERE id = $1', [id]);

  res.json({ success: true });
});

export default router;
