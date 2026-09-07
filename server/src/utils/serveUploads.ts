import express, { Router } from 'express';
import { lucia } from '../auth/lucia.js';
import { UPLOAD_DIR } from '../config.js';
import pool from '../db/connection.js';
import { tryServeUploadFromGcs } from '../routes/uploads.js';
import { canReadUploadedMapAsset } from './uploadAuth.js';

function canonicalUploadPath(rawPath: string): string | null {
  // A separator must be structural, never introduced by URL decoding.
  if (/%(?:2f|5c)/i.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(decoded)) return null;
  const segments = decoded.slice(1).split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || /%(?:2e|2f|5c)/i.test(segment)
    )
  ) {
    return null;
  }
  return decoded;
}

/** Mount at /uploads so authentication, ACLs, and both storage backends share one path. */
export function createUploadRouter(uploadDir = UPLOAD_DIR): Router {
  const router = Router();
  router.use(async (req, res, next) => {
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

    const reqPath = canonicalUploadPath(req.path);
    if (!reqPath) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const serveAuthorizedUpload = async () => {
      if (await tryServeUploadFromGcs(reqPath, res)) return;
      // express.static decodes once. Re-encode the already authorized path
      // so local fallback cannot interpret it differently from the GCS key.
      const queryIndex = req.url.indexOf('?');
      const query = queryIndex === -1 ? '' : req.url.slice(queryIndex);
      req.url = reqPath.split('/').map(encodeURIComponent).join('/') + query;
      next();
    };

    // Compendium art and handouts remain readable to authenticated users.
    if (
      ['/tokens/', '/spells/', '/items/', '/handouts/'].some((prefix) => reqPath.startsWith(prefix))
    ) {
      await serveAuthorizedUpload();
      return;
    }

    // DMs can read all campaign maps; players only the active ribbon map.
    if (reqPath.startsWith('/maps/')) {
      const column = reqPath.startsWith('/maps/thumbnails/') ? 'thumbnail_url' : 'image_url';
      if (!(await canReadUploadedMapAsset(`/uploads${reqPath}`, user.id, column))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      await serveAuthorizedUpload();
      return;
    }

    // Portraits require character ownership or shared session membership.
    if (reqPath.startsWith('/portraits/')) {
      const { rows } = await pool.query(
        `SELECT 1 FROM characters c
       LEFT JOIN session_players sp1 ON sp1.character_id = c.id
       LEFT JOIN session_players sp2 ON sp2.session_id = sp1.session_id
       WHERE c.portrait_url = $1
         AND (c.user_id = $2 OR sp2.user_id = $2)
       LIMIT 1`,
        [`/uploads${reqPath}`, user.id]
      );
      if (rows.length === 0) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      await serveAuthorizedUpload();
      return;
    }

    res.status(404).json({ error: 'Not found' });
  });
  router.use(
    express.static(uploadDir, {
      maxAge: '1h',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    })
  );
  return router;
}
