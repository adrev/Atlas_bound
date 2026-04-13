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

  // Fallback: check if user is DM of ANY session the character is linked to
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
 * Assert the user is the DM of the session.
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
