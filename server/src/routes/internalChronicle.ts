/**
 * Internal Chronicle worker endpoints — consumed by the on-prem
 * `dgx-worker` (or any other "off-cloud" inference host).
 *
 * Why this exists: Cloud Run can't reach the DGX over Tailscale —
 * Cloud Run egress doesn't natively join a Tailscale network without
 * heroic plumbing. The clean solution is to invert the direction:
 * the DGX polls *us* for pending jobs, runs Gemma 4 locally, and
 * posts results back. That's what these endpoints serve.
 *
 * Auth model: a single shared secret (`CHRONICLE_WORKER_TOKEN` env
 * var, set on Cloud Run AND the worker host) gates every call. NOT
 * the user-session cookie — the worker has no user. Token is sent
 * via the `Authorization: Bearer <token>` header. Empty / mismatched
 * → 401.
 *
 * Two endpoints:
 *
 *   POST   /api/internal/chronicle/jobs/claim
 *     Atomically picks the oldest `pending` row, flips it to
 *     `generating`, returns its full payload. 204 if no work.
 *     Atomicity is enforced by an UPDATE … RETURNING with a
 *     subquery + FOR UPDATE SKIP LOCKED so two workers can't
 *     claim the same row.
 *
 *   POST   /api/internal/chronicle/jobs/:id/result
 *     Body:
 *       { recapShort, recapFull, keyEntities, whereLeftOff, modelUsed }
 *       OR
 *       { error: string, hint?: string }
 *     Updates the row to `draft` or `failed` accordingly. The
 *     existing user-facing PATCH/publish endpoints take over from
 *     here — DM reviews and publishes through the normal flow.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import pool from '../db/connection.js';

const router = Router();

const WORKER_TOKEN = process.env.CHRONICLE_WORKER_TOKEN || '';

function tokenMatches(provided: string): boolean {
  const expected = Buffer.from(WORKER_TOKEN);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Bearer-token gate. We deliberately do NOT log the failure reason
 * (token mismatch vs missing header) so a probing attacker can't
 * fingerprint our auth shape.
 */
function requireWorkerToken(req: Request, res: Response, next: NextFunction): void {
  if (!WORKER_TOKEN) {
    // Fail closed in production: missing config means no internal
    // access, full stop. In dev the absence of the env var still
    // closes the door — write CHRONICLE_WORKER_TOKEN=devsecret to
    // .env if you need to test locally.
    res.status(503).json({ error: 'Worker auth not configured' });
    return;
  }
  const header = req.header('authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !tokenMatches(m[1])) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

interface ChronicleRow {
  id: string;
  campaign_id: string;
  sequence_number: number;
  raw_transcript: string;
  session_started_at: string | null;
  session_ended_at: string | null;
  campaign_name: string;
  party_names: string[] | null;
}

// ── POST /api/internal/chronicle/jobs/claim ─────────────────────

router.post('/internal/chronicle/jobs/claim', requireWorkerToken, async (_req: Request, res: Response) => {
  // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED inside an
  // UPDATE so concurrent workers can't grab the same row. Postgres
  // takes a row lock for the duration of the UPDATE; SKIP LOCKED
  // means a second worker simply sees no row and gets a 204.
  const { rows } = await pool.query<ChronicleRow>(
    `WITH next_job AS (
       SELECT id FROM chronicle_entries
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE chronicle_entries c
        SET status = 'generating',
            generation_started_at = NOW()::text,
            updated_at = NOW()::text
       FROM next_job
      WHERE c.id = next_job.id
     RETURNING c.id, c.campaign_id, c.sequence_number, c.raw_transcript,
               c.session_started_at, c.session_ended_at,
               (SELECT name FROM sessions WHERE id = c.campaign_id) AS campaign_name,
               COALESCE(
                 (SELECT array_agg(ch.name)
                    FROM session_players sp
                    JOIN characters ch ON ch.id = sp.character_id
                   WHERE sp.session_id = c.campaign_id),
                 '{}'
               ) AS party_names`,
  );

  if (rows.length === 0) {
    res.status(204).end();
    return;
  }

  const row = rows[0];
  res.json({
    job: {
      id: row.id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      sequenceNumber: row.sequence_number,
      transcript: row.raw_transcript,
      partyNames: row.party_names ?? [],
      sessionStartedAt: row.session_started_at,
      sessionEndedAt: row.session_ended_at,
    },
  });
});

// ── POST /api/internal/chronicle/jobs/:id/result ────────────────

const successBodySchema = z.object({
  recapShort: z.string().min(1).max(2000),
  recapFull: z.string().min(1).max(8000),
  keyEntities: z.array(z.string().max(80)).max(20),
  whereLeftOff: z.string().min(1).max(500),
  modelUsed: z.string().max(80).optional(),
});

const errorBodySchema = z.object({
  error: z.string().min(1).max(500),
  hint: z.string().max(2000).optional(),
});

router.post('/internal/chronicle/jobs/:id/result', requireWorkerToken, async (req: Request, res: Response) => {
  const id = String(req.params.id);

  // Caller posts EITHER the success shape OR the error shape. Try
  // success first; if it doesn't match, fall through to error.
  const success = successBodySchema.safeParse(req.body);
  if (success.success) {
    const d = success.data;
    const result = await pool.query(
      `UPDATE chronicle_entries
          SET status = 'draft',
              recap_short = $2,
              recap_full = $3,
              key_entities = $4,
              where_left_off = $5,
              model_used = $6,
              generation_finished_at = NOW()::text,
              generation_error = NULL,
              updated_at = NOW()::text
        WHERE id = $1
          AND status IN ('generating', 'pending')`,
      [id, d.recapShort, d.recapFull, d.keyEntities, d.whereLeftOff, d.modelUsed ?? null],
    );
    if (result.rowCount === 0) {
      // Either the id doesn't exist or the row was already moved to
      // a terminal state (published/failed) by a parallel writer.
      // Worker treats this as benign — no retry.
      res.status(409).json({ error: 'Job not in claimable state' });
      return;
    }
    res.json({ ok: true, status: 'draft' });
    return;
  }

  const failure = errorBodySchema.safeParse(req.body);
  if (failure.success) {
    const e = failure.data;
    const summary = `${e.error}${e.hint ? `: ${e.hint}` : ''}`.slice(0, 1000);
    const result = await pool.query(
      `UPDATE chronicle_entries
          SET status = 'failed',
              generation_finished_at = NOW()::text,
              generation_error = $2,
              updated_at = NOW()::text
        WHERE id = $1
          AND status IN ('generating', 'pending')`,
      [id, summary],
    );
    if (result.rowCount === 0) {
      res.status(409).json({ error: 'Job not in claimable state' });
      return;
    }
    res.json({ ok: true, status: 'failed' });
    return;
  }

  res.status(400).json({
    error: 'Body must be either {recapShort,recapFull,keyEntities,whereLeftOff} or {error,hint?}',
    successErrors: success.error?.issues,
    failureErrors: failure.error?.issues,
  });
});

export default router;
