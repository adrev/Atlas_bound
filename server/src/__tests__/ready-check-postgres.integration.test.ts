import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import type { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkedDatabaseUrl,
  configureFixtureDatabase,
  deferred,
} from './fixtures/runtime-process.js';

// Explicit loopback QA database only. Never infer opt-in from DATABASE_URL.
const database = process.env.ATLAS_RUNTIME_TEST_DATABASE_URL;
if (database) checkedDatabaseUrl(database);
const schema = `atlas_runtime_it_${randomUUID().replaceAll('-', '')}`;
const applicationName = `ready-check-it-${process.pid}-${randomUUID()}`;
const sessions = new Set<string>();
const previousEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  CLOUD_SQL_CONNECTION_NAME: process.env.CLOUD_SQL_CONNECTION_NAME,
  PGOPTIONS: process.env.PGOPTIONS,
};
let admin: Pool | undefined;
let schemaCreated = false;
let connection: typeof import('../db/connection.js');
let runtime: typeof import('../services/SessionRuntime.js');
let ready: typeof import('../services/ReadyCheckRuntime.js');
let rooms: typeof import('../utils/roomState.js');
let transactions: typeof import('../db/transactionContext.js');

async function fixture() {
  const id = randomUUID();
  sessions.add(id);
  await connection.rawPool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [
    id,
    'Ready QA',
  ]);
  await connection.rawPool.query(
    'INSERT INTO sessions (id, name, room_code, dm_user_id) VALUES ($1, $2, $1, $1)',
    [id, 'Ready QA']
  );
  await connection.rawPool.query(
    'INSERT INTO maps (id, session_id, name, grid_size) VALUES ($1, $1, $2, 70)',
    [id, 'Ready QA']
  );
  await connection.rawPool.query(
    'UPDATE sessions SET current_map_id = $1, player_map_id = $1 WHERE id = $1',
    [id]
  );
  await connection.rawPool.query(
    'INSERT INTO tokens (id, map_id, name, x, y) VALUES ($1, $1, $2, 0, 0)',
    [id, 'Ready QA NPC']
  );
  const emissions: string[] = [];
  const io = {
    to: () => ({
      emit: (event: string) =>
        transactions.afterCommit(() => {
          emissions.push(event);
        }),
    }),
  } as unknown as Server;
  return { id, io, emissions };
}

async function durable(id: string) {
  const { rows } = await connection.rawPool.query(
    `SELECT
    (SELECT state->'values'->'readyCheck' FROM session_runtime WHERE session_id = $1) AS ready,
    (SELECT state->'values'->'combatState' FROM session_runtime WHERE session_id = $1) AS combat,
    (SELECT COUNT(*)::int FROM combat_state WHERE session_id = $1) AS combat_rows`,
    [id]
  );
  return rows[0] as {
    ready: { id: string; deadline: number; responses: [string, boolean][] } | null;
    combat: { active: boolean } | null;
    combat_rows: number;
  };
}

async function waitForCombat(id: string) {
  for (let i = 0; i < 200; i++) {
    const state = await durable(id);
    if (state.combat?.active) return state;
    await delay(10);
  }
  throw new Error('Timed out waiting for committed ready-check combat');
}

