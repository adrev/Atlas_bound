import Database from 'libsql';
import path from 'path';
import fs from 'fs';
import { DB_PATH } from '../config.js';

// Turso cloud sync — when TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are
// set, the local SQLite file syncs to Turso's hosted libSQL service.
// In development (no env vars), it works as a normal local SQLite DB
// identical to better-sqlite3.
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

// Ensure the directory for the database file exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbOptions: Record<string, unknown> = {};
if (TURSO_URL && TURSO_TOKEN) {
  // Embedded replica mode: local file + cloud sync to Turso
  (dbOptions as any).syncUrl = TURSO_URL;
  (dbOptions as any).authToken = TURSO_TOKEN;
  console.log(`[DB] Turso sync enabled → ${TURSO_URL}`);
} else {
  console.log(`[DB] Local SQLite mode → ${DB_PATH}`);
}

const db: any = new Database(DB_PATH, dbOptions as any);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// If Turso sync is configured, do an initial sync
if (TURSO_URL && TURSO_TOKEN) {
  try {
    (db as any).sync();
    console.log('[DB] Initial Turso sync complete');
  } catch (err) {
    console.warn('[DB] Initial Turso sync failed (will retry):', err);
  }
}

export default db;
