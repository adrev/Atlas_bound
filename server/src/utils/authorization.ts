import type { Request } from 'express';
import pool from '../db/connection.js';

/**
 * Extract the authenticated user's ID from the request.
 * Throws a 401-style error if not authenticated.
 */
export function getAuthUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) {
    const err = new Error('Authentication required') as Error & { status: number };
    err.status = 401;
    throw err;
  }
  return userId;
}

/**
 * Assert the user owns the character, or is the DM of a session that
 * contains that character.  Throws 403 on failure, 404 if character
 * doesn't exist.
 */
export async function assertCharacterOwnerOrDM(
  characterId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  const { rows } = await pool.query(
    'SELECT user_id FROM characters WHERE id = $1',
    [characterId],
  );
  if (rows.length === 0) {
    const err = new Error('Character not found') as Error & { status: number };
    err.status = 404;
    throw err;
  }

  // Owner check
  if (rows[0].user_id === userId) return;

  // DM check: if a sessionId is given, see if user is DM of that session
  if (sessionId) {
    const { rows: spRows } = await pool.query(
      "SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2 AND role = 'dm'",
      [sessionId, userId],
    );
    if (spRows.length > 0) return;
  }

  // Fallback #1: user is DM of ANY session where this character is
  // linked via session_players. Covers the PC case.
  const { rows: dmRows } = await pool.query(
    `SELECT 1 FROM session_players sp
     JOIN session_players sp2 ON sp2.session_id = sp.session_id
     WHERE sp2.character_id = $1
       AND sp.user_id = $2
       AND sp.role = 'dm'
     LIMIT 1`,
    [characterId, userId],
  );
  if (dmRows.length > 0) return;

  // Fallback #2: NPCs (creatures, loot bags) are never in
  // session_players — they exist only as tokens on maps. A DM editing
  // a creature's inventory or loot needs the session-via-token path
  // or they hit 403 on every "add loot to creature" / "toggle NPC
  // weapon equipped" call. Same pattern we fixed on /loot/transfer.
  const { rows: npcDmRows } = await pool.query(
    `SELECT 1 FROM tokens t
       JOIN maps m ON m.id = t.map_id
       JOIN session_players sp ON sp.session_id = m.session_id
      WHERE t.character_id = $1
        AND sp.user_id = $2
        AND sp.role = 'dm'
      LIMIT 1`,
    [characterId, userId],
  );
  if (npcDmRows.length > 0) return;

  // Fallback #3: Brand-new NPC rows with `user_id = 'npc'` that don't
  // have a token yet. The LootEditor drop flow creates a loot-bag
  // character BEFORE spawning its token, then immediately calls
  // `/characters/:id/loot` to add the item — at that moment there's
  // no token linking the character to any session, so fallback #2
  // can't find a DM record. Allow any DM (of any session the caller
  // is a member of) to mutate NPC characters; NPCs are a shared
  // resource without cross-session impact, and the caller being a
  // DM somewhere proves they have legitimate game-running
  // authority. Human-owned PCs still require the stricter checks
  // above — this only widens access for `user_id = 'npc'` rows.
  if (rows[0].user_id === 'npc') {
    const { rows: anyDmRows } = await pool.query(
      `SELECT 1 FROM session_players WHERE user_id = $1 AND role = 'dm' LIMIT 1`,
      [userId],
    );
    if (anyDmRows.length > 0) return;
  }

  const err = new Error('Not authorized') as Error & { status: number };
  err.status = 403;
  throw err;
}

/**
 * Assert the user is a member (player or DM) of the session.
 */
export async function assertSessionMember(
  sessionId: string,
  userId: string,
): Promise<void> {
  const { rows } = await pool.query(
    'SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  if (rows.length === 0) {
    const err = new Error('Not a member of this session') as Error & { status: number };
    err.status = 403;
    throw err;
  }
}

/**
 * Assert the user is *a* DM of the session. This passes for both the
 * owner and any co-DM \u2014 use it to gate kick/ban/settings operations
 * where co-DMs have full authority.
 */
export async function assertSessionDM(
  sessionId: string,
  userId: string,
): Promise<void> {
  const { rows } = await pool.query(
    "SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2 AND role = 'dm'",
    [sessionId, userId],
  );
  if (rows.length === 0) {
    const err = new Error('Only the DM can perform this action') as Error & { status: number };
    err.status = 403;
    throw err;
  }
}

/**
 * Assert the user is the *owner* \u2014 the original creator recorded in
 * `sessions.dm_user_id`. Ownership-scoped actions (promote/demote,
 * transfer, delete session) go through this gate so co-DMs can't
 * reshuffle the hierarchy or hand the session away.
 */
export async function assertSessionOwner(
  sessionId: string,
  userId: string,
): Promise<void> {
  const { rows } = await pool.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND dm_user_id = $2',
    [sessionId, userId],
  );
  if (rows.length === 0) {
    const err = new Error('Only the session owner can perform this action') as Error & { status: number };
    err.status = 403;
    throw err;
  }
}

/**
 * True if the given user is the owner of this session. Use in code
 * paths that need a boolean rather than a throwing assertion (e.g.
 * deciding whether to show the Promote button in a payload).
 */
export async function isSessionOwner(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND dm_user_id = $2',
    [sessionId, userId],
  );
  return rows.length > 0;
}
