import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  createSession: vi.fn(),
  validateCode: vi.fn(),
}));
vi.mock('../db/connection.js', () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../auth/lucia.js', () => ({
  lucia: {
    createSession: mocks.createSession,
    createSessionCookie: () => ({ serialize: () => 'auth_session=test-session' }),
  },
}));
vi.mock('../config.js', () => ({
  BASE_URL: 'https://example.test',
  CORS_ORIGINS: [],
  DISCORD_CLIENT_ID: 'test',
  DISCORD_CLIENT_SECRET: 'test',
  GOOGLE_CLIENT_ID: 'test',
  GOOGLE_CLIENT_SECRET: 'test',
  APPLE_CLIENT_ID: 'test',
  APPLE_TEAM_ID: 'test',
  APPLE_KEY_ID: 'test',
  APPLE_PRIVATE_KEY: 'test',
}));
vi.mock('arctic', () => ({
  Discord: class {
    validateAuthorizationCode = mocks.validateCode;
  },
  Google: class {
    validateAuthorizationCode = mocks.validateCode;
  },
  Apple: class {
    validateAuthorizationCode = mocks.validateCode;
  },
}));

import discordRouter, {
  findOrCreateOAuthUser,
  OAuthAccountLinkRequiredError,
} from '../auth/oauth/discord.js';
import googleRouter from '../auth/oauth/google.js';
import appleRouter from '../auth/oauth/apple.js';
import { isAdminUser } from '../auth/admin.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.createSession.mockResolvedValue({ id: 'session' });
  mocks.validateCode.mockResolvedValue({ accessToken: () => 'test-access-token' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const verified = {
  provider: 'google',
  providerUserId: 'google-victim',
  email: 'Victim@example.test',
  emailVerified: true,
  username: 'Victim',
  avatarUrl: null,
};

interface AuthUserRow {
  id: string;
  email: string | null;
  email_verified: number;
  hashed_password: string | null;
}

function mockIdentityStore(initialUsers: AuthUserRow[] = [], linkedUserId?: string) {
  const users = new Map(initialUsers.map((user) => [user.id, { ...user }]));
  const accounts = new Map<string, string>();
  if (linkedUserId) accounts.set('discord:discord-user', linkedUserId);

  // Model state across logins while asserting the SQL guards separately;
  // this is a query double, not a PostgreSQL integration test.
  const query = async (sql: string, params: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('SELECT user_id FROM oauth_accounts')) {
      const userId = accounts.get(`${params[0]}:${params[1]}`);
      return { rows: userId ? [{ user_id: userId }] : [] };
    }
    if (sql.startsWith('UPDATE oauth_accounts')) return { rows: [] };
    if (sql.startsWith('SELECT id, email_verified')) {
      return {
        rows: [...users.values()].filter((user) => user.email?.toLowerCase() === params[0]),
      };
    }
    if (sql.startsWith('UPDATE auth_users')) {
      const normalized = sql.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').trim();
      expect(normalized).toBe(
        'UPDATE auth_users SET email = COALESCE(email, $2), email_verified = 1 ' +
          'WHERE id = $1 AND hashed_password IS NULL ' +
          'AND (lower(email) = $2 OR (email IS NULL AND NOT EXISTS (' +
          'SELECT 1 FROM auth_users AS other WHERE other.id <> $1 AND lower(other.email) = $2)))'
      );
      const user = users.get(String(params[0]));
      const email = String(params[1]);
      const collision = [...users.values()].some(
        (other) => other.id !== user?.id && other.email?.toLowerCase() === email
      );
      if (
        user &&
        user.hashed_password === null &&
        (user.email?.toLowerCase() === email || (user.email === null && !collision))
      ) {
        user.email ??= email;
        user.email_verified = 1;
      }
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO auth_users')) {
      const user = {
        id: String(params[0]),
        email: params[1] as string | null,
        email_verified: Number(params[4]),
        hashed_password: null,
      };
      users.set(user.id, user);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO users')) return { rows: [] };
    if (sql.includes('INSERT INTO oauth_accounts')) {
      accounts.set(`${params[0]}:${params[1]}`, String(params[2]));
      return { rows: [] };
    }
    throw new Error(`Unexpected identity query: ${sql}`);
  };
  mocks.query.mockImplementation(query);
  mocks.clientQuery.mockImplementation(query);
  return { users, accounts };
}

const discordIdentity = { ...verified, provider: 'discord', providerUserId: 'discord-user' };
const emailCollisionError = {
  code: '23505',
  table: 'auth_users',
  constraint: 'auth_users_email_key',
};

describe('OAuth email trust', () => {
  it('does not attach a verified OAuth identity to an unverified pre-registered password account', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith('SELECT id, email_verified')
        ? [{ id: 'attacker-account', email_verified: 0, hashed_password: 'attacker-hash' }]
        : [],
    }));
    await expect(findOrCreateOAuthUser(verified)).rejects.toBeInstanceOf(
      OAuthAccountLinkRequiredError
    );
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('only links a verified claim to one verified passwordless identity', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith('SELECT id, email_verified')
        ? [{ id: 'existing-oauth', email_verified: 1, hashed_password: null }]
        : [],
    }));
    expect(await findOrCreateOAuthUser(verified)).toBe('existing-oauth');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('WHERE lower(email) = $1'), [
      'victim@example.test',
    ]);
  });

  it('keeps an existing provider login bound to its original user ID and verifies its matching passwordless account', async () => {
    const { users } = mockIdentityStore(
      [
        {
          id: 'original-user',
          email: 'Victim@example.test',
          email_verified: 0,
          hashed_password: null,
        },
      ],
      'original-user'
    );
    expect(await findOrCreateOAuthUser(discordIdentity)).toBe('original-user');
    expect(users.get('original-user')).toMatchObject({
      email: 'Victim@example.test',
      email_verified: 1,
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('adopts a newly verified Discord email so a later Google login keeps the same user ID', async () => {
    const { users, accounts } = mockIdentityStore();
    const originalId = await findOrCreateOAuthUser({ ...discordIdentity, emailVerified: false });
    expect(users.get(originalId)).toMatchObject({ email: null, email_verified: 0 });

    expect(
      await findOrCreateOAuthUser({ ...discordIdentity, email: ' Victim@example.test ' })
    ).toBe(originalId);
    expect(users.get(originalId)).toMatchObject({
      email: 'victim@example.test',
      email_verified: 1,
    });
    expect(await findOrCreateOAuthUser(verified)).toBe(originalId);
    expect([...users.keys()]).toEqual([originalId]);
    expect([...accounts.values()]).toEqual([originalId, originalId]);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { email: 'victim@example.test', email_verified: 1, hashed_password: null },
    { email: 'VICTIM@example.test', email_verified: 1, hashed_password: null },
    { email: 'Victim@example.test', email_verified: 0, hashed_password: 'password-hash' },
  ])(
    'keeps the original provider login without adoption or merging on collision: %j',
    async (other) => {
      const original = {
        id: 'original-user',
        email: null,
        email_verified: 0,
        hashed_password: null,
      };
      const collision = { id: 'other-user', ...other };
      const { users, accounts } = mockIdentityStore([original, collision], original.id);

      expect(await findOrCreateOAuthUser(discordIdentity)).toBe(original.id);
      expect([...users.values()]).toEqual([original, collision]);
      expect([...accounts.entries()]).toEqual([['discord:discord-user', original.id]]);
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it.each([null, 'victim@example.test'])(
    'does not adopt or verify a linked password account with email %s',
    async (email) => {
      const original = {
        id: 'original-user',
        email,
        email_verified: 0,
        hashed_password: 'password-hash',
      };
      const { users } = mockIdentityStore([original], original.id);
      expect(await findOrCreateOAuthUser(discordIdentity)).toBe(original.id);
      expect(users.get(original.id)).toEqual(original);
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it('does not replace a different non-null email on the existing provider account', async () => {
    const original = {
      id: 'original-user',
      email: 'original@example.test',
      email_verified: 0,
      hashed_password: null,
    };
    const { users } = mockIdentityStore([original], original.id);
    expect(await findOrCreateOAuthUser(discordIdentity)).toBe(original.id);
    expect(users.get(original.id)).toEqual(original);
  });

  it.each([
    { email: 'victim@example.test', emailVerified: false },
    { email: null, emailVerified: true },
    { email: '  ', emailVerified: true },
  ])('leaves a linked account unchanged without a trusted email: %j', async (claim) => {
    const original = { id: 'original-user', email: null, email_verified: 0, hashed_password: null };
    const { users } = mockIdentityStore([original], original.id);
    expect(await findOrCreateOAuthUser({ ...discordIdentity, ...claim })).toBe(original.id);
    expect(users.get(original.id)).toEqual(original);
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE auth_users'))).toBe(false);
  });

  it('still creates the original user session when an email uniqueness race prevents adoption', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT user_id')) return { rows: [{ user_id: 'original-user' }] };
      if (sql.startsWith('UPDATE auth_users')) throw emailCollisionError;
      return { rows: [] };
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'discord-user',
          username: 'Victim',
          email: 'victim@example.test',
          verified: true,
        }),
      })
    );
    const app = express();
    app.use('/api/auth', discordRouter);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await supertest(app)
        .get('/api/auth/discord/callback?code=test&state=test')
        .set('Cookie', 'discord_oauth_state=test');
      expect(res.headers.location).toBe('/?auth=success');
      expect(mocks.createSession).toHaveBeenCalledWith('original-user', {});
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    { ...emailCollisionError, constraint: 'auth_users_pkey' },
    { ...emailCollisionError, table: 'other_table' },
    { ...emailCollisionError, code: '08006' },
    { code: '23505' },
    new Error('connection lost'),
    null,
  ])('does not swallow an unrelated adoption error: %j', async (error) => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT user_id')) return { rows: [{ user_id: 'original-user' }] };
      if (sql.startsWith('UPDATE auth_users')) throw error;
      return { rows: [] };
    });
    await expect(findOrCreateOAuthUser(discordIdentity)).rejects.toBe(error);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('does not swallow even an email constraint error from the provider metadata update', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT user_id')) return { rows: [{ user_id: 'original-user' }] };
      throw emailCollisionError;
    });
    await expect(findOrCreateOAuthUser(discordIdentity)).rejects.toBe(emailCollisionError);
  });

  it('never assigns an unverified provider email to a login identity', async () => {
    await findOrCreateOAuthUser({ ...verified, emailVerified: false });
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('FROM auth_users'))).toBe(false);
    const insert = mocks.clientQuery.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO auth_users')
    );
    expect(insert?.[1][1]).toBeNull();
    expect(insert?.[1][4]).toBe(0);
  });

  it.each(['google', 'discord'])(
    '%s callback passes provider verification through to account creation',
    async (provider) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () =>
            provider === 'google'
              ? { sub: 'remote-user', email: 'claimed@example.test', email_verified: false }
              : {
                  id: 'remote-user',
                  username: 'User',
                  email: 'claimed@example.test',
                  verified: false,
                },
        })
      );
      const app = express();
      app.use('/api/auth', provider === 'google' ? googleRouter : discordRouter);
      const res = await supertest(app)
        .get(`/api/auth/${provider}/callback?code=test&state=test`)
        .set('Cookie', `${provider}_oauth_state=test; google_code_verifier=test`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/?auth=success');
      const insert = mocks.clientQuery.mock.calls.find(([sql]) =>
        sql.startsWith('INSERT INTO auth_users')
      );
      expect(insert?.[1][1]).toBeNull();
      expect(insert?.[1][4]).toBe(0);
    }
  );

  it('does not create a login session when Google collides with an unverified account', async () => {
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith('SELECT id, email_verified')
        ? [{ id: 'attacker-account', email_verified: 0, hashed_password: 'attacker-hash' }]
        : [],
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sub: 'victim-google',
          email: 'victim@example.test',
          email_verified: true,
        }),
      })
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = express();
      app.use('/api/auth', googleRouter);
      const res = await supertest(app)
        .get('/api/auth/google/callback?code=test&state=test')
        .set('Cookie', 'google_oauth_state=test; google_code_verifier=test');
      expect(res.headers.location).toBe('/?auth=error&reason=account_link_required');
      expect(mocks.createSession).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('ignores a forged Apple user.email in favor of the token endpoint identity', async () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'apple-user', email: 'real@example.test', email_verified: 'true' })
    ).toString('base64url');
    mocks.validateCode.mockResolvedValue({ idToken: () => `header.${payload}.signature` });
    const app = express();
    app.use('/api/auth', appleRouter);
    const res = await supertest(app)
      .post('/api/auth/apple/callback')
      .set('Cookie', 'apple_oauth_state=test')
      .type('form')
      .send({
        state: 'test',
        code: 'test',
        user: JSON.stringify({ email: 'victim@example.test' }),
      });
    expect(res.headers.location).toBe('/?auth=success');
    const insert = mocks.clientQuery.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO auth_users')
    );
    expect(insert?.[1][1]).toBe('real@example.test');
    expect(insert?.[1][4]).toBe(1);
  });
});

describe('admin email trust', () => {
  it('requires verified email ownership even for an exact allowlist match', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_USER_IDS', 'admin@example.test');
    expect(isAdminUser({ id: 'new-user', email: 'admin@example.test' })).toBe(false);
    expect(isAdminUser({ id: 'new-user', email: 'admin@example.test', emailVerified: false })).toBe(
      false
    );
    expect(
      isAdminUser({ id: 'real-admin', email: 'ADMIN@example.test', emailVerified: true })
    ).toBe(true);
  });

  it('retains immutable user-ID administration without email verification', () => {
    vi.stubEnv('ADMIN_USER_IDS', 'admin-id');
    expect(isAdminUser({ id: 'admin-id' })).toBe(true);
  });
});
