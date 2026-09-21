import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

const state = vi.hoisted(() => {
  const connection = process.env.ATLAS_RUNTIME_TEST_DATABASE_URL;
  const schema = `chronicle_test_${process.pid}_${Date.now()}`;
  if (connection) {
    const url = new URL(connection);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/atlas_scale_zero'
    ) {
      throw new Error(
        'Chronicle integration tests require an explicit loopback atlas_scale_zero database'
      );
    }
    url.searchParams.set('options', `-c search_path=${schema}`);
    return { connection, scopedConnection: url.href, schema, pool: undefined as Pool | undefined };
  }
  return {
    connection: undefined,
    scopedConnection: undefined,
    schema,
    pool: undefined as Pool | undefined,
  };
});
vi.mock('../db/connection.js', async () => {
  if (!state.scopedConnection) return { default: {} };
  const { Pool } = await import('pg');
  state.pool = new Pool({ connectionString: state.scopedConnection });
  return { default: state.pool };
});
import {
  claimChronicleJob,
  finishChronicleJob,
  recoverInterruptedChronicles,
  requeueExternalChronicle,
} from '../services/ChronicleJobs.js';
import { migrateChronicleJobs } from '../db/chronicleJobs.js';

const output = {
  recapShort: 'short',
  recapFull: 'full',
  keyEntities: ['PC'],
  whereLeftOff: 'Continue.',
};
const exec = promisify(execFile);

