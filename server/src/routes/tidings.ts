/**
 * Tidings — admin-authored patch notes / announcements.
 *
 * Public path (auth required, all users):
 *   GET    /api/tidings                  → recent published rows + unreadCount
 *   POST   /api/tidings/mark-read        → bump current user's lastReadAt to now
 *
 * Admin path (ADMIN_USER_IDS only):
 *   GET    /api/admin/tidings            → ALL rows (incl. unpublished + expired)
 *   POST   /api/admin/tidings            → create
 *   PATCH  /api/admin/tidings/:id        → update
 *   DELETE /api/admin/tidings/:id        → hard-delete (rare; usually expire instead)
 *
 * Schema fields:
 *   - kind          'patch' | 'content' | 'announcement'   (drives the icon + tone)
 *   - title         short headline; surfaces as <em>Title</em> in the lead phrase
 *   - body          required, ~1 sentence; rendered with the title prepended
 *   - expandedBody  optional longer markdown for "Read more" (not rendered yet)
 *   - audience      'all' | 'dm' | 'player' — gates visibility per role
 *   - versionTag    e.g. "0.7.2" for patch entries
 *   - publishedAt   ISO timestamp; future-dated rows are scheduled and hidden
 *                   from public reads until the timestamp passes
 *   - expiresAt     after which the row stops surfacing in the lobby
 *   - pinned        boolean (stored as INTEGER 0/1); always sorts first
 */
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import pool from '../db/connection.js';
import { requireAuth } from '../auth/middleware.js';
import { requireAdmin } from '../auth/admin.js';
import { getAuthUserId } from '../utils/authorization.js';
import { sendReleaseWebhook, type LinkedFeedbackSummary } from '../utils/releasesWebhook.js';

const router = Router();

const VALID_KINDS = ['patch', 'content', 'announcement'] as const;
const VALID_AUDIENCES = ['all', 'dm', 'player'] as const;

const tidingCreateSchema = z.object({
  kind: z.enum(VALID_KINDS).default('announcement'),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  expandedBody: z.string().max(10_000).optional(),
  audience: z.enum(VALID_AUDIENCES).default('all'),
  versionTag: z.string().max(40).optional(),
  /** ISO timestamp. Defaults to now (publish immediately). Future
   *  values schedule the row — public GETs will hide it until the
   *  publish window opens. */
  publishedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  pinned: z.boolean().optional(),
  /** feedback.id values that motivated this release. The Releases
   *  webhook expands each into a Discord deep-link in the embed.
   *  Empty / omitted = no back-links. */
  linkedFeedbackIds: z.array(z.string().uuid()).optional(),
  /** When true and kind === 'patch', skip the Releases webhook even
   *  if the URL is configured. Useful for hot-fixing typos in a
   *  release tiding without re-spamming Discord. */
  skipDiscord: z.boolean().optional(),
});

const tidingUpdateSchema = tidingCreateSchema.partial();

/**
 * Loose row shape for everything we read out of `tidings` (or
 * tidings-joined-auth_users). Postgres returns columns as snake_case,
 * arrays as JS arrays, and nullable columns as either the value or
 * null. We don't try to encode all of that with strict types — pg's
 * driver isn't generic over column shapes — but a `Record<string,
 * unknown>` is enough to keep ESLint happy without lying about it.
 */
type TidingRow = Record<string, unknown>;
type FeedbackRow = Record<string, unknown>;
type RoleRow = { role: string };

/** Coerce a possibly-unknown column value to string. */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
/** Coerce to nullable string — preserves `null` rather than turning it
 *  into the empty string. */
function asNullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Map a DB row → wire shape. Snake-case → camelCase, integer → boolean
 * for `pinned`. The shape mirrors what the client lobby + admin page
 * both consume.
 */
function rowToTiding(r: TidingRow) {
  // Postgres TEXT[] hydrates as a JS array on the wire, but legacy
  // rows that predate the column may show up as null. Normalise so
  // the client always sees an array.
  const linkedIds: string[] = Array.isArray(r.linked_feedback_ids)
    ? (r.linked_feedback_ids as string[])
    : [];
  return {
    id: asStr(r.id),
    kind: asStr(r.kind) as typeof VALID_KINDS[number],
    title: asStr(r.title),
    body: asStr(r.body),
    expandedBody: asNullableStr(r.expanded_body),
    audience: asStr(r.audience) as typeof VALID_AUDIENCES[number],
    versionTag: asNullableStr(r.version_tag),
    publishedAt: asStr(r.published_at),
    expiresAt: asNullableStr(r.expires_at),
    pinned: r.pinned === 1 || r.pinned === true,
    linkedFeedbackIds: linkedIds,
    discordAnnouncedAt: asNullableStr(r.discord_announced_at),
    discordThreadUrl: asNullableStr(r.discord_thread_url),
    createdBy: asNullableStr(r.created_by),
    authorDisplayName: asNullableStr(r.author_display_name),
    createdAt: asStr(r.created_at),
    updatedAt: asStr(r.updated_at),
  };
}

