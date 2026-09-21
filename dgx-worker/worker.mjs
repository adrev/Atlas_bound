/**
 * Atlas Bound — Chronicle worker (DGX edition)
 *
 * Runs on the DGX (or any host with Ollama), polls Cloud Run for
 * pending chronicle jobs, runs Gemma 4 locally, posts results back.
 *
 * Why polling (DGX → Cloud Run) instead of push (Cloud Run → DGX):
 * Cloud Run egress can't natively reach a Tailscale network without
 * a userspace daemon inside the container, which is messy. Inverting
 * the direction sidesteps the whole networking puzzle — the DGX just
 * needs outbound HTTPS, which it already has.
 *
 * Lifecycle on each tick:
 *   1. POST  /api/internal/chronicle/jobs/claim   → 204 = no work, sleep
 *      → otherwise the row is now status='generating' and we own it
 *   2. POST  http://localhost:11434/api/chat       → Ollama call
 *   3. POST  /api/internal/chronicle/jobs/:id/result with the parsed
 *      output (or { error, hint } on failure)
 *
 * Env vars required:
 *   ATLAS_BASE_URL                 e.g. https://kbrt.ai
 *   CHRONICLE_WORKER_TOKEN         shared secret, must match Cloud Run
 *   OLLAMA_URL                     default http://127.0.0.1:11434
 *   CHRONICLER_OLLAMA_MODEL        default gemma4:26b
 *   POLL_INTERVAL_MS               initial idle delay, default 30000
 *   MAX_IDLE_POLL_MS               idle backoff ceiling, default 1800000
 *
 * Run via systemd (see dgx-worker/atlas-chronicle.service) or just
 * `node worker.mjs` for ad-hoc testing.
 */

import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ATLAS_BASE_URL = process.env.ATLAS_BASE_URL || 'https://kbrt.ai';
const TOKEN = process.env.CHRONICLE_WORKER_TOKEN;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.CHRONICLER_OLLAMA_MODEL || 'gemma4:26b';
const positiveMs = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const MAX_IDLE_POLL_MS = positiveMs(process.env.MAX_IDLE_POLL_MS, 30 * 60_000);
const POLL_INTERVAL_MS = Math.min(positiveMs(process.env.POLL_INTERVAL_MS, 30_000), MAX_IDLE_POLL_MS);
const MAX_TRANSCRIPT_CHARS = 12_000;

// ── System prompt + JSON schema (mirrors server/services/Chronicler) ──

const SYSTEM_PROMPT = `You are the Chronicler — the in-world bard who keeps the chronicle of an ongoing D&D campaign.

For each session you're given:
- A short narrative recap (2-4 sentences) in PAST tense, third person, written as a single flowing paragraph. Mention WHO did WHAT, what changed in the world, any unresolved threads. NO bullet points. NO meta commentary. Just the prose.
- A longer recap (3-6 sentences) for the "Read more" expand — slightly more colour, but still tight prose.
- A list of key entities — proper nouns the recaps reference, returned separately as plain strings. The UI italicizes them at render time, so do NOT add asterisks, markdown, or any other emphasis to the recap text itself. Just write the prose as plain text and put the nouns in the keyEntities array. Names of PCs, NPCs, places, factions, items. 3-8 entries. Just the noun, no descriptors.
- A single present-tense sentence addressed to the returning DM, summarising the live situation as if pausing the action. End it with a directive that names the next character to act ("Your move, Liraya."). This is the "where you left off" line.

Style: concise, evocative, slightly formal. Match the tone of high-fantasy fiction without overdoing it.

Output a single JSON object with keys: recapShort, recapFull, keyEntities, whereLeftOff. Nothing else — no preamble, no markdown fences, no comments.`;

const JSON_FORMAT = {
  type: 'object',
  properties: {
    recapShort: { type: 'string' },
    recapFull: { type: 'string' },
    keyEntities: { type: 'array', items: { type: 'string' } },
    whereLeftOff: { type: 'string' },
  },
  required: ['recapShort', 'recapFull', 'keyEntities', 'whereLeftOff'],
};

function buildUserPrompt(job) {
  const t = job.transcript ?? '';
  const trimmed = t.length > MAX_TRANSCRIPT_CHARS
    ? `[…transcript trimmed at the head; kept most recent ${MAX_TRANSCRIPT_CHARS} chars…]\n${t.slice(-MAX_TRANSCRIPT_CHARS)}`
    : t;
  const partyLine = (job.partyNames && job.partyNames.length > 0)
    ? `The party at the table: ${job.partyNames.join(', ')}.`
    : '';
  const timingLine = (job.sessionStartedAt && job.sessionEndedAt)
    ? `Session ran from ${job.sessionStartedAt} to ${job.sessionEndedAt}.`
    : '';
  return `Campaign: ${job.campaignName}
Session number: ${job.sequenceNumber}
${partyLine}
${timingLine}

Transcript follows.
---
${trimmed}
---
Write the chronicle.`;
}

// ── Ollama client ───────────────────────────────────────────────

async function callOllama(job) {
  const timeout = Math.min(10 * 60_000, Date.parse(job.leaseUntil) - Date.now() - 60_000);
  if (!(timeout > 0)) throw new Error('Insufficient lease time for inference');
  const userPrompt = buildUserPrompt(job);
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    format: JSON_FORMAT,        // structured-output schema (Ollama ≥0.5)
    stream: false,
    options: {
      temperature: 0.4,
      num_predict: 1024,
    },
    keep_alive: '15m',          // keep the model warm between sessions
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.floor(timeout)),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  // Ollama /api/chat returns { message: { role, content }, ... }.
  // With format=schema the content is the JSON string directly.
  const content = data?.message?.content;
  if (!content) throw new Error(`Ollama response missing message.content: ${JSON.stringify(data).slice(0, 400)}`);
  return content;
}

