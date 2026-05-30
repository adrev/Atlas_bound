import { describe, it, expect } from 'vitest';
import { stateSnapshotEtag } from '../utils/stateEtag.js';

// The ETag is a cache key for GET /sessions/:id/state. Correctness rule:
// it MUST change whenever the per-recipient body could change (caller,
// role, viewing map, event cursor, or the time bucket), and stay stable
// when none of those move. Under-invalidating (a stale 304) is the only
// dangerous failure, so these tests pin "changes when it must".

// now is bucket-aligned (1_200_000 / 60_000 = 20 exactly) so "+59s" stays
// in the same window and "+61s" crosses into the next.
const base = {
  sessionId: 's1', userId: 'u1', isDM: false, viewingMapId: 'map-1' as string | null, nextEventId: 5, now: 1_200_000,
};

describe('stateSnapshotEtag', () => {
  it('is stable for identical inputs within the same time bucket', () => {
    expect(stateSnapshotEtag(base)).toBe(stateSnapshotEtag({ ...base, now: base.now + 59_000 }));
  });

  it('differs between sessions even when every other input collides', () => {
    // The leak CodeX caught: same user, role, map, cursor, bucket — but a
    // different session must not share an ETag (else cross-session nav 304s
    // to the wrong session's state).
    expect(stateSnapshotEtag(base)).not.toBe(stateSnapshotEtag({ ...base, sessionId: 's2' }));
  });

  it('changes when the event cursor advances', () => {
    expect(stateSnapshotEtag(base)).not.toBe(stateSnapshotEtag({ ...base, nextEventId: 6 }));
  });

  it('changes when the viewing map changes', () => {
    expect(stateSnapshotEtag(base)).not.toBe(stateSnapshotEtag({ ...base, viewingMapId: 'map-2' }));
  });

  it('differs between a player and a DM view (different filtered body)', () => {
    expect(stateSnapshotEtag(base)).not.toBe(stateSnapshotEtag({ ...base, isDM: true }));
  });

  it('differs per user (each sees a filtered view)', () => {
    expect(stateSnapshotEtag(base)).not.toBe(stateSnapshotEtag({ ...base, userId: 'u2' }));
  });

  it('rolls over when the time bucket flips (bounds unwrapped-broadcast staleness)', () => {
    expect(stateSnapshotEtag(base)).not.toBe(stateSnapshotEtag({ ...base, now: base.now + 61_000 }));
  });

  it('treats a null viewing map distinctly from a named map', () => {
    expect(stateSnapshotEtag({ ...base, viewingMapId: null }))
      .not.toBe(stateSnapshotEtag({ ...base, viewingMapId: 'map-1' }));
  });

  it('emits a weak validator (W/) so proxies do not byte-compare', () => {
    expect(stateSnapshotEtag(base)).toMatch(/^W\//);
  });
});
