import { Router, type Request, type Response } from 'express';
import { Google } from 'arctic';
import { v4 as uuidv4 } from 'uuid';
import { lucia } from '../lucia.js';
import { findOrCreateOAuthUser, parseCookies } from './discord.js';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BASE_URL,
} from '../../config.js';

const router = Router();

function getGoogle(): Google | null {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  return new Google(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/api/auth/google/callback`,
  );
}

// GET /api/auth/google - Start Google OAuth flow
router.get('/google', async (req: Request, res: Response) => {
  const google = getGoogle();
  if (!google) {
    res.status(503).json({ error: 'Google OAuth is not configured' });
    return;
  }

  const state = uuidv4();
  const codeVerifier = uuidv4() + uuidv4(); // PKCE code verifier
  const url = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']);

  // Store state and code verifier in httpOnly cookies
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `google_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
    `google_code_verifier=${codeVerifier}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  ]);

  res.redirect(url.toString());
});

// GET /api/auth/google/callback - Google OAuth callback
router.get('/google/callback', async (req: Request, res: Response) => {
  const google = getGoogle();
  if (!google) {
    res.redirect('/?auth=error&reason=not_configured');
    return;
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  const cookies = parseCookies(req.headers.cookie ?? '');
  const storedState = cookies['google_oauth_state'];
  const codeVerifier = cookies['google_code_verifier'];

  if (!code || !state || !storedState || state !== storedState || !codeVerifier) {
    res.redirect('/?auth=error&reason=invalid_state');
    return;
  }

  try {
    const tokens = await google.validateAuthorizationCode(code, codeVerifier);
    const accessToken = tokens.accessToken();

    // Fetch Google user info
    const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userResponse.ok) {
      res.redirect('/?auth=error&reason=google_api_failed');
      return;
    }

    const googleUser = (await userResponse.json()) as {
      sub: string;
      email?: string;
      name?: string;
      picture?: string;
    };

    const userId = await findOrCreateOAuthUser({
      provider: 'google',
      providerUserId: googleUser.sub,
      email: googleUser.email ?? null,
      username: googleUser.name ?? googleUser.email ?? 'Google User',
      avatarUrl: googleUser.picture ?? null,
    });

    const session = await lucia.createSession(userId, {});
    const sessionCookie = lucia.createSessionCookie(session.id);

    res.setHeader('Set-Cookie', [
      sessionCookie.serialize(),
      `google_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
      `google_code_verifier=; Path=/; HttpOnly; Max-Age=0`,
    ]);

    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[google-oauth] Callback error:', err);
    res.redirect('/?auth=error&reason=server_error');
  }
});

export default router;
