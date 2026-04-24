import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import rateLimit from 'express-rate-limit';
import pool from '../db/connection.js';
import {
  createSessionSchema, joinSessionSchema, patchSessionSchema,
  transferOwnershipSchema, sessionPromoteSchema, sessionDemoteSchema,
} from '../utils/validation.js';
import { DEFAULT_SESSION_SETTINGS } from '@dnd-vtt/shared';
import {
  getAuthUserId, assertSessionMember, assertSessionDM, assertSessionOwner,
} from '../utils/authorization.js';
import {
  hashSessionPassword, verifySessionPassword, generateInviteCode,
} from '../utils/sessionPassword.js';
import { getIO } from '../socket/ioInstance.js';
import { getRoom, removePlayerFromRoom } from '../utils/roomState.js';
import { safeParseJSON } from '../utils/safeJson.js';

const router = Router();

// 32-char alphabet excluding 0/O and 1/I for readability.
// 8 chars × log2(32) = 40 bits of entropy per code.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 8;

export function generateRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

// Rate-limit room-code join attempts to prevent code enumeration.
const joinLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'Too many join attempts. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
  validate: false, // Cloud Run proxies set X-Forwarded-For
});

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

  const { name, visibility: rawVisibility, password } = parsed.data;
  const visibility = rawVisibility ?? 'public';

  // A private session without a password is allowed (invite-only mode),
  // but if the client DID send a password it must meet the min-length
  // requirement already enforced by the schema. Reject the obviously
  // confused case of a public session with a password \u2014 the password
  // would never be checked and the UI would lie to users.
  if (visibility === 'public' && password !== undefined && password !== '') {
    res.status(400).json({ error: 'Public sessions cannot have a password' });
    return;
  }

  const userId = req.user!.id;
  const sessionId = uuidv4();
  const roomCode = await getUniqueRoomCode();
  const settings = JSON.stringify(DEFAULT_SESSION_SETTINGS);
  const passwordHash = password && visibility === 'private'
    ? await hashSessionPassword(password)
    : null;
  // Every session gets an invite code up-front so the DM can share the
  // link later without a second round-trip. Public sessions just don't
  // display it prominently.
  const inviteCode = generateInviteCode();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO sessions (id, name, room_code, dm_user_id, settings, visibility, password_hash, invite_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sessionId, name, roomCode, userId, settings, visibility, passwordHash, inviteCode],
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
    visibility,
    hasPassword: passwordHash !== null,
    inviteCode,
  });
});