/**
 * Hydrate the feedback rows referenced by `linkedFeedbackIds` into the
 * shape the Releases webhook needs. Rows that no longer exist (deleted
 * after the tiding was authored) are silently dropped — better an
 * incomplete back-link list than a broken release post. Order is
 * preserved to match the order the admin selected them in.
 */
async function loadLinkedFeedback(ids: string[]): Promise<LinkedFeedbackSummary[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, category, content, discord_thread_url
       FROM feedback
      WHERE id = ANY($1::text[])`,
    [ids],
  );
  // Build a map so we can return rows in the original requested order.
  const byId = new Map<string, FeedbackRow>(
    (rows as FeedbackRow[]).map((r) => [asStr(r.id), r]),
  );
  const summaries: LinkedFeedbackSummary[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    summaries.push({
      id: asStr(r.id),
      category: asStr(r.category) as LinkedFeedbackSummary['category'],
      summary: asStr(r.content),
      threadUrl: asNullableStr(r.discord_thread_url),
    });
  }
  return summaries;
}

/**
 * Decide whether saving a tiding should fire the Releases webhook.
 * Rules:
 *   1. Only patch-kind tidings announce.
 *   2. Skip when caller passed skipDiscord=true.
 *   3. Skip when discord_announced_at is already populated (i.e.
 *      we've already sent this row — re-saves shouldn't re-spam).
 *   4. Skip when publishedAt is in the future (scheduled releases
 *      announce on publish, not on author).
 */
function shouldAnnounceTiding(opts: {
  kind: string;
  publishedAt: string;
  skipDiscord?: boolean;
  alreadyAnnouncedAt?: string | null;
}): boolean {
  if (opts.skipDiscord) return false;
  if (opts.kind !== 'patch') return false;
  if (opts.alreadyAnnouncedAt) return false;
  if (new Date(opts.publishedAt).getTime() > Date.now() + 60_000) return false;
  return true;
}

/**
 * Fire-and-forget the Releases webhook for a tiding. Updates the
 * tiding row with the announcement timestamp + thread URL once
 * Discord responds, so the next save doesn't double-announce. Errors
 * are swallowed; the admin's save already returned 2xx by the time
 * this runs.
 */
function announceTidingInBackground(tidingId: string): void {
  void (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id, kind, title, body, version_tag, published_at,
                linked_feedback_ids, discord_announced_at
           FROM tidings WHERE id = $1`,
        [tidingId],
      );
      const r = rows[0] as TidingRow | undefined;
      if (!r) return;
      if (r.discord_announced_at) return; // raced

      const linkedFeedback = await loadLinkedFeedback(
        Array.isArray(r.linked_feedback_ids) ? (r.linked_feedback_ids as string[]) : [],
      );
      const result = await sendReleaseWebhook({
        tidingId: asStr(r.id),
        kind: asStr(r.kind) as 'patch' | 'content' | 'announcement',
        title: asStr(r.title),
        body: asStr(r.body),
        versionTag: asNullableStr(r.version_tag),
        linkedFeedback,
      });

      if (result.ok) {
        await pool.query(
          `UPDATE tidings
              SET discord_announced_at = NOW()::text,
                  discord_thread_url = $2
            WHERE id = $1`,
          [tidingId, result.threadUrl],
        );
      }
    } catch (err) {
      console.warn('[tidings] release announcement failed:', err);
    }
  })();
}

// ── Public read ─────────────────────────────────────────────────

/**
 * GET /api/tidings — list recent published, non-expired tidings the
 * caller is allowed to see, plus their unread count.
 *
 * Audience filter:
 *   - 'all'    → everyone
 *   - 'dm'     → users who own at least one session OR are a co-DM
 *   - 'player' → users who are a member of any session in role 'player'
 *
 * The audience check uses the session_players join rather than a flag
 * on auth_users so it reflects current state — promoting someone to
 * DM today changes what tidings they see immediately.
 */
