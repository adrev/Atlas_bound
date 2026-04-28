/**
 * Chronicle endpoints — the LLM-powered session recap pipeline that
 * powers the lobby's Chronicle rail.
 *
 * Lifecycle:
 *
 *   DM clicks "Forge Chronicle" in-session
 *      → POST /api/sessions/:id/chronicle/generate { transcript }
 *      → server queues a row (status: 'generating'), kicks off the
 *        Vertex AI call in the background, returns 202 immediately
 *      → polling: GET /api/sessions/:id/chronicle/:entryId
 *      → status: 'draft' once the call finishes
 *      → DM edits the recap if they want, then publishes
 *      → POST /api/chronicle/:id/publish
 *      → status: 'published' → row appears in lobby Chronicle rail
 *        for every player in the campaign
 *
 * Reads:
 *   GET /api/chronicle/mine     → all published entries from the
 *                                  current user's campaigns (drives
 *                                  the lobby rail)
 *   GET /api/sessions/:id/chronicle → all entries for one campaign
 *                                     (DM-only sees drafts; players
 *                                     see only published)
 */
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import pool from '../db/connection.js';
import { getAuthUserId, assertSessionMember, assertSessionDM } from '../utils/authorization.js';
import {
  generateChronicle,
  isChroniclerError,
  CHRONICLER_MODEL_ID,
} from '../services/Chronicler.js';

const router = Router();

type ChronicleStatus = 'pending' | 'generating' | 'draft' | 'published' | 'failed';

