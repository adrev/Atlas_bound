/**
 * Companions — the friend system that powers the lobby's right-rail
 * Companions list. One row per friendship in `friendships`, with a
 * canonical (user_a_id < user_b_id) ordering so duplicate requests
 * from either side collide on the UNIQUE constraint.
 *
 * Endpoint surface (all auth-required):
 *
 *   GET    /api/friends            → accepted friends + presence
 *   GET    /api/friends/pending    → incoming + outgoing pending requests
 *   GET    /api/friends/search?q=  → user search for the Add modal
 *   POST   /api/friends/request    → body: { target } where target is
 *                                    a display name OR email
 *   POST   /api/friends/:id/accept → flip pending → accepted (recipient only)
 *   POST   /api/friends/:id/decline → delete pending row (recipient only)
 *   POST   /api/friends/:id/cancel → delete pending row (sender only)
 *   POST   /api/friends/:id/block  → set status=blocked
 *   DELETE /api/friends/:id        → unfriend / remove block
 *
 * Presence is derived on read from in-memory `roomState`: any user
 * with at least one active socket in any room is "in-game" with
 * the room id; otherwise "offline". A real "online but in the
 * tavern" presence requires lobby-side sockets which we haven't
 * shipped yet — this is honest about that gap.
 */
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import pool from '../db/connection.js';
import { getAuthUserId } from '../utils/authorization.js';
import { getAllRooms } from '../utils/roomState.js';

const router = Router();

type FriendshipStatus = 'pending' | 'accepted' | 'blocked';

interface FriendshipRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  requested_by: string;
  status: FriendshipStatus;
  blocked_by: string | null;
  created_at: string;
  updated_at: string;
}

interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
}

/**
 * Wire shape coming back from the JOINed list queries — friendship
 * fields plus the OTHER user's profile aliased as `other_*`. Loose
 * `Record` so we don't have to keep two interfaces in sync; the
 * column list is short enough that local field access stays clear.
 */
interface FriendshipWithOtherRow extends FriendshipRow {
  other_id: string;
  other_display_name: string;
  other_email: string | null;
  other_avatar_url: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Lexicographic sort so the canonical (a, b) pair is stable. */
function canonicalPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/**
 * Build a presence map for the given userIds. We iterate every room
 * once and stamp the first room each user is seen in — a user who
 * happens to have two browser tabs in different rooms gets the
 * deterministic-but-arbitrary first hit; that's better than picking
 * randomly and reasonable in practice (people don't run two campaigns
 * concurrently in two tabs).
 */
interface Presence {
  status: 'in-game' | 'offline';
  sessionId: string | null;
  sessionName: string | null;
  roomCode: string | null;
}

async function buildPresenceMap(userIds: Set<string>): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>();
  if (userIds.size === 0) return result;

  // Step 1 — find which rooms each requested user is currently in.
  const sessionIdsByUser = new Map<string, string>();
  for (const [sessionId, room] of getAllRooms()) {
    for (const [userId, sockets] of room.userSockets) {
      if (!userIds.has(userId)) continue;
      if (sessionIdsByUser.has(userId)) continue;
      if (sockets.size === 0) continue;
      sessionIdsByUser.set(userId, sessionId);
    }
  }

  // Step 2 — hydrate session names for any rooms we found. One query.
  const sessionIds = Array.from(new Set(sessionIdsByUser.values()));
  let nameByRoom = new Map<string, { name: string; roomCode: string }>();
  if (sessionIds.length > 0) {
    const { rows } = await pool.query<{ id: string; name: string; room_code: string }>(
      'SELECT id, name, room_code FROM sessions WHERE id = ANY($1::text[])',
      [sessionIds],
    );
    nameByRoom = new Map(rows.map((r) => [r.id, { name: r.name, roomCode: r.room_code }]));
  }

  // Step 3 — assemble per user. Anyone we didn't find is offline.
  for (const userId of userIds) {
    const sessionId = sessionIdsByUser.get(userId) ?? null;
    if (!sessionId) {
      result.set(userId, { status: 'offline', sessionId: null, sessionName: null, roomCode: null });
      continue;
    }
    const meta = nameByRoom.get(sessionId);
    result.set(userId, {
      status: 'in-game',
      sessionId,
      sessionName: meta?.name ?? null,
      roomCode: meta?.roomCode ?? null,
    });
  }
  return result;
}

