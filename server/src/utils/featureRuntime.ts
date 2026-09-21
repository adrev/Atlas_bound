import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const coordinate = z.number().finite();
const pointPool = z
  .object({
    max: count,
    remaining: count,
    die: z.union([z.literal(8), z.literal(10), z.literal(12)]).optional(),
  })
  .strict();
const characterSchema = z
  .object({
    version: z.literal(1),
    namespaces: z
      .object({
        xp: count.optional(),
        wildShape: z
          .object({
            beastName: z.string(),
            beastHp: count,
            beastMax: count,
            beastAc: count.nullable(),
            beastSpeed: count.nullable(),
          })
          .strict()
          .optional(),
        arcaneWard: z.object({ current: count, max: count }).strict().optional(),
        portentDice: z.array(z.number().int().min(1).max(20)).max(3).optional(),
        luckPoints: count.max(3).optional(),
        enduranceUsed: z.boolean().optional(),
        indomitableUsed: count.max(3).optional(),
        pointPools: z.record(pointPool).optional(),
      })
      .strict(),
  })
  .strict();

const sessionSchema = z
  .object({
    version: z.literal(1),
    namespaces: z
      .object({
        underwater: z.boolean().optional(),
        mountLinks: z
          .record(z.object({ mountTokenId: z.string(), controlled: z.boolean() }).strict())
          .optional(),
        echoPositions: z.record(z.object({ x: coordinate, y: coordinate }).strict()).optional(),
        unleashUsed: z.record(z.string()).optional(),
        colossusUsed: z.record(z.string()).optional(),
        grimHarvestUsed: z.record(z.string()).optional(),
        divineFuryUsed: z.record(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

export type CharacterFeatureState = z.infer<typeof characterSchema>['namespaces'];
export type SessionFeatureState = z.infer<typeof sessionSchema>['namespaces'];
export type FeaturePointPools = Map<string, Map<string, z.infer<typeof pointPool>>>;
export function parseCharacterFeatureState(value: unknown): CharacterFeatureState {
  return characterSchema.parse(value).namespaces;
}
export type FeatureQuery = (
  text: string,
  values?: unknown[]
) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;

interface LoadedState<T> {
  value: T;
  original: string;
}

export interface FeatureRuntime {
  readonly sessionId: string;
  readonly session: LoadedState<z.infer<typeof sessionSchema>>;
  readonly characters: Map<string, LoadedState<z.infer<typeof characterSchema>>>;
}

// Only the request context lives here. No gameplay values are cached between events.
const context = new AsyncLocalStorage<FeatureRuntime>();

/**
 * The caller must supply one open transaction's query callback, keep its locks
 * through saveFeatureRuntime + COMMIT, and discard this runtime on rollback.
 * Character IDs must include every character this event can touch. Locking them
 * in a stable order serializes shared characters across independent sessions.
 */
export async function loadFeatureRuntime(
  query: FeatureQuery,
  sessionId: string,
  characterIds: readonly string[]
): Promise<FeatureRuntime> {
  await query(
    'INSERT INTO session_feature_runtime (session_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [sessionId]
  );
  const session = await query(
    'SELECT state FROM session_feature_runtime WHERE session_id = $1 FOR UPDATE',
    [sessionId]
  );
  const sessionValue = sessionSchema.parse(session.rows[0]?.state);
  const runtime: FeatureRuntime = {
    sessionId,
    session: { value: sessionValue, original: JSON.stringify(sessionValue) },
    characters: new Map(),
  };
  for (const characterId of [...new Set(characterIds)].sort()) {
    await query(
      'INSERT INTO character_feature_runtime (character_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [characterId]
    );
    const result = await query(
      'SELECT state FROM character_feature_runtime WHERE character_id = $1 FOR UPDATE',
      [characterId]
    );
    const value = characterSchema.parse(result.rows[0]?.state);
    runtime.characters.set(characterId, { value, original: JSON.stringify(value) });
  }
  return runtime;
}

export function runWithFeatureRuntime<T>(runtime: FeatureRuntime, operation: () => T): T {
  return context.run(runtime, operation);
}

function currentRuntime(): FeatureRuntime {
  const runtime = context.getStore();
  if (!runtime) throw new Error('Gameplay feature state requires a hydrated transaction scope');
  return runtime;
}

export function characterFeatures(characterId: string): CharacterFeatureState {
  const state = currentRuntime().characters.get(characterId);
  if (!state) throw new Error(`Character feature state was not loaded: ${characterId}`);
  return state.value.namespaces;
}

export function sessionFeatures(sessionId: string): SessionFeatureState {
  const runtime = currentRuntime();
  if (runtime.sessionId !== sessionId) throw new Error('Gameplay feature session scope mismatch');
  return runtime.session.value.namespaces;
}

/** Restore the character-owned pools instead of overlaying a session snapshot. */
export function hydrateFeaturePointPools(runtime: FeatureRuntime): FeaturePointPools {
  const pools: FeaturePointPools = new Map();
  for (const [id, state] of runtime.characters) {
    const stored = state.value.namespaces.pointPools;
    if (stored !== undefined) {
      pools.set(id, new Map(Object.entries(stored).map(([name, value]) => [name, { ...value }])));
    }
  }
  return pools;
}

/** Capture only preloaded character rows; never create a cross-session copy. */
export function captureFeaturePointPools(runtime: FeatureRuntime, pools: FeaturePointPools): void {
  for (const id of pools.keys()) {
    if (!runtime.characters.has(id))
      throw new Error(`Character point pools were not loaded: ${id}`);
  }
  for (const [id, state] of runtime.characters) {
    const poolMap = pools.get(id);
    if (poolMap) {
      state.value.namespaces.pointPools = Object.fromEntries(
        [...poolMap].map(([name, value]) => [name, pointPool.parse(value)])
      );
    } else {
      delete state.value.namespaces.pointPools;
    }
  }
}

/** Await this before any success fanout/acknowledgement and before COMMIT. */
export async function saveFeatureRuntime(
  query: FeatureQuery,
  runtime: FeatureRuntime
): Promise<void> {
  // Validate the entire write set before issuing writes. Bad state must never
  // quietly round-trip as null, disappear, or reset an exhausted resource.
  const session = JSON.stringify(sessionSchema.parse(runtime.session.value));
  const characters = [...runtime.characters].map(([id, state]) => ({
    id,
    state,
    serialized: JSON.stringify(characterSchema.parse(state.value)),
  }));
  if (session !== runtime.session.original) {
    const result = await query(
      'UPDATE session_feature_runtime SET state = $2::jsonb WHERE session_id = $1 AND state = $3::jsonb',
      [runtime.sessionId, session, runtime.session.original]
    );
    if (result.rowCount !== 1) throw new Error('Stale session feature state');
  }
  for (const { id, state, serialized } of characters) {
    if (serialized === state.original) continue;
    const result = await query(
      'UPDATE character_feature_runtime SET state = $2::jsonb WHERE character_id = $1 AND state = $3::jsonb',
      [id, serialized, state.original]
    );
    if (result.rowCount !== 1) throw new Error(`Stale character feature state: ${id}`);
  }
  runtime.session.original = session;
  for (const { state, serialized } of characters) state.original = serialized;
}
