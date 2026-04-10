import type { Request, Response, NextFunction } from 'express';
import type { Session, User } from 'lucia';
import { lucia } from './lucia.js';

// Augment Express Request with auth fields
declare global {
  namespace Express {
    interface Request {
      user: User | null;
      session: Session | null;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionId = lucia.readSessionCookie(req.headers.cookie ?? '');
  if (!sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { session, user } = await lucia.validateSession(sessionId);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  // Renew cookie if session was refreshed
  if (session.fresh) {
    const cookie = lucia.createSessionCookie(session.id);
    res.setHeader('Set-Cookie', cookie.serialize());
  }

  req.user = user;
  req.session = session;
  next();
}

export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  req.user = null;
  req.session = null;

  const sessionId = lucia.readSessionCookie(req.headers.cookie ?? '');
  if (!sessionId) {
    next();
    return;
  }

  const { session, user } = await lucia.validateSession(sessionId);
  if (session) {
    if (session.fresh) {
      const cookie = lucia.createSessionCookie(session.id);
      res.setHeader('Set-Cookie', cookie.serialize());
    }
    req.user = user;
    req.session = session;
  }

  next();
}
