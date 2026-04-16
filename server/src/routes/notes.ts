import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import pool from '../db/connection.js';
import { getAuthUserId, assertSessionDM, assertSessionMember } from '../utils/authorization.js';

const router = Router();

// Shared Zod schemas for session note mutations. The notes endpoints
// previously accepted arbitrary `title` / `content` shapes, which meant
// a malformed or oversized payload would still reach the DB layer
// before failing. These caps match the UI's input limits.
const NOTE_CATEGORIES = ['general', 'npc', 'location', 'quest', 'loot', 'session-recap'] as const;
const createNoteSchema = z.object({
  title: z.string().max(200).optional(),
  content: z.string().max(50_000).optional(),
  category: z.enum(NOTE_CATEGORIES).optional(),
});
const updateNoteSchema = z.object({
  title: z.string().max(200).optional(),
  content: z.string().max(50_000).optional(),
  category: z.enum(NOTE_CATEGORIES).optional(),
  isShared: z.boolean().optional(),
});

// GET /api/sessions/:sessionId/notes — list notes for a session
router.get('/sessions/:sessionId/notes', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.sessionId);

  await assertSessionMember(sessionId, userId);

  // Check if user is DM
  const { rows: roleRows } = await pool.query(
    "SELECT role FROM session_players WHERE session_id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  const isDM = roleRows[0]?.role === 'dm';

  let rows;
  if (isDM) {
    // DM sees all notes
    ({ rows } = await pool.query(
      'SELECT * FROM session_notes WHERE session_id = $1 ORDER BY created_at DESC',
      [sessionId],
    ));
  } else {
    // Players see only shared notes
    ({ rows } = await pool.query(
      'SELECT * FROM session_notes WHERE session_id = $1 AND is_shared = 1 ORDER BY created_at DESC',
      [sessionId],
    ));
  }

  res.json(rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    sessionId: r.session_id,
    title: r.title,
    content: r.content,
    category: r.category,
    isShared: r.is_shared === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
});

// POST /api/sessions/:sessionId/notes — create a note (DM only)
router.post('/sessions/:sessionId/notes', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.sessionId);

  await assertSessionDM(sessionId, userId);

  const parsed = createNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid note payload', details: parsed.error.issues });
    return;
  }
  const { title, content, category } = parsed.data;
  const id = uuidv4();
  const cat = category ?? 'general';

  await pool.query(
    `INSERT INTO session_notes (id, session_id, title, content, category, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, sessionId, title || 'Untitled', content || '', cat, userId],
  );

  res.status(201).json({
    id,
    sessionId,
    title: title || 'Untitled',
    content: content || '',
    category: cat,
    isShared: false,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

// PUT /api/notes/:id — update a note (DM only)
router.put('/notes/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  // Look up the note to get its session
  const { rows: noteRows } = await pool.query('SELECT session_id FROM session_notes WHERE id = $1', [id]);
  if (noteRows.length === 0) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const sessionId = noteRows[0].session_id as string;
  await assertSessionDM(sessionId, userId);

  const parsed = updateNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid note payload', details: parsed.error.issues });
    return;
  }
  const { title, content, category, isShared } = parsed.data;

  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (title !== undefined) {
    updates.push(`title = $${paramIndex++}`);
    values.push(title);
  }
  if (content !== undefined) {
    updates.push(`content = $${paramIndex++}`);
    values.push(content);
  }
  if (category !== undefined) {
    updates.push(`category = $${paramIndex++}`);
    values.push(category);
  }
  if (isShared !== undefined) {
    updates.push(`is_shared = $${paramIndex++}`);
    values.push(isShared ? 1 : 0);
  }
  updates.push(`updated_at = $${paramIndex++}`);
  values.push(new Date().toISOString());

  values.push(id);

  await pool.query(
    `UPDATE session_notes SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values,
  );

  res.json({ success: true });
});

// DELETE /api/notes/:id — delete a note (DM only)
router.delete('/notes/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  const { rows: noteRows } = await pool.query('SELECT session_id FROM session_notes WHERE id = $1', [id]);
  if (noteRows.length === 0) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const sessionId = noteRows[0].session_id as string;
  await assertSessionDM(sessionId, userId);

  await pool.query('DELETE FROM session_notes WHERE id = $1', [id]);
  res.json({ success: true });
});

// PATCH /api/notes/:id/share — toggle shared status (DM only)
router.patch('/notes/:id/share', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  const { rows: noteRows } = await pool.query('SELECT session_id, is_shared FROM session_notes WHERE id = $1', [id]);
  if (noteRows.length === 0) {
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const sessionId = noteRows[0].session_id as string;
  await assertSessionDM(sessionId, userId);

  const newShared = noteRows[0].is_shared === 1 ? 0 : 1;
  await pool.query('UPDATE session_notes SET is_shared = $1, updated_at = $2 WHERE id = $3', [
    newShared, new Date().toISOString(), id,
  ]);

  res.json({ isShared: newShared === 1 });
});

export default router;
