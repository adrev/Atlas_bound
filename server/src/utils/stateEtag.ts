/**
 * Weak ETag for `GET /api/sessions/:id/state`.
 *
 * The snapshot is polled every few seconds by every client purely to
 * reconcile drift. When nothing has changed, re-sending the full body and
 * re-running the client's reconcile pass is pure waste — a 304 skips both.
 *
 * The key covers everything that varies the per-recipient body: the
 * session, the caller (each user sees a filtered view), their role, the
 * map they're viewing, and the room's monotonic event cursor (every
 * meaningful broadcast bumps it). `sessionId` is essential — without it a
 * user navigating between two sessions whose cursors happen to line up
 * could be served a 304 carrying the wrong session's state. A coarse time
 * bucket is mixed in as a safety net: a handful of
 * legacy emit sites broadcast without advancing the cursor, so without the
 * bucket an unwrapped change could serve a stale 304 indefinitely. With it,
 * the worst case is one bucket window (default 60 s) of staleness for that
 * narrow class of change — the same bound the snapshot already tolerates.
 *
 * Errs toward over-invalidating (correct but occasionally redundant) rather
 * than under-invalidating (a stale 304), which is the safe direction.
 */
export function stateSnapshotEtag(params: {
  sessionId: string;
  userId: string;
  isDM: boolean;
  viewingMapId: string | null;
  nextEventId: number;
  now: number;
  bucketMs?: number;
}): string {
  const bucket = Math.floor(params.now / (params.bucketMs ?? 60_000));
  const role = params.isDM ? 'dm' : 'pl';
  // Empty string is a safe "no map" sentinel — a real map id is never empty
  // (schema requires min length 1), so it can't collide with a named map.
  const map = params.viewingMapId ?? '';
  return `W/"v1-${params.sessionId}-${params.userId}-${role}-${map}-${params.nextEventId}-${bucket}"`;
}
