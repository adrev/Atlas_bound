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
import errorsRouter from './routes/errors.js';
import { seedCompendium, isCompendiumSeeded } from './services/Open5eService.js';
import { seedEquipment, isEquipmentSeeded } from './services/seedEquipment.js';
import { registerSocketHandler } from './socket/handler.js';
import { setIO } from './socket/ioInstance.js';
import { setupStaticServing } from './static.js';
import { tokenUpload, portraitUpload, handoutUpload, validateAndSaveUpload } from './routes/uploads.js';
import rateLimit from 'express-rate-limit';
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

// Seed compendium in the background (don't block startup). Flip a
// module-level flag when done so /api/health can distinguish
// "process is alive" from "ready to serve reads that hit the compendium".
let compendiumReady = false;
isCompendiumSeeded().then(seeded => {
  if (!seeded) {
    console.log('Seeding D&D 5E compendium from open5e API...');
    seedCompendium()
      .then(() => { compendiumReady = true; console.log('Compendium seeded!'); })
      .catch(err => console.error('Seed failed:', err));
  } else {
    compendiumReady = true;
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
      // 'wasm-unsafe-eval' lets us instantiate WebAssembly modules
      // (Ammo.js physics powering the 3D dice). blob: is needed so
      // @3d-dice/dice-box can spawn its Babylon.js render worker from
      // a generated blob URL — without it the dice never appear and
      // the browser logs a CSP violation the moment a roll fires.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'blob:'],
      // Explicit worker-src so the browser doesn't fall through to
      // the script-src fallback and still block the blob worker.
      workerSrc: ["'self'", 'blob:'],
      // Google Fonts sends its CSS from fonts.googleapis.com and
      // pulls the actual font files from fonts.gstatic.com. Without
      // the first, every @font-face link in index.html gets blocked
      // and the UI falls back to system fonts mid-session.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', '*.dndbeyond.com', '*.discordapp.com', '*.discord.com', '*.googleusercontent.com', 'https://storage.googleapis.com'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'blob:', 'https://storage.googleapis.com'],
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

  // Maps: caller must be a member of a session that references the map
  // file. Two distinct asset namespaces share this prefix:
  //   /uploads/maps/{file}                       — full-resolution map
  //   /uploads/maps/thumbnails/{file}            — 480-px JPEG thumbnail
  // Both check the maps table; the thumbnail variant matches against
  // `thumbnail_url` so the same membership rule applies without
  // letting an attacker enumerate thumbnails for sessions they
  // aren't in.
  if (reqPath.startsWith('/maps/')) {
    const url = `/uploads${reqPath}`;
    const isThumbnail = reqPath.startsWith('/maps/thumbnails/');
    const column = isThumbnail ? 'thumbnail_url' : 'image_url';
    const { rows } = await pool.query(
      `SELECT 1 FROM maps m
       JOIN session_players sp ON sp.session_id = m.session_id
       WHERE m.${column} = $1 AND sp.user_id = $2
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

  // Default-deny any /uploads subpath we don't recognise. Adding a new
  // upload folder must be an explicit decision — otherwise a future
  // /uploads/private/ folder (e.g. for handout images scoped to a
  // specific player) would be silently readable by every logged-in
  // user.
  res.status(404).json({ error: 'Not found' });
  return;
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

// Split liveness + readiness so Cloud Run doesn't route traffic to a
// node that's still seeding the compendium.
//
//   /healthz  — LIVENESS.  Process is up and can respond. Used by
//               Cloud Run's basic health check. Never fails unless
//               the process itself has deadlocked.
//   /readyz   — READINESS. 200 only when the DB is reachable AND
//               the compendium seed has completed. This is what
//               autoscaler / load-balancer probes should hit.
//
// /api/health kept as a legacy alias of /readyz so existing probes
// and smoke tests don't break.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});
const readinessHandler = async (_req: express.Request, res: express.Response) => {
  let db: 'ok' | 'down' = 'ok';
  try { await pool.query('SELECT 1'); } catch { db = 'down'; }
  const ready = db === 'ok' && compendiumReady;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'starting',
    db,
    compendium: compendiumReady ? 'ready' : 'seeding',
    timestamp: new Date().toISOString(),
  });
};
app.get('/readyz', readinessHandler);
app.get('/api/health', readinessHandler);

// Public API routes
app.use('/api/compendium', compendiumRouter);
app.use('/api/errors', errorsRouter);

// Protected API routes
app.use('/api/sessions', requireAuth, sessionsRouter);
app.use('/api', requireAuth, mapsRouter);
app.use('/api/characters', requireAuth, charactersRouter);
app.use('/api/dndbeyond', requireAuth, dndbeyondRouter);
app.use('/api', requireAuth, lootRouter);
app.use('/api/custom', requireAuth, customContentRouter);
app.use('/api', requireAuth, notesRouter);
app.use('/api', requireAuth, encountersRouter);

// Upload endpoints (authenticated, magic-byte validated, rate-limited).
// Without a per-user cap any logged-in account could repeatedly store
// 5 MB orphan files. 10 uploads per 5 minutes per IP is generous for
// normal play (token portrait + map upload) while blocking scripts.
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads — try again in a few minutes' },
});
app.post('/api/uploads/token-image', requireAuth, uploadLimiter, tokenUpload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  try {
    const filename = validateAndSaveUpload(req.file, 'tokens');
    res.json({ url: `/uploads/tokens/${filename}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid image file';
    res.status(400).json({ error: msg });
  }
});
app.post('/api/uploads/portrait', requireAuth, uploadLimiter, portraitUpload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  try {
    const filename = validateAndSaveUpload(req.file, 'portraits');
    res.json({ url: `/uploads/portraits/${filename}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid image file';
    res.status(400).json({ error: msg });
  }
});

/**
 * Handout image upload endpoint — DM picks a file in HandoutSender
 * and receives back a `/uploads/handouts/<uuid>.<ext>` URL that gets
 * stamped on the outgoing `session:handout` payload. Subject to the
 * same 5 MB / image-magic-byte validation as the other upload endpoints.
 * Saved alongside the auto-created note so players can browse past
 * handouts + their images in the Notes tab.
 */
app.post('/api/uploads/handout', requireAuth, uploadLimiter, handoutUpload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  try {
    const filename = validateAndSaveUpload(req.file, 'handouts');
    res.json({ url: `/uploads/handouts/${filename}` });
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
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { status?: number; message?: string } | null;
  const status = e?.status ?? 500;
  const message = status < 500 ? (e?.message ?? 'Bad request') : 'Internal server error';
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