function parseChroniclerJson(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`Model returned non-JSON: ${text.slice(0, 200)}`); }
  if (!raw || typeof raw !== 'object') throw new Error('Model JSON not an object');
  const recapShort = typeof raw.recapShort === 'string' ? raw.recapShort.trim() : '';
  const recapFull = typeof raw.recapFull === 'string' ? raw.recapFull.trim() : '';
  const whereLeftOff = typeof raw.whereLeftOff === 'string' ? raw.whereLeftOff.trim() : '';
  const keyEntitiesRaw = Array.isArray(raw.keyEntities) ? raw.keyEntities : [];
  const keyEntities = keyEntitiesRaw
    .filter((e) => typeof e === 'string')
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!recapShort) throw new Error('Model omitted recapShort');
  if (!whereLeftOff) throw new Error('Model omitted whereLeftOff');
  return {
    recapShort: recapShort.slice(0, 2000),
    recapFull: (recapFull || recapShort).slice(0, 8000),
    keyEntities: keyEntities.map((name) => name.slice(0, 80)),
    whereLeftOff: whereLeftOff.slice(0, 500),
  };
}

// ── Cloud Run client ────────────────────────────────────────────

export async function claimJob() {
  const res = await fetch(`${ATLAS_BASE_URL}/api/internal/chronicle/jobs/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return null;        // no work
  if (!res.ok) {
    throw new Error(`claim failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  const job = data.job;
  if (!job || typeof job.id !== 'string' || typeof job.transcript !== 'string'
      || typeof job.attemptId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.attemptId)
      || !(Date.parse(job.leaseUntil) > Date.now())) {
    throw new Error('Invalid claim acknowledgement: attemptId and live lease required');
  }
  return job;
}

export async function postResult(job, payload, { fetchImpl = fetch, wait = sleep, now = Date.now } = {}) {
  const body = JSON.stringify({ ...payload, attemptId: job.attemptId });
  const expectedStatus = 'error' in payload ? 'failed' : 'draft';
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    const remaining = Date.parse(job.leaseUntil) - now();
    if (!(remaining > 0)) throw new Error('Result delivery lease expired; job will be reclaimed');
    try {
      const res = await fetchImpl(`${ATLAS_BASE_URL}/api/internal/chronicle/jobs/${encodeURIComponent(job.id)}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body,
        signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(15_000, remaining)))),
      });
      if (res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status)) {
        const error = new Error(`Result rejected: HTTP ${res.status}`);
        error.permanent = true;
        throw error;
      }
      if (!res.ok) throw new Error(`Result delivery failed: HTTP ${res.status}`);
      const ack = await res.json();
      if (ack.ok !== true || ack.entryId !== job.id || ack.attemptId !== job.attemptId || ack.status !== expectedStatus) {
        throw new Error('Invalid result acknowledgement');
      }
      return ack;
    } catch (err) {
      if (err.permanent) throw err;
      lastError = err;
    }
    if (attempt < 7) await wait(Math.max(0, Math.min(2_000 * 2 ** attempt, 30_000, Date.parse(job.leaseUntil) - now())));
  }
  throw lastError;
}

// ── Main loop ───────────────────────────────────────────────────

export async function processOne({ claim = claimJob, generate = callOllama, deliver = postResult, log = console } = {}) {
  const job = await claim();
  if (!job) return false;

  log.log(`[${new Date().toISOString()}] claimed job ${job.id} (${job.transcript.length} chars)`);
  const t0 = Date.now();
  let payload;
  try {
    const raw = await generate(job);
    const parsed = parseChroniclerJson(raw);
    payload = { ...parsed, modelUsed: MODEL.slice(0, 80) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Inference failed: ${message}`);
    payload = { error: 'Ollama call failed', hint: message.slice(0, 800) };
  }
  // Delivery errors must never turn a successfully generated result into a failure report.
  await deliver(job, payload);
  log.log(`Result acknowledged as ${'error' in payload ? 'failed' : 'draft'} in ${Date.now() - t0}ms`);
  return true;
}

export function idleDelay(emptyPolls, base = POLL_INTERVAL_MS, max = MAX_IDLE_POLL_MS) {
  return Math.min(max, base * 2 ** Math.min(Math.max(0, emptyPolls - 1), 30));
}

async function loop() {
  if (!TOKEN) throw new Error('CHRONICLE_WORKER_TOKEN env var is required');
  console.log(`Atlas Chronicle worker online: model=${MODEL}, idle polling ${POLL_INTERVAL_MS}-${MAX_IDLE_POLL_MS}ms`);
  // Graceful shutdown — finish any in-flight job before exit.
  let stopping = false;
  let emptyPolls = 0;
  const idleAbort = new AbortController();
  const stop = () => { stopping = true; idleAbort.abort(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    let processed = false;
    try { processed = await processOne(); }
    catch (err) {
      console.error('Loop error:', err);
    }
    if (stopping) break;
    emptyPolls = processed ? 0 : emptyPolls + 1;
    if (!processed) await sleep(idleDelay(emptyPolls), undefined, { signal: idleAbort.signal }).catch((err) => {
      if (err.name !== 'AbortError') throw err;
    });
  }
  console.log('Worker exiting cleanly.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loop().catch((err) => {
    console.error('Worker crashed:', err);
    process.exitCode = 1;
  });
}
