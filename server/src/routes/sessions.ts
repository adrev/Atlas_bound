import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { createSessionSchema, joinSessionSchema } from '../utils/validation.js';
import { DEFAULT_SESSION_SETTINGS } from '@dnd-vtt/shared';
import { getAuthUserId, assertSessionMember, assertSessionDM } from '../utils/authorization.js';

const router = Router();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function getUniqueRoomCode(): Promise<string> {
  let code: string;
  let attempts = 0;
  do {
    code = generateRoomCode();
    attempts++;
    if (attempts > 100) throw new Error('Failed to generate unique room code');
    const { rows } = await pool.query('SELECT 1 FROM sessions WHERE room_code = $1', [code]);
    if (rows.length === 0) return code;
  } while (true);
}

// POST /api/sessions - Create a new session
router.post('/', async (req: Request, res: Response) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { name } = parsed.data;
  const userId = req.user!.id;
  const sessionId = uuidv4();
  const roomCode = await getUniqueRoomCode();
  const settings = JSON.stringify(DEFAULT_SESSION_SETTINGS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO sessions (id, name, room_code, dm_user_id, settings) VALUES ($1, $2, $3, $4, $5)',
      [sessionId, name, roomCode, userId, settings],
    );
    await client.query(
      'INSERT INTO session_players (session_id, user_id, role) VALUES ($1, $2, $3)',
      [sessionId, userId, 'dm'],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({
    sessionId,
    roomCode,
    userId,
  });
});

// POST /api/sessions/join - Join a session by room code
router.post('/join', async (req: Request, res: Response) => {
  const parsed = joinSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { roomCode } = parsed.data;

  const { rows: sessionRows } = await pool.query(
    'SELECT id, name, room_code, dm_user_id FROM sessions WHERE room_code = $1',
    [roomCode],
  );
  const session = sessionRows[0] as { id: string; name: string; room_code: string; dm_user_id: string } | undefined;

  if (!session) {
    res.status(404).json({ error: 'Session not found with that room code' });
    return;
  }

  const userId = req.user!.id;

  const { rows: existingRows } = await pool.query(
    'SELECT sp.user_id, sp.role FROM session_players sp WHERE sp.session_id = $1 AND sp.user_id = $2',
    [session.id, userId],
  );

  if (existingRows.length === 0) {
    await pool.query(
      'INSERT INTO session_players (session_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [session.id, userId, 'player'],
    );
  }

  res.json({
    sessionId: session.id,
    userId,
    sessionName: session.name,
    roomCode: session.room_code,
  });
});

// GET /api/sessions/mine - List sessions the current user belongs to
router.get('/mine', async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.json([]); return; }

  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.room_code, sp.role,
           (SELECT COUNT(*) FROM session_players WHERE session_id = s.id) as player_count,
           s.created_at
    FROM session_players sp
    JOIN sessions s ON sp.session_id = s.id
    WHERE sp.user_id = $1
    ORDER BY s.created_at DESC
  `, [userId]);

  res.json(rows.map(r => ({
    id: r.id, name: r.name, roomCode: r.room_code,
    role: r.role, playerCount: r.player_count, createdAt: r.created_at,
  })));
});

// DELETE /api/sessions/:id/leave - Leave a session
router.delete('/:id/leave', async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  await pool.query('DELETE FROM session_players WHERE session_id = $1 AND user_id = $2',
    [req.params.id, userId]);
  res.json({ success: true });
});

// POST /api/sessions/:id/link-character - Link a character to a player in this session
router.post('/:id/link-character', async (req: Request, res: Response) => {
  const authUserId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  const { userId, characterId } = req.body || {};
  if (!userId || !characterId) {
    res.status(400).json({ error: 'userId and characterId required' });
    return;
  }

  // Must be a member of the session
  await assertSessionMember(sessionId, authUserId);

  // Players can only link characters to themselves; DM can link for anyone
  if (userId !== authUserId) {
    await assertSessionDM(sessionId, authUserId);
  }

  // Verify the character exists and is owned by the target player (or caller is DM)
  const { rows: charRows } = await pool.query('SELECT user_id FROM characters WHERE id = $1', [characterId]);
  if (charRows.length === 0) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  if (charRows[0].user_id !== userId) {
    // DM can link any character; players can only link their own
    const { rows: dmCheck } = await pool.query(
      "SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2 AND role = 'dm'",
      [sessionId, authUserId],
    );
    if (dmCheck.length === 0) {
      res.status(403).json({ error: 'Can only link your own characters' });
      return;
    }
  }

  await pool.query('UPDATE session_players SET character_id = $1 WHERE session_id = $2 AND user_id = $3',
    [characterId, sessionId, userId]);
  res.json({ success: true });
});

// GET /api/sessions/:id - Get session details
router.get('/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  await assertSessionMember(String(id), userId);

  const { rows: sessionRows } = await pool.query(`
    SELECT id, name, room_code, dm_user_id, current_map_id, combat_active, game_mode, settings, created_at, updated_at
    FROM sessions WHERE id = $1
  `, [id]);
  const session = sessionRows[0] as Record<string, unknown> | undefined;

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const { rows: players } = await pool.query(`
    SELECT sp.user_id, sp.role, sp.character_id, u.display_name, u.avatar_url
    FROM session_players sp
    JOIN users u ON u.id = sp.user_id
    WHERE sp.session_id = $1
  `, [id]);

  const { rows: maps } = await pool.query(`
    SELECT id, name, image_url, width, height, grid_size, created_at
    FROM maps WHERE session_id = $1
    ORDER BY created_at DESC
  `, [id]);

  res.json({
    id: session.id,
    name: session.name,
    roomCode: session.room_code,
    dmUserId: session.dm_user_id,
    currentMapId: session.current_map_id,
    combatActive: Boolean(session.combat_active),
    gameMode: session.game_mode,
    settings: JSON.parse(session.settings as string),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    players: players.map(p => ({
      userId: p.user_id,
      displayName: p.display_name,
      avatarUrl: p.avatar_url,
      role: p.role,
      characterId: p.character_id,
      connected: false,
    })),
    maps,
  });
});

export default router;