// POST /api/sessions/join - Join a session by room code.
// Decision tree (in order):
//   1. Session missing              \u2192 404
//   2. Requester is banned          \u2192 403 with reason
//   3. Requester already a member   \u2192 OK (role-independent; no pw needed)
//   4. visibility === 'public'      \u2192 OK, insert as player
//   5. visibility === 'private':
//        a. valid inviteToken       \u2192 OK, insert as player
//        b. password matches        \u2192 OK, insert as player
//        c. otherwise               \u2192 401 { requiresPassword: true }
router.post('/join', joinLimiter, async (req: Request, res: Response) => {
  const parsed = joinSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { password, inviteToken } = parsed.data;
  // Normalize so lowercase input still matches (codes are generated uppercase).
  const roomCode = parsed.data.roomCode.toUpperCase();

  const { rows: sessionRows } = await pool.query(
    `SELECT id, name, room_code, dm_user_id, visibility, password_hash, invite_code
       FROM sessions WHERE room_code = $1`,
    [roomCode],
  );
  const session = sessionRows[0] as {
    id: string; name: string; room_code: string; dm_user_id: string;
    visibility: string; password_hash: string | null; invite_code: string | null;
  } | undefined;

  if (!session) {
    res.status(404).json({ error: 'Session not found with that room code' });
    return;
  }

  const userId = req.user!.id;

  // Ban check first \u2014 banned users get the most specific error so they
  // know why they can't get in (rather than fumbling with a password).
  const { rows: banRows } = await pool.query(
    `SELECT b.banned_at, b.reason, bu.display_name AS banned_by_name
       FROM session_bans b
       LEFT JOIN users bu ON bu.id = b.banned_by
       WHERE b.session_id = $1 AND b.user_id = $2`,
    [session.id, userId],
  );
  if (banRows.length > 0) {
    const b = banRows[0] as { banned_at: string; reason: string | null; banned_by_name: string | null };
    res.status(403).json({
      error: 'banned',
      reason: b.reason,
      bannedBy: b.banned_by_name,
      bannedAt: b.banned_at,
    });
    return;
  }

  const { rows: existingRows } = await pool.query(
    'SELECT user_id, role FROM session_players WHERE session_id = $1 AND user_id = $2',
    [session.id, userId],
  );
  const isAlreadyMember = existingRows.length > 0;

  if (!isAlreadyMember) {
    if (session.visibility === 'private') {
      // Try invite token first (it's a cheaper equality check than
      // the bcrypt compare and lets invite-link users skip the prompt).
      const validInvite = !!inviteToken
        && !!session.invite_code
        && inviteToken === session.invite_code;

      let validPassword = false;
      if (!validInvite && password && session.password_hash) {
        validPassword = await verifySessionPassword(password, session.password_hash);
      }

      if (!validInvite && !validPassword) {
        res.status(401).json({
          error: 'Password required',
          requiresPassword: true,
          hasPassword: !!session.password_hash,
        });
        return;
      }
    }

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

// GET /api/invites/:token - Look up a session by invite token. Used by the
// /join/:token frontend route to resolve the invite before the user hits
// the join form. Doesn't add the user to the session \u2014 the actual
// insertion happens on the subsequent POST /join with the token.
router.get('/invites/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  if (token.length < 10 || token.length > 64) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  const { rows } = await pool.query(
    'SELECT id, name, room_code FROM sessions WHERE invite_code = $1',
    [token],
  );
  const row = rows[0] as { id: string; name: string; room_code: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  res.json({ sessionId: row.id, sessionName: row.name, roomCode: row.room_code });
});

// GET /api/sessions/mine - List sessions the current user belongs to
router.get('/mine', async (req: Request, res: Response) => {
  const userId = req.user?.id;
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

// DELETE /api/sessions/:id - Delete a session (Owner-only). Cascades to
// session_players, maps, tokens, bans, notes, etc. via FK cascades.
// Broadcasts a terminal event so every connected client redirects home.
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionOwner(sessionId, userId);

  // Broadcast BEFORE the row is gone so the event can carry context.
  const io = getIO();
  if (io) io.to(sessionId).emit('session:deleted', { sessionId });

  // Evict EVERY socket for EVERY user — not just primary socketIds.
  // Without this, secondary tabs stay subscribed and stale room state
  // lets getPlayerBySocketId resolve against a deleted session.
  const room = getRoom(sessionId);
  if (room && io) {
    for (const [_userId, sockets] of room.userSockets) {
      for (const sid of sockets) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.leave(sessionId);
      }
    }
    // Also catch any primary socketIds not in userSockets (shouldn't
    // happen, but defense-in-depth).
    for (const player of room.players.values()) {
      const sock = io.sockets.sockets.get(player.socketId);
      if (sock) sock.leave(sessionId);
    }
  }
  // Wipe the room from in-memory state entirely so no socket handler
  // can resolve against it after the DB row is gone.
  if (room) {
    const { deleteRoom } = await import('../utils/roomState.js');
    deleteRoom(sessionId);
  }

  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  res.json({ success: true });
});

// DELETE /api/sessions/:id/leave - Leave a session
router.delete('/:id/leave', async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }

  // Owner must transfer first (or delete the session). Otherwise leaving
  // would orphan every co-DM and player without an authority figure.
  const { rows: ownerRows } = await pool.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND dm_user_id = $2',
    [req.params.id, userId],
  );
  if (ownerRows.length > 0) {
    res.status(409).json({
      error: 'Transfer ownership to another DM before leaving, or delete the session.',
    });
    return;
  }

  await pool.query('DELETE FROM session_players WHERE session_id = $1 AND user_id = $2',
    [req.params.id, userId]);

  // Evict all live sockets for this user from the Socket.IO room +
  // room state. Without this, the user's connected tabs keep receiving
  // broadcasts and can perform socket actions until they refresh —
  // the DB membership is gone but the in-memory state is stale.
  const sessionId = String(req.params.id);
  const room = getRoom(sessionId);
  if (room) {
    const io = getIO();
    if (io) {
      const allSockets: string[] = [];
      const userSocks = room.userSockets.get(userId);
      if (userSocks) for (const sid of userSocks) allSockets.push(sid);
      const primary = room.players.get(userId);
      if (primary && !allSockets.includes(primary.socketId)) allSockets.push(primary.socketId);
      for (const sid of allSockets) {
        io.to(sid).emit('session:kicked', { userId });
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.leave(sessionId);
      }
    }
    removePlayerFromRoom(sessionId, userId);
  }

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

  // Players can only link characters to themselves; DMs may trigger the
  // link on behalf of another player but the character must still be
  // owned by that target player. Previously a DM could type any guessed
  // character id and the server would accept it, "laundering" an
  // unrelated user's PC into the session (after which the session-scoped
  // authorisation helpers — which trust session_players.character_id —
  // would let the session read or mutate that character).
  if (userId !== authUserId) {
    await assertSessionDM(sessionId, authUserId);
  }

  // Target must actually be a member of this session; otherwise we'd
  // be writing a character_id onto a row that doesn't exist.
  const { rows: memberRows } = await pool.query(
    'SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  if (memberRows.length === 0) {
    res.status(404).json({ error: 'Player not in session' });
    return;
  }

  const { rows: charRows } = await pool.query('SELECT user_id FROM characters WHERE id = $1', [characterId]);
  if (charRows.length === 0) {
    res.status(404).json({ error: 'Character not found' });
    return;
  }
  // Strict ownership: the character must belong to the user we are
  // linking it to. DMs do NOT get to bypass this — if a DM needs to
  // hand a PC to a player they should use a dedicated character-
  // transfer flow (not yet built). For now, refuse to link mismatched
  // ownership under any role to close the laundering window.
  if (charRows[0].user_id !== userId) {
    res.status(403).json({ error: 'Character is not owned by the target player' });
    return;
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
    SELECT id, name, room_code, dm_user_id, current_map_id, player_map_id,
           combat_active, game_mode, settings,
           visibility, password_hash, invite_code, created_at, updated_at
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

  // The invite token is DM planning data — a curious player can't see
  // it in the socket state-sync, so we must not leak it via REST either.
  const requesterIsDM = players.some(
    (p) => p.user_id === userId && p.role === 'dm',
  );

  // Scope the maps list to DMs. Players must never receive the prep /
  // preview map list through REST because /uploads/maps/* authorises
  // any session member to load the image by URL — once a player has
  // the image_url of a DM's preview scene, they can see the artwork
  // for encounters the party hasn't walked into yet. Players get only
  // the active player-ribbon map (player_map_id), not the session's
  // legacy current_map_id which may still point at DM prep state from
  // before the preview-isolation fix shipped.
  let maps: Array<Record<string, unknown>> = [];
  if (requesterIsDM) {
    const { rows } = await pool.query(`
      SELECT id, name, image_url, width, height, grid_size, created_at
      FROM maps WHERE session_id = $1
      ORDER BY created_at DESC
    `, [id]);
    maps = rows;
  } else {
    const playerMapId = (session.player_map_id as string | null | undefined) ?? null;
    if (playerMapId) {
      const { rows } = await pool.query(`
        SELECT id, name, image_url, width, height, grid_size, created_at
        FROM maps WHERE id = $1 AND session_id = $2
      `, [playerMapId, id]);
      maps = rows;
    }
  }

  res.json({
    id: session.id,
    name: session.name,
    roomCode: session.room_code,
    dmUserId: session.dm_user_id,
    // currentMapId is DM prep-pointer state. Non-DMs see the player
    // ribbon map in its place (or null when no ribbon is set) so the
    // client still has a single "what map am I on" pointer to consume
    // without needing to know the role distinction.
    currentMapId: requesterIsDM
      ? session.current_map_id
      : ((session.player_map_id as string | null | undefined) ?? null),
    combatActive: Boolean(session.combat_active),
    gameMode: session.game_mode,
    settings: safeParseJSON(session.settings, DEFAULT_SESSION_SETTINGS, 'sessions.settings'),
    visibility: (session.visibility as string) ?? 'public',
    hasPassword: session.password_hash !== null,
    inviteCode: requesterIsDM ? ((session.invite_code as string | null) ?? null) : null,
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

// PATCH /api/sessions/:id  (DM-only)
// Updates name / visibility / password. `regenerateInvite: true` rotates
// the invite_code so the old shareable link stops resolving.
router.patch('/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionDM(sessionId, userId);

  const parsed = patchSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const patch = parsed.data;

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); params.push(patch.name); }
  if (patch.visibility !== undefined) { sets.push(`visibility = $${i++}`); params.push(patch.visibility); }

  if (patch.password !== undefined) {
    if (patch.password === '') {
      sets.push(`password_hash = NULL`);
    } else {
      const hash = await hashSessionPassword(patch.password);
      sets.push(`password_hash = $${i++}`); params.push(hash);
    }
  }

  if (patch.regenerateInvite) {
    // Extremely small collision window — try once, retry on unique-violation.
    let newCode = generateInviteCode();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await pool.query('UPDATE sessions SET invite_code = $1 WHERE id = $2', [newCode, sessionId]);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        newCode = generateInviteCode();
      }
    }
  }

  if (sets.length > 0) {
    sets.push(`updated_at = NOW()::text`);
    params.push(sessionId);
    await pool.query(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $${i}`, params);
  }

  const { rows } = await pool.query(
    'SELECT visibility, password_hash, invite_code FROM sessions WHERE id = $1',
    [sessionId],
  );
  const row = rows[0] as { visibility: string; password_hash: string | null; invite_code: string | null } | undefined;

  // Broadcast to the room so DM clients pick up invite rotation / password
  // toggle without refetching. Invite tokens are DM-only; players only need
  // the visibility/password flags because their membership already survives.
  const io = getIO();
  if (io && row) {
    const room = getRoom(sessionId);
    if (room) {
      for (const player of room.players.values()) {
        io.to(player.socketId).emit('session:settings-changed', {
          visibility: row.visibility,
          hasPassword: row.password_hash !== null,
          inviteCode: player.role === 'dm' ? row.invite_code : null,
        });
      }
    }
  }

  res.json({
    visibility: row?.visibility ?? 'public',
    hasPassword: row?.password_hash != null,
    inviteCode: row?.invite_code ?? null,
  });
});

// ---- Bans -----------------------------------------------------------------

// GET /api/sessions/:id/bans  (member-only)
router.get('/:id/bans', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionMember(sessionId, userId);
  const { rows } = await pool.query(`
    SELECT b.user_id, b.banned_by, b.banned_at, b.reason,
           u.display_name, u.avatar_url,
           bu.display_name AS banned_by_name
    FROM session_bans b
    JOIN users u ON u.id = b.user_id
    LEFT JOIN users bu ON bu.id = b.banned_by
    WHERE b.session_id = $1
    ORDER BY b.banned_at DESC
  `, [sessionId]);
  res.json(rows.map(r => ({
    userId: r.user_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    bannedBy: r.banned_by_name,
    bannedByUserId: r.banned_by,
    bannedAt: r.banned_at,
    reason: r.reason,
  })));
});

// POST /api/sessions/:id/bans  (DM-only)
// Co-DM hierarchy: any DM can ban a player, but cannot ban another DM
// (demote them first). Owner can't be banned by anyone.
router.post('/:id/bans', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionDM(sessionId, userId);

  const parsed = (await import('../utils/validation.js')).sessionBanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const { targetUserId, reason } = parsed.data;

  if (targetUserId === userId) {
    res.status(400).json({ error: 'Cannot ban yourself' });
    return;
  }

  const { rows: targetRows } = await pool.query(
    `SELECT sp.role, s.dm_user_id
       FROM session_players sp
       JOIN sessions s ON s.id = sp.session_id
       WHERE sp.session_id = $1 AND sp.user_id = $2`,
    [sessionId, targetUserId],
  );
  const target = targetRows[0] as { role: string; dm_user_id: string } | undefined;
  if (target) {
    if (target.dm_user_id === targetUserId) {
      res.status(403).json({ error: 'The session owner cannot be banned' });
      return;
    }
    if (target.role === 'dm') {
      res.status(403).json({ error: 'Demote this DM before banning them' });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO session_bans (session_id, user_id, banned_by, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sessionId, targetUserId, userId, reason ?? null],
    );
    await client.query(
      'DELETE FROM session_players WHERE session_id = $1 AND user_id = $2',
      [sessionId, targetUserId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Notify the banned user (so their client shows a modal + disconnects)
  // and broadcast the updated ban list to everyone else.
  const io = getIO();
  if (io) {
    const { rows: banRows } = await pool.query(`
      SELECT b.user_id, b.banned_by, b.banned_at, b.reason,
             u.display_name, u.avatar_url,
             bu.display_name AS banned_by_name
      FROM session_bans b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN users bu ON bu.id = b.banned_by
      WHERE b.session_id = $1
      ORDER BY b.banned_at DESC
    `, [sessionId]);
    const bans = banRows.map(r => ({
      userId: r.user_id, displayName: r.display_name, avatarUrl: r.avatar_url,
      bannedBy: r.banned_by_name, bannedByUserId: r.banned_by,
      bannedAt: r.banned_at, reason: r.reason,
    }));
    // Send the fatal `player-banned` event to the target first so their
    // client has the reason and can redirect. Then broadcast the
    // updated ban list to everyone EXCEPT the banned user \u2014 otherwise
    // they'd briefly see themselves listed as banned before the 1.5s
    // redirect fires.
    const { getRoom, removePlayerFromRoom } = await import('../utils/roomState.js');
    const room = getRoom(sessionId);

    // Collect ALL socket IDs for the banned user BEFORE removing them
    // from room state. Multi-tab users have entries in room.userSockets
    // — if we only evict the primary socketId, secondary tabs keep
    // receiving broadcasts silently.
    const allTargetSockets: string[] = [];
    if (room) {
      const userSocks = room.userSockets.get(targetUserId);
      if (userSocks) for (const sid of userSocks) allTargetSockets.push(sid);
      const primary = room.players.get(targetUserId);
      if (primary && !allTargetSockets.includes(primary.socketId)) {
        allTargetSockets.push(primary.socketId);
      }
    }

    // Emit the ban event to every socket the target has open.
    for (const sid of allTargetSockets) {
      io.to(sid).emit('session:player-banned', { userId: targetUserId, reason: reason ?? null });
    }

    // Everyone else gets the updated ban list.
    let emitter = io.to(sessionId);
    for (const sid of allTargetSockets) emitter = emitter.except(sid);
    emitter.emit('session:bans-updated', { bans });

    // Force every socket out of the Socket.IO room AND remove from
    // room state so they can't passively read broadcasts.
    for (const sid of allTargetSockets) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.leave(sessionId);
    }
    if (room) removePlayerFromRoom(sessionId, targetUserId);
  }

  res.status(204).send();
});

// DELETE /api/sessions/:id/bans/:userId  (DM-only)
router.delete('/:id/bans/:userId', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  const targetUserId = String(req.params.userId);
  await assertSessionDM(sessionId, userId);

  await pool.query(
    'DELETE FROM session_bans WHERE session_id = $1 AND user_id = $2',
    [sessionId, targetUserId],
  );

  const io = getIO();
  if (io) {
    const { rows: banRows } = await pool.query(`
      SELECT b.user_id, b.banned_by, b.banned_at, b.reason,
             u.display_name, u.avatar_url,
             bu.display_name AS banned_by_name
      FROM session_bans b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN users bu ON bu.id = b.banned_by
      WHERE b.session_id = $1
      ORDER BY b.banned_at DESC
    `, [sessionId]);
    const bans = banRows.map(r => ({
      userId: r.user_id, displayName: r.display_name, avatarUrl: r.avatar_url,
      bannedBy: r.banned_by_name, bannedByUserId: r.banned_by,
      bannedAt: r.banned_at, reason: r.reason,
    }));
    io.to(sessionId).emit('session:bans-updated', { bans });
  }

  res.status(204).send();
});

// ---- Role changes (Owner-only) -------------------------------------------

router.post('/:id/promote', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionOwner(sessionId, userId);

  const parsed = sessionPromoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const { targetUserId } = parsed.data;

  const { rows } = await pool.query(
    'UPDATE session_players SET role = $1 WHERE session_id = $2 AND user_id = $3 RETURNING role',
    ['dm', sessionId, targetUserId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Player not in session' });
    return;
  }

  // Sync the in-memory room state so socket handlers that check
  // ctx.player.role see the new role immediately, not on next reconnect.
  const room = getRoom(sessionId);
  if (room) {
    const p = room.players.get(targetUserId);
    if (p) p.role = 'dm';
  }

  const io = getIO();
  if (io) {
    io.to(sessionId).emit('session:role-changed', { userId: targetUserId, role: 'dm' });
  }
  res.status(204).send();
});

router.post('/:id/demote', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionOwner(sessionId, userId);

  const parsed = sessionDemoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const { targetUserId } = parsed.data;

  // The owner cannot demote themselves \u2014 would leave the session in an
  // invalid state (owner with role='player'). They must transfer first.
  if (targetUserId === userId) {
    res.status(400).json({ error: 'Transfer ownership before demoting yourself' });
    return;
  }

  const { rows } = await pool.query(
    'UPDATE session_players SET role = $1 WHERE session_id = $2 AND user_id = $3 RETURNING role',
    ['player', sessionId, targetUserId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Player not in session' });
    return;
  }

  // Sync room state immediately so the demoted user loses DM socket
  // powers without needing to reconnect.
  const room = getRoom(sessionId);
  if (room) {
    const p = room.players.get(targetUserId);
    if (p) p.role = 'player';
  }

  const io = getIO();
  if (io) {
    io.to(sessionId).emit('session:role-changed', { userId: targetUserId, role: 'player' });
  }
  res.status(204).send();
});

// POST /api/sessions/:id/transfer-ownership  (Owner-only)
// Designates a new owner; the old owner stays as a co-DM.
router.post('/:id/transfer-ownership', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionOwner(sessionId, userId);

  const parsed = transferOwnershipSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const { newOwnerId } = parsed.data;

  if (newOwnerId === userId) {
    res.status(400).json({ error: 'You are already the owner' });
    return;
  }

  const { rows: targetRows } = await pool.query(
    'SELECT role FROM session_players WHERE session_id = $1 AND user_id = $2',
    [sessionId, newOwnerId],
  );
  const target = targetRows[0] as { role: string } | undefined;
  if (!target) {
    res.status(404).json({ error: 'New owner must be a current member' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Promote the new owner to DM (idempotent for an already-co-DM).
    await client.query(
      "UPDATE session_players SET role = 'dm' WHERE session_id = $1 AND user_id = $2",
      [sessionId, newOwnerId],
    );
    // Previous owner stays as a co-DM (role='dm').
    await client.query('UPDATE sessions SET dm_user_id = $1, updated_at = NOW()::text WHERE id = $2', [newOwnerId, sessionId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Sync room state: owner pointer + the new owner's role.
  const room = getRoom(sessionId);
  if (room) {
    room.dmUserId = newOwnerId;
    const p = room.players.get(newOwnerId);
    if (p) p.role = 'dm';
  }

  const io = getIO();
  if (io) {
    io.to(sessionId).emit('session:owner-changed', { oldOwnerId: userId, newOwnerId });
    if (target.role !== 'dm') {
      io.to(sessionId).emit('session:role-changed', { userId: newOwnerId, role: 'dm' });
    }
  }
  res.status(204).send();
});

// ─── Authoritative state snapshot ────────────────────────────────
//
// GET /api/sessions/:id/state
//
// Returns the server's current view of everything a client needs to
// render gameplay — tokens on the caller's active map, combat state,
// and every character they can see. Used as the ground-truth
// reconciliation path: the event cursor gives us low-latency deltas
// for free, but if ANY broadcast path ever slips through unwrapped
// (there are ~90 legacy emit sites across chat command handlers that
// still bypass the cursor), the snapshot gets pulled on every 15 s
// keep-alive tick and the client replaces local state wholesale.
//
// Per-recipient filtering:
//   - Tokens: DMs see everything; players drop tokens with
//     visible=false or in-session Invisible without Faerie Fire.
//   - Combat combatants: same visibility rule as tokens.
//   - Characters: the caller's own + NPCs the caller has a token for
//     (so the panel can read HP / conditions), but filtered further
//     by the session's showPlayersToPlayers / showCreatureStats.
router.get('/:id/state', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  await assertSessionMember(sessionId, userId);

  const room = getRoom(sessionId);
  if (!room) {
    res.json({
      tokens: [],
      combat: null,
      characters: {},
      nextEventId: 0,
      roundNumber: 0,
      serverTime: Date.now(),
    });
    return;
  }

  const player = room.players.get(userId);
  const isDM = player?.role === 'dm';

  // Tokens on the map this user is currently viewing — DM preview or
  // player ribbon — plus filtered for visibility + invisibility.
  const viewingMapId = isDM
    ? (room.dmViewingMap.get(userId) ?? room.playerMapId ?? room.currentMapId)
    : room.playerMapId;
  const allTokens = Array.from(room.tokens.values())
    .filter((t) => t.mapId === viewingMapId);
  const visibleTokens = isDM
    ? allTokens
    : allTokens.filter((t) => {
        if (t.visible === false) return false;
        const conds = (t.conditions || []) as string[];
        if (conds.includes('invisible') && !conds.includes('outlined')) {
          // Same-side (player's own token) stays visible to owner.
          if (t.ownerUserId !== userId) return false;
        }
        return true;
      });

  // Combat — filter combatants with the same hidden-token rule so the
  // initiative tracker snapshot doesn't leak NPC names a player can't
  // see yet on the map.
  let combat: unknown = null;
  if (room.combatState?.active) {
    const filtered = isDM
      ? room.combatState.combatants
      : room.combatState.combatants.filter((c) => {
          const tok = room.tokens.get(c.tokenId);
          return tok ? tok.visible !== false : false;
        });
    combat = {
      active: true,
      roundNumber: room.combatState.roundNumber,
      currentTurnIndex: room.combatState.currentTurnIndex,
      combatants: filtered,
      startedAt: room.combatState.startedAt,
    };
  }

  // Characters — return every character referenced by a visible token
  // plus the caller's own character, filtered by the session privacy
  // toggles. The DM gets everything. A player gets:
  //   - their own characters (always)
  //   - NPCs linked to visible tokens IF showCreatureStatsToPlayers
  //   - other PCs linked to visible tokens IF showPlayersToPlayers
  const { rows: sessionRows } = await pool.query(
    'SELECT settings FROM sessions WHERE id = $1',
    [sessionId],
  );
  const settings = sessionRows[0]
    ? safeParseJSON<Record<string, unknown>>(sessionRows[0].settings, {}, 'sessions.settings')
    : {};
  const showCreatureStats = settings.showCreatureStatsToPlayers === true;
  const showPlayersToPlayers = settings.showPlayersToPlayers === true;

  const charIds = new Set<string>();
  for (const t of visibleTokens) {
    if (t.characterId) charIds.add(t.characterId);
  }
  // Always include the caller's own character row(s) even when their
  // token isn't on this map (late-join / Hero tab access).
  const { rows: myCharRows } = await pool.query(
    'SELECT id FROM characters WHERE user_id = $1',
    [userId],
  );
  for (const r of myCharRows) charIds.add(r.id as string);

  const characters: Record<string, unknown> = {};
  if (charIds.size > 0) {
    const idList = Array.from(charIds);
    const { rows: charRows } = await pool.query(
      `SELECT * FROM characters WHERE id = ANY($1::text[])`,
      [idList],
    );
    for (const row of charRows) {
      const ownUserId = row.user_id as string;
      const isOwnChar = ownUserId === userId;
      const isNPCChar = ownUserId === 'npc';
      const isOtherPC = !isNPCChar && !isOwnChar;
      if (!isDM && !isOwnChar) {
        if (isNPCChar && !showCreatureStats) continue;
        if (isOtherPC && !showPlayersToPlayers) continue;
      }
      // Full character row — matches what character:synced ships.
      // Cheaper to ship the whole row and let the client's applyRemoteSync
      // reconcile than to diff field-by-field.
      characters[row.id as string] = row;
    }
  }

  res.json({
    tokens: visibleTokens,
    combat,
    characters,
    nextEventId: room.nextEventId,
    roundNumber: room.combatState?.roundNumber ?? 0,
    serverTime: Date.now(),
  });
});

// ─── Event cursor replay ─────────────────────────────────────────
//
// GET /api/sessions/:id/events?since=<id>
//
// Returns every event with `id > since` from the room's in-memory
// event log, filtered for what this user is allowed to see. Clients
// call this on reconnect + on every periodic keep-alive tick so the
// "I missed a websocket frame" window can't persist — if their cursor
// trails the room's, they replay the delta through the same socket
// listeners and catch up.
//
// Events older than the in-memory window (~500 entries, roughly 15
// min of play) return a 410 with `{ fullResync: true }` — the client
// reacts by re-firing session:join to pull the current snapshot.
router.get('/:id/events', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const sessionId = String(req.params.id);
  const since = Number.parseInt(String(req.query.since ?? '0'), 10);
  if (!Number.isFinite(since) || since < 0) {
    res.status(400).json({ error: 'invalid since' });
    return;
  }

  await assertSessionMember(sessionId, userId);
  const room = getRoom(sessionId);
  if (!room) {
    res.json({ events: [], latestEventId: 0 });
    return;
  }

  // If the caller's cursor is older than the oldest entry we still
  // have, we can't guarantee a complete replay. Signal a full resync
  // so the client re-emits session:join and rebuilds its state from
  // the authoritative map:loaded + combat:state-sync hydration.
  const oldest = room.eventLog.length > 0 ? room.eventLog[0].id : 0;
  if (since > 0 && since < oldest - 1) {
    res.status(410).json({
      fullResync: true,
      latestEventId: room.nextEventId,
      message: 'event cursor fell out of the replay buffer — trigger a full rejoin',
    });
    return;
  }

  // Filter per-recipient. DM sees everything; players drop events
  // that reference a currently-hidden token so replay doesn't leak
  // visibility the DM has since hidden.
  const player = room.players.get(userId);
  const isDM = player?.role === 'dm';
  const delta = [];
  for (const e of room.eventLog) {
    if (e.id <= since) continue;
    if (!isDM && e.tokenId) {
      const tok = room.tokens.get(e.tokenId);
      if (tok && tok.visible === false) continue;
    }
    delta.push(e);
  }

  res.json({ events: delta, latestEventId: room.nextEventId });
});

export default router;
