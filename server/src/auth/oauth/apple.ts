import { Router, type Request, type Response } from 'express';
import express from 'express';
import { Apple } from 'arctic';
import { v4 as uuidv4 } from 'uuid';
import { lucia } from '../lucia.js';
import { findOrCreateOAuthUser, parseCookies } from './discord.js';
import {
  APPLE_CLIENT_ID,
  APPLE_TEAM_ID,
  APPLE_KEY_ID,
  APPLE_PRIVATE_KEY,
  BASE_URL,
} from '../../config.js';

const router = Router();

function getApple(): Apple | null {
  if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) return null;
  // Arctic v3 expects pkcs8PrivateKey as Uint8Array
  const privateKeyBytes = new TextEncoder().encode(APPLE_PRIVATE_KEY);
  return new Apple(
    APPLE_CLIENT_ID,
    APPLE_TEAM_ID,
    APPLE_KEY_ID,
    privateKeyBytes,
    `${BASE_URL}/api/auth/apple/callback`,
  );
}

// GET /api/auth/apple - Start Apple OAuth flow
router.get('/apple', (req: Request, res: Response) => {
  const apple = getApple();
  if (!apple) {
    res.status(503).json({ error: 'Apple OAuth is not configured' });
    return;
  }

  const state = uuidv4();
  const url = apple.createAuthorizationURL(state, ['name', 'email']);

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `apple_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  ]);

  res.redirect(url.toString());
});

// Apple sends POST to callback (not GET)
// Need urlencoded parser for Apple's POST body
router.post(
  '/apple/callback',
  express.urlencoded({ extended: false }),
  async (req: Request, res: Response) => {
    const apple = getApple();
    if (!apple) {
      res.redirect('/?auth=error&reason=not_configured');
      return;
    }

    const code = req.body.code as string | undefined;
    const state = req.body.state as string | undefined;

    const cookies = parseCookies(req.headers.cookie ?? '');
    const storedState = cookies['apple_oauth_state'];

    if (!code || !state || !storedState || state !== storedState) {
      res.redirect('/?auth=error&reason=invalid_state');
      return;
    }

    try {
      const tokens = await apple.validateAuthorizationCode(code);

      // Apple sends user info only on FIRST authorization in the POST body
      // as a JSON-encoded string in the `user` field
      let appleUserName: string | null = null;
      let appleUserEmail: string | null = null;

      if (req.body.user) {
        try {
          const userData = JSON.parse(req.body.user as string) as {
            name?: { firstName?: string; lastName?: string };
            email?: string;
          };
          if (userData.name) {
            const parts = [userData.name.firstName, userData.name.lastName].filter(Boolean);
            appleUserName = parts.join(' ') || null;
          }
          appleUserEmail = userData.email ?? null;
        } catch {
          // user field parse failed, continue without it
        }
      }

      // Decode the ID token to get the subject (user ID) and email
      // Apple's ID token is a JWT; we only need to decode (not verify here
      // since we just received it from Apple's token endpoint over HTTPS)
      const idToken = tokens.idToken();
      const payload = JSON.parse(
        Buffer.from(idToken.split('.')[1], 'base64url').toString(),
      ) as { sub: string; email?: string };

      const appleUserId = payload.sub;
      const email = appleUserEmail ?? payload.email ?? null;
      const displayName = appleUserName ?? (email ? email.split('@')[0] : 'Apple User');

      const userId = findOrCreateOAuthUser({
        provider: 'apple',
        providerUserId: appleUserId,
        email,
        username: displayName,
        avatarUrl: null, // Apple doesn't provide avatars
      });

      const session = await lucia.createSession(userId, {});
      const sessionCookie = lucia.createSessionCookie(session.id);

      res.setHeader('Set-Cookie', [
        sessionCookie.serialize(),
        `apple_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
      ]);

      res.redirect('/?auth=success');
    } catch (err) {
      console.error('[apple-oauth] Callback error:', err);
      res.redirect('/?auth=error&reason=server_error');
    }
  },
);

export default router;
