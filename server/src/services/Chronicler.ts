/**
 * The Chronicler — turns a raw session transcript into a narrative
 * recap suitable for the lobby's Chronicle rail.
 *
 * Backed by Vertex AI's Gemini 2.5 Flash-Lite. Picked for:
 *   - Cheap (~$0.0003 per recap at 8k input + 200 output)
 *   - In-ecosystem (Cloud Run service account just needs aiplatform.user)
 *   - Fast (sub-second at this size)
 *   - JSON-mode native (responseMimeType: 'application/json')
 *
 * The model picks proper nouns to emphasize on its own — Liraya,
 * Briar Hollow, Mahadi — and we surface them as key_entities so the
 * lobby UI can wrap them in <em> tags consistent with the design's
 * "lead-noun emphasis" aesthetic.
 *
 * Failure path: every error is caught + tagged onto the chronicle
 * row's `generation_error` field. The DM can retry, edit by hand,
 * or skip publishing — the lobby just hides failed rows.
 */

import { VertexAI, SchemaType, type GenerateContentRequest } from '@google-cloud/vertexai';

/** GCP region we're calling. Must match a region where the chosen
 *  model is available. us-central1 has every model we care about. */
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

/** Project id. In Cloud Run, the Vertex SDK can discover the runtime
 *  project from metadata; local dev can override it explicitly. */
const VERTEX_PROJECT_ID = process.env.GCP_PROJECT_ID
  || process.env.GOOGLE_CLOUD_PROJECT
  || process.env.GCLOUD_PROJECT
  || '';

/** Model id. Flash-Lite is the cheap tier; flip to "gemini-2.5-flash"
 *  for slightly better prose at ~2× the cost. */
const CHRONICLER_MODEL = process.env.CHRONICLER_MODEL || 'gemini-2.5-flash-lite';

/** Hard cap on the transcript we send. Vertex's input ceiling is much
 *  higher (millions of tokens for 2.5) but a 12k-char cap keeps
 *  per-recap cost predictable. We trim oldest-first if exceeded. */
const MAX_TRANSCRIPT_CHARS = 12_000;

export interface ChroniclerInput {
  /** Campaign name, e.g. "Mists of Thornreach" — gives the model
   *  vibes for tone matching. */
  campaignName: string;
  /** Sequence number within the campaign — "Session 7" reads better
   *  in the recap than "session UUID xyz". */
  sequenceNumber: number;
  /** Raw transcript: chat messages, dice rolls, combat events,
   *  DM-flagged beats, all interleaved chronologically. Plain text. */
  transcript: string;
  /** Optional names of player characters at the table — biases the
   *  model toward weaving them into the recap. */
  partyNames?: string[];
  /** Optional ISO timestamps; if both present we surface the
   *  duration in the where-left-off line. */
  sessionStartedAt?: string;
  sessionEndedAt?: string;
}

export interface ChroniclerOutput {
  /** 2-4 sentence narrative paragraph for the lobby rail. */
  recapShort: string;
  /** Longer paragraph or two for the "Read more" expand. */
  recapFull: string;
  /** Proper nouns to emphasize inline. The lobby wraps these in <em>. */
  keyEntities: string[];
  /** One present-tense sentence addressed to the returning DM,
   *  ending with a directive. Powers the Resume card. */
  whereLeftOff: string;
}

export interface ChroniclerError {
  error: string;
  hint?: string;
}

/**
 * Build the system + user messages. Pure function so we can unit-test
 * the prompt shape without spinning up a Vertex client.
 */
export function buildChroniclerRequest(input: ChroniclerInput): GenerateContentRequest {
  const { campaignName, sequenceNumber, transcript, partyNames, sessionStartedAt, sessionEndedAt } = input;

  // Trim oldest-first if the transcript is huge. We assume the most
  // recent events matter most for the recap; truncating the head is
  // a clean way to stay under the cap.
  const trimmed = transcript.length > MAX_TRANSCRIPT_CHARS
    ? `[…transcript trimmed at the head; kept most recent ${MAX_TRANSCRIPT_CHARS} chars…]\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`
    : transcript;

  const partyLine = partyNames && partyNames.length > 0
    ? `The party at the table: ${partyNames.join(', ')}.`
    : '';

  const timingLine = (sessionStartedAt && sessionEndedAt)
    ? `Session ran from ${sessionStartedAt} to ${sessionEndedAt}.`
    : '';

  // System instruction: the persona + the strict JSON contract.
  const systemPrompt = `You are the Chronicler — the in-world bard who keeps the chronicle of an ongoing D&D campaign.

For each session you're given:
- A short narrative recap (2-4 sentences) in PAST tense, third person, written as a single flowing paragraph. Mention WHO did WHAT, what changed in the world, any unresolved threads. NO bullet points. NO meta commentary. Just the prose.
- A longer recap (3-6 sentences) for the "Read more" expand — slightly more colour, but still tight prose.
- A list of key entities — proper nouns the recaps reference, returned separately as plain strings. The UI italicizes them at render time, so do NOT add asterisks, markdown, or any other emphasis to the recap text itself. Just write the prose as plain text and put the nouns in the keyEntities array. Names of PCs, NPCs, places, factions, items. 3-8 entries. Just the noun, no descriptors.
- A single present-tense sentence addressed to the returning DM, summarising the live situation as if pausing the action. End it with a directive that names the next character to act ("Your move, Liraya."). This is the "where you left off" line.

Style: concise, evocative, slightly formal. Match the tone of high-fantasy fiction without overdoing it.

Output a single JSON object with keys: recapShort, recapFull, keyEntities, whereLeftOff. Nothing else — no preamble, no markdown fences.`;

  const userPrompt = `Campaign: ${campaignName}
Session number: ${sequenceNumber}
${partyLine}
${timingLine}

Transcript follows.
---
${trimmed}
---
Write the chronicle.`;

  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: systemPrompt }],
    },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      // JSON output mode + strict schema: the model returns a JSON
      // object that matches our ChroniclerOutput shape exactly. This
      // is the cleanest way to avoid hallucinated keys or markdown
      // fences around the response.
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          recapShort: { type: SchemaType.STRING },
          recapFull: { type: SchemaType.STRING },
          keyEntities: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          whereLeftOff: { type: SchemaType.STRING },
        },
        required: ['recapShort', 'recapFull', 'keyEntities', 'whereLeftOff'],
      },
      // 800 tokens is plenty for the entire JSON payload.
      maxOutputTokens: 1024,
      // Slight creativity but not unhinged. 0.4 keeps proper nouns
      // stable across repeated runs of the same transcript.
      temperature: 0.4,
    },
  };
}

