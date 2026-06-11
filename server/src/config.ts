import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = parseInt(process.env.PORT ?? '3001', 10);

export const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '..', 'data', 'dnd-vtt.db');

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(__dirname, '..', 'uploads');

/**
 * Optional private GCS bucket for user-uploaded files. When set, new
 * uploads are written to this bucket and `/uploads/*` streams from it
 * after the existing auth/ACL checks. Local filesystem remains the
 * fallback for dev/tests.
 */
export const UPLOAD_GCS_BUCKET = process.env.UPLOAD_GCS_BUCKET || '';

export const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'];

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// OAuth configuration
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';
export const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
export const APPLE_KEY_ID = process.env.APPLE_KEY_ID || '';
export const APPLE_PRIVATE_KEY = process.env.APPLE_PRIVATE_KEY || '';
export const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

/**
 * Discord webhook URL pinged whenever a user submits feedback.
 * Optional: when unset (e.g. in dev) the notifier silently no-ops, so
 * feedback still lands in the database — only the side-channel ping
 * is skipped. Create a webhook on a Discord channel you own (Server
 * Settings → Integrations → Webhooks → New Webhook) and inject the
 * URL via Cloud Run env vars.
 */
export const DISCORD_FEEDBACK_WEBHOOK_URL = process.env.DISCORD_FEEDBACK_WEBHOOK_URL || '';

/**
 * Discord webhook URL pinged when a patch-kind Tiding is published —
 * this is the "release notes" channel. Lives separately from the
 * feedback webhook so admins can route releases to a dedicated
 * forum (Releases) without spamming the feedback channel. Optional;
 * when unset the lobby's Tidings still publish, only the side-channel
 * announcement is skipped.
 */
export const DISCORD_RELEASES_WEBHOOK_URL = process.env.DISCORD_RELEASES_WEBHOOK_URL || '';

/**
 * Boot-time configuration sanity check. Returns human-readable WARNINGS
 * for likely misconfigurations — it never throws (the hard-required DB
 * connection is already enforced in db/connection.ts, which exits if
 * DATABASE_URL / PGPASSWORD are missing). This surfaces silent PRODUCTION
 * footguns at startup instead of as a confusing runtime failure later:
 * no OAuth provider, or a localhost BASE_URL that breaks OAuth redirects.
 */
export function validateConfig(env: Record<string, string | undefined> = process.env): string[] {
  const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') return warnings;

  if (!env.DISCORD_CLIENT_ID && !env.GOOGLE_CLIENT_ID && !env.APPLE_CLIENT_ID) {
    warnings.push(
      'No OAuth provider configured (DISCORD_CLIENT_ID / GOOGLE_CLIENT_ID / APPLE_CLIENT_ID all unset) — only email/password login will work.'
    );
  }
  const baseUrl = env.BASE_URL;
  let hasInvalidBaseUrl = !baseUrl;
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      hasInvalidBaseUrl = hostname === 'localhost' || hostname.endsWith('.localhost');
    } catch {
      hasInvalidBaseUrl = true;
    }
  }
  if (hasInvalidBaseUrl) {
    warnings.push(
      `BASE_URL is "${env.BASE_URL ?? '(unset)'}" in production — OAuth redirect callbacks will break. Set it to your public URL.`
    );
  }
  return warnings;
}
