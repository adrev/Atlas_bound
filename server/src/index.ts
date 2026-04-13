import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
import { tokenUpload, portraitUpload } from './routes/uploads.js';
import authRouter from './auth/routes.js';
import discordAuth from './auth/oauth/discord.js';
import googleAuth from './auth/oauth/google.js';
import appleAuth from './auth/oauth/apple.js';
import { requireAuth } from './auth/middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize database
initDatabase();
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
if (!isEquipmentSeeded()) {
  console.log('Seeding PHB equipment...');
  seedEquipment();
} else {
  console.log('PHB equipment already seeded');
}

// Create Express app
const app = express();

// Middleware
app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Static file serving for uploads
app.use('/uploads', express.static(UPLOAD_DIR));

// Auth routes (unauthenticated)
app.use('/api/auth', authRouter);
app.use('/api/auth', discordAuth);
app.use('/api/auth', googleAuth);
app.use('/api/auth', appleAuth);

// Public API routes
app.use('/api/compendium', compendiumRouter);

// Protected API routes
app.use('/api/sessions', requireAuth, sessionsRouter);
app.use('/api', requireAuth, mapsRouter);
app.use('/api/characters', requireAuth, charactersRouter);
app.use('/api/dndbeyond', requireAuth, dndbeyondRouter);
app.use('/api', requireAuth, lootRouter);
app.use('/api/custom', requireAuth, customContentRouter);

// Upload endpoints
app.post('/api/uploads/token-image', tokenUpload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  res.json({ url: `/uploads/tokens/${req.file.filename}` });
});
app.post('/api/uploads/portrait', portraitUpload.single('image'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'No image file' }); return; }
  res.json({ url: `/uploads/portraits/${req.file.filename}` });
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// Start listening
httpServer.listen(PORT, () => {
  console.log(`D&D VTT Server running on http://localhost:${PORT}`);
  console.log(`CORS origins: ${CORS_ORIGINS.join(', ')}`);
  console.log(`Environment: ${IS_PRODUCTION ? 'production' : 'development'}`);
});

export { app, io, httpServer };