interface ChronicleRow {
  id: string;
  campaign_id: string;
  sequence_number: number;
  raw_transcript: string;
  recap_short: string | null;
  recap_full: string | null;
  key_entities: string[] | null;
  where_left_off: string | null;
  dm_recap_short: string | null;
  dm_recap_full: string | null;
  status: ChronicleStatus;
  session_started_at: string | null;
  session_ended_at: string | null;
  duration_ms: number | null;
  model_used: string | null;
  generation_started_at: string | null;
  generation_finished_at: string | null;
  generation_error: string | null;
  triggered_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Wire shape returned to the client. Snake-case → camelCase.
 * `effectiveRecap*` fields prefer DM edits over the auto-generated
 * text — the lobby + admin UI just read these and don't have to
 * pick which version to show.
 */
function rowToChronicle(r: ChronicleRow, campaignName?: string) {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    campaignName: campaignName ?? null,
    sequenceNumber: r.sequence_number,
    rawTranscript: r.raw_transcript,
    autoRecapShort: r.recap_short,
    autoRecapFull: r.recap_full,
    keyEntities: r.key_entities ?? [],
    whereLeftOff: r.where_left_off,
    dmRecapShort: r.dm_recap_short,
    dmRecapFull: r.dm_recap_full,
    effectiveRecapShort: r.dm_recap_short ?? r.recap_short ?? '',
    effectiveRecapFull: r.dm_recap_full ?? r.recap_full ?? '',
    status: r.status,
    sessionStartedAt: r.session_started_at,
    sessionEndedAt: r.session_ended_at,
    durationMs: r.duration_ms,
    modelUsed: r.model_used,
    generationError: r.generation_error,
    triggeredBy: r.triggered_by,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Background generator ────────────────────────────────────────

/**
 * Fire the Vertex AI call out-of-band. The caller (POST generate) has
 * already returned 202 to the client; this fills in the row when the
 * model responds. Errors are stamped onto generation_error so the DM
 * can see what happened on the next poll.
 */
async function runChronicleGeneration(entryId: string): Promise<void> {
  // Re-read the row inside this task — the route already inserted it.
  const { rows } = await pool.query<ChronicleRow & { campaign_name: string; party_names: string[] }>(
    `SELECT c.*, s.name AS campaign_name,
            COALESCE(
              (SELECT array_agg(ch.name)
                 FROM session_players sp
                 JOIN characters ch ON ch.id = sp.character_id
                WHERE sp.session_id = c.campaign_id),
              '{}'
            ) AS party_names
       FROM chronicle_entries c
       JOIN sessions s ON s.id = c.campaign_id
      WHERE c.id = $1`,
    [entryId],
  );
  const row = rows[0];
  if (!row) return;

  await pool.query(
    `UPDATE chronicle_entries
        SET status = 'generating',
            generation_started_at = NOW()::text,
            updated_at = NOW()::text
      WHERE id = $1`,
    [entryId],
  );

  const result = await generateChronicle({
    campaignName: row.campaign_name,
    sequenceNumber: row.sequence_number,
    transcript: row.raw_transcript,
    partyNames: row.party_names ?? [],
    sessionStartedAt: row.session_started_at ?? undefined,
    sessionEndedAt: row.session_ended_at ?? undefined,
  });

  if (isChroniclerError(result)) {
    await pool.query(
      `UPDATE chronicle_entries
          SET status = 'failed',
              generation_finished_at = NOW()::text,
              generation_error = $2,
              updated_at = NOW()::text
        WHERE id = $1`,
      [entryId, `${result.error}${result.hint ? `: ${result.hint}` : ''}`],
    );
    return;
  }

  await pool.query(
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
      WHERE id = $1`,
    [
      entryId,
      result.recapShort,
      result.recapFull,
      result.keyEntities,
      result.whereLeftOff,
      CHRONICLER_MODEL_ID,
    ],
  );
}

// ── POST /api/sessions/:id/chronicle/generate ───────────────────

const generateBodySchema = z.object({
  transcript: z.string().min(20).max(50_000),
  sessionStartedAt: z.string().datetime().optional(),
  sessionEndedAt: z.string().datetime().optional(),
});

router.post('/sessions/:id/chronicle/generate', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const campaignId = String(req.params.id);

  // Only DMs of this campaign can trigger chronicle generation.
  await assertSessionDM(campaignId, userId);

  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const data = parsed.data;

  // Sequence number = (max existing for this campaign) + 1. Counted
  // server-side so concurrent triggers don't collide.
  const { rows: seqRows } = await pool.query<{ next_seq: number }>(
    `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
       FROM chronicle_entries
      WHERE campaign_id = $1`,
    [campaignId],
  );
  const sequenceNumber = seqRows[0]?.next_seq ?? 1;

  // Compute duration if both timestamps were provided.
  let durationMs: number | null = null;
  if (data.sessionStartedAt && data.sessionEndedAt) {
    const start = new Date(data.sessionStartedAt).getTime();
    const end = new Date(data.sessionEndedAt).getTime();
    if (!isNaN(start) && !isNaN(end) && end > start) durationMs = end - start;
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO chronicle_entries (
       id, campaign_id, sequence_number, raw_transcript,
       session_started_at, session_ended_at, duration_ms,
       triggered_by, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [
      id, campaignId, sequenceNumber, data.transcript,
      data.sessionStartedAt ?? null, data.sessionEndedAt ?? null, durationMs,
      userId,
    ],
  );

  // Fire the LLM call out of band. The DM polls the row to get
  // status flipped from 'generating' → 'draft' once Gemini returns.
  // void marks the floating promise as intentional.
  void runChronicleGeneration(id);

  res.status(202).json({ entryId: id, status: 'pending', sequenceNumber });
});

// ── GET /api/sessions/:id/chronicle ─────────────────────────────

router.get('/sessions/:id/chronicle', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const campaignId = String(req.params.id);
  await assertSessionMember(campaignId, userId);

  // Players see only published rows; DMs see everything (drafts +
  // failures + pending generations).
  const { rows: dmRows } = await pool.query(
    `SELECT 1 FROM session_players
      WHERE session_id = $1 AND user_id = $2 AND role = 'dm' LIMIT 1`,
    [campaignId, userId],
  );
  const isDM = dmRows.length > 0;

  const { rows } = await pool.query<ChronicleRow>(
    `SELECT * FROM chronicle_entries
      WHERE campaign_id = $1
        ${isDM ? '' : "AND status = 'published'"}
      ORDER BY sequence_number DESC`,
    [campaignId],
  );

  res.json({
    entries: rows.map((r) => rowToChronicle(r)),
    isDM,
  });
});

// ── GET /api/sessions/:id/chronicle/:entryId ────────────────────

router.get('/sessions/:id/chronicle/:entryId', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const campaignId = String(req.params.id);
  const entryId = String(req.params.entryId);
  await assertSessionMember(campaignId, userId);

  const { rows } = await pool.query<ChronicleRow>(
    'SELECT * FROM chronicle_entries WHERE id = $1 AND campaign_id = $2',
    [entryId, campaignId],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Chronicle entry not found' }); return; }

  // Players only see published rows.
  if (row.status !== 'published') {
    const { rows: dmRows } = await pool.query(
      `SELECT 1 FROM session_players
        WHERE session_id = $1 AND user_id = $2 AND role = 'dm' LIMIT 1`,
      [campaignId, userId],
    );
    if (dmRows.length === 0) { res.status(404).json({ error: 'Chronicle entry not found' }); return; }
  }
  res.json({ entry: rowToChronicle(row) });
});

// ── PATCH /api/chronicle/:id — DM edits ─────────────────────────

const patchBodySchema = z.object({
  dmRecapShort: z.string().max(2000).nullable().optional(),
  dmRecapFull: z.string().max(8000).nullable().optional(),
  whereLeftOff: z.string().max(500).nullable().optional(),
  keyEntities: z.array(z.string().max(80)).max(20).optional(),
});

router.patch('/chronicle/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);

  // Look up the campaign so we can gate DM-only edits.
  const { rows: lookupRows } = await pool.query<{ campaign_id: string }>(
    'SELECT campaign_id FROM chronicle_entries WHERE id = $1', [id],
  );
  const lookup = lookupRows[0];
  if (!lookup) { res.status(404).json({ error: 'Chronicle entry not found' }); return; }
  await assertSessionDM(lookup.campaign_id, userId);

  const parsed = patchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const updates: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (d.dmRecapShort !== undefined) { updates.push(`dm_recap_short = $${p++}`); params.push(d.dmRecapShort); }
  if (d.dmRecapFull !== undefined)  { updates.push(`dm_recap_full = $${p++}`); params.push(d.dmRecapFull); }
  if (d.whereLeftOff !== undefined) { updates.push(`where_left_off = $${p++}`); params.push(d.whereLeftOff); }
  if (d.keyEntities !== undefined)  { updates.push(`key_entities = $${p++}`); params.push(d.keyEntities); }

  if (updates.length === 0) { res.json({ ok: true }); return; }
  updates.push(`updated_at = NOW()::text`);
  params.push(id);
  await pool.query(`UPDATE chronicle_entries SET ${updates.join(', ')} WHERE id = $${p}`, params);

  const { rows } = await pool.query<ChronicleRow>('SELECT * FROM chronicle_entries WHERE id = $1', [id]);
  res.json({ entry: rowToChronicle(rows[0]) });
});

// ── POST /api/chronicle/:id/publish ─────────────────────────────

router.post('/chronicle/:id/publish', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows: lookupRows } = await pool.query<ChronicleRow>(
    'SELECT * FROM chronicle_entries WHERE id = $1', [id],
  );
  const row = lookupRows[0];
  if (!row) { res.status(404).json({ error: 'Chronicle entry not found' }); return; }
  await assertSessionDM(row.campaign_id, userId);

  if (row.status === 'pending' || row.status === 'generating') {
    res.status(409).json({ error: 'Cannot publish — generation still in flight' });
    return;
  }
  if (row.status === 'failed' && !row.dm_recap_short) {
    res.status(409).json({ error: 'Cannot publish a failed entry — write your own recap first' });
    return;
  }

  await pool.query(
    `UPDATE chronicle_entries
        SET status = 'published', published_at = NOW()::text, updated_at = NOW()::text
      WHERE id = $1`,
    [id],
  );
  const { rows } = await pool.query<ChronicleRow>('SELECT * FROM chronicle_entries WHERE id = $1', [id]);
  res.json({ entry: rowToChronicle(rows[0]) });
});

// ── POST /api/chronicle/:id/retry — re-run a failed generation ─

router.post('/chronicle/:id/retry', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows } = await pool.query<ChronicleRow>(
    'SELECT * FROM chronicle_entries WHERE id = $1', [id],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Chronicle entry not found' }); return; }
  await assertSessionDM(row.campaign_id, userId);
  if (row.status !== 'failed') {
    res.status(409).json({ error: `Cannot retry — current status is '${row.status}'` });
    return;
  }
  await pool.query(
    `UPDATE chronicle_entries
        SET status = 'pending', generation_error = NULL, updated_at = NOW()::text
      WHERE id = $1`,
    [id],
  );
  void runChronicleGeneration(id);
  res.status(202).json({ entryId: id, status: 'pending' });
});

// ── DELETE /api/chronicle/:id ───────────────────────────────────

router.delete('/chronicle/:id', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const id = String(req.params.id);
  const { rows } = await pool.query<{ campaign_id: string }>(
    'SELECT campaign_id FROM chronicle_entries WHERE id = $1', [id],
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Chronicle entry not found' }); return; }
  await assertSessionDM(row.campaign_id, userId);
  await pool.query('DELETE FROM chronicle_entries WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ── GET /api/chronicle/mine — feeds the lobby rail ──────────────

/**
 * Recent published chronicle entries across every campaign the
 * caller belongs to. The lobby rail renders a small handful — we
 * cap at 12 server-side and the client takes the first 5-6 it
 * cares about.
 */
router.get('/chronicle/mine', async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  const { rows } = await pool.query<ChronicleRow & { campaign_name: string }>(
    `SELECT c.*, s.name AS campaign_name
       FROM chronicle_entries c
       JOIN sessions s ON s.id = c.campaign_id
       JOIN session_players sp ON sp.session_id = c.campaign_id
      WHERE sp.user_id = $1
        AND c.status = 'published'
      ORDER BY c.published_at DESC
      LIMIT 12`,
    [userId],
  );
  res.json({
    entries: rows.map((r) => rowToChronicle(r, r.campaign_name)),
  });
});

export default router;
