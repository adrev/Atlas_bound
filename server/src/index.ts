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
import { seedCompendium, isCompendiumSeeded } from './services/Open5eService.js';
import { seedEquipment, isEquipmentSeeded } from './services/seedEquipment.js';
import { registerSocketHandler } from './socket/handler.js';
import { setupStaticServing } from './static.js';
import { tokenUpload, portraitUpload, validateAndSaveUpload } from './routes/uploads.js';
import authRouter from './auth/routes.js';
import discordAuth from './auth/oauth/discord.js';
import googleAuth from './auth/oauth/google.js';
import appleAuth from './auth/oauth/apple.js';
import { requireAuth } from './auth/middleware.js';
import { lucia } from './auth/lucia.js';

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
      imgSrc: ["'self'", 'data:', 'blob:', '*.dndbeyond.com', '*.discordapp.com', '*.discord.com', '*.googleusercontent.com'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
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

// Static file serving for uploads (authenticated, with nosniff)
app.use('/uploads', async (req, res, next) => {
  const sessionCookie = lucia.readSessionCookie(req.headers.cookie ?? '');
  if (!sessionCookie) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const { session } = await lucia.validateSession(sessionCookie);
  if (!session) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }
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
