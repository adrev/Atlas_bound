import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import { createSessionSchema, joinSessionSchema } from '../utils/validation.js';
import { DEFAULT_SESSION_SETTINGS } from '@dnd-vtt/shared';

const router = Router();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getUniqueRoomCode(): string {
  const checkStmt = db.prepare('SELECT 1 FROM sessions WHERE room_code = ?');
  let code: string;
  let attempts = 0;
  do {
    code = generateRoomCode();
    attempts++;
    if (attempts > 100) throw new Error('Failed to generate unique room code');
  } while (checkStmt.get(code));
  return code;
}

// POST /api/sessions - Create a new session
router.post('/', (req: Request, res: Response) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { name } = parsed.data;

  // Use authenticated user's ID (requireAuth guarantees req.user exists)
  const userId = req.user!.id;
  const sessionId = uuidv4();
  const roomCode = getUniqueRoomCode();
  const settings = JSON.stringify(DEFAULT_SESSION_SETTINGS);

  const createSession = db.prepare(
    'INSERT INTO sessions (id, name, room_code, dm_user_id, settings) VALUES (?, ?, ?, ?, ?)'
  );
  const addPlayer = db.prepare(
    'INSERT INTO session_players (session_id, user_id, role) VALUES (?, ?, ?)'
  );

  const transaction = db.transaction(() => {
    createSession.run(sessionId, name, roomCode, userId, settings);
    addPlayer.run(sessionId, userId, 'dm');
  });

  transaction();

  res.status(201).json({
    sessionId,
    roomCode,
    userId,
  });
});

// POST /api/sessions/join - Join a session by room code
router.post('/join', (req: Request, res: Response) => {
  const parsed = joinSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { roomCode } = parsed.data;

  const session = db.prepare(
    'SELECT id, name, room_code, dm_user_id FROM sessions WHERE room_code = ?'
  ).get(roomCode) as { id: string; name: string; room_code: string; dm_user_id: string } | undefined;

  if (!session) {
    res.status(404).json({ error: 'Session not found with that room code' });
    return;
  }

  // Use authenticated user's ID
  const userId = req.user!.id;

  // Check if this user is already in this session (reconnect)
  const existingPlayer = db.prepare(`
    SELECT sp.user_id, sp.role
    FROM session_players sp
    WHERE sp.session_id = ? AND sp.user_id = ?
  `).get(session.id, userId) as { user_id: string; role: string } | undefined;

  if (!existingPlayer) {
    // New user joining
    const addPlayer = db.prepare(
      'INSERT OR IGNORE INTO session_players (session_id, user_id, role) VALUES (?, ?, ?)'
    );
    addPlayer.run(session.id, userId, 'player');
  }

  res.json({
    sessionId: session.id,
    userId,
    sessionName: session.name,
    roomCode: session.room_code,
  });
});

// GET /api/sessions/mine - List sessions the current user belongs to
router.get('/mine', (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.json([]); return; }

  const rows = db.prepare(`
    SELECT s.id, s.name, s.room_code, sp.role,
           (SELECT COUNT(*) FROM session_players WHERE session_id = s.id) as player_count,
           s.created_at
    FROM session_players sp
    JOIN sessions s ON sp.session_id = s.id
    WHERE sp.user_id = ?
    ORDER BY s.created_at DESC
  `).all(userId) as Array<Record<string, unknown>>;

  res.json(rows.map(r => ({
    id: r.id, name: r.name, roomCode: r.room_code,
    role: r.role, playerCount: r.player_count, createdAt: r.created_at,
  })));
});

// DELETE /api/sessions/:id/leave - Leave a session
router.delete('/:id/leave', (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  db.prepare('DELETE FROM session_players WHERE session_id = ? AND user_id = ?')
    .run(req.params.id, userId);
  res.json({ success: true });
});

// POST /api/sessions/:id/link-character - Link a character to a player in this session
router.post('/:id/link-character', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const { userId, characterId } = req.body || {};
  if (!userId || !characterId) {
    res.status(400).json({ error: 'userId and characterId required' });
    return;
  }
  db.prepare('UPDATE session_players SET character_id = ? WHERE session_id = ? AND user_id = ?')
    .run(characterId, sessionId, userId);
  res.json({ success: true });
});

// GET /api/sessions/:id - Get session details
router.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const session = db.prepare(`
    SELECT id, name, room_code, dm_user_id, current_map_id, combat_active, game_mode, settings, created_at, updated_at
    FROM sessions WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const players = db.prepare(`
    SELECT sp.user_id, sp.role, sp.character_id, u.display_name, u.avatar_url
    FROM session_players sp
    JOIN users u ON u.id = sp.user_id
    WHERE sp.session_id = ?
  `).all(id) as Array<{
    user_id: string;
    role: string;
    character_id: string | null;
    display_name: string;
    avatar_url: string | null;
  }>;

  const maps = db.prepare(`
    SELECT id, name, image_url, width, height, grid_size, created_at
    FROM maps WHERE session_id = ?
    ORDER BY created_at DESC
  `).all(id);

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
