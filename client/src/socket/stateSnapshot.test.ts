import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Token } from '@dnd-vtt/shared';
import { pullStateSnapshot } from './stateSnapshot';
import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';

/**
 * Regression: the 15s /state reconciler must NOT wipe real local state when
 * the server returns its "no room on this instance" fallback (empty snapshot,
 * nextEventId 0) — which happens on a Cloud Run session-affinity miss or an
 * instance that just restarted. nextEventId is monotonic, so a session that
 * ever had activity reports > 0; only the fallback (or a pristine room) is 0.
 */

function tok(id: string): Token {
  return {
    id, mapId: 'map-1', characterId: null, name: id,
    x: 1, y: 1, size: 1, imageUrl: null, color: '#000',
    layer: 'token', visible: true, hasLight: false,
    lightRadius: 0, lightDimRadius: 0, lightColor: '#fff',
    conditions: [], ownerUserId: null, createdAt: new Date(0).toISOString(),
  } as Token;
}

function mockState(body: unknown, etag?: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200,
    ok: true,
    headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? (etag ?? null) : null) },
    json: async () => body,
  })));
}

describe('pullStateSnapshot — no-room fallback guard', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessionId: 's1' } as never);
    useMapStore.setState({ tokens: {}, currentMap: { id: 'map-1' } } as never);
    useCombatStore.setState({ active: false } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does NOT wipe local tokens on an empty no-room snapshot (nextEventId 0)', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    mockState({ tokens: [], combat: null, characters: {}, nextEventId: 0, roundNumber: 0 });
    const res = await pullStateSnapshot();
    expect(res.applied).toBe(false);
    expect(Object.keys(useMapStore.getState().tokens)).toEqual(['t1']);
  });

  it('still reconciles a genuinely-empty AUTHORITATIVE snapshot (nextEventId > 0)', async () => {
    useMapStore.setState({ tokens: { t1: tok('t1') }, currentMap: { id: 'map-1' } } as never);
    mockState({ tokens: [], combat: null, characters: {}, nextEventId: 7, roundNumber: 0 }, 'W/"v1"');
    const res = await pullStateSnapshot();
    expect(res.applied).toBe(true);
    expect(Object.keys(useMapStore.getState().tokens)).toEqual([]);
  });
});