/**
 * Render a friend (the OTHER user in the row) plus the friendship
 * metadata + presence. Used by GET /friends and /friends/pending.
 */
function renderFriend(
  friendship: FriendshipRow,
  selfId: string,
  user: UserRow,
  presence: Presence | undefined,
) {
  const friendId = friendship.user_a_id === selfId ? friendship.user_b_id : friendship.user_a_id;
  return {
    friendshipId: friendship.id,
    userId: friendId,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    status: friendship.status,
    requestedBy: friendship.requested_by,
    requestedByMe: friendship.requested_by === selfId,
    blockedByMe: friendship.blocked_by === selfId,
    presence: presence ?? { status: 'offline' as const, sessionId: null, sessionName: null, roomCode: null },
    createdAt: friendship.created_at,
  };
}

// ── GET /api/friends — accepted friends only ────────────────────

router.get('/friends', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);

  // Pull every accepted friendship the caller is part of, joined to
  // the OTHER user's profile in a single query — `CASE` picks the
  // far user from the canonical pair.
  const { rows } = await pool.query<FriendshipWithOtherRow>(
    `SELECT f.id, f.user_a_id, f.user_b_id, f.requested_by, f.status,
            f.blocked_by, f.created_at, f.updated_at,
            other.id AS other_id,
            other.display_name AS other_display_name,
            other.email AS other_email,
            other.avatar_url AS other_avatar_url
       FROM friendships f
       JOIN auth_users other ON other.id = CASE
         WHEN f.user_a_id = $1 THEN f.user_b_id
         ELSE f.user_a_id
       END
      WHERE (f.user_a_id = $1 OR f.user_b_id = $1)
        AND f.status = 'accepted'
      ORDER BY f.updated_at DESC`,
    [userId],
  );

  // Bridge the JOIN aliases to clean shapes.
  const joinedRows = rows as FriendshipWithOtherRow[];
  const friendships: FriendshipRow[] = joinedRows.map((r) => ({
    id: r.id,
    user_a_id: r.user_a_id,
    user_b_id: r.user_b_id,
    requested_by: r.requested_by,
    status: r.status,
    blocked_by: r.blocked_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  const usersById = new Map<string, UserRow>(
    joinedRows.map((r) => [r.other_id, {
      id: r.other_id,
      display_name: r.other_display_name,
      email: r.other_email,
      avatar_url: r.other_avatar_url,
    }]),
  );

  const friendUserIds = new Set(joinedRows.map((r) => r.other_id));
  const presenceMap = await buildPresenceMap(friendUserIds);

  res.json({
    friends: friendships.map((f) => {
      const friendUserId = f.user_a_id === userId ? f.user_b_id : f.user_a_id;
      const profile = usersById.get(friendUserId);
      if (!profile) return null;
      return renderFriend(f, userId, profile, presenceMap.get(friendUserId));
    }).filter(Boolean),
  });
});

// ── GET /api/friends/pending — incoming + outgoing requests ────

router.get('/friends/pending', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);

  const { rows } = await pool.query<FriendshipWithOtherRow>(
    `SELECT f.id, f.user_a_id, f.user_b_id, f.requested_by, f.status,
            f.blocked_by, f.created_at, f.updated_at,
            other.id AS other_id,
            other.display_name AS other_display_name,
            other.email AS other_email,
            other.avatar_url AS other_avatar_url
       FROM friendships f
       JOIN auth_users other ON other.id = CASE
         WHEN f.user_a_id = $1 THEN f.user_b_id
         ELSE f.user_a_id
       END
      WHERE (f.user_a_id = $1 OR f.user_b_id = $1)
        AND f.status = 'pending'
      ORDER BY f.created_at DESC`,
    [userId],
  );

  const incoming: ReturnType<typeof renderFriend>[] = [];
  const outgoing: ReturnType<typeof renderFriend>[] = [];

  for (const r of rows as FriendshipWithOtherRow[]) {
    const friendship: FriendshipRow = {
      id: r.id, user_a_id: r.user_a_id, user_b_id: r.user_b_id,
      requested_by: r.requested_by, status: r.status,
      blocked_by: r.blocked_by, created_at: r.created_at, updated_at: r.updated_at,
    };
    const profile: UserRow = {
      id: r.other_id, display_name: r.other_display_name,
      email: r.other_email, avatar_url: r.other_avatar_url,
    };
    const rendered = renderFriend(friendship, userId, profile, undefined);
    if (friendship.requested_by === userId) outgoing.push(rendered);
    else incoming.push(rendered);
  }

  res.json({ incoming, outgoing });
});

