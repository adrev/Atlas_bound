import { Router, type Request, type Response, type NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import { mapUpload } from './uploads.js';
import { createMapSchema } from '../utils/validation.js';

const router = Router();

// POST /api/sessions/:sessionId/maps - Create a new map
// Supports both JSON body (for prebuilt maps) and multipart form (for image uploads)
router.post(
  '/sessions/:sessionId/maps',
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      mapUpload.single('image')(req, res, next);
    } else {
      next();
    }
  },
  (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId);

    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const parsed = createMapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { name, width, height, gridSize, gridType, prebuiltKey } = parsed.data;

    // ── Prebuilt dedup ────────────────────────────────────────────
    // When the client passes a prebuiltKey it's saying "this is a
    // reload of the same template, reuse if it exists". Dedup by
    // exact name match within the same session. This lets the DM
    // click "Load Goblin Camp" twice without losing any walls / fog /
    // tokens they already set up on the first instance.
    if (prebuiltKey) {
      const existing = db.prepare(
        'SELECT * FROM maps WHERE session_id = ? AND name = ? LIMIT 1',
      ).get(sessionId, name) as Record<string, unknown> | undefined;
      if (existing) {
        res.status(200).json({
          id: existing.id,
          sessionId: existing.session_id,
          name: existing.name,
          imageUrl: existing.image_url,
          width: existing.width,
          height: existing.height,
          gridSize: existing.grid_size,
          gridType: existing.grid_type,
          gridOffsetX: existing.grid_offset_x,
          gridOffsetY: existing.grid_offset_y,
          walls: JSON.parse(existing.walls as string),
          fogState: JSON.parse(existing.fog_state as string),
          createdAt: existing.created_at,
          reused: true,
        });
        return;
      }
    }

    const mapId = uuidv4();
    const imageUrl = req.file ? `/uploads/maps/${req.file.filename}` : null;

    db.prepare(`
      INSERT INTO maps (id, session_id, name, image_url, width, height, grid_size, grid_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(mapId, sessionId, name, imageUrl, width, height, gridSize, gridType);

    const map = db.prepare('SELECT * FROM maps WHERE id = ?').get(mapId) as Record<string, unknown>;

    res.status(201).json({
      id: map.id,
      sessionId: map.session_id,
      name: map.name,
      imageUrl: map.image_url,
      width: map.width,
      height: map.height,
      gridSize: map.grid_size,
      gridType: map.grid_type,
      gridOffsetX: map.grid_offset_x,
      gridOffsetY: map.grid_offset_y,
      walls: JSON.parse(map.walls as string),
      fogState: JSON.parse(map.fog_state as string),
      createdAt: map.created_at,
      reused: false,
    });
  },
);

// GET /api/sessions/:sessionId/maps - List maps for a session
router.get('/sessions/:sessionId/maps', (req: Request, res: Response) => {
  const { sessionId } = req.params;

  const maps = db.prepare(`
    SELECT id, session_id, name, image_url, width, height, grid_size, grid_type, created_at
    FROM maps WHERE session_id = ?
    ORDER BY created_at DESC
  `).all(sessionId) as Array<Record<string, unknown>>;

  res.json(
    maps.map(m => ({
      id: m.id,
      sessionId: m.session_id,
      name: m.name,
      imageUrl: m.image_url,
      width: m.width,
      height: m.height,
      gridSize: m.grid_size,
      gridType: m.grid_type,
      createdAt: m.created_at,
    })),
  );
});

// GET /api/maps/:id - Get a single map with tokens
router.get('/maps/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const map = db.prepare('SELECT * FROM maps WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!map) {
    res.status(404).json({ error: 'Map not found' });
    return;
  }

  const tokens = db.prepare('SELECT * FROM tokens WHERE map_id = ?').all(id) as Array<Record<string, unknown>>;

  res.json({
    id: map.id,
    sessionId: map.session_id,
    name: map.name,
    imageUrl: map.image_url,
    width: map.width,
    height: map.height,
    gridSize: map.grid_size,
    gridType: map.grid_type,
    gridOffsetX: map.grid_offset_x,
    gridOffsetY: map.grid_offset_y,
    walls: JSON.parse(map.walls as string),
    fogState: JSON.parse(map.fog_state as string),
    createdAt: map.created_at,
    tokens: tokens.map(t => ({
      id: t.id,
      mapId: t.map_id,
      characterId: t.character_id,
      name: t.name,
      x: t.x,
      y: t.y,
      size: t.size,
      imageUrl: t.image_url,
      color: t.color,
      layer: t.layer,
      visible: Boolean(t.visible),
      hasLight: Boolean(t.has_light),
      lightRadius: t.light_radius,
      lightDimRadius: t.light_dim_radius,
      lightColor: t.light_color,
      conditions: JSON.parse(t.conditions as string),
      ownerUserId: t.owner_user_id,
      createdAt: t.created_at,
    })),
  });
});

// DELETE /api/maps/:id - Delete a map
router.delete('/maps/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const map = db.prepare('SELECT id FROM maps WHERE id = ?').get(id);
  if (!map) {
    res.status(404).json({ error: 'Map not found' });
    return;
  }

  db.prepare('DELETE FROM tokens WHERE map_id = ?').run(id);
  db.prepare('DELETE FROM maps WHERE id = ?').run(id);

  res.json({ success: true });
});

export default router;
