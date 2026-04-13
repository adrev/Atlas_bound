import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import db from '../db/connection.js';
import { lucia } from './lucia.js';
import { optionalAuth } from './middleware.js';

const router = Router();

// --- Rate limiters ---

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Validation schemas ---

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(50),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// --- Routes ---

// POST /api/auth/register
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { email, password, displayName } = parsed.data;

  // Check email uniqueness
  const existing = db.prepare('SELECT id FROM auth_users WHERE email = ?').get(email);
  if (existing) {
    res.status(409).json({ error: 'An account with that email already exists' });
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const userId = uuidv4();

  const transaction = db.transaction(() => {
    // Create auth user
    db.prepare(
      `INSERT INTO auth_users (id, email, hashed_password, display_name) VALUES (?, ?, ?, ?)`
    ).run(userId, email, hashedPassword, displayName);

    // Create corresponding users row (for session_players, characters, etc.)
    db.prepare(
      `INSERT INTO users (id, display_name, auth_user_id) VALUES (?, ?, ?)`
    ).run(userId, displayName, userId);
  });

  transaction();

  // Create session
  const session = await lucia.createSession(userId, {});
  const cookie = lucia.createSessionCookie(session.id);
  res.setHeader('Set-Cookie', cookie.serialize());

  res.status(201).json({
    user: {
      id: userId,
      email,
      displayName,
      avatarUrl: null,
    },
  });
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { email, password } = parsed.data;

  const user = db.prepare(
    'SELECT id, email, hashed_password, display_name, avatar_url FROM auth_users WHERE email = ?'
  ).get(email) as {
    id: string;
    email: string;
    hashed_password: string | null;
    display_name: string;
    avatar_url: string | null;
  } | undefined;

  if (!user || !user.hashed_password) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const valid = await bcrypt.compare(password, user.hashed_password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const session = await lucia.createSession(user.id, {});
  const cookie = lucia.createSessionCookie(session.id);
  res.setHeader('Set-Cookie', cookie.serialize());

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
    },
  });
});

// POST /api/auth/logout
router.post('/logout', async (req: Request, res: Response) => {
  const sessionId = lucia.readSessionCookie(req.headers.cookie ?? '');
  if (sessionId) {
    await lucia.invalidateSession(sessionId);
  }

  const blankCookie = lucia.createBlankSessionCookie();
  res.setHeader('Set-Cookie', blankCookie.serialize());
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', optionalAuth, (req: Request, res: Response) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }

  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      displayName: req.user.displayName,
      avatarUrl: req.user.avatarUrl,
    },
  });
});

// PUT /api/auth/profile - Update display name and avatar
router.put('/profile', optionalAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }

  const { displayName, avatarUrl } = req.body;
  if (!displayName?.trim()) { res.status(400).json({ error: 'Display name required' }); return; }

  // Update both auth_users and users tables
  db.prepare('UPDATE auth_users SET display_name = ?, avatar_url = ?, updated_at = datetime("now") WHERE id = ?')
    .run(displayName.trim(), avatarUrl || null, user.id);
  db.prepare('UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ? OR auth_user_id = ?')
    .run(displayName.trim(), avatarUrl || null, user.id, user.id);

  res.json({ id: user.id, email: user.email, displayName: displayName.trim(), avatarUrl: avatarUrl || null });
});

export default router;