router.get('/tidings', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);

  // Resolve which audiences this user qualifies for. Everyone qualifies
  // for 'all'; DMs additionally qualify for 'dm'; players for 'player'.
  // A user who has both DM and player rows qualifies for everything.
  const { rows: roleRows } = await pool.query(
    `SELECT DISTINCT role FROM session_players WHERE user_id = $1`,
    [userId],
  );
  const isDm = (roleRows as RoleRow[]).some((r) => r.role === 'dm');
  const isPlayer = (roleRows as RoleRow[]).some((r) => r.role === 'player');
  const audiences: string[] = ['all'];
  if (isDm) audiences.push('dm');
  if (isPlayer) audiences.push('player');

  const { rows } = await pool.query(
    `SELECT t.*, u.display_name AS author_display_name
       FROM tidings t
       LEFT JOIN auth_users u ON u.id = t.created_by
      WHERE t.audience = ANY($1::text[])
        AND t.published_at::timestamp <= NOW()
        AND (t.expires_at IS NULL OR t.expires_at::timestamp > NOW())
      ORDER BY t.pinned DESC, t.published_at DESC
      LIMIT 50`,
    [audiences],
  );

  // Unread count: how many of those returned rows were published after
  // the user's lastReadTidingsAt. We compute this in JS rather than SQL
  // so the COUNT query doesn't have to repeat the audience join.
  const { rows: lastReadRows } = await pool.query(
    `SELECT last_read_tidings_at FROM auth_users WHERE id = $1`,
    [userId],
  );
  const lastReadRow = lastReadRows[0] as { last_read_tidings_at?: string | null } | undefined;
  const lastReadAt: string | null = lastReadRow?.last_read_tidings_at ?? null;
  const lastReadMs = lastReadAt ? new Date(lastReadAt).getTime() : 0;
  const unreadCount = (rows as TidingRow[]).reduce((acc, r) => {
    return acc + (new Date(asStr(r.published_at)).getTime() > lastReadMs ? 1 : 0);
  }, 0);

  res.json({
    tidings: (rows as TidingRow[]).map(rowToTiding),
    unreadCount,
    lastReadAt,
  });
});

/**
 * POST /api/tidings/mark-read — bump the caller's lastReadTidingsAt to
 * now. Idempotent; cheap (one UPDATE). Called by the lobby once the
 * user opens or scrolls the Tidings rail so the bell badge clears.
 */
router.post('/tidings/mark-read', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  await pool.query(
    `UPDATE auth_users SET last_read_tidings_at = NOW()::text WHERE id = $1`,
    [userId],
  );
  res.json({ ok: true });
});

// ── Admin CRUD ──────────────────────────────────────────────────

router.get('/admin/tidings', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT t.*, u.display_name AS author_display_name
       FROM tidings t
       LEFT JOIN auth_users u ON u.id = t.created_by
      ORDER BY t.pinned DESC, t.published_at DESC
      LIMIT 200`,
  );
  res.json({ tidings: (rows as TidingRow[]).map(rowToTiding) });
});

router.post('/admin/tidings', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const parsed = tidingCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid tiding payload', details: parsed.error.issues });
    return;
  }

  const id = uuidv4();
  const data = parsed.data;
  const publishedAt = data.publishedAt ?? new Date().toISOString();
  const linkedIds = data.linkedFeedbackIds ?? [];

  await pool.query(
    `INSERT INTO tidings (
       id, kind, title, body, expanded_body, audience, version_tag,
       published_at, expires_at, pinned, linked_feedback_ids, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id, data.kind, data.title, data.body, data.expandedBody ?? null,
      data.audience, data.versionTag ?? null,
      publishedAt, data.expiresAt ?? null,
      data.pinned ? 1 : 0, linkedIds, userId,
    ],
  );

  // Echo the freshly-inserted row back so the admin UI doesn't have to
  // refetch the whole list to render the new entry.
  const { rows } = await pool.query(
    `SELECT t.*, u.display_name AS author_display_name
       FROM tidings t LEFT JOIN auth_users u ON u.id = t.created_by
       WHERE t.id = $1`,
    [id],
  );

  // Fire the Releases webhook in the background for patch-kind
  // publishes. Never blocks the admin's save — the row is already
  // visible in the lobby; the Discord post is purely a side channel.
  if (
    shouldAnnounceTiding({
      kind: data.kind,
      publishedAt,
      skipDiscord: data.skipDiscord,
      alreadyAnnouncedAt: null,
    })
  ) {
    announceTidingInBackground(id);
  }

  res.status(201).json({ tiding: rowToTiding(rows[0] as TidingRow) });
});

