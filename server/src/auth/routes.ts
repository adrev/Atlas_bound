import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import pool from '../db/connection.js';
import { lucia } from './lucia.js';
import { optionalAuth, requireAuth } from './middleware.js';
import { safeImageUrlSchema } from '../utils/imageUrlValidator.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
  validate: false, // Cloud Run proxies set X-Forwarded-For
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
  validate: false,
});

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(50),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/auth/register
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { email, password, displayName } = parsed.data;

  const { rows: existingRows } = await pool.query('SELECT id FROM auth_users WHERE email = $1', [email]);
  if (existingRows.length > 0) {
    res.status(409).json({ error: 'An account with that email already exists' });
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const userId = uuidv4();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO auth_users (id, email, hashed_password, display_name) VALUES ($1, $2, $3, $4)',
      [userId, email, hashedPassword, displayName],
    );
    await client.query(
      'INSERT INTO users (id, display_name, auth_user_id) VALUES ($1, $2, $3)',
      [userId, displayName, userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const session = await lucia.createSession(userId, {});
  const cookie = lucia.createSessionCookie(session.id);
  res.setHeader('Set-Cookie', cookie.serialize());

  res.status(201).json({ user: { id: userId, email, displayName, avatarUrl: null } });
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { email, password } = parsed.data;

  const { rows } = await pool.query(
    'SELECT id, email, hashed_password, display_name, avatar_url FROM auth_users WHERE email = $1',
    [email],
  );
  const user = rows[0] as { id: string; email: string; hashed_password: string | null; display_name: string; avatar_url: string | null } | undefined;

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

  res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, avatarUrl: user.avatar_url } });
});

// POST /api/auth/logout
router.post('/logout', async (req: Request, res: Response) => {
  const sessionId = lucia.readSessionCookie(req.headers.cookie ?? '');
  if (sessionId) await lucia.invalidateSession(sessionId);
  const blankCookie = lucia.createBlankSessionCookie();
  res.setHeader('Set-Cookie', blankCookie.serialize());
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', optionalAuth, (req: Request, res: Response) => {
  if (!req.user) { res.json({ user: null }); return; }
  res.json({ user: { id: req.user.id, email: req.user.email, displayName: req.user.displayName, avatarUrl: req.user.avatarUrl } });
});

// PUT /api/auth/profile
const profileUpdateSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  avatarUrl: safeImageUrlSchema.nullable().optional(),
});

router.put('/profile', requireAuth, async (req: Request, res: Response) => {
  const user = req.user!;

  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { displayName, avatarUrl } = parsed.data;
  const finalDisplayName = displayName?.trim() || user.displayName;
  const finalAvatarUrl = avatarUrl !== undefined ? avatarUrl : user.avatarUrl;

  await pool.query("UPDATE auth_users SET display_name = $1, avatar_url = $2, updated_at = NOW()::text WHERE id = $3",
    [finalDisplayName, finalAvatarUrl || null, user.id]);
  await pool.query('UPDATE users SET display_name = $1, avatar_url = $2 WHERE id = $3 OR auth_user_id = $3',
    [finalDisplayName, finalAvatarUrl || null, user.id]);

  res.json({ id: user.id, email: user.email, displayName: finalDisplayName, avatarUrl: finalAvatarUrl || null });
});

export default router;
