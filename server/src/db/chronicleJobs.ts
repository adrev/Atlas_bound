import pool from './connection.js';

/** Call after the base schema, before accepting requests. No background sweeper. */
export async function migrateChronicleJobs(): Promise<void> {
  await pool.query(`
    ALTER TABLE chronicle_entries
      ADD COLUMN IF NOT EXISTS generation_backend TEXT,
      ADD COLUMN IF NOT EXISTS generation_attempt_id TEXT,
      ADD COLUMN IF NOT EXISTS generation_lease_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS generation_result_digest TEXT;
    CREATE INDEX IF NOT EXISTS idx_chronicle_lease
      ON chronicle_entries (generation_backend, generation_lease_until)
      WHERE status IN ('pending', 'generating');
  `);
  // Pin legacy jobs to the configured backend; future inserts specify it.
  await pool.query(
    `UPDATE chronicle_entries SET generation_backend = $1 WHERE generation_backend IS NULL`,
    [
      (process.env.CHRONICLER_BACKEND ?? 'vertex').toLowerCase() === 'vertex'
        ? 'vertex'
        : 'external',
    ]
  );
}
