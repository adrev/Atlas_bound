import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DB_PATH } from '../config.js';

// Ensure the directory for the database file exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db: import('better-sqlite3').Database = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;