/**
 * Parse the model's JSON response into the typed output shape.
 * Defensive: the model is supposed to honour the schema but we
 * still validate before persisting.
 */
export function parseChroniclerResponse(jsonText: string): ChroniclerOutput | ChroniclerError {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { error: 'Chronicler returned non-JSON', hint: jsonText.slice(0, 200) };
  }

  if (!raw || typeof raw !== 'object') {
    return { error: 'Chronicler response was not an object' };
  }

  const obj = raw as Record<string, unknown>;
  const recapShort = typeof obj.recapShort === 'string' ? obj.recapShort.trim() : '';
  const recapFull = typeof obj.recapFull === 'string' ? obj.recapFull.trim() : '';
  const whereLeftOff = typeof obj.whereLeftOff === 'string' ? obj.whereLeftOff.trim() : '';
  const keyEntitiesRaw = Array.isArray(obj.keyEntities) ? obj.keyEntities : [];
  const keyEntities = keyEntitiesRaw
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim())
    .filter(Boolean)
    .slice(0, 12); // cap

  if (!recapShort) return { error: 'Chronicler omitted recapShort' };
  if (!whereLeftOff) return { error: 'Chronicler omitted whereLeftOff' };

  return { recapShort, recapFull: recapFull || recapShort, keyEntities, whereLeftOff };
}

/**
 * Module-level Vertex client. Constructed once on first call so the
 * tests can swap it out via setVertexClientForTesting().
 */
let vertexClient: VertexAI | null = null;

function getVertexClient(): VertexAI {
  if (!vertexClient) {
    vertexClient = new VertexAI({
      ...(VERTEX_PROJECT_ID ? { project: VERTEX_PROJECT_ID } : {}),
      location: VERTEX_LOCATION,
    });
  }
  return vertexClient;
}

/** Test-only escape hatch — install a stub client + reset between cases. */
export function setVertexClientForTesting(client: VertexAI | null): void {
  vertexClient = client;
}

/**
 * Run the Chronicler. One Vertex AI call per invocation; no retries.
 * Callers should `await` the result and stamp the output onto the
 * chronicle row. Errors are returned as the error variant rather
 * than thrown — matches the "best-effort side-channel" pattern we
 * use elsewhere (Discord webhook, etc.) and lets the route layer
 * persist the error message onto generation_error.
 */
export async function generateChronicle(input: ChroniclerInput): Promise<ChroniclerOutput | ChroniclerError> {
  if (!input.transcript || input.transcript.trim().length < 20) {
    return {
      error: 'Transcript too short',
      hint: 'Need at least 20 chars of session text for a meaningful recap.',
    };
  }

  const request = buildChroniclerRequest(input);
  const generativeModel = getVertexClient().getGenerativeModel({ model: CHRONICLER_MODEL });

  let responseText = '';
  try {
    const result = await generativeModel.generateContent(request);
    const candidate = result.response?.candidates?.[0];
    const part = candidate?.content?.parts?.[0];
    responseText = part?.text ?? '';
  } catch (err) {
    return {
      error: 'Vertex AI call failed',
      hint: err instanceof Error ? err.message : String(err),
    };
  }

  if (!responseText) {
    return { error: 'Empty response from Vertex AI' };
  }

  return parseChroniclerResponse(responseText);
}

/** Tiny helper so callers can branch on the result. */
export function isChroniclerError(r: ChroniclerOutput | ChroniclerError): r is ChroniclerError {
  return 'error' in r;
}

/** Exported model id so route handlers can stamp it onto the row. */
export const CHRONICLER_MODEL_ID = CHRONICLER_MODEL;
