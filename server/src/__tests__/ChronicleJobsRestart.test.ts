import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query } }));
import {
  claimChronicleJob,
  finishChronicleJob,
  recoverInterruptedChronicles,
  requeueExternalChronicle,
  VERTEX_LEASE_MS,
  EXTERNAL_LEASE_MS,
} from '../services/ChronicleJobs.js';
import { migrateChronicleJobs } from '../db/chronicleJobs.js';

const output = {
  recapShort: 'short',
  recapFull: 'full',
  keyEntities: ['PC'],
  whereLeftOff: 'Continue.',
};
beforeEach(() => {
  query.mockReset();
});

describe('durable Chronicle attempts', () => {
  it('claims pending, failed retries and expired generating rows atomically with fresh tokens', async () => {
    query.mockResolvedValue({ rows: [{ id: 'entry' }] });
    await claimChronicleJob('vertex', 'entry');
    await claimChronicleJob('vertex', 'entry');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("status = 'failed' AND $2::text IS NOT NULL");
    expect(sql).toContain('generation_lease_until <= clock_timestamp()');
    expect(sql).toContain('generation_backend = $1');
    expect(params).toEqual(['vertex', 'entry', expect.any(String), VERTEX_LEASE_MS]);
    expect(params[2]).not.toEqual(query.mock.calls[1][1][2]);
  });

  it('external polling uses a longer lease and never claims another backend', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await claimChronicleJob('external')).toBeNull();
    expect(query.mock.calls[0][1]).toEqual([
      'external',
      null,
      expect.any(String),
      EXTERNAL_LEASE_MS,
    ]);
  });

  it('fences writes on backend, live lease, generating state and attempt', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect(await finishChronicleJob('entry', 'attempt', 'vertex', output, 'model')).toBe('draft');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('generation_attempt_id = $2 AND generation_backend = $3');
    expect(sql).toContain("status = 'generating' AND generation_lease_until > clock_timestamp()");
    expect(params.slice(0, 4)).toEqual(['entry', 'attempt', 'vertex', 'draft']);
    expect(params[10]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects stale completions even if the same entry was reclaimed', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [] });
    expect(await finishChronicleJob('entry', 'old', 'external', output)).toBeNull();
    expect(query.mock.calls[1][1].slice(0, 3)).toEqual(['entry', 'old', 'external']);
  });

  it('acknowledges an identical committed result without overwriting later edits or publication', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [{}] });
    expect(await finishChronicleJob('entry', 'attempt', 'external', output)).toBe('draft');
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('generation_result_digest = $4');
    expect(sql).toContain("status = 'published' AND $5 = 'draft'");
    expect(params[3]).toBe(query.mock.calls[0][1][10]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('recovers only expired Vertex work and clears the previous receipt and attempt', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await recoverInterruptedChronicles('campaign');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("generation_backend = 'vertex'");
    expect(sql).toContain('generation_attempt_id = NULL');
    expect(sql).toContain('generation_result_digest = NULL');
    expect(sql).toContain('updated_at::timestamptz <=');
    expect(params).toEqual(['campaign', VERTEX_LEASE_MS]);
  });

  it('does not reset a live external lease on retry', async () => {
    query.mockResolvedValue({ rowCount: 0 });
    expect(await requeueExternalChronicle('entry')).toBe(false);
    expect(query.mock.calls[0][0]).toContain('generation_lease_until <= clock_timestamp()');
  });

  it('propagates failed completion persistence instead of acknowledging success', async () => {
    query.mockRejectedValue(new Error('database unavailable'));
    await expect(finishChronicleJob('entry', 'attempt', 'vertex', output)).rejects.toThrow(
      'database unavailable'
    );
  });

  it('uses idempotent DDL and only initializes backend for legacy rows', async () => {
    query.mockResolvedValue({ rows: [] });
    await migrateChronicleJobs();
    expect(query.mock.calls[0][0]).toContain('ADD COLUMN IF NOT EXISTS generation_attempt_id');
    expect(query.mock.calls[0][0]).toContain('generation_lease_until TIMESTAMPTZ');
    expect(query.mock.calls[1][0]).toContain('WHERE generation_backend IS NULL');
  });
});
