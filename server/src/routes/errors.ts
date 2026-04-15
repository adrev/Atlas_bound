import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { lucia } from '../auth/lucia.js';

/**
 * Minimal client-error reporter. Used by the React ErrorBoundary.
 *
 * Unauth'd because the error might itself be about a failed login
 * attempt, and we want crash visibility regardless. We still look up
 * the session cookie so the log line includes a user id when possible
 * — that's the single biggest help in prod debugging ("which user is
 * seeing this?").
 *
 * Does NOT persist to the DB — Cloud Run already streams stderr to
 * Cloud Logging, so a plain console.error is enough. Keeping the
 * surface minimal makes the endpoint easy to spam-filter later if a
 * hostile client tries to flood it.
 */
const router = Router();

const clientErrorSchema = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  componentStack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
  buildId: z.string().max(64).optional(),
});

// In-memory rate limit: 20 reports per IP per minute. Good enough to
// stop a rogue client from DOS'ing our log pipeline while still
// catching genuine bursts during a bug.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const reports = new Map<string, number[]>();

function shouldRateLimit(ip: string): boolean {
  const now = Date.now();
  const list = (reports.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (list.length >= RATE_LIMIT_MAX) return true;
  list.push(now);
  reports.set(ip, list);
  return false;
}

router.post('/', async (req: Request, res: Response) => {
  const parsed = clientErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid error payload' });
    return;
  }

  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || 'unknown';
  if (shouldRateLimit(ip)) {
    res.status(429).json({ error: 'Too many error reports' });
    return;
  }

  let userId: string | null = null;
  try {
    const sessionCookie = lucia.readSessionCookie(req.headers.cookie ?? '');
    if (sessionCookie) {
      const { session } = await lucia.validateSession(sessionCookie);
      if (session) userId = session.userId;
    }
  } catch { /* ignore — reporting works unauthenticated too */ }

  const data = parsed.data;
  // One line, structured. Cloud Logging turns the JSON blob into
  // searchable fields automatically.
  console.error(JSON.stringify({
    level: 'client-error',
    userId,
    ip,
    message: data.message,
    url: data.url,
    buildId: data.buildId,
    stack: data.stack,
    componentStack: data.componentStack,
    userAgent: data.userAgent ?? req.headers['user-agent'],
    at: new Date().toISOString(),
  }));

  res.status(204).end();
});

export default router;
