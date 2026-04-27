import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = parseInt(process.env.PORT ?? '3001', 10);

export const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '..', 'data', 'dnd-vtt.db');

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(__dirname, '..', 'uploads');

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
