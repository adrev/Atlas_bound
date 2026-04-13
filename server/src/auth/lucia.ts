import { Lucia } from 'lucia';
import { BetterSqlite3Adapter } from '@lucia-auth/adapter-sqlite';
import db from '../db/connection.js';

const adapter = new BetterSqlite3Adapter(db as any, {
  user: 'auth_users',
  session: 'auth_sessions',
});

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    name: 'auth_session',
    attributes: {
      // Cloud Run terminates SSL at the load balancer — the app sees
      // HTTP internally. Set secure based on BASE_URL, not NODE_ENV,
      // so the cookie works behind the proxy.
      secure: (process.env.BASE_URL ?? '').startsWith('https'),
      sameSite: 'lax',
      path: '/',
    },
  },
  getUserAttributes: (attributes) => ({
    email: attributes.email,
    displayName: attributes.display_name,
    avatarUrl: attributes.avatar_url,
  }),
});

declare module 'lucia' {
  interface Register {
    Lucia: typeof lucia;
    DatabaseUserAttributes: {
      email: string | null;
      display_name: string;
      avatar_url: string | null;
    };
  }
}
