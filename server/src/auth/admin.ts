import type { Request, Response, NextFunction } from 'express';

/**
 * Parse the ADMIN_USER_IDS env var into a Set of allowed identifiers.
 * Admins may be identified by user id or email (comma-separated list).
 */
function getAdminIdentifiers(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Middleware that gates a route to admin users only.
 *
 * Requires `requireAuth` to have run first so `req.user` is populated.
 *
 * Admins are identified by matching `req.user.id` or `req.user.email`
 * against the `ADMIN_USER_IDS` environment variable (comma-separated).
 *
 * If `ADMIN_USER_IDS` is empty:
 *   - In production (`NODE_ENV === 'production'`): refuse access.
 *   - Otherwise: log a warning and allow access (dev convenience).
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = req.user;
  if (!user || !user.id) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const admins = getAdminIdentifiers();

  if (admins.size === 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[requireAdmin] ADMIN_USER_IDS is not configured; refusing admin access in production.',
      );
      res.status(403).json({ error: 'Admin access not configured' });
      return;
    }
    console.warn(
      '[requireAdmin] ADMIN_USER_IDS is empty; allowing admin access in non-production environment.',
    );
    next();
    return;
  }

  const email = (user as { email?: string | null }).email ?? '';
  if (admins.has(user.id) || (email && admins.has(email))) {
    next();
    return;
  }

  res.status(403).json({ error: 'Admin privileges required' });
}
