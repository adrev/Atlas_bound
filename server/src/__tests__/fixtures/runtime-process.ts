import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { RoomSnapshot } from '../../utils/roomSnapshot.js';
import type { CharacterFeatureState, SessionFeatureState } from '../../utils/featureRuntime.js';
import type { Token } from '@dnd-vtt/shared';

export interface FixtureIds {
  sessionId: string;
  userId: string;
  characterId: string;
  mapId: string;
  tokenId: string;
}

export interface ObservedRuntime {
  pid: number;
  node: string;
  cold: boolean;
  snapshot: RoomSnapshot;
  character: CharacterFeatureState;
  session: SessionFeatureState;
  pointPools: [string, [string, { max: number; remaining: number }][]][];
  tokens: Token[];
  players: number;
  sockets: number;
  gameMode: string;
  mapId: string | null;
  gridSize: number | undefined;
}

export interface WorkerRequest extends FixtureIds {
  mode: 'inspect' | 'increment';
  iterations?: number;
  hold?: boolean;
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** No connection (including module-level pool creation) precedes this guard. */
export function checkedDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('ATLAS_RUNTIME_TEST_DATABASE_URL is required');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Runtime integration tests require a PostgreSQL URL');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Runtime integration tests refuse a non-loopback database host');
  }
  if (!decodeURIComponent(url.pathname.slice(1)).includes('atlas_scale_zero')) {
    throw new Error('Runtime integration tests require an atlas_scale_zero database');
  }
  // libpq parameters can override host/database or add an unsafe search_path.
  if (url.search || url.hash) throw new Error('Runtime integration tests refuse URL overrides');
  return url.href;
}

export function fixtureDatabaseUrl(value: string, schema: string, applicationName: string): string {
  const url = new URL(checkedDatabaseUrl(value));
  if (!/^atlas_runtime_it_[a-f0-9]{32}$/.test(schema))
    throw new Error('Invalid owned fixture schema');
  url.searchParams.set('options', `-c search_path=${schema}`);
  url.searchParams.set('application_name', applicationName);
  return url.href;
}

export function configureFixtureDatabase(
  value: string,
  schema: string,
  applicationName: string
): void {
  process.env.DATABASE_URL = fixtureDatabaseUrl(value, schema, applicationName);
  delete process.env.CLOUD_SQL_CONNECTION_NAME;
  delete process.env.PGOPTIONS;
}

async function run(): Promise<void> {
  const request = JSON.parse(process.argv[2]) as WorkerRequest;
  const database = checkedDatabaseUrl(process.env.ATLAS_RUNTIME_TEST_DATABASE_URL);
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Fixture requires Node 24+');
  configureFixtureDatabase(
    database,
    process.env.ATLAS_RUNTIME_TEST_SCHEMA ?? '',
    `atlas-runtime-child-${process.pid}`
  );
  const { default: pool, rawPool } = await import('../../db/connection.js');
  const { configureSessionRuntime, withSessionRuntime } =
    await import('../../services/SessionRuntime.js');
  const { getRoom } = await import('../../utils/roomState.js');
  const { snapshotRoom } = await import('../../utils/roomSnapshot.js');
  const { characterFeatures, sessionFeatures } = await import('../../utils/featureRuntime.js');
  const start = deferred();
  const release = deferred();
  const onMessage = (message: unknown) => {
    if (message === 'start') start.resolve();
    if (message === 'release') release.resolve();
  };
  process.on('message', onMessage);
  try {
    configureSessionRuntime();
    const cold = !getRoom(request.sessionId);
    const { rows } = await pool.query('SELECT pg_backend_pid() AS pid, current_schema() AS schema');
    if (rows[0].schema !== process.env.ATLAS_RUNTIME_TEST_SCHEMA)
      throw new Error('Wrong fixture schema');
    process.send?.({ type: 'ready', pid: process.pid, backendPid: rows[0].pid });
    await start.promise;
    if (request.mode === 'increment') {
      for (let i = 0; i < (request.iterations ?? 1); i++) {
        await withSessionRuntime(request.sessionId, async () => {
          const room = getRoom(request.sessionId)!;
          const features = characterFeatures(request.characterId);
          const xp = features.xp ?? 0;
          const cursor = room.nextEventId;
          const ki = room.pointPools.get(request.characterId)?.get('ki');
          if (!ki || ki.remaining <= 0) throw new Error('Missing or exhausted fixture Ki');
          if (i === 0) {
            process.send?.({ type: 'entered', pid: process.pid });
            if (request.hold) await release.promise;
          }
          // A read/modify/write, not an atomic SQL increment: stale hydration loses data.
          await pool.query('SELECT pg_sleep(0.02)');
          features.xp = xp + 1;
          ki.remaining -= 1;
          room.nextEventId = cursor + 1;
          room.roundHooks.push(`writer:${process.pid}:${i}`);
        });
      }
    }
    const result = await withSessionRuntime(
      request.sessionId,
      async (): Promise<ObservedRuntime> => {
        const room = getRoom(request.sessionId)!;
        return {
          pid: process.pid,
          node: process.versions.node,
          cold,
          snapshot: snapshotRoom(room),
          character: structuredClone(characterFeatures(request.characterId)),
          session: structuredClone(sessionFeatures(request.sessionId)),
          pointPools: [...room.pointPools].map(([id, pools]) => [id, [...pools]]),
          tokens: [...room.tokens.values()],
          players: room.players.size,
          sockets: room.userSockets.size,
          gameMode: room.gameMode,
          mapId: room.playerMapId,
          gridSize: room.mapGridSizes.get(request.mapId),
        };
      }
    );
    process.send?.({ type: 'result', result });
  } finally {
    process.off('message', onMessage);
    await rawPool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .catch((error: unknown) => {
      process.send?.({
        type: 'failure',
        error: error instanceof Error ? error.stack : String(error),
      });
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      process.disconnect?.();
    });
}
