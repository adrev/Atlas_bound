import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { getAuthUserId, assertSessionDM } from '../utils/authorization.js';
import { createEncounterSchema } from '../utils/validation.js';
import { safeParseJSON } from '../utils/safeJson.js';

type EncounterCreature = { slug: string; name: string; count: number };

const router = Router();

// GET /api/sessions/:sessionId/encounters — list presets (DM only)
router.get('/sessions/:sessionId/encounters', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.sessionId);
  await assertSessionDM(sessionId, userId);

  const { rows } = await pool.query(
    'SELECT * FROM encounter_presets WHERE session_id = $1 ORDER BY created_at DESC',
    [sessionId],
  );

  // Parse the creatures JSON column for each row
  const presets = rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    creatures: safeParseJSON<EncounterCreature[]>(row.creatures, [], 'encounter_presets.creatures'),
    createdAt: row.created_at,
  }));

  res.json(presets);
});

// POST /api/sessions/:sessionId/encounters — create preset (DM only)
router.post('/sessions/:sessionId/encounters', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.sessionId);
  await assertSessionDM(sessionId, userId);

  const parsed = createEncounterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { name, creatures } = parsed.data;
  const id = uuidv4();

  await pool.query(
    'INSERT INTO encounter_presets (id, session_id, name, creatures) VALUES ($1, $2, $3, $4)',
    [id, sessionId, name, JSON.stringify(creatures)],
  );

  res.status(201).json({
    id,
    sessionId,
    name,
    creatures,
  });
});

// DELETE /api/encounters/:id — delete preset (DM only)
router.delete('/encounters/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const presetId = String(req.params.id);

  // Look up the preset to find its session, then assert DM
  const { rows } = await pool.query(
    'SELECT session_id FROM encounter_presets WHERE id = $1',
    [presetId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Encounter preset not found' });
    return;
  }

  await assertSessionDM(rows[0].session_id as string, userId);

  await pool.query('DELETE FROM encounter_presets WHERE id = $1', [presetId]);
  res.json({ success: true });
});

// POST /api/encounters/:id/deploy — deploy to map (DM only)
// Returns the list of creatures to spawn. Token creation is done client-side.
router.post('/encounters/:id/deploy', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const presetId = String(req.params.id);

  const { rows } = await pool.query(
    'SELECT * FROM encounter_presets WHERE id = $1',
    [presetId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Encounter preset not found' });
    return;
  }

  const preset = rows[0];
  await assertSessionDM(preset.session_id as string, userId);

  const creatures = safeParseJSON<EncounterCreature[]>(
    preset.creatures,
    [],
    'encounter_presets.creatures',
  );

  res.json({
    id: preset.id,
    name: preset.name,
    creatures,
  });
});

export default router;