// ── GET /api/friends/search — user search for Add modal ─────────

const searchQuerySchema = z.object({
  q: z.string().min(2).max(100),
});

router.get('/friends/search', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const parsed = searchQuerySchema.safeParse({ q: req.query.q ?? '' });
  if (!parsed.success) {
    res.json({ users: [] });
    return;
  }
  const q = parsed.data.q.trim();
  // ILIKE on display_name OR email — exclude self. Limit to 10 hits
  // to keep the autocomplete dropdown snappy and discourage scraping.
  const { rows } = await pool.query<UserRow>(
    `SELECT id, display_name, email, avatar_url
       FROM auth_users
      WHERE id <> $1
        AND (display_name ILIKE $2 OR email ILIKE $2)
      ORDER BY display_name ASC
      LIMIT 10`,
    [userId, `%${q}%`],
  );

  // Annotate each result with the current friendship status so the
  // UI can render "Already friends" / "Pending" instead of a duplicate
  // request button.
  const candidateIds = rows.map((r) => r.id);
  let statusByUser = new Map<string, FriendshipStatus>();
  if (candidateIds.length > 0) {
    const { rows: existingRows } = await pool.query<{ user_a_id: string; user_b_id: string; status: FriendshipStatus }>(
      `SELECT user_a_id, user_b_id, status
         FROM friendships
        WHERE (user_a_id = $1 AND user_b_id = ANY($2::text[]))
           OR (user_b_id = $1 AND user_a_id = ANY($2::text[]))`,
      [userId, candidateIds],
    );
    statusByUser = new Map(
      existingRows.map((r) => [r.user_a_id === userId ? r.user_b_id : r.user_a_id, r.status]),
    );
  }

  res.json({
    users: rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      // Email is intentionally omitted from search results to avoid
      // disclosing harvested addresses; only the requester's existing
      // friends + their email through other channels.
      avatarUrl: r.avatar_url,
      friendshipStatus: statusByUser.get(r.id) ?? null,
    })),
  });
});

// ── POST /api/friends/request ───────────────────────────────────

const requestBodySchema = z.object({
  target: z.string().min(1).max(255).optional(),
  targetUserId: z.string().uuid().optional(),
}).refine((d) => Boolean(d.target || d.targetUserId), { message: 'target or targetUserId required' });

