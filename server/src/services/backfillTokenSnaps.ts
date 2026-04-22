import pool from '../db/connection.js';
import { snapToGrid } from '@dnd-vtt/shared';

/**
 * One-shot startup backfill: snap every existing token's (x, y) to
 * the nearest cell CENTER on its parent map's grid.
 *
 * Context: `map:token-add` started snapping drops on 2026-04-19
 * (commit 5cfadc6-ish), but rows added before that live at whatever
 * raw pointer coordinates the drop site supplied — most visibly
 * landing on the cross-hair corner where four cells meet so the
 * character appears to straddle four tiles. Same math as the add
 * path, just run once over the legacy rows.
 *
 * Idempotency: guarded by a row in `schema_markers`. Once the
 * `token-snap-backfill-v1` key is present, subsequent boots are a
 * single SELECT and a no-op. Drop the marker row to re-run
 * (e.g. if a future change invalidates the earlier snap choice).
 *
 * Safe to run concurrently across instances — `INSERT ... ON CONFLICT
 * DO NOTHING` means the marker wins whichever pod finishes first; the
 * other pod's UPDATEs are idempotent (already-snapped coords are
 * the same value, so the UPDATE is a no-op).
 */

const MARKER_KEY = 'token-snap-backfill-v1';

export interface BackfillResult {
  /** total tokens scanned (rows joined with maps having a grid). */
  scanned: number;
  /** tokens whose (x, y) actually moved. */
  updated: number;
  /** true when the marker row already existed — did nothing. */
  skipped: boolean;
}

export async function backfillTokenSnaps(): Promise<BackfillResult> {
  // Marker table creation is harmless if some other migration added
  // it first. We use TIMESTAMPTZ default NOW() so the row doubles as
  // an audit trail of when each backfill landed on the deployment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_markers (
      marker_key TEXT PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: existing } = await pool.query(
    'SELECT 1 FROM schema_markers WHERE marker_key = $1',
    [MARKER_KEY],
  );
  if (existing.length > 0) {
    return { scanned: 0, updated: 0, skipped: true };
  }

  // Pull every token whose parent map has a grid. Maps without a grid
  // (grid_size = 0 / NULL) are handout / reference images — snapping
  // would be meaningless there.
  const { rows: tokens } = await pool.query<{
    id: string;
    x: number;
    y: number;
    grid_size: number;
  }>(`
    SELECT t.id, t.x, t.y, m.grid_size
    FROM tokens t
    JOIN maps m ON t.map_id = m.id
    WHERE m.grid_size IS NOT NULL AND m.grid_size > 0
  `);

  let updated = 0;
  // 0.5 px epsilon — fractional rounding in snapToGrid can return
  // 120.00000000001 for an input of 120, which isn't a real move.
  const EPSILON = 0.5;
  for (const row of tokens) {
    const snapped = snapToGrid(Number(row.x), Number(row.y), Number(row.grid_size));
    if (Math.abs(snapped.x - Number(row.x)) > EPSILON ||
        Math.abs(snapped.y - Number(row.y)) > EPSILON) {
      await pool.query('UPDATE tokens SET x = $1, y = $2 WHERE id = $3',
        [snapped.x, snapped.y, row.id]);
      updated += 1;
    }
  }

  await pool.query(
    `INSERT INTO schema_markers (marker_key) VALUES ($1)
     ON CONFLICT (marker_key) DO NOTHING`,
    [MARKER_KEY],
  );

  return { scanned: tokens.length, updated, skipped: false };
}
