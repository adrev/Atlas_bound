import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { IS_PRODUCTION } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Serve the built client in production mode.
 * - Static files from ../client/dist
 * - SPA fallback: any non-API route serves index.html
 */
export function setupStaticServing(app: Express): void {
  if (!IS_PRODUCTION) return;

  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');

  // Serve static assets (JS, CSS, images, etc.)
  app.use(express.static(clientDist, {
    maxAge: '1y',
    immutable: true,
    index: false, // We handle index.html via the SPA fallback
  }));

  // SPA fallback: any GET request that doesn't match an API route
  // or a static file gets index.html
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    // Skip API routes
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/socket.io/')) {
      next();
      return;
    }

    res.sendFile(path.join(clientDist, 'index.html'));
  });
}
