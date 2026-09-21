import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { Server, Socket } from 'socket.io';
import {
  checkedDatabaseUrl,
  configureFixtureDatabase,
  deferred,
  type FixtureIds,
  type ObservedRuntime,
  type WorkerRequest,
} from './fixtures/runtime-process.js';

// Explicit opt-in; DATABASE_URL alone must never enable this suite.
const database = process.env.ATLAS_RUNTIME_TEST_DATABASE_URL;
if (database) checkedDatabaseUrl(database);
const schema = `atlas_runtime_it_${randomUUID().replaceAll('-', '')}`;
const children = new Set<ChildProcess>();
const sessions = new Set<string>();
let admin: Pool | undefined;
let schemaCreated = false;
let connection: typeof import('../db/connection.js');
let runtime: typeof import('../services/SessionRuntime.js');
let rooms: typeof import('../utils/roomState.js');
let snapshots: typeof import('../utils/roomSnapshot.js');
let features: typeof import('../utils/featureRuntime.js');
let transaction: typeof import('../db/transactionContext.js');
let initDatabase: (typeof import('../db/schema.js'))['initDatabase'];
let initRuntimeSchema: (typeof import('../db/runtimeSchema.js'))['initRuntimeSchema'];
const previousEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  CLOUD_SQL_CONNECTION_NAME: process.env.CLOUD_SQL_CONNECTION_NAME,
  PGOPTIONS: process.env.PGOPTIONS,
};

describe('PostgreSQL runtime safety gate', () => {
  it.each([
    undefined,
    'postgresql://postgres:secret@example.com/atlas_scale_zero',
    'postgresql://postgres:secret@127.0.0.1/production',
    'postgresql://postgres:secret@127.0.0.1/atlas_scale_zero?host=example.com',
    'postgresql://postgres:secret@127.0.0.1/atlas_scale_zero?dbname=production',
    'https://127.0.0.1/atlas_scale_zero',
  ])('rejects unsafe or missing database URLs: %s', (value) => {
    expect(() => checkedDatabaseUrl(value)).toThrow();
  });
  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts explicit loopback %s', (host) => {
    expect(
      checkedDatabaseUrl(`postgresql://postgres:secret@${host}:55439/atlas_scale_zero`)
    ).toContain('atlas_scale_zero');
  });
});

interface WorkerMessage {
  type: string;
  pid?: number;
  backendPid?: number;
  result?: ObservedRuntime;
  error?: string;
}

function worker(request: WorkerRequest) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/runtime-process.ts', import.meta.url)),
    [JSON.stringify(request)],
    {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, ATLAS_RUNTIME_TEST_SCHEMA: schema },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
  children.add(child);
  let output = '';
  const messages: WorkerMessage[] = [];
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.on('message', (message) => {
    messages.push(message as WorkerMessage);
  });
  const finished = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 30_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      children.delete(child);
      if (code !== 0)
        reject(
          new Error(
            `Runtime child failed (${code}/${signal}):\n${output}\n${JSON.stringify(messages)}`
          )
        );
      else resolve();
    });
  });
  // Attach immediately so an early worker failure cannot become an unhandled rejection.
  void finished.catch(() => {});
  return {
    pid: child.pid!,
    send(value: 'start' | 'release') {
      child.send(value);
    },
    async wait(type: string): Promise<WorkerMessage> {
      for (let attempts = 0; attempts < 1_000; attempts++) {
        const error = messages.find((message) => message.type === 'failure');
        if (error) throw new Error(`${error.error}\n${output}`);
        const message = messages.find((entry) => entry.type === type);
        if (message) return message;
        if (child.exitCode !== null || child.signalCode) {
          await finished;
          throw new Error(`Runtime child exited without ${type}: ${output}`);
        }
        await delay(10);
      }
      throw new Error(`Timed out waiting for child ${type}: ${output}`);
    },
    async result(): Promise<ObservedRuntime> {
      await finished;
      const message = messages.find((entry) => entry.type === 'result');
      if (!message?.result) throw new Error(`Missing runtime child result: ${output}`);
      expect(message.result.pid).not.toBe(process.pid);
      expect(Number(message.result.node.split('.')[0])).toBeGreaterThanOrEqual(24);
      expect(message.result.cold).toBe(true);
      return message.result;
    },
  };
}