router.patch('/admin/tidings/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = tidingUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update payload', details: parsed.error.issues });
    return;
  }

  // Build a dynamic UPDATE — only set the fields the caller actually
  // sent so we don't accidentally null-out untouched columns.
  const updates: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  const d = parsed.data;
  if (d.kind !== undefined)              { updates.push(`kind = $${p++}`); params.push(d.kind); }
  if (d.title !== undefined)             { updates.push(`title = $${p++}`); params.push(d.title); }
  if (d.body !== undefined)              { updates.push(`body = $${p++}`); params.push(d.body); }
  if (d.expandedBody !== undefined)      { updates.push(`expanded_body = $${p++}`); params.push(d.expandedBody ?? null); }
  if (d.audience !== undefined)          { updates.push(`audience = $${p++}`); params.push(d.audience); }
  if (d.versionTag !== undefined)        { updates.push(`version_tag = $${p++}`); params.push(d.versionTag ?? null); }
  if (d.publishedAt !== undefined)       { updates.push(`published_at = $${p++}`); params.push(d.publishedAt); }
  if (d.expiresAt !== undefined)         { updates.push(`expires_at = $${p++}`); params.push(d.expiresAt ?? null); }
  if (d.pinned !== undefined)            { updates.push(`pinned = $${p++}`); params.push(d.pinned ? 1 : 0); }
  if (d.linkedFeedbackIds !== undefined) { updates.push(`linked_feedback_ids = $${p++}`); params.push(d.linkedFeedbackIds); }

  if (updates.length === 0) { res.json({ ok: true }); return; }

  updates.push(`updated_at = NOW()::text`);
  params.push(id);
  await pool.query(`UPDATE tidings SET ${updates.join(', ')} WHERE id = $${p}`, params);

  const { rows } = await pool.query(
    `SELECT t.*, u.display_name AS author_display_name
       FROM tidings t LEFT JOIN auth_users u ON u.id = t.created_by
       WHERE t.id = $1`,
    [id],
  );
  if (!rows[0]) { res.status(404).json({ error: 'Tiding not found' }); return; }

  // PATCH can also be the trigger for a release announcement — e.g.
  // an admin authors the row as kind='announcement' first, fixes
  // typos, then flips to 'patch' to publish. Re-uses the same
  // shouldAnnounceTiding gate so re-saves never double-fire.
  const updatedRow = rows[0] as TidingRow;
  if (
    shouldAnnounceTiding({
      kind: asStr(updatedRow.kind),
      publishedAt: asStr(updatedRow.published_at),
      skipDiscord: d.skipDiscord,
      alreadyAnnouncedAt: asNullableStr(updatedRow.discord_announced_at),
    })
  ) {
    announceTidingInBackground(id);
  }

  res.json({ tiding: rowToTiding(updatedRow) });
});

/**
 * GET /api/admin/tidings/recent-feedback — feeds the feedback picker
 * in the admin Tidings authoring UI. Returns the most recent N
 * feedback rows with just enough fields to render a checkbox list
 * (id, category, content snippet, status, anonymity, threadUrl).
 *
 * Mounted under `/admin` so it inherits the requireAdmin gate; the
 * shape is intentionally narrower than GET /api/admin/feedback so
 * the picker can stay light without re-fetching everything.
 */
router.get('/admin/tidings/recent-feedback', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.category, f.content, f.anonymous, f.status,
            f.discord_thread_url, f.created_at,
            u.display_name AS user_display_name
       FROM feedback f
       LEFT JOIN auth_users u ON u.id = f.user_id
      ORDER BY f.created_at DESC
      LIMIT 100`,
  );

  res.json({
    feedback: (rows as FeedbackRow[]).map((r) => ({
      id: asStr(r.id),
      category: asStr(r.category),
      content: asStr(r.content),
      anonymous: r.anonymous === 1,
      status: asStr(r.status),
      discordThreadUrl: asNullableStr(r.discord_thread_url),
      userDisplayName: r.anonymous === 1 ? null : asNullableStr(r.user_display_name),
      createdAt: asStr(r.created_at),
    })),
  });
});

router.delete('/admin/tidings/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  await pool.query('DELETE FROM tidings WHERE id = $1', [id]);
  res.json({ ok: true });
});

export default router;
