import { Router, type Request, type Response } from 'express';
import { Discord } from 'arctic';
import { v4 as uuidv4 } from 'uuid';
import db from '../../db/connection.js';
import { lucia } from '../lucia.js';
import {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  BASE_URL,
} from '../../config.js';

const router = Router();

function getDiscord(): Discord | null {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return null;
  return new Discord(
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    `${BASE_URL}/api/auth/discord/callback`,
  );
}

// GET /api/auth/discord - Start Discord OAuth flow
router.get('/discord', (req: Request, res: Response) => {
  const discord = getDiscord();
  if (!discord) {
    res.status(503).json({ error: 'Discord OAuth is not configured' });
    return;
  }

  const state = uuidv4();
  // Discord doesn't require PKCE but arctic v3 API expects the parameter (nullable)
  const url = discord.createAuthorizationURL(state, null, ['identify', 'email']);

  // Store state in httpOnly cookie for validation
  res.setHeader('Set-Cookie', [
    `discord_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  ]);

  res.redirect(url.toString());
});

// GET /api/auth/discord/callback - Discord OAuth callback
router.get('/discord/callback', async (req: Request, res: Response) => {
  const discord = getDiscord();
  if (!discord) {
    res.redirect('/?auth=error&reason=not_configured');
    return;
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  // Parse state cookie manually
  const cookies = parseCookies(req.headers.cookie ?? '');
  const storedState = cookies['discord_oauth_state'];

  if (!code || !state || !storedState || state !== storedState) {
    res.redirect('/?auth=error&reason=invalid_state');
    return;
  }

  try {
    // Exchange code for tokens
    const tokens = await discord.validateAuthorizationCode(code, null);
    const accessToken = tokens.accessToken();

    // Fetch Discord user profile
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userResponse.ok) {
      res.redirect('/?auth=error&reason=discord_api_failed');
      return;
    }

    const discordUser = (await userResponse.json()) as {
      id: string;
      username: string;
      email?: string;
      avatar?: string;
    };

    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null;

    // Find or create user
    const userId = findOrCreateOAuthUser({
      provider: 'discord',
      providerUserId: discordUser.id,
      email: discordUser.email ?? null,
      username: discordUser.username,
      avatarUrl,
    });

    // Create session
    const session = await lucia.createSession(userId, {});
    const sessionCookie = lucia.createSessionCookie(session.id);

    // Clear state cookie, set session cookie
    res.setHeader('Set-Cookie', [
      sessionCookie.serialize(),
      `discord_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
    ]);

    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[discord-oauth] Callback error:', err);
    res.redirect('/?auth=error&reason=server_error');
  }
});

/**
 * Find an existing user by OAuth account or email, or create a new one.
 * Returns the auth_users.id
 */
function findOrCreateOAuthUser(params: {
  provider: string;
  providerUserId: string;
  email: string | null;
  username: string;
  avatarUrl: string | null;
}): string {
  const { provider, providerUserId, email, username, avatarUrl } = params;

  // 1. Check if OAuth account already exists
  const existingOAuth = db.prepare(
    'SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?'
  ).get(provider, providerUserId) as { user_id: string } | undefined;

  if (existingOAuth) {
    // Update avatar/username on the oauth_accounts row
    db.prepare(
      'UPDATE oauth_accounts SET provider_username = ?, provider_avatar_url = ? WHERE provider = ? AND provider_user_id = ?'
    ).run(username, avatarUrl, provider, providerUserId);

    return existingOAuth.user_id;
  }

  // 2. Check if an auth_user with the same email exists (link accounts)
  if (email) {
    const existingUser = db.prepare(
      'SELECT id FROM auth_users WHERE email = ?'
    ).get(email) as { id: string } | undefined;

    if (existingUser) {
      // Link this OAuth account to the existing user
      db.prepare(
        `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, provider_email, provider_username, provider_avatar_url)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(provider, providerUserId, existingUser.id, email, username, avatarUrl);

      return existingUser.id;
    }
  }

  // 3. Create new user
  const userId = uuidv4();

  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO auth_users (id, email, display_name, avatar_url) VALUES (?, ?, ?, ?)`
    ).run(userId, email, username, avatarUrl);

    db.prepare(
      `INSERT INTO users (id, display_name, avatar_url, auth_user_id) VALUES (?, ?, ?, ?)`
    ).run(userId, username, avatarUrl, userId);

    db.prepare(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, provider_email, provider_username, provider_avatar_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(provider, providerUserId, userId, email, username, avatarUrl);
  });

  transaction();

  return userId;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key) {
      cookies[key.trim()] = rest.join('=').trim();
    }
  }
  return cookies;
}

// Export the helper for reuse by other OAuth providers
export { findOrCreateOAuthUser, parseCookies };

export default router;
