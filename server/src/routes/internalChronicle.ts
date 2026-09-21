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
 *     Atomically picks pending or lease-expired external work and
 *     returns a fresh attemptId and leaseUntil. 204 if no work.
 *     Atomicity is enforced by an UPDATE … RETURNING with a
 *     subquery + FOR UPDATE SKIP LOCKED so two workers can't
 *     claim the same row.
 *
 *   POST   /api/internal/chronicle/jobs/:id/result
 *     Body:
 *       { attemptId, recapShort, recapFull, keyEntities, whereLeftOff, modelUsed }
 *       OR
 *       { attemptId, error: string, hint?: string }
 *     Updates only a matching, unexpired attempt. Identical result
 *     redelivery is acknowledged without rewriting terminal rows. The
 *     existing user-facing PATCH/publish endpoints take over from
 *     here — DM reviews and publishes through the normal flow.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { claimChronicleJob, finishChronicleJob } from '../services/ChronicleJobs.js';

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

// ── POST /api/internal/chronicle/jobs/claim ─────────────────────

router.post(
  '/internal/chronicle/jobs/claim',
  requireWorkerToken,
  async (_req: Request, res: Response) => {
    const row = await claimChronicleJob('external');
    if (!row) {
      res.status(204).end();
      return;
    }

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
        attemptId: row.generation_attempt_id,
        leaseUntil: row.generation_lease_until,
      },
    });
  }
);

// ── POST /api/internal/chronicle/jobs/:id/result ────────────────

const successBodySchema = z.object({
  attemptId: z.string().uuid(),
  recapShort: z.string().min(1).max(2000),
  recapFull: z.string().min(1).max(8000),
  keyEntities: z.array(z.string().max(80)).max(20),
  whereLeftOff: z.string().min(1).max(500),
  modelUsed: z.string().max(80).optional(),
});

const errorBodySchema = z.object({
  attemptId: z.string().uuid(),
  error: z.string().min(1).max(500),
  hint: z.string().max(2000).optional(),
});

router.post(
  '/internal/chronicle/jobs/:id/result',
  requireWorkerToken,
  async (req: Request, res: Response) => {
    const id = String(req.params.id);

    // Caller posts EITHER the success shape OR the error shape. Try
    // success first; if it doesn't match, fall through to error.
    const success = successBodySchema.safeParse(req.body);
    if (success.success) {
      const d = success.data;
      const status = await finishChronicleJob(id, d.attemptId, 'external', d, d.modelUsed ?? null);
      if (!status) {
        res.status(409).json({ error: 'Generation attempt expired or no longer owns this entry' });
        return;
      }
      res.json({ ok: true, entryId: id, attemptId: d.attemptId, status });
      return;
    }

    const failure = errorBodySchema.safeParse(req.body);
    if (failure.success) {
      const e = failure.data;
      const status = await finishChronicleJob(id, e.attemptId, 'external', e);
      if (!status) {
        res.status(409).json({ error: 'Generation attempt expired or no longer owns this entry' });
        return;
      }
      res.json({ ok: true, entryId: id, attemptId: e.attemptId, status });
      return;
    }

    res.status(400).json({
      error:
        'Body must be either {attemptId,recapShort,recapFull,keyEntities,whereLeftOff} or {attemptId,error,hint?}',
      successErrors: success.error?.issues,
      failureErrors: failure.error?.issues,
    });
  }
);

export default router;
