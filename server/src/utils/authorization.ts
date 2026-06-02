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
    `SELECT
       c.user_id,
       c.user_id = $2 AS is_owner,
       (
         $3::text IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM session_players sp
            WHERE sp.session_id = $3
              AND sp.user_id = $2
              AND sp.role = 'dm'
         )
       ) AS is_dm_in_session,
       EXISTS (
         SELECT 1
           FROM session_players dm
           JOIN session_players linked
             ON linked.session_id = dm.session_id
          WHERE linked.character_id = c.id
            AND dm.user_id = $2
            AND dm.role = 'dm'
       ) AS is_linked_session_dm,
       EXISTS (
         SELECT 1
           FROM tokens t
           JOIN maps m ON m.id = t.map_id
           JOIN session_players sp ON sp.session_id = m.session_id
          WHERE t.character_id = c.id
            AND sp.user_id = $2
            AND sp.role = 'dm'
       ) AS is_token_session_dm,
       (
         c.user_id = 'npc'
         AND EXISTS (
           SELECT 1
             FROM session_players sp
            WHERE sp.user_id = $2
              AND sp.role = 'dm'
            LIMIT 1
         )
       ) AS is_any_dm_for_npc
     FROM characters c
     WHERE c.id = $1
     LIMIT 1`,
    [characterId, userId, sessionId ?? null],
  );
  if (rows.length === 0) {
    const err = new Error('Character not found') as Error & { status: number };
    err.status = 404;
    throw err;
  }

  const auth = rows[0];
  if (
    auth.is_owner ||
    auth.is_dm_in_session ||
    auth.is_linked_session_dm ||
    auth.is_token_session_dm ||
    auth.is_any_dm_for_npc
  ) {
    return;
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
