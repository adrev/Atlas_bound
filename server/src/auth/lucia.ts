import { Lucia } from 'lucia';
import { BetterSqlite3Adapter } from '@lucia-auth/adapter-sqlite';
import db from '../db/connection.js';

const adapter = new BetterSqlite3Adapter(db as any, {
  user: 'auth_users',
  session: 'auth_sessions',
});

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    attributes: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
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
