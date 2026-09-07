import { Router, type Request, type Response } from 'express';
import { Discord } from 'arctic';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection.js';
import { lucia } from '../lucia.js';
import { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } from '../../config.js';
import { getOAuthOrigin } from './origin.js';
import {
  sanitizeReturnPath,
  returnPathSetCookie,
  returnPathClearCookie,
  readReturnPath,
} from './returnPath.js';

const router = Router();

function getDiscord(req: Request): Discord | null {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return null;
  return new Discord(
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    `${getOAuthOrigin(req)}/api/auth/discord/callback`
  );
}

router.get('/discord', (req: Request, res: Response) => {
  const discord = getDiscord(req);
  if (!discord) {
    res.status(503).json({ error: 'Discord OAuth is not configured' });
    return;
  }
  const state = uuidv4();
  const url = discord.createAuthorizationURL(state, null, ['identify', 'email']);
  const secure = process.env.NODE_ENV === 'production';
  const cookies = [
    `discord_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
  ];
  // Optional post-login destination (e.g. an invite link the user was
  // on when they hit the login wall). Validated to same-origin paths.
  const next = sanitizeReturnPath(req.query.next);
  cookies.push(next ? returnPathSetCookie(next, secure) : returnPathClearCookie());
  res.setHeader('Set-Cookie', cookies);
  res.redirect(url.toString());
});

router.get('/discord/callback', async (req: Request, res: Response) => {
  const discord = getDiscord(req);
  if (!discord) {
    res.redirect('/?auth=error&reason=not_configured');
    return;
  }
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const cookies = parseCookies(req.headers.cookie ?? '');
  const storedState = cookies['discord_oauth_state'];

  if (!code || !state || !storedState || state !== storedState) {
    res.setHeader('Set-Cookie', [
      `discord_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
      returnPathClearCookie(),
    ]);
    res.redirect('/?auth=error&reason=invalid_state');
    return;
  }

  try {
    const tokens = await discord.validateAuthorizationCode(code, null);
    const accessToken = tokens.accessToken();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userResponse.ok) {
      res.setHeader('Set-Cookie', [
        `discord_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
        returnPathClearCookie(),
      ]);
      res.redirect('/?auth=error&reason=discord_api_failed');
      return;
    }

    const discordUser = (await userResponse.json()) as {
      id: string;
      username: string;
      email?: string;
      verified?: boolean;
      avatar?: string;
    };
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null;

    const userId = await findOrCreateOAuthUser({
      provider: 'discord',
      providerUserId: discordUser.id,
      email: discordUser.email ?? null,
      emailVerified: discordUser.verified === true,
      username: discordUser.username,
      avatarUrl,
    });

    const session = await lucia.createSession(userId, {});
    const sessionCookie = lucia.createSessionCookie(session.id);
    const returnTo = readReturnPath(cookies);
    res.setHeader('Set-Cookie', [
      sessionCookie.serialize(),
      `discord_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
      returnPathClearCookie(),
    ]);
    // Land back where the user started (invite link etc.) — falls back
    // to the lobby success page when no return path was stashed.
    res.redirect(returnTo ?? '/?auth=success');
  } catch (err) {
    console.error('[discord-oauth] Callback error:', err);
    res.setHeader('Set-Cookie', [
      `discord_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
      returnPathClearCookie(),
    ]);
    res.redirect(`/?auth=error&reason=${err instanceof OAuthAccountLinkRequiredError ? 'account_link_required' : 'server_error'}`);
  }
});

export class OAuthAccountLinkRequiredError extends Error {}

async function findOrCreateOAuthUser(params: {
  provider: string;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  username: string;
  avatarUrl: string | null;
}): Promise<string> {
  const { provider, providerUserId, emailVerified, username, avatarUrl } = params;
  const email = params.email?.trim().toLowerCase() || null;
  const trustedEmail = emailVerified ? email : null;

  // 1. Check existing OAuth account
  const { rows: oauthRows } = await pool.query(
    'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2',
    [provider, providerUserId]
  );
  if (oauthRows.length > 0) {
    await pool.query(
      'UPDATE oauth_accounts SET provider_username = $1, provider_avatar_url = $2 WHERE provider = $3 AND provider_user_id = $4',
      [username, avatarUrl, provider, providerUserId]
    );
    if (trustedEmail) {
      // Legacy password/OAuth combinations require explicit recovery: a
      // password may have been planted before the first OAuth login.
      try {
        await pool.query(
          `UPDATE auth_users SET email = COALESCE(email, $2), email_verified = 1
           WHERE id = $1 AND hashed_password IS NULL
             AND (lower(email) = $2 OR (email IS NULL AND NOT EXISTS (
               SELECT 1 FROM auth_users AS other WHERE other.id <> $1 AND lower(other.email) = $2)))`,
          [oauthRows[0].user_id, trustedEmail]
        );
      } catch (err) {
        // Another signup may claim this email after the NOT EXISTS check.
        // Email adoption is optional; the linked provider still owns this ID.
        const dbError = err as { code?: string; table?: string; constraint?: string } | null;
        if (
          dbError?.code !== '23505' ||
          dbError.table !== 'auth_users' ||
          dbError.constraint !== 'auth_users_email_key'
        ) {
          throw err;
        }
      }
    }
    return oauthRows[0].user_id;
  }

  // 2. Check existing auth_user by email
  if (trustedEmail) {
    const { rows: userRows } = await pool.query('SELECT id, email_verified, hashed_password FROM auth_users WHERE lower(email) = $1', [
      trustedEmail,
    ]);
    if (userRows.length > 0) {
      if (userRows.length !== 1 || userRows[0].email_verified !== 1 || userRows[0].hashed_password != null) {
        throw new OAuthAccountLinkRequiredError('Sign in with the original login method to resolve this account.');
      }
      await pool.query(
        `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, provider_email, provider_username, provider_avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [provider, providerUserId, userRows[0].id, email, username, avatarUrl]
      );
      return userRows[0].id;
    }
  }

  // 3. Create new user
  const userId = uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO auth_users (id, email, display_name, avatar_url, email_verified) VALUES ($1, $2, $3, $4, $5)',
      [userId, trustedEmail, username, avatarUrl, trustedEmail ? 1 : 0]
    );
    await client.query(
      'INSERT INTO users (id, display_name, avatar_url, auth_user_id) VALUES ($1, $2, $3, $4)',
      [userId, username, avatarUrl, userId]
    );
    await client.query(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, provider_email, provider_username, provider_avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [provider, providerUserId, userId, email, username, avatarUrl]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return userId;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export { findOrCreateOAuthUser, parseCookies };
export default router;