async function inspect(ids: FixtureIds): Promise<ObservedRuntime> {
  const child = worker({ ...ids, mode: 'inspect' });
  await child.wait('ready');
  child.send('start');
  return child.result();
}

async function fixture(shared?: Pick<FixtureIds, 'userId' | 'characterId'>): Promise<FixtureIds> {
  const prefix = `runtime-it-${randomUUID()}`;
  const ids = {
    sessionId: `${prefix}-session`,
    userId: shared?.userId ?? `${prefix}-user`,
    characterId: shared?.characterId ?? `${prefix}-character`,
    mapId: `${prefix}-map`,
    tokenId: `${prefix}-token`,
  };
  sessions.add(ids.sessionId);
  const pool = connection.rawPool;
  if (!shared) {
    await pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [ids.userId, prefix]);
    await pool.query('INSERT INTO characters (id, user_id, name) VALUES ($1, $2, $3)', [
      ids.characterId,
      ids.userId,
      prefix,
    ]);
  }
  await pool.query(
    'INSERT INTO sessions (id, name, room_code, dm_user_id, current_map_id, player_map_id) VALUES ($1,$2,$3,$4,$5,$5)',
    [ids.sessionId, prefix, prefix, ids.userId, ids.mapId]
  );
  await pool.query(
    'INSERT INTO session_players (session_id, user_id, role, character_id) VALUES ($1,$2,$3,$4)',
    [ids.sessionId, ids.userId, 'dm', ids.characterId]
  );
  await pool.query(
    'INSERT INTO maps (id, session_id, name, grid_size, display_order) VALUES ($1,$2,$3,85,1)',
    [ids.mapId, ids.sessionId, prefix]
  );
  await pool.query(
    'INSERT INTO tokens (id, map_id, character_id, owner_user_id, name, x, y, faction, conditions) VALUES ($1,$2,$3,$4,$5,17,29,$6,$7)',
    [ids.tokenId, ids.mapId, ids.characterId, ids.userId, prefix, 'friendly', '["poisoned"]']
  );
  return ids;
}

function seedImportantState(ids: FixtureIds): void {
  const room = rooms.getRoom(ids.sessionId)!;
  room.combatState = {
    sessionId: ids.sessionId,
    active: true,
    roundNumber: 7,
    currentTurnIndex: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    combatants: [
      {
        tokenId: ids.tokenId,
        characterId: ids.characterId,
        name: 'Durable hero',
        initiative: 18,
        initiativeBonus: 3,
        hp: 9,
        maxHp: 30,
        tempHp: 2,
        armorClass: 15,
        speed: 30,
        isNPC: false,
        conditions: ['poisoned'],
        deathSaves: { successes: 1, failures: 2 },
        portraitUrl: null,
        deathSaveRolledRound: 7,
        exhaustionLevel: 2,
        hasAlert: true,
      },
    ],
  };
  room.actionEconomies.set(ids.tokenId, {
    action: true,
    bonusAction: true,
    reaction: true,
    movementRemaining: 0,
    movementMax: 30,
  });
  room.conditionMeta.set(
    ids.tokenId,
    new Map([
      [
        'poisoned',
        {
          name: 'poisoned',
          source: 'Durable spell',
          casterTokenId: ids.tokenId,
          appliedRound: 5,
          expiresAfterRound: 10,
          saveAtEndOfTurn: { ability: 'con', dc: 16, advantage: true },
          endsOnDamage: false,
          concentration: true,
        },
      ],
    ])
  );
  room.legendaryActions.set(ids.tokenId, { max: 3, remaining: 0 });
  room.legendaryResistance.set(ids.tokenId, { max: 3, remaining: 1 });
  room.rechargePools.set(ids.tokenId, new Map([['Breath', { min: 5, available: false }]]));
  room.lairActionTokens.add(ids.tokenId);
  room.polearmMasters.add(ids.tokenId);
  room.mobileMeleeTargets.set(ids.tokenId, new Set(['already-attacked']));
  room.tokenMeleeReach.set(ids.tokenId, 2);
  room.turnHooks.set(ids.tokenId, ['Remember poison']);
  room.roundHooks = ['Lair action on 20'];
  room.dmViewingMap.set(ids.userId, ids.mapId);
  room.music = { track: 'durability-ambience', fileIndex: 2, action: 'pause' };
  room.nextEventId = 41;
  room.eventLog = [
    { id: 40, kind: 'music:action', payload: { action: 'pause' }, ts: 12345 },
    {
      id: 41,
      kind: 'token:updated',
      payload: { id: ids.tokenId },
      ts: 12346,
      tokenId: ids.tokenId,
      mapId: ids.mapId,
    },
  ];
  room.pointPools.set(
    ids.characterId,
    new Map([
      ['ki', { max: 6, remaining: 0 }],
      ['sorcery', { max: 5, remaining: 2 }],
    ])
  );
  Object.assign(features.characterFeatures(ids.characterId), {
    xp: 1234,
    wildShape: { beastName: 'Bear', beastHp: 1, beastMax: 34, beastAc: 12, beastSpeed: 40 },
    arcaneWard: { current: 0, max: 14 },
    portentDice: [],
    luckPoints: 0,
    enduranceUsed: true,
    indomitableUsed: 2,
  });
  Object.assign(features.sessionFeatures(ids.sessionId), {
    underwater: true,
    mountLinks: { [ids.tokenId]: { mountTokenId: 'fixture-mount', controlled: true } },
    echoPositions: { [ids.characterId]: { x: 11.5, y: 22.25 } },
    unleashUsed: { [ids.characterId]: '7:0' },
    colossusUsed: { [ids.characterId]: '7:0' },
    grimHarvestUsed: { [ids.characterId]: '7:0' },
    divineFuryUsed: { [ids.characterId]: '7:0' },
  });
}