describe.skipIf(!state.connection)('Chronicle restart safety on disposable PostgreSQL', () => {
  let admin: Pool;
  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: state.connection });
    await admin.query(`CREATE SCHEMA ${state.schema}`);
    await state.pool!.query(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE session_players (session_id TEXT, character_id TEXT);
      CREATE TABLE chronicle_entries (
        id TEXT PRIMARY KEY, campaign_id TEXT, sequence_number INTEGER,
        raw_transcript TEXT, status TEXT DEFAULT 'pending',
        session_started_at TEXT, session_ended_at TEXT,
        recap_short TEXT, recap_full TEXT, key_entities TEXT[], where_left_off TEXT,
        model_used TEXT, generation_started_at TEXT, generation_finished_at TEXT,
        generation_error TEXT, created_at TEXT DEFAULT clock_timestamp()::text,
        updated_at TEXT DEFAULT clock_timestamp()::text
      );
      INSERT INTO sessions VALUES ('campaign', 'Test campaign');
    `);
    await migrateChronicleJobs();
    await migrateChronicleJobs();
  });
  afterAll(async () => {
    await state.pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${state.schema} CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    await state.pool!.query('TRUNCATE chronicle_entries');
  });

  async function insert(id = 'entry', backend = 'vertex', status = 'pending') {
    await state.pool!.query(
      `INSERT INTO chronicle_entries (id, campaign_id, sequence_number, raw_transcript, generation_backend, status)
       VALUES ($1, 'campaign', 1, 'The party safely crossed the bridge.', $2, $3)`,
      [id, backend, status]
    );
  }

  it('concurrent claims produce exactly one live attempt and isolate the backend', async () => {
    await insert();
    expect(await claimChronicleJob('external')).toBeNull();
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimChronicleJob('vertex', 'entry'))
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimChronicleJob('vertex', 'entry')).toBeNull();
  });

  it('a new process recovers a dead claimant and rejects its late completion', async () => {
    await insert();
    const jobsUrl = new URL('../services/ChronicleJobs.ts', import.meta.url).href;
    const source = `const { claimChronicleJob } = await import(${JSON.stringify(jobsUrl)});
      const job = await claimChronicleJob('vertex', 'entry');
      console.log('CLAIM=' + JSON.stringify(job)); process.exit(0);`;
    const claimInFreshProcess = async () => {
      const { stdout } = await exec(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source],
        {
          cwd: process.cwd(),
          timeout: 10_000,
          env: { DATABASE_URL: state.scopedConnection!, CHRONICLER_BACKEND: 'vertex' },
        }
      );
      return JSON.parse(stdout.split('CLAIM=')[1].trim()) as { generation_attempt_id: string };
    };
    const first = await claimInFreshProcess();
    await state.pool!.query(
      "UPDATE chronicle_entries SET generation_lease_until = clock_timestamp() - INTERVAL '1 second'"
    );
    const second = await claimInFreshProcess();
    expect(first.generation_attempt_id).not.toBe(second.generation_attempt_id);
    expect(
      await finishChronicleJob('entry', first.generation_attempt_id, 'vertex', output)
    ).toBeNull();
    expect(await finishChronicleJob('entry', second.generation_attempt_id, 'vertex', output)).toBe(
      'draft'
    );
  });

  it('rejects expired completion before a successor even claims the entry', async () => {
    await insert();
    const job = await claimChronicleJob('vertex', 'entry');
    await state.pool!.query(
      "UPDATE chronicle_entries SET generation_lease_until = clock_timestamp() - INTERVAL '1 second'"
    );
    expect(
      await finishChronicleJob('entry', job!.generation_attempt_id, 'vertex', output)
    ).toBeNull();
  });

  it('acknowledges lost receipts without replacing edited/published output or accepting changed payloads', async () => {
    await insert('entry', 'external');
    const job = await claimChronicleJob('external');
    expect(await finishChronicleJob('entry', job!.generation_attempt_id, 'external', output)).toBe(
      'draft'
    );
    await state.pool!.query(
      "UPDATE chronicle_entries SET recap_short = 'DM edit', status = 'published'"
    );
    expect(await finishChronicleJob('entry', job!.generation_attempt_id, 'external', output)).toBe(
      'draft'
    );
    expect(
      await finishChronicleJob('entry', job!.generation_attempt_id, 'external', {
        ...output,
        recapShort: 'different',
      })
    ).toBeNull();
    const { rows } = await state.pool!.query('SELECT recap_short, status FROM chronicle_entries');
    expect(rows[0]).toEqual({ recap_short: 'DM edit', status: 'published' });
  });

  it('recovers stale pending and legacy generating rows without disturbing active work', async () => {
    await insert('stale');
    await insert('legacy', 'vertex', 'generating');
    await insert('active');
    await insert('fresh');
    await insert('external', 'external');
    const active = await claimChronicleJob('vertex', 'active');
    await state.pool!.query(
      "UPDATE chronicle_entries SET updated_at = (clock_timestamp() - INTERVAL '3 minutes')::text WHERE id = 'stale'"
    );
    await recoverInterruptedChronicles('campaign');
    const { rows } = await state.pool!.query(
      'SELECT id, status FROM chronicle_entries ORDER BY id'
    );
    expect(rows).toEqual([
      { id: 'active', status: 'generating' },
      { id: 'external', status: 'pending' },
      { id: 'fresh', status: 'pending' },
      { id: 'legacy', status: 'failed' },
      { id: 'stale', status: 'failed' },
    ]);
    expect(
      await finishChronicleJob('active', active!.generation_attempt_id, 'vertex', output)
    ).toBe('draft');
    expect(await claimChronicleJob('vertex', 'stale')).not.toBeNull();
  });

  it('reclaims expired external work while rejecting live retry and old error receipts', async () => {
    await insert('entry', 'external');
    const old = await claimChronicleJob('external');
    expect(await requeueExternalChronicle('entry')).toBe(false);
    await state.pool!.query(
      "UPDATE chronicle_entries SET generation_lease_until = clock_timestamp() - INTERVAL '1 second'"
    );
    const next = await claimChronicleJob('external');
    expect(next!.generation_attempt_id).not.toBe(old!.generation_attempt_id);
    expect(
      await finishChronicleJob('entry', old!.generation_attempt_id, 'external', {
        error: 'old failure',
      })
    ).toBeNull();
    expect(
      await finishChronicleJob('entry', next!.generation_attempt_id, 'external', {
        error: 'new failure',
      })
    ).toBe('failed');
    expect(
      await finishChronicleJob('entry', next!.generation_attempt_id, 'external', {
        error: 'new failure',
      })
    ).toBe('failed');
    expect(await requeueExternalChronicle('entry')).toBe(true);
    expect(
      await finishChronicleJob('entry', next!.generation_attempt_id, 'external', {
        error: 'new failure',
      })
    ).toBeNull();
  });

  it('directly retries a legacy generating row without any lease or attempt token', async () => {
    await insert('legacy', 'vertex', 'generating');
    const job = await claimChronicleJob('vertex', 'legacy');
    expect(job?.generation_attempt_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(job!.generation_lease_until.getTime()).toBeGreaterThan(Date.now());
    expect(await finishChronicleJob('legacy', job!.generation_attempt_id, 'vertex', output)).toBe(
      'draft'
    );
  });
});
