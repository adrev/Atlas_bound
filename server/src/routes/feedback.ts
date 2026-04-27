/**
 * User feedback / suggestions API.
 *
 * Submission path (any authenticated user):
 *   POST /api/feedback
 *     body: { category, content, pageUrl?, browser?, appVersion?,
 *             sessionId?, anonymous? }
 *     200:  { id }
 *     429:  rate-limit (5 / day per user)
 *
 * Admin path (only ADMIN_USER_IDS):
 *   GET   /api/admin/feedback?status=&category=&limit=&offset=
 *   PATCH /api/admin/feedback/:id  body: { status?, adminNotes? }
 *
 * No public read endpoint in v1 — feedback is private by design,
 * surfaces only in the admin panel until we decide whether to ship a
 * community wall later.
 */

import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import pool from '../db/connection.js';
import { requireAuth } from '../auth/middleware.js';
import { requireAdmin } from '../auth/admin.js';
import { getAuthUserId } from '../utils/authorization.js';
import { sendFeedbackWebhook } from '../utils/discordWebhook.js';

const router = Router();

const VALID_CATEGORIES = ['bug', 'feature', 'ux', 'other'] as const;
const VALID_STATUSES = ['open', 'triaged', 'planned', 'shipped', 'wontfix'] as const;

const submitSchema = z.object({
  category: z.enum(VALID_CATEGORIES).default('other'),
  content: z.string().min(5).max(5000),
  pageUrl: z.string().max(500).optional(),
  browser: z.string().max(500).optional(),
  appVersion: z.string().max(50).optional(),
  sessionId: z.string().uuid().optional(),
  anonymous: z.boolean().optional(),
  screenshotUrl: z.string().max(500).optional(),
});

const updateSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  adminNotes: z.string().max(5000).optional(),
});

/**
 * Submitter rate limit. We allow 5 successful submissions per user per
 * 24 hours so a runaway client / annoyed user can't DoS the table or
 * spam your admin queue. Counted via a simple lookup against the
 * existing `feedback` rows (no separate counter table needed).
 */
const DAILY_LIMIT = 5;

async function recentSubmissionCount(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM feedback
     WHERE user_id = $1 AND created_at::timestamp > NOW() - INTERVAL '24 hours'`,
    [userId],
  );
  return (rows[0]?.n as number) ?? 0;
}

router.post('/feedback', requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid feedback payload', details: parsed.error.issues });
    return;
  }

  const recent = await recentSubmissionCount(userId);
  if (recent >= DAILY_LIMIT) {
    res.status(429).json({
      error: 'Daily feedback limit reached. Try again tomorrow.',
      limit: DAILY_LIMIT,
    });
    return;
  }

  const id = uuidv4();
  const data = parsed.data;

  await pool.query(
    `INSERT INTO feedback (
      id, user_id, session_id, category, content,
      page_url, browser, app_version, screenshot_url, anonymous, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')`,
    [
      id, userId, data.sessionId ?? null, data.category, data.content,
      data.pageUrl ?? null, data.browser ?? null, data.appVersion ?? null,
      data.screenshotUrl ?? null,
      data.anonymous ? 1 : 0,
    ],
  );

  // Side-channel notification to Discord. Look up the submitter's
  // display name + email so admins see who sent it (unless the user
  // ticked the anonymous box, in which case the webhook scrubs both).
  // We deliberately don't await — the user has already succeeded;
  // letting Discord delivery run in the background keeps the response
  // snappy and means a slow webhook can't stretch the request.
  let submitter: { displayName: string | null; email: string | null } = { displayName: null, email: null };
  if (!data.anonymous) {
    try {
      const { rows: userRows } = await pool.query(
        'SELECT display_name, email FROM auth_users WHERE id = $1',
        [userId],
      );
      if (userRows[0]) {
        submitter = {
          displayName: (userRows[0].display_name as string | null) ?? null,
          email: (userRows[0].email as string | null) ?? null,
        };
      }
    } catch (err) {
      // Lookup failure is non-fatal; the webhook will just say "Unknown user".
      console.warn('[feedback] submitter lookup failed:', err);
    }
  }

  void sendFeedbackWebhook({
    id,
    category: data.category,
    content: data.content,
    pageUrl: data.pageUrl ?? null,
    browser: data.browser ?? null,
    appVersion: data.appVersion ?? null,
    sessionId: data.sessionId ?? null,
    anonymous: !!data.anonymous,
    userDisplayName: submitter.displayName,
    userEmail: submitter.email,
  });

  res.status(201).json({ id });
});

// ── Admin endpoints ─────────────────────────────────────────────

router.get('/admin/feedback', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const status = (req.query.status as string | undefined) ?? '';
  const category = (req.query.category as string | undefined) ?? '';
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (status && VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    where.push(`f.status = $${p++}`);
    params.push(status);
  }
  if (category && VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
    where.push(`f.category = $${p++}`);
    params.push(category);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  // Join auth_users so the admin can see who submitted (unless
  // anonymous, in which case display_name comes back blank). Newest
  // first so the queue reads naturally.
  const sql = `
    SELECT
      f.id, f.user_id, f.session_id, f.category, f.content,
      f.page_url, f.browser, f.app_version, f.screenshot_url,
      f.anonymous, f.status, f.admin_notes,
      f.created_at, f.updated_at,
      u.display_name AS user_display_name,
      u.email AS user_email
    FROM feedback f
    LEFT JOIN auth_users u ON u.id = f.user_id
    ${whereSql}
    ORDER BY f.created_at DESC
    LIMIT $${p++} OFFSET $${p++}
  `;
  params.push(limit, offset);

  const { rows } = await pool.query(sql, params);

  res.json({
    feedback: rows.map((r) => ({
      id: r.id,
      userId: r.anonymous === 1 ? null : r.user_id,
      userDisplayName: r.anonymous === 1 ? '(anonymous)' : (r.user_display_name ?? null),
      userEmail: r.anonymous === 1 ? null : (r.user_email ?? null),
      sessionId: r.session_id,
      category: r.category,
      content: r.content,
      pageUrl: r.page_url,
      browser: r.browser,
      appVersion: r.app_version,
      screenshotUrl: r.screenshot_url,
      anonymous: r.anonymous === 1,
      status: r.status,
      adminNotes: r.admin_notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

router.patch('/admin/feedback/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update payload', details: parsed.error.issues });
    return;
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (parsed.data.status !== undefined) {
    updates.push(`status = $${p++}`);
    params.push(parsed.data.status);
  }
  if (parsed.data.adminNotes !== undefined) {
    updates.push(`admin_notes = $${p++}`);
    params.push(parsed.data.adminNotes);
  }
  if (updates.length === 0) {
    res.json({ ok: true });
    return;
  }
  updates.push(`updated_at = NOW()::text`);
  params.push(id);
  await pool.query(
    `UPDATE feedback SET ${updates.join(', ')} WHERE id = $${p}`,
    params,
  );
  res.json({ ok: true });
});

export default router;
