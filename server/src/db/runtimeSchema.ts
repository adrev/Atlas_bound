import pool from './connection.js';

export async function initRuntimeSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_runtime (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      state JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS session_feature_runtime (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      state JSONB NOT NULL DEFAULT '{"version":1,"namespaces":{}}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS character_feature_runtime (
      character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      state JSONB NOT NULL DEFAULT '{"version":1,"namespaces":{}}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS socket_io_attachments (
      id BIGSERIAL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      payload BYTEA
    );
  `);
}
