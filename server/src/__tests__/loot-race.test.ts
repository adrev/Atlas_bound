/* eslint-disable @typescript-eslint/no-explicit-any */
// Tests interact with Express routers and mock response objects, both
// of which use `any` extensively in their own typings. Scoping the
// loosening to this file keeps production code strict.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock the database connection. The loot route uses pool.query AND
// pool.connect() → client.query — we need to provide a fake client
// whose query calls are recorded in a single list so we can assert
// on the full sequence.
const { clientQuery, connect, poolQuery } = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const connect = vi.fn(async () => ({
    query: clientQuery,
    release: vi.fn(),
  }));
  const poolQuery = vi.fn();
  return { clientQuery, connect, poolQuery };
});

vi.mock('../db/connection.js', () => ({
  default: { query: poolQuery, connect },
}));

vi.mock('../utils/authorization.js', () => ({
  getAuthUserId: () => 'user-1',
  assertCharacterOwnerOrDM: vi.fn(async () => undefined),
}));

vi.mock('../socket/ioInstance.js', () => ({ getIO: () => null }));
vi.mock('../utils/roomState.js', () => ({ getRoom: () => null, socketsOnMap: () => [] }));

let lootRouter: any;
beforeEach(async () => {
  clientQuery.mockReset();
  connect.mockClear();
  poolQuery.mockReset();
  vi.resetModules();
  const mod = await import('../routes/loot.js');
  lootRouter = mod.default;
});

function findTakeHandler(router: any) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === '/characters/:id/loot/take',
  );
  return layer.route.stack[0].handle;
}

function findTransferHandler(router: any) {
  const layer = router.stack.find((l: any) => l.route?.path === '/loot/transfer');
  return layer.route.stack[0].handle;
}

function makeRes() {
  const res: Partial<Response> & { statusCode: number; body: any } = {
    statusCode: 200,
    body: undefined,
  };
  res.status = vi.fn((code: number) => {
    (res as any).statusCode = code;
    return res as Response;
  }) as any;
  res.json = vi.fn((payload: any) => {
    (res as any).body = payload;
    return res as Response;
  }) as any;
  return res as Response & { statusCode: number; body: any };
}

describe('POST /characters/:id/loot/take — race safety', () => {
  it('locks the loot_entries row with FOR UPDATE inside a transaction', async () => {
    // Authorization reads (source owner + session checks)
    poolQuery
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] }); // source owner == caller

    // Client queries inside the transaction
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'e1', character_id: 'src', quantity: 2, item_name: 'Sword', item_rarity: 'common', item_slug: null, custom_item_id: null }] }) // SELECT FOR UPDATE loot_entries
      .mockResolvedValueOnce({ rows: [{ id: 'tgt', inventory: '[]' }] }) // SELECT FOR UPDATE characters
      .mockResolvedValueOnce(undefined) // UPDATE loot_entries
      .mockResolvedValueOnce(undefined) // UPDATE characters
      .mockResolvedValueOnce(undefined); // COMMIT

    const handler = findTakeHandler(lootRouter);
    const req = {
      params: { id: 'src' },
      body: { entryId: 'e1', targetCharacterId: 'tgt' },
      user: { id: 'user-1' },
    } as unknown as Request;
    const res = makeRes();

    await handler(req, res, () => {});

    // Verify the transaction shape: BEGIN first, SELECT ... FOR UPDATE on
    // loot_entries next, final COMMIT, and client was acquired exactly once.
    expect(connect).toHaveBeenCalledTimes(1);
    const calls = clientQuery.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toMatch(/^BEGIN$/);
    expect(calls[1]).toMatch(/SELECT \* FROM loot_entries[\s\S]+FOR UPDATE/);
    expect(calls).toContain('COMMIT');
    // The decrement must be inside the same transaction (before COMMIT).
    const commitIdx = calls.indexOf('COMMIT');
    const decrementIdx = calls.findIndex((q) => /UPDATE loot_entries SET quantity = quantity - 1/.test(q));
    expect(decrementIdx).toBeGreaterThan(-1);
    expect(decrementIdx).toBeLessThan(commitIdx);
    expect(res.statusCode).toBe(200);
  });

  it('rolls back and 400s when the locked loot row has quantity 0', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] });
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'e1', character_id: 'src', quantity: 0, item_name: 'Sword' }] })
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const handler = findTakeHandler(lootRouter);
    const req = {
      params: { id: 'src' },
      body: { entryId: 'e1', targetCharacterId: 'tgt' },
      user: { id: 'user-1' },
    } as unknown as Request;
    const res = makeRes();

    await handler(req, res, () => {});

    expect(res.statusCode).toBe(400);
    const calls = clientQuery.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });
});

describe('POST /loot/transfer — race safety', () => {
  it('locks the loot_entries row with FOR UPDATE inside a transaction', async () => {
    // Session membership checks (from/to sessions)
    poolQuery
      .mockResolvedValueOnce({ rows: [{ session_id: 's1' }] }) // fromSessions
      .mockResolvedValueOnce({ rows: [{ session_id: 's1' }] }); // toSessions

    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'e1', item_name: 'Sword' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'tgt', name: 'Target' }] }) // SELECT character
      .mockResolvedValueOnce(undefined) // UPDATE loot_entries
      .mockResolvedValueOnce(undefined); // COMMIT

    const handler = findTransferHandler(lootRouter);
    const req = {
      body: { fromCharacterId: 'src', toCharacterId: 'tgt', lootEntryId: 'e1' },
      user: { id: 'user-1' },
    } as unknown as Request;
    const res = makeRes();

    await handler(req, res, () => {});

    const calls = clientQuery.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/SELECT \* FROM loot_entries[\s\S]+FOR UPDATE/);
    expect(calls).toContain('COMMIT');
    expect(res.statusCode).toBe(200);
  });
});
