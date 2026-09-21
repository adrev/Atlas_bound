import { createHash, randomUUID } from 'node:crypto';
import pool from '../db/connection.js';
import type { ChroniclerError, ChroniclerOutput } from './Chronicler.js';

export const CHRONICLE_BACKEND =
  (process.env.CHRONICLER_BACKEND ?? 'vertex').toLowerCase() === 'vertex' ? 'vertex' : 'external';
export const VERTEX_TIMEOUT_MS = 90_000;
export const VERTEX_LEASE_MS = VERTEX_TIMEOUT_MS + 30_000;
export const EXTERNAL_LEASE_MS = 15 * 60_000;
type Backend = 'vertex' | 'external';

export interface ChronicleJob {
  id: string;
  campaign_id: string;
  campaign_name: string;
  sequence_number: number;
  raw_transcript: string;
  party_names: string[] | null;
  session_started_at: string | null;
  session_ended_at: string | null;
  generation_attempt_id: string;
  generation_lease_until: Date;
}

/** An expired lease is recoverable even after every application process has died. */
export async function claimChronicleJob(
  backend: Backend,
  entryId: string | null = null
): Promise<ChronicleJob | null> {
  const { rows } = await pool.query<ChronicleJob>(
    `WITH next_job AS (
       SELECT id FROM chronicle_entries
        WHERE generation_backend = $1
          AND ($2::text IS NULL OR id = $2)
          AND (status = 'pending'
            OR (status = 'failed' AND $2::text IS NOT NULL)
            OR (status = 'generating' AND
                (generation_lease_until IS NULL OR generation_lease_until <= clock_timestamp())))
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE chronicle_entries c
        SET status = 'generating', generation_attempt_id = $3,
            generation_lease_until = clock_timestamp() + $4 * INTERVAL '1 millisecond',
            generation_result_digest = NULL, generation_error = NULL,
            generation_started_at = clock_timestamp()::text,
            generation_finished_at = NULL, updated_at = clock_timestamp()::text
       FROM next_job WHERE c.id = next_job.id
     RETURNING c.*,
       (SELECT name FROM sessions WHERE id = c.campaign_id) AS campaign_name,
       COALESCE((SELECT array_agg(ch.name) FROM session_players sp
         JOIN characters ch ON ch.id = sp.character_id
         WHERE sp.session_id = c.campaign_id), '{}') AS party_names`,
    [backend, entryId, randomUUID(), backend === 'vertex' ? VERTEX_LEASE_MS : EXTERNAL_LEASE_MS]
  );
  return rows[0] ?? null;
}

/** Make interrupted Vertex jobs visible to the existing failed/retry UI. */
export async function recoverInterruptedChronicles(campaignId: string): Promise<void> {
  await pool.query(
    `UPDATE chronicle_entries
        SET status = 'failed', generation_attempt_id = NULL, generation_lease_until = NULL,
            generation_result_digest = NULL,
            generation_error = 'Generation interrupted. Retry to start a new attempt.',
            generation_finished_at = clock_timestamp()::text, updated_at = clock_timestamp()::text
      WHERE campaign_id = $1 AND generation_backend = 'vertex'
        AND ((status = 'generating' AND
              (generation_lease_until IS NULL OR generation_lease_until <= clock_timestamp()))
          OR (status = 'pending' AND updated_at::timestamptz <=
              clock_timestamp() - $2 * INTERVAL '1 millisecond'))`,
    [campaignId, VERTEX_LEASE_MS]
  );
}

export async function requeueExternalChronicle(entryId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE chronicle_entries
        SET status = 'pending', generation_attempt_id = NULL, generation_lease_until = NULL,
            generation_result_digest = NULL, generation_error = NULL,
            generation_finished_at = NULL, updated_at = clock_timestamp()::text
      WHERE id = $1 AND generation_backend = 'external'
        AND (status IN ('failed', 'pending') OR (status = 'generating' AND
             (generation_lease_until IS NULL OR generation_lease_until <= clock_timestamp())))`,
    [entryId]
  );
  return result.rowCount === 1;
}

/** Identical redelivery is acknowledged without rewriting a DM's later edits. */
export async function finishChronicleJob(
  entryId: string,
  attemptId: string,
  backend: Backend,
  output: ChroniclerOutput | ChroniclerError,
  modelUsed: string | null = null
): Promise<'draft' | 'failed' | null> {
  const failed = 'error' in output;
  const status = failed ? 'failed' : 'draft';
  const error = failed
    ? `${output.error}${output.hint ? `: ${output.hint}` : ''}`.slice(0, 1000)
    : null;
  // Ordered fields give retries a stable receipt independent of JSON key order.
  const fields = failed
    ? [error]
    : [output.recapShort, output.recapFull, output.keyEntities, output.whereLeftOff, modelUsed];
  const digest = createHash('sha256')
    .update(JSON.stringify([status, fields]))
    .digest('hex');
  const { rowCount } = await pool.query(
    `UPDATE chronicle_entries
        SET status = $4, recap_short = $5, recap_full = $6, key_entities = $7,
            where_left_off = $8, model_used = $9, generation_error = $10,
            generation_result_digest = $11, generation_lease_until = NULL,
            generation_finished_at = clock_timestamp()::text, updated_at = clock_timestamp()::text
      WHERE id = $1 AND generation_attempt_id = $2 AND generation_backend = $3
        AND status = 'generating' AND generation_lease_until > clock_timestamp()`,
    [
      entryId,
      attemptId,
      backend,
      status,
      failed ? null : output.recapShort,
      failed ? null : output.recapFull,
      failed ? null : output.keyEntities,
      failed ? null : output.whereLeftOff,
      modelUsed,
      error,
      digest,
    ]
  );
  if (rowCount === 1) return status;
  const { rows } = await pool.query(
    `SELECT 1 FROM chronicle_entries
      WHERE id = $1 AND generation_attempt_id = $2 AND generation_backend = $3
        AND generation_result_digest = $4
        AND (status = $5 OR (status = 'published' AND $5 = 'draft'))`,
    [entryId, attemptId, backend, digest, status]
  );
  return rows.length ? status : null;
}