async function durableRows(ids: FixtureIds) {
  const { rows } = await connection.rawPool.query(
    `SELECT
    (SELECT to_jsonb(r) - 'updated_at' FROM session_runtime r WHERE session_id = $1) AS room,
    (SELECT state FROM session_feature_runtime WHERE session_id = $1) AS session,
    (SELECT state FROM character_feature_runtime WHERE character_id = $2) AS character,
    (SELECT to_jsonb(t) FROM tokens t WHERE id = $3) AS token,
    (SELECT to_jsonb(c) FROM characters c WHERE id = $2) AS character_row`,
    [ids.sessionId, ids.characterId, ids.tokenId]
  );
  return rows[0];
}

describe.skipIf(!database)('REAL PostgreSQL runtime durability', () => {
  beforeAll(async () => {
    expect(
      Number(process.versions.node.split('.')[0]),
      'Run this suite with Node 24+'
    ).toBeGreaterThanOrEqual(24);
    admin = new Pool({ connectionString: checkedDatabaseUrl(database), max: 2 });
    const { rows } = await admin.query('SELECT current_database() AS database');
    expect(rows[0].database).toContain('atlas_scale_zero');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    configureFixtureDatabase(database!, schema, `atlas-runtime-parent-${process.pid}`);
    connection = await import('../db/connection.js');
    ({ initDatabase } = await import('../db/schema.js'));
    ({ initRuntimeSchema } = await import('../db/runtimeSchema.js'));
    runtime = await import('../services/SessionRuntime.js');
    rooms = await import('../utils/roomState.js');
    snapshots = await import('../utils/roomSnapshot.js');
    features = await import('../utils/featureRuntime.js');
    transaction = await import('../db/transactionContext.js');
    expect(
      (await connection.rawPool.query('SELECT current_schema() AS schema')).rows[0].schema
    ).toBe(schema);
    await initDatabase();
    await initRuntimeSchema();
    runtime.configureSessionRuntime();
  }, 30_000);

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    for (const sessionId of sessions) rooms?.deleteRoom(sessionId);
    await connection?.rawPool.end();
    // The identifier is generated by this run, not derived from user input.
    if (schemaCreated) await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 30_000);

  it('initializes an empty real schema and reruns both initializers without losing saved data', async () => {
    const ids = await fixture();
    await runtime.withSessionRuntime(ids.sessionId, async () => {
      seedImportantState(ids);
    });
    const before = await durableRows(ids);
    const tables = (
      await connection.rawPool.query(
        'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
        [schema]
      )
    ).rows;
    await initDatabase();
    await initRuntimeSchema();
    await initDatabase();
    await initRuntimeSchema();
    expect(await durableRows(ids)).toEqual(before);
    expect(
      (
        await connection.rawPool.query(
          'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
          [schema]
        )
      ).rows
    ).toEqual(tables);
    expect(tables.map((row) => row.tablename)).toEqual(
      expect.arrayContaining([
        'sessions',
        'tokens',
        'session_runtime',
        'session_feature_runtime',
        'character_feature_runtime',
        'socket_io_attachments',
      ])
    );
  }, 30_000);

  it('restores all important state after deleteRoom in two genuinely fresh Node processes', async () => {
    const ids = await fixture();
    await runtime.withSessionRuntime(ids.sessionId, async () => {
      seedImportantState(ids);
    });
    const before = await durableRows(ids);
    const expectedSnapshot = snapshots.snapshotRoom(rooms.getRoom(ids.sessionId)!);
    const expectedToken = structuredClone(rooms.getRoom(ids.sessionId)!.tokens.get(ids.tokenId));
    rooms.addPlayerToRoom(ids.sessionId, {
      userId: ids.userId,
      socketId: `socket-${ids.sessionId}`,
      role: 'dm',
      displayName: 'DM',
      characterId: ids.characterId,
    });
    rooms.getRoom(ids.sessionId)!.readyCheck = {
      id: `ready-${randomUUID()}`,
      deadline: Date.now() + 60_000,
      playerIds: [ids.userId],
      tokenIds: [ids.tokenId],
      responses: new Map(),
      timeout: null,
    };
    rooms.deleteRoom(ids.sessionId);
    expect(rooms.getRoom(ids.sessionId)).toBeUndefined();
    const restored = await inspect(ids);
    expect(restored.snapshot).toEqual(expectedSnapshot);
    // An equality check using snapshotRoom on both sides alone could miss a
    // field accidentally removed from the persistence allowlist.
    expect(Object.keys(restored.snapshot.values)).toEqual(
      expect.arrayContaining([
        'combatState',
        'music',
        'roundHooks',
        'nextEventId',
        'eventLog',
        'generation',
        'actionEconomies',
        'dmViewingMap',
        'turnHooks',
        'tokenMeleeReach',
        'legendaryActions',
        'legendaryResistance',
        'conditionMeta',
        'rechargePools',
        'lairActionTokens',
        'polearmMasters',
        'mobileMeleeTargets',
        'readyCheck',
      ])
    );
    expect(restored.snapshot.values.actionEconomies).toEqual([
      [
        ids.tokenId,
        { action: true, bonusAction: true, reaction: true, movementRemaining: 0, movementMax: 30 },
      ],
    ]);
    expect(restored.snapshot.values.legendaryActions).toEqual([
      [ids.tokenId, { max: 3, remaining: 0 }],
    ]);
    expect(restored.snapshot.values.rechargePools).toEqual([
      [ids.tokenId, [['Breath', { min: 5, available: false }]]],
    ]);
    expect(restored.character).toEqual(before.character.namespaces);
    expect(restored.character).toMatchObject({
      xp: 1234,
      wildShape: { beastName: 'Bear', beastHp: 1, beastMax: 34, beastAc: 12, beastSpeed: 40 },
      arcaneWard: { current: 0, max: 14 },
      portentDice: [],
      luckPoints: 0,
      enduranceUsed: true,
      indomitableUsed: 2,
    });
    expect(restored.session).toEqual(before.session.namespaces);
    expect(restored.session).toEqual({
      underwater: true,
      mountLinks: { [ids.tokenId]: { mountTokenId: 'fixture-mount', controlled: true } },
      echoPositions: { [ids.characterId]: { x: 11.5, y: 22.25 } },
      unleashUsed: { [ids.characterId]: '7:0' },
      colossusUsed: { [ids.characterId]: '7:0' },
      grimHarvestUsed: { [ids.characterId]: '7:0' },
      divineFuryUsed: { [ids.characterId]: '7:0' },
    });
    expect(restored.pointPools).toEqual([
      [
        ids.characterId,
        [
          ['ki', { max: 6, remaining: 0 }],
          ['sorcery', { max: 5, remaining: 2 }],
        ],
      ],
    ]);
    expect(restored.tokens).toEqual([JSON.parse(JSON.stringify(expectedToken))]);
    expect(restored).toMatchObject({
      players: 0,
      sockets: 0,
      gameMode: 'combat',
      mapId: ids.mapId,
      gridSize: 85,
    });
    expect(restored.snapshot.values).not.toHaveProperty('players');
    expect(restored.snapshot.values.readyCheck).toBeNull();
    const again = await inspect(ids);
    expect(again.pid).not.toBe(restored.pid);
    expect(again.snapshot).toEqual(restored.snapshot);
    expect(again.character).toEqual(restored.character);
    expect(again.pointPools).toEqual(restored.pointPools);
    expect(rooms.getRoom(ids.sessionId)).toBeUndefined();
  }, 30_000);

  it.each(['same session', 'different sessions sharing a character'] as const)(
    'serializes fresh-process writers: %s',
    async (scenario) => {
      const first = await fixture();
      const second = scenario === 'same session' ? first : await fixture(first);
      await runtime.withSessionRuntime(first.sessionId, async () => {
        features.characterFeatures(first.characterId).xp = 100;
        rooms
          .getRoom(first.sessionId)!
          .pointPools.set(first.characterId, new Map([['ki', { max: 8, remaining: 8 }]]));
      });
      if (second !== first) await runtime.withSessionRuntime(second.sessionId, async () => {});
      const a = worker({ ...first, mode: 'increment', iterations: 4, hold: true });
      const b = worker({ ...second, mode: 'increment', iterations: 4 });
      await a.wait('ready');
      const bReady = await b.wait('ready');
      a.send('start');
      await a.wait('entered');
      b.send('start');
      try {
        let lock: { wait_event_type: string; wait_event: string } | undefined;
        for (let i = 0; i < 300; i++) {
          const { rows } = await connection.rawPool.query(
            'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1',
            [bReady.backendPid]
          );
          if (rows[0]?.wait_event_type === 'Lock') {
            lock = rows[0];
            break;
          }
          await delay(10);
        }
        expect(lock, 'second Node process must actually wait on a PostgreSQL lock').toBeDefined();
        if (scenario === 'same session') expect(lock!.wait_event).toBe('advisory');
      } finally {
        a.send('release');
      }
      const results = await Promise.all([a.result(), b.result()]);
      expect(results[0].pid).not.toBe(results[1].pid);
      const restored = await inspect(first);
      expect(restored.character.xp).toBe(108);
      expect(restored.character.pointPools?.ki).toEqual({ max: 8, remaining: 0 });
      expect(restored.pointPools).toEqual([
        [first.characterId, [['ki', { max: 8, remaining: 0 }]]],
      ]);
      const hooks = [...(restored.snapshot.values.roundHooks as string[])];
      if (scenario === 'same session') expect(restored.snapshot.values.nextEventId).toBe(8);
      else {
        const other = await inspect(second);
        expect(other.character).toEqual(restored.character);
        expect(other.pointPools).toEqual(restored.pointPools);
        expect(other.snapshot.values.nextEventId).toBe(4);
        expect(restored.snapshot.values.nextEventId).toBe(4);
        hooks.push(...(other.snapshot.values.roundHooks as string[]));
      }
      expect(hooks).toHaveLength(8);
      expect(new Set(hooks).size).toBe(8);
    },
    30_000
  );

  it('rolls back runtime, tokens and feature writes after a swallowed SQL error, without afterCommit success', async () => {
    const ids = await fixture();
    await runtime.withSessionRuntime(ids.sessionId, async () => {
      seedImportantState(ids);
    });
    const before = await durableRows(ids);
    const snapshot = snapshots.snapshotRoom(rooms.getRoom(ids.sessionId)!);
    const pools = structuredClone(rooms.getRoom(ids.sessionId)!.pointPools);
    const token = structuredClone(rooms.getRoom(ids.sessionId)!.tokens.get(ids.tokenId));
    let effects = 0;
    let callerSwallowed = false;
    let callbackReturned = false;
    await expect(
      runtime.withSessionRuntime(ids.sessionId, async () => {
        const room = rooms.getRoom(ids.sessionId)!;
        room.music.action = 'resume';
        room.actionEconomies.get(ids.tokenId)!.action = false;
        room.pointPools.get(ids.characterId)!.get('ki')!.remaining = 6;
        room.tokens.get(ids.tokenId)!.x = 999;
        features.characterFeatures(ids.characterId).xp = 9999;
        features.sessionFeatures(ids.sessionId).underwater = false;
        await connection.default.query('UPDATE tokens SET x = 999 WHERE id = $1', [ids.tokenId]);
        await connection.default.query('UPDATE characters SET hit_points = 1 WHERE id = $1', [
          ids.characterId,
        ]);
        transaction.afterCommit(() => {
          effects++;
        });
        // Recover PostgreSQL's savepoint so only the transaction failure tracker
        // can stop these otherwise valid later writes from committing.
        const nested = await connection.default.connect();
        try {
          await nested.query('BEGIN');
          try {
            await nested.query('SELECT 1 / 0');
          } catch {
            callerSwallowed = true;
            await nested.query('ROLLBACK');
          }
          await nested.query('COMMIT');
        } finally {
          nested.release();
        }
        await connection.default.query('SELECT 1');
        callbackReturned = true;
      })
    ).rejects.toThrow(/division by zero/);
    expect(callerSwallowed).toBe(true);
    expect(callbackReturned).toBe(true);
    expect(effects).toBe(0);
    expect(await durableRows(ids)).toEqual(before);
    expect(snapshots.snapshotRoom(rooms.getRoom(ids.sessionId)!)).toEqual(snapshot);
    expect(rooms.getRoom(ids.sessionId)!.tokens.get(ids.tokenId)).toEqual(token);
    expect.soft(rooms.getRoom(ids.sessionId)!.pointPools).toEqual(pools);
    rooms.deleteRoom(ids.sessionId);
    const restored = await inspect(ids);
    expect(restored.snapshot).toEqual(snapshot);
    expect(restored.character).toEqual(before.character.namespaces);
  }, 30_000);

  it('keeps token writes invisible until runtime commit and emits success only after durable commit', async () => {
    const ids = await fixture();
    await runtime.withSessionRuntime(ids.sessionId, async () => {});
    const before = await durableRows(ids);
    let effects = 0;
    let observedAfterCommit: ReturnType<typeof durableRows> | undefined;
    await runtime.withSessionRuntime(ids.sessionId, async () => {
      const room = rooms.getRoom(ids.sessionId)!;
      room.music = { track: 'committed', fileIndex: 1, action: 'resume' };
      const first = await connection.default.query('SELECT pg_current_xact_id()::text AS xid');
      const write = await connection.default.query(
        'UPDATE tokens SET x = 71, y = 83 WHERE id = $1 RETURNING pg_current_xact_id()::text AS xid',
        [ids.tokenId]
      );
      expect(write.rows[0].xid).toBe(first.rows[0].xid);
      room.tokens.get(ids.tokenId)!.x = 71;
      room.tokens.get(ids.tokenId)!.y = 83;
      // Legacy fire-and-forget writes must still be awaited by the transaction.
      void connection.default.query('UPDATE characters SET hit_points = 7 WHERE id = $1', [
        ids.characterId,
      ]);
      transaction.afterCommit(() => {
        effects++;
        observedAfterCommit = durableRows(ids);
      });
      expect(await durableRows(ids)).toEqual(before);
      expect(effects).toBe(0);
    });
    expect(effects).toBe(1);
    const committed = await observedAfterCommit;
    expect(committed.token).toMatchObject({ x: 71, y: 83, version: before.token.version + 1 });
    expect(committed.character_row.hit_points).toBe(7);
    expect(committed.room.state.values.music.track).toBe('committed');
    rooms.deleteRoom(ids.sessionId);
    const restored = await inspect(ids);
    expect(restored.tokens[0]).toMatchObject({ x: 71, y: 83, version: before.token.version + 1 });
    expect(restored.snapshot.values.music).toEqual({
      track: 'committed',
      fileIndex: 1,
      action: 'resume',
    });
  }, 30_000);

  it('commits an in-flight action before last-socket disconnect and denies later queued gameplay', async () => {
    const ids = await fixture();
    await runtime.withSessionRuntime(ids.sessionId, async () => {});
    const handlers = new Map<string, (data: unknown) => Promise<void>>();
    const emitted: string[] = [];
    const socket = {
      id: `runtime-socket-${randomUUID()}`,
      data: { userId: ids.userId },
      on(event: string, handler: (data: unknown) => Promise<void>) {
        handlers.set(event, handler);
      },
      emit(event: string) {
        emitted.push(event);
      },
      to() {
        return {
          emit(event: string) {
            emitted.push(event);
          },
        };
      },
      leave() {},
    } as unknown as Socket;
    const { configureSocketExecutor } = await import('../utils/socketHelpers.js');
    const { registerSessionEvents } = await import('../socket/sessionEvents.js');
    configureSocketExecutor(runtime.runSocketOperation);
    registerSessionEvents({} as Server, socket);
    rooms.addPlayerToRoom(ids.sessionId, {
      userId: ids.userId,
      socketId: socket.id,
      displayName: 'Last DM',
      role: 'dm',
      characterId: ids.characterId,
    });
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    let queuedMutated = false;
    const readyCheck = {
      id: `ready-${randomUUID()}`,
      deadline: Date.now() + 60_000,
      playerIds: [ids.userId],
      tokenIds: [ids.tokenId],
      responses: new Map([[ids.userId, false]]),
      timeout: null,
    };
    const action = runtime.runSocketOperation(socket, undefined, async () => {
      order.push('action');
      entered.resolve();
      await release.promise;
      rooms.getRoom(ids.sessionId)!.roundHooks.push('before disconnect');
      rooms.getRoom(ids.sessionId)!.readyCheck = readyCheck;
      features.characterFeatures(ids.characterId).xp = 73;
      await connection.default.query('UPDATE tokens SET x = 42 WHERE id = $1', [ids.tokenId]);
    });
    await entered.promise;
    const disconnect = handlers.get('disconnect')!('transport close').then(() => {
      order.push('disconnect');
    });
    // The queued handler resolves membership only after disconnect. Match the
    // gameplay handlers' authorization guard, never revive an expired socket.
    const queued = runtime.runSocketOperation(socket, undefined, async () => {
      order.push('queued');
      const ctx = rooms.getPlayerBySocketId(socket.id);
      expect(ctx).toBeUndefined();
      if (!ctx) return;
      queuedMutated = true;
      ctx.room.roundHooks.push('unauthorized after disconnect');
      features.characterFeatures(ids.characterId).xp = 999;
      await connection.default.query('UPDATE tokens SET x = 999 WHERE id = $1', [ids.tokenId]);
    });
    expect(order).toEqual(['action']);
    release.resolve();
    await Promise.all([action, disconnect, queued]);
    expect(order).toEqual(['action', 'disconnect', 'queued']);
    expect(queuedMutated).toBe(false);
    expect(emitted).toContain('session:player-left');
    expect(emitted).not.toContain('session:error');
    expect(rooms.getPlayerBySocketId(socket.id)).toBeUndefined();
    expect(rooms.getRoom(ids.sessionId)).toBeUndefined();
    expect((await durableRows(ids)).room.state.values.readyCheck).toBeNull();
    const restored = await inspect(ids);
    expect(restored.snapshot.values.roundHooks).toEqual(['before disconnect']);
    expect(restored.snapshot.values.readyCheck).toBeNull();
    expect(restored.character.xp).toBe(73);
    expect(restored.tokens[0].x).toBe(42);
    expect(restored.players).toBe(0);
    expect(restored.sockets).toBe(0);
  }, 30_000);

  it('rejects old-generation, ahead and expired cursors through the real HTTP replay route after cold hydration', async () => {
    const ids = await fixture();
    await runtime.withSessionRuntime(ids.sessionId, async () => {
      seedImportantState(ids);
    });
    const oldGeneration = rooms.getRoom(ids.sessionId)!.generation;
    // Model a replacement generation without resetting the durable cursor.
    await runtime.withSessionRuntime(ids.sessionId, async () => {
      rooms.getRoom(ids.sessionId)!.generation = randomUUID();
    });
    const generation = rooms.getRoom(ids.sessionId)!.generation;
    rooms.deleteRoom(ids.sessionId);
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: ids.userId };
      next();
    });
    app.use('/sessions', (await import('../routes/sessions.js')).default);
    const path = `/sessions/${ids.sessionId}/events`;
    const stale = await supertest(app).get(path).query({ generation: oldGeneration, since: 40 });
    expect(stale.status).toBe(410);
    expect(stale.body).toMatchObject({ fullResync: true, generation, latestEventId: 41 });
    const ahead = await supertest(app).get(path).query({ generation, since: 999 });
    expect(ahead.status).toBe(410);
    const expired = await supertest(app).get(path).query({ generation, since: 1 });
    expect(expired.status).toBe(410);
    const valid = await supertest(app).get(path).query({ generation, since: 40 });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ generation, latestEventId: 41 });
    expect(valid.body.events.map((event: { id: number }) => event.id)).toEqual([41]);
    const caughtUp = await supertest(app).get(path).query({ generation, since: 41 });
    expect(caughtUp.status).toBe(200);
    expect(caughtUp.body.events).toEqual([]);
    expect((await inspect(ids)).snapshot.values.generation).toBe(generation);
  }, 30_000);
});