describe.skipIf(!database)('ready checks on real PostgreSQL', () => {
  beforeAll(async () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(24);
    admin = new Pool({ connectionString: checkedDatabaseUrl(database) });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    configureFixtureDatabase(database!, schema, applicationName);
    connection = await import('../db/connection.js');
    await (await import('../db/schema.js')).initDatabase();
    await (await import('../db/runtimeSchema.js')).initRuntimeSchema();
    runtime = await import('../services/SessionRuntime.js');
    ready = await import('../services/ReadyCheckRuntime.js');
    rooms = await import('../utils/roomState.js');
    transactions = await import('../db/transactionContext.js');
    runtime.configureSessionRuntime();
  }, 30_000);

  afterAll(async () => {
    for (const id of sessions) rooms?.deleteRoom(id);
    await runtime?.drainSessionRuntime();
    await connection?.rawPool.end();
    if (schemaCreated) await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 30_000);

  it('does not arm before commit even if the absolute deadline passes during the transaction', async () => {
    const { id, io, emissions } = await fixture();
    const entered = deferred();
    const release = deferred();
    const work = runtime.withSessionRuntime(id, async () => {
      const room = rooms.getRoom(id)!;
      room.readyCheck = {
        id: 'slow-commit',
        deadline: Date.now() + 30,
        tokenIds: [id],
        playerIds: ['player'],
        responses: new Map(),
        timeout: null,
      };
      ready.armReadyCheckTimer(room, io);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      await delay(60);
      expect(rooms.getRoom(id)!.readyCheck!.timeout).toBeNull();
      expect(await durable(id)).toEqual({ ready: null, combat: null, combat_rows: 0 });
      expect(emissions).toEqual([]);
    } finally {
      release.resolve();
    }
    await work;
    const state = await waitForCombat(id);
    expect(state).toMatchObject({ ready: null, combat: { active: true }, combat_rows: 1 });
    await runtime.withSessionRuntime(id, async () => {});
    expect(emissions.filter((event) => event === 'combat:ready-check-complete')).toHaveLength(1);
  });

  it('rehydrates responses/deadline in a fresh Node process and starts only once from saved intent', async () => {
    const { id, io } = await fixture();
    const deadline = Date.now() + 200;
    await runtime.withSessionRuntime(id, async () => {
      const room = rooms.getRoom(id)!;
      room.readyCheck = {
        id: 'cold-check',
        deadline,
        tokenIds: [id],
        playerIds: ['one', 'two'],
        responses: new Map([
          ['one', true],
          ['two', false],
        ]),
        timeout: null,
      };
      ready.armReadyCheckTimer(room, io);
    });
    const saved = await durable(id);
    expect(saved.ready).toEqual({
      id: 'cold-check',
      deadline,
      tokenIds: [id],
      playerIds: ['one', 'two'],
      responses: [
        ['one', true],
        ['two', false],
      ],
    });
    rooms.deleteRoom(id); // Local state disappears, as with process loss; SQL remains.
    const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const script = `
      import { configureFixtureDatabase } from ${source('./fixtures/runtime-process.ts')};
      configureFixtureDatabase(process.env.ATLAS_RUNTIME_TEST_DATABASE_URL, ${JSON.stringify(schema)}, 'ready-check-cold-child');
      const connection = await import(${source('../db/connection.ts')});
      const runtime = await import(${source('../services/SessionRuntime.ts')});
      const { armReadyCheckTimer } = await import(${source('../services/ReadyCheckRuntime.ts')});
      const { getRoom } = await import(${source('../utils/roomState.ts')});
      const { afterCommit } = await import(${source('../db/transactionContext.ts')});
      const id = ${JSON.stringify(id)};
      const events = [];
      const io = { to: () => ({ emit: (event) => afterCommit(() => { events.push(event); }) }) };
      try {
        if (getRoom(id)) throw new Error('Expected genuinely cold room');
        runtime.configureSessionRuntime();
        let restored;
        await runtime.withSessionRuntime(id, async () => {
          const room = getRoom(id);
          restored = { id: room.readyCheck.id, deadline: room.readyCheck.deadline, responses: [...room.readyCheck.responses] };
          armReadyCheckTimer(room, io);
          armReadyCheckTimer(room, io);
        });
        let committed = false;
        for (let i = 0; i < 200; i++) {
          const { rows } = await connection.rawPool.query('SELECT 1 FROM combat_state WHERE session_id = $1', [id]);
          if (rows.length) { committed = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!committed) throw new Error('No committed cold-start combat');
        await runtime.withSessionRuntime(id, async () => {});
        console.log('READY_RESULT:' + JSON.stringify({ pid: process.pid, restored, events }));
      } finally {
        await runtime.drainSessionRuntime();
        await connection.rawPool.end();
      }
    `;
    const child = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        env: { ...process.env },
        timeout: 15_000,
      }
    );
    const result = JSON.parse(
      child.stdout
        .split('\n')
        .find((line) => line.startsWith('READY_RESULT:'))!
        .slice('READY_RESULT:'.length)
    );
    expect(result.pid).not.toBe(process.pid);
    expect(result.restored).toEqual({
      id: 'cold-check',
      deadline,
      responses: [
        ['one', true],
        ['two', false],
      ],
    });
    expect(
      result.events.filter((event: string) => event === 'combat:ready-check-complete')
    ).toHaveLength(1);
    expect(await durable(id)).toMatchObject({
      ready: null,
      combat: { active: true },
      combat_rows: 1,
    });
  });

  it('revalidates a remote cancellation after waiting on the PostgreSQL session lock', async () => {
    const { id, io, emissions } = await fixture();
    await runtime.withSessionRuntime(id, async () => {
      const room = rooms.getRoom(id)!;
      room.readyCheck = {
        id: 'cancel-check',
        deadline: Date.now() + 100,
        tokenIds: [id],
        responses: new Map(),
        timeout: null,
      };
      ready.armReadyCheckTimer(room, io);
    });
    const remote = await connection.rawPool.connect();
    try {
      await remote.query('BEGIN');
      await remote.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `atlas-session:${id}`,
      ]);
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const { rows } = await connection.rawPool.query(
          'SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = $2',
          [applicationName, 'advisory']
        );
        if (rows.length > 0) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      expect(waiting, 'timer must actually wait on the database lock').toBe(true);
      await remote.query(
        `UPDATE session_runtime SET state = jsonb_set(state, '{values,readyCheck}', 'null'::jsonb) WHERE session_id = $1`,
        [id]
      );
      await remote.query('COMMIT');
    } finally {
      await remote.query('ROLLBACK');
      remote.release();
    }
    await runtime.withSessionRuntime(id, async () => {});
    expect(await durable(id)).toEqual({ ready: null, combat: null, combat_rows: 0 });
    expect(emissions).toEqual([]);
  });

  it('rolls back an uncommitted ready check without arming or emitting completion', async () => {
    const { id, io, emissions } = await fixture();
    await expect(
      runtime.withSessionRuntime(id, async () => {
        const room = rooms.getRoom(id)!;
        room.readyCheck = {
          id: 'failed-check',
          deadline: Date.now(),
          tokenIds: [id],
          responses: new Map(),
          timeout: null,
        };
        ready.armReadyCheckTimer(room, io);
        throw new Error('discard check');
      })
    ).rejects.toThrow('discard check');
    await delay(30);
    expect(await durable(id)).toEqual({ ready: null, combat: null, combat_rows: 0 });
    expect(emissions).toEqual([]);
  });
});
