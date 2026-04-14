import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ClientToServerEvents, ServerToClientEvents } from '@dnd-vtt/shared';
import { PORT, CORS_ORIGINS, UPLOAD_DIR, IS_PRODUCTION } from './config.js';
import { initDatabase } from './db/schema.js';
import sessionsRouter from './routes/sessions.js';
import mapsRouter from './routes/maps.js';
import charactersRouter from './routes/characters.js';
import dndbeyondRouter from './routes/dndbeyond.js';
import compendiumRouter from './routes/compendium.js';
import lootRouter from './routes/loot.js';
import customContentRouter from './routes/customContent.js';
import notesRouter from './routes/notes.js';
import encountersRouter from './routes/encounters.js';
import { seedCompendium, isCompendiumSeeded } from './services/Open5eService.js';
import { seedEquipment, isEquipmentSeeded } from './services/seedEquipment.js';
import { registerSocketHandler } from './socket/handler.js';
import { setIO } from './socket/ioInstance.js';
import { setupStaticServing } from './static.js';
import { tokenUpload, portraitUpload, validateAndSaveUpload } from './routes/uploads.js';
import authRouter from './auth/routes.js';
import discordAuth from './auth/oauth/discord.js';
import googleAuth from './auth/oauth/google.js';
import appleAuth from './auth/oauth/apple.js';
import { requireAuth } from './auth/middleware.js';
import { lucia } from './auth/lucia.js';
import pool from './db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize database (async for Postgres)
await initDatabase();
console.log('Database initialized');

// Seed compendium in the background (don't block startup)
isCompendiumSeeded().then(seeded => {
  if (!seeded) {
    console.log('Seeding D&D 5E compendium from open5e API...');
    seedCompendium().then(() => console.log('Compendium seeded!')).catch(err => console.error('Seed failed:', err));
  } else {
    console.log('Compendium already seeded');
  }
});

// Seed PHB equipment (mundane weapons, armor, gear)
const equipmentSeeded = await isEquipmentSeeded();
if (!equipmentSeeded) {
  console.log('Seeding PHB equipment...');
  await seedEquipment();
} else {
  console.log('PHB equipment already seeded');
}

// Create Express app
const app = express();

// Trust the Cloud Run proxy so cookies with Secure flag work
// behind the HTTPS load balancer (app sees HTTP internally)
app.set('trust proxy', 1);

// Security headers
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', '*.dndbeyond.com', '*.discordapp.com', '*.discord.com', '*.googleusercontent.com', 'https://storage.googleapis.com'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https://storage.googleapis.com'],
      mediaSrc: ["'self'", 'https://storage.googleapis.com'],
    },
  },
  hsts: IS_PRODUCTION,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Middleware
app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Static file serving for uploads (authenticated + scoped, with nosniff).
//
// Paths under /uploads/tokens, /uploads/spells, /uploads/items are treated
// as public compendium artwork and only require a valid session.
//
// Paths under /uploads/maps and /uploads/portraits are scoped to users
// who share a session with the asset: otherwise any authenticated user
// could harvest maps/portraits from other users' sessions by guessing
// filenames. The lookup is imperfect (file renames etc. are not tracked)
// but it stops cross-session scraping in the common case.
app.use('/uploads', async (req, res, next) => {
  const sessionCookie = lucia.readSessionCookie(req.headers.cookie ?? '');
  if (!sessionCookie) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const { session, user } = await lucia.validateSession(sessionCookie);
  if (!session || !user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  const reqPath = req.path;

  // Reject any path traversal attempts (belt-and-suspenders in addition
  // to express.static's own protection).
  if (reqPath.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  // Public compendium art — no per-user scoping needed.
  if (
    reqPath.startsWith('/tokens/') ||
    reqPath.startsWith('/spells/') ||
    reqPath.startsWith('/items/')
  ) {
    next();
    return;
  }

  // Maps: caller must be a member of a session that references the map file.
  if (reqPath.startsWith('/maps/')) {
    const filename = reqPath.slice('/maps/'.length);
    const url = `/uploads/maps/${filename}`;
    const { rows } = await pool.query(
      `SELECT 1 FROM maps m
       JOIN session_players sp ON sp.session_id = m.session_id
       WHERE m.image_url = $1 AND sp.user_id = $2
       LIMIT 1`,
      [url, user.id],
    );
    if (rows.length === 0) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
    return;
  }

  // Portraits: caller must own the character that uses the portrait,
  // or share a session with a character that uses it.
  if (reqPath.startsWith('/portraits/')) {
    const filename = reqPath.slice('/portraits/'.length);
    const url = `/uploads/portraits/${filename}`;
    const { rows } = await pool.query(
      `SELECT 1 FROM characters c
       LEFT JOIN session_players sp1 ON sp1.character_id = c.id
       LEFT JOIN session_players sp2 ON sp2.session_id = sp1.session_id
       WHERE c.portrait_url = $1
         AND (c.user_id = $2 OR sp2.user_id = $2)
       LIMIT 1`,
      [url, user.id],
    );
    if (rows.length === 0) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
    return;
  }

  // Any other /uploads subpath: fall through to static (authenticated only).
  next();
}, express.static(UPLOAD_DIR, {
  maxAge: '1h',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// Auth routes (unauthenticated)
app.use('/api/auth', authRouter);
app.use('/api/auth', discordAuth);
app.use('/api/auth', googleAuth);
app.use('/api/auth', appleAuth);

// Health check (before auth middleware — used by Cloud Run + Docker HEALTHCHECK)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public API routes
app.use('/api/compendium', compendiumRouter);

// Protected API routes
app.use('/api/sessions', requireAuth, sessionsRouter);
app.use('/api', requireAuth, mapsRouter);
app.use('/api/characters', requireAuth, charactersRouter);
app.use('/api/dndbeyond', requireAuth, dndbeyondRouter);
app.use('/api', requireAuth, lootRouter);
app.use('/api/custom', requireAuth, customContentRouter);
app.use('/api', requireAuth, notesRouter);
app.use('/api', requireAuth, encountersRouter);

// Upload endpoints (authenticated, with magic-byte validation)
app.post('/api/uploads/token-image', requireAuth, tokenUpload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  try {
    const filename = validateAndSaveUpload(req.file, 'tokens');
    res.json({ url: `/uploads/tokens/${filename}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid image file';
    res.status(400).json({ error: msg });
  }
});
app.post('/api/uploads/portrait', requireAuth, portraitUpload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  try {
    const filename = validateAndSaveUpload(req.file, 'portraits');
    res.json({ url: `/uploads/portraits/${filename}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid image file';
    res.status(400).json({ error: msg });
  }
});

// Serve client build in production (static files + SPA fallback)
setupStaticServing(app);

// Create HTTP server
const httpServer = createServer(app);

// Create Socket.io server with typed events
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    credentials: true,
  },
  maxHttpBufferSize: 5 * 1024 * 1024, // 5MB for larger payloads
});

// Expose io to non-socket modules (HTTP routes) that need to broadcast.
setIO(io);

// Register socket event handlers
registerSocketHandler(io);

// Global error handler — catches thrown errors from async routes and authorization helpers
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  if (status >= 500) console.error('[Server Error]', err);
  res.status(status).json({ error: message });
});

// Start listening
httpServer.listen(PORT, () => {
  console.log(`D&D VTT Server running on http://localhost:${PORT}`);
  console.log(`CORS origins: ${CORS_ORIGINS.join(', ')}`);
  console.log(`Environment: ${IS_PRODUCTION ? 'production' : 'development'}`);
});

export { app, io, httpServer };
