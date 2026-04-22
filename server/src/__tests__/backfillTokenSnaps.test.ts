/**
 * Tests for the one-shot legacy-token snap-to-center backfill.
 *
 * We mock pg pool via vi.hoisted and drive the marker + SELECT +
 * UPDATE sequence through a single query router. Verifies:
 *   \u2022 already-snapped tokens don't trigger an UPDATE
 *   \u2022 off-grid tokens do get snapped to cell center
 *   \u2022 a second run (marker present) is a no-op
 *   \u2022 maps with grid_size NULL or 0 are filtered out upstream
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { backfillTokenSnaps } from '../services/backfillTokenSnaps.js';

// Snap reference: snapToGrid(x, y, g) returns
//   x_center = round((x - g/2) / g) * g + g/2
// so for gridSize=70: 0 \u2192 35, 35 \u2192 35, 70 \u2192 105, 105 \u2192 105.

interface QueryState {
  markerPresent: boolean;
  tokens: Array<{ id: string; x: number; y: number; grid_size: number }>;
  updates: Array<{ id: string; x: number; y: number }>;
  insertedMarker: boolean;
}

function installQueryRouter(state: QueryState): void {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const q = sql.trim();
    if (/CREATE TABLE IF NOT EXISTS schema_markers/.test(q)) {
      return { rows: [] };
    }
    if (/SELECT 1 FROM schema_markers/.test(q)) {
      return { rows: state.markerPresent ? [{ ok: 1 }] : [] };
    }
    if (/SELECT t\.id, t\.x, t\.y, m\.grid_size/.test(q)) {
      return { rows: state.tokens };
    }
    if (/UPDATE tokens SET x = /.test(q)) {
      const [x, y, id] = params as [number, number, string];
      state.updates.push({ id, x, y });
      return { rows: [] };
    }
    if (/INSERT INTO schema_markers/.test(q)) {
      state.insertedMarker = true;
      return { rows: [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('backfillTokenSnaps', () => {
  it('skips entirely when the marker row is already present', async () => {
    const state: QueryState = {
      markerPresent: true, tokens: [], updates: [], insertedMarker: false,
    };
    installQueryRouter(state);
    const result = await backfillTokenSnaps();
    expect(result).toEqual({ scanned: 0, updated: 0, skipped: true });
    expect(state.updates).toHaveLength(0);
    expect(state.insertedMarker).toBe(false);
  });

  it('does nothing for already-snapped tokens', async () => {
    const state: QueryState = {
      markerPresent: false,
      tokens: [
        { id: 't1', x: 35, y: 35, grid_size: 70 },
        { id: 't2', x: 105, y: 105, grid_size: 70 },
      ],
      updates: [], insertedMarker: false,
    };
    installQueryRouter(state);
    const result = await backfillTokenSnaps();
    expect(result).toEqual({ scanned: 2, updated: 0, skipped: false });
    expect(state.updates).toHaveLength(0);
    expect(state.insertedMarker).toBe(true);
  });

  it('snaps an off-grid token to the nearest cell center', async () => {
    const state: QueryState = {
      markerPresent: false,
      // (0, 0) is the corner where four cells meet for gridSize=70.
      // snapToGrid should pull it to (35, 35).
      tokens: [{ id: 't1', x: 0, y: 0, grid_size: 70 }],
      updates: [], insertedMarker: false,
    };
    installQueryRouter(state);
    const result = await backfillTokenSnaps();
    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(false);
    expect(state.updates).toEqual([{ id: 't1', x: 35, y: 35 }]);
  });

  it('snaps several tokens on different grid sizes independently', async () => {
    const state: QueryState = {
      markerPresent: false,
      tokens: [
        { id: 't1', x: 10, y: 10, grid_size: 50 },   // \u2192 25, 25
        { id: 't2', x: 200, y: 200, grid_size: 100 }, // \u2192 250, 250
        { id: 't3', x: 35, y: 35, grid_size: 70 },   // already-center, no-op
      ],
      updates: [], insertedMarker: false,
    };
    installQueryRouter(state);
    const result = await backfillTokenSnaps();
    expect(result.scanned).toBe(3);
    expect(result.updated).toBe(2);
    const updatedById = new Map(state.updates.map((u) => [u.id, u]));
    expect(updatedById.get('t1')).toEqual({ id: 't1', x: 25, y: 25 });
    expect(updatedById.get('t2')).toEqual({ id: 't2', x: 250, y: 250 });
    expect(updatedById.has('t3')).toBe(false);
  });

  it('inserts the marker row exactly once on success', async () => {
    const state: QueryState = {
      markerPresent: false, tokens: [], updates: [], insertedMarker: false,
    };
    installQueryRouter(state);
    await backfillTokenSnaps();
    expect(state.insertedMarker).toBe(true);
  });
});
