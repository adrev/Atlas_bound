import { Router, type Request, type Response } from 'express';
import { Discord } from 'arctic';
import { v4 as uuidv4 } from 'uuid';
import pool from '../../db/connection.js';
import { lucia } from '../lucia.js';
import {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  BASE_URL,
} from '../../config.js';

const router = Router();

function getDiscord(): Discord | null {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return null;
  return new Discord(DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, `${BASE_URL}/api/auth/discord/callback`);
}

router.get('/discord', (req: Request, res: Response) => {
  const discord = getDiscord();
  if (!discord) { res.status(503).json({ error: 'Discord OAuth is not configured' }); return; }
  const state = uuidv4();
  const url = discord.createAuthorizationURL(state, null, ['identify', 'email']);
  res.setHeader('Set-Cookie', [
    `discord_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  ]);
  res.redirect(url.toString());
});

router.get('/discord/callback', async (req: Request, res: Response) => {
  const discord = getDiscord();
  if (!discord) { res.redirect('/?auth=error&reason=not_configured'); return; }
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const cookies = parseCookies(req.headers.cookie ?? '');
  const storedState = cookies['discord_oauth_state'];

  if (!code || !state || !storedState || state !== storedState) {
    res.redirect('/?auth=error&reason=invalid_state'); return;
  }

  try {
    const tokens = await discord.validateAuthorizationCode(code, null);
    const accessToken = tokens.accessToken();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userResponse.ok) { res.redirect('/?auth=error&reason=discord_api_failed'); return; }

    const discordUser = (await userResponse.json()) as { id: string; username: string; email?: string; avatar?: string };
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png` : null;

    const userId = await findOrCreateOAuthUser({
      provider: 'discord', providerUserId: discordUser.id,
      email: discordUser.email ?? null, username: discordUser.username, avatarUrl,
    });

    const session = await lucia.createSession(userId, {});
    const sessionCookie = lucia.createSessionCookie(session.id);
    res.setHeader('Set-Cookie', [sessionCookie.serialize(), `discord_oauth_state=; Path=/; HttpOnly; Max-Age=0`]);
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[discord-oauth] Callback error:', err);
    res.redirect('/?auth=error&reason=server_error');
  }
});

async function findOrCreateOAuthUser(params: {
  provider: string; providerUserId: string;
  email: string | null; username: string; avatarUrl: string | null;
}): Promise<string> {
  const { provider, providerUserId, email, username, avatarUrl } = params;

  // 1. Check existing OAuth account
  const { rows: oauthRows } = await pool.query(
    'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2',
    [provider, providerUserId],
  );
  if (oauthRows.length > 0) {
    await pool.query(
      'UPDATE oauth_accounts SET provider_username = $1, provider_avatar_url = $2 WHERE provider = $3 AND provider_user_id = $4',
      [username, avatarUrl, provider, providerUserId],
    );
    return oauthRows[0].user_id;
  }

  // 2. Check existing auth_user by email
  if (email) {
    const { rows: userRows } = await pool.query('SELECT id FROM auth_users WHERE email = $1', [email]);
    if (userRows.length > 0) {
      await pool.query(
        `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, provider_email, provider_username, provider_avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [provider, providerUserId, userRows[0].id, email, username, avatarUrl],
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
      'INSERT INTO auth_users (id, email, display_name, avatar_url) VALUES ($1, $2, $3, $4)',
      [userId, email, username, avatarUrl],
    );
    await client.query(
      'INSERT INTO users (id, display_name, avatar_url, auth_user_id) VALUES ($1, $2, $3, $4)',
      [userId, username, avatarUrl, userId],
    );
    await client.query(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, provider_email, provider_username, provider_avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [provider, providerUserId, userId, email, username, avatarUrl],
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
