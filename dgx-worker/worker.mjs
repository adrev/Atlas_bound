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
 *   POLL_INTERVAL_MS               default 5000
 *
 * Run via systemd (see dgx-worker/atlas-chronicle.service) or just
 * `node worker.mjs` for ad-hoc testing.
 */

const ATLAS_BASE_URL = process.env.ATLAS_BASE_URL || 'https://kbrt.ai';
const TOKEN = process.env.CHRONICLE_WORKER_TOKEN;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.CHRONICLER_OLLAMA_MODEL || 'gemma4:26b';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_TRANSCRIPT_CHARS = 12_000;

if (!TOKEN) {
  console.error('FATAL: CHRONICLE_WORKER_TOKEN env var is required');
  process.exit(1);
}

// ── System prompt + JSON schema (mirrors server/services/Chronicler) ──

const SYSTEM_PROMPT = `You are the Chronicler — the in-world bard who keeps the chronicle of an ongoing D&D campaign.

For each session you're given:
- A short narrative recap (2-4 sentences) in PAST tense, third person, written as a single flowing paragraph. Mention WHO did WHAT, what changed in the world, any unresolved threads. NO bullet points. NO meta commentary. Just the prose.
- A longer recap (3-6 sentences) for the "Read more" expand — slightly more colour, but still tight prose.
- A list of key entities — proper nouns the recaps reference, that the UI will italicize. Names of PCs, NPCs, places, factions, items. 3-8 entries. Just the noun, no descriptors.
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
    recapShort,
    recapFull: recapFull || recapShort,
    keyEntities,
    whereLeftOff,
  };
}

// ── Cloud Run client ────────────────────────────────────────────

async function claimJob() {
  const res = await fetch(`${ATLAS_BASE_URL}/api/internal/chronicle/jobs/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (res.status === 204) return null;        // no work
  if (!res.ok) {
    console.warn(`claim failed: HTTP ${res.status}`);
    return null;
  }
  const data = await res.json();
  return data.job ?? null;
}

async function postResult(jobId, payload) {
  const res = await fetch(`${ATLAS_BASE_URL}/api/internal/chronicle/jobs/${jobId}/result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.warn(`postResult failed: HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.ok;
}

// ── Main loop ───────────────────────────────────────────────────

async function processOne() {
  const job = await claimJob();
  if (!job) return false;

  console.log(`[${new Date().toISOString()}] claimed job ${job.id} — "${job.campaignName}" #${job.sequenceNumber} (${job.transcript.length} chars)`);
  const t0 = Date.now();
  try {
    const raw = await callOllama(job);
    const parsed = parseChroniclerJson(raw);
    const tookMs = Date.now() - t0;
    await postResult(job.id, { ...parsed, modelUsed: MODEL });
    console.log(`  → ok in ${tookMs}ms (recap ${parsed.recapShort.length} chars, ${parsed.keyEntities.length} entities)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  → FAILED: ${message}`);
    await postResult(job.id, { error: 'Ollama call failed', hint: message.slice(0, 800) });
  }
  return true;
}

async function loop() {
  console.log(`Atlas Chronicle worker online — model=${MODEL}, poll every ${POLL_INTERVAL_MS}ms, base=${ATLAS_BASE_URL}`);
  // Graceful shutdown — finish any in-flight job before exit.
  let stopping = false;
  process.on('SIGINT', () => { console.log('SIGINT — finishing current job and exiting'); stopping = true; });
  process.on('SIGTERM', () => { console.log('SIGTERM — finishing current job and exiting'); stopping = true; });

  while (!stopping) {
    let processed = false;
    try { processed = await processOne(); }
    catch (err) {
      console.error('Loop error:', err);
    }
    if (stopping) break;
    // If we just processed a job, immediately check for another —
    // batches finish faster. Otherwise sleep the poll interval.
    if (!processed) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log('Worker exiting cleanly.');
}

loop().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
