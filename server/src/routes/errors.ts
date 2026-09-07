import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ipKeyGenerator } from 'express-rate-limit';
import { lucia } from '../auth/lucia.js';
import { BoundedRateLimiter } from '../utils/boundedRateLimiter.js';

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
const clientErrorSchema = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  componentStack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
  buildId: z.string().max(64).optional(),
});

// Bound both the rolling report count and the number of tracked addresses.
// At capacity, new addresses fail closed until an existing entry expires.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_MAX_KEYS = 10_000;

export function createErrorsRouter(
  limiter = new BoundedRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_KEYS)
): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const parsed = clientErrorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid error payload' });
      return;
    }

    // Express applies the configured proxy trust; never trust a raw XFF prefix.
    // Group IPv6 addresses by subnet so rotating interface IDs cannot reset limits.
    const ip = ipKeyGenerator(req.ip || 'unknown');
    if (!limiter.consume(ip)) {
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
    } catch {
      /* ignore — reporting works unauthenticated too */
    }

    const data = parsed.data;
    // One line, structured. Cloud Logging turns the JSON blob into
    // searchable fields automatically.
    console.error(
      JSON.stringify({
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
      })
    );

    res.status(204).end();
  });
  return router;
}

export default createErrorsRouter();