router.post('/friends/request', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const parsed = requestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request payload', details: parsed.error.issues });
    return;
  }

  // Resolve the target user. By id is exact; by string we try exact
  // email match first, then exact display_name (case-insensitive),
  // finally first ILIKE match. Refusing to match self happens later.
  let resolvedId: string | null = null;
  if (parsed.data.targetUserId) {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM auth_users WHERE id = $1', [parsed.data.targetUserId],
    );
    resolvedId = rows[0]?.id ?? null;
  } else {
    const target = (parsed.data.target ?? '').trim();
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM auth_users
        WHERE LOWER(email) = LOWER($1)
           OR LOWER(display_name) = LOWER($1)
        LIMIT 1`,
      [target],
    );
    resolvedId = rows[0]?.id ?? null;
  }

  if (!resolvedId) {
    res.status(404).json({ error: 'No traveler matched that name or email.' });
    return;
  }
  if (resolvedId === userId) {
    res.status(400).json({ error: "You can't befriend yourself — but the Loremasters appreciate the thought." });
    return;
  }

  const [a, b] = canonicalPair(userId, resolvedId);

  // Check for an existing row. If accepted, no-op (already friends).
  // If pending and the OTHER side requested, auto-accept (sane UX:
  // request meets request → they become friends). If pending and we
  // requested before, return the existing pending row. If blocked
  // by the OTHER user, fail without leaking that fact.
  const { rows: existingRows } = await pool.query<FriendshipRow>(
    'SELECT * FROM friendships WHERE user_a_id = $1 AND user_b_id = $2',
    [a, b],
  );
  const existing = existingRows[0];
  if (existing) {
    if (existing.status === 'accepted') {
      res.json({ friendship: existing, message: 'Already friends.' });
      return;
    }
    if (existing.status === 'blocked') {
      // Don't leak who blocked. Caller sees a generic refusal whether
      // they were blocked OR they themselves did the blocking.
      res.status(403).json({ error: 'This traveler is unreachable.' });
      return;
    }
    // pending
    if (existing.requested_by === userId) {
      res.json({ friendship: existing, message: 'Request already sent.' });
      return;
    }
    // The other side requested; auto-accept.
    await pool.query(
      `UPDATE friendships
          SET status = 'accepted', updated_at = NOW()::text
        WHERE id = $1`,
      [existing.id],
    );
    res.json({ friendshipId: existing.id, status: 'accepted', autoAccepted: true });
    return;
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO friendships (id, user_a_id, user_b_id, requested_by, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [id, a, b, userId],
  );

  res.status(201).json({ friendshipId: id, status: 'pending' });
});

// ── POST /api/friends/:id/accept ────────────────────────────────

router.post('/friends/:id/accept', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows } = await pool.query<FriendshipRow>(
    'SELECT * FROM friendships WHERE id = $1', [id],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Friendship not found' }); return; }
  if (row.user_a_id !== userId && row.user_b_id !== userId) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  if (row.status !== 'pending') { res.json({ friendshipId: id, status: row.status }); return; }
  if (row.requested_by === userId) {
    // The sender can't accept their own request.
    res.status(400).json({ error: 'Cannot accept your own request' });
    return;
  }
  await pool.query(
    `UPDATE friendships SET status = 'accepted', updated_at = NOW()::text WHERE id = $1`,
    [id],
  );
  res.json({ friendshipId: id, status: 'accepted' });
});

// ── POST /api/friends/:id/decline ───────────────────────────────

router.post('/friends/:id/decline', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows } = await pool.query<FriendshipRow>(
    'SELECT * FROM friendships WHERE id = $1', [id],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Friendship not found' }); return; }
  if (row.user_a_id !== userId && row.user_b_id !== userId) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  if (row.status !== 'pending' || row.requested_by === userId) {
    res.status(400).json({ error: 'Only the recipient can decline a pending request' });
    return;
  }
  await pool.query('DELETE FROM friendships WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ── POST /api/friends/:id/cancel — sender retracts a pending request ──

router.post('/friends/:id/cancel', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows } = await pool.query<FriendshipRow>(
    'SELECT * FROM friendships WHERE id = $1', [id],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Friendship not found' }); return; }
  if (row.requested_by !== userId) {
    res.status(403).json({ error: 'Only the sender can cancel a pending request' });
    return;
  }
  if (row.status !== 'pending') {
    res.status(400).json({ error: 'Friendship is no longer pending' });
    return;
  }
  await pool.query('DELETE FROM friendships WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ── POST /api/friends/:id/block ─────────────────────────────────

router.post('/friends/:id/block', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows } = await pool.query<FriendshipRow>(
    'SELECT * FROM friendships WHERE id = $1', [id],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Friendship not found' }); return; }
  if (row.user_a_id !== userId && row.user_b_id !== userId) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  await pool.query(
    `UPDATE friendships
        SET status = 'blocked', blocked_by = $2, updated_at = NOW()::text
      WHERE id = $1`,
    [id, userId],
  );
  res.json({ friendshipId: id, status: 'blocked' });
});

// ── DELETE /api/friends/:id — unfriend / unblock ────────────────

router.delete('/friends/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows } = await pool.query<FriendshipRow>(
    'SELECT * FROM friendships WHERE id = $1', [id],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Friendship not found' }); return; }
  if (row.user_a_id !== userId && row.user_b_id !== userId) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  // For 'blocked' rows, only the blocker can unblock.
  if (row.status === 'blocked' && row.blocked_by !== userId) {
    res.status(403).json({ error: 'Not authorized' }); return;
  }
  await pool.query('DELETE FROM friendships WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
