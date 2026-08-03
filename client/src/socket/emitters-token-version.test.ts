/**
 * Token version = POSITION optimistic lock (audit #3, client half).
 *
 * A property update (conditions, aura, light) must NOT bump the local
 * token version — the DB trigger only advances it on x/y changes, so
 * bumping locally would make the next drag send a version the server
 * never reached and rubber-band the token. emitTokenUpdate still sends
 * the version it last saw as expectedVersion; the authoritative version
 * arrives on the map:token-updated echo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockSocket, mockTriggerSnapshot } = vi.hoisted(() => ({
  mockSocket: { connected: true, emit: vi.fn() },
  mockTriggerSnapshot: vi.fn(),
}));
vi.mock('./client', () => ({ getSocket: () => mockSocket }));
vi.mock('./stateSnapshot', () => ({ triggerSnapshot: mockTriggerSnapshot }));
vi.mock('../components/ui/Toast', () => ({ showToast: vi.fn() }));

import { emitTokenUpdate } from './emitters';
import { useMapStore } from '../stores/useMapStore';

const tok = (over: Partial<Token> = {}): Token =>
  ({
    id: 'tk',
    version: 5,
    mapId: 'm1',
    characterId: null,
    name: 'Goblin',
    x: 70,
    y: 70,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    conditions: [],
    ownerUserId: null,
    createdAt: new Date(0).toISOString(),
    ...over,
  }) as Token;

beforeEach(() => {
  mockSocket.emit.mockReset();
  useMapStore.setState({ tokens: { tk: tok() } });
});

describe('emitTokenUpdate — token version is a position lock (audit #3)', () => {
  it('applies the change but does NOT bump the local version', () => {
    emitTokenUpdate('tk', { conditions: ['poisoned'] as never });
    const t = useMapStore.getState().tokens['tk'];
    expect(t.conditions).toEqual(['poisoned']);
    expect(t.version).toBe(5); // unchanged — a condition change is not a move
  });

  it('sends the last-seen version as expectedVersion', () => {
    emitTokenUpdate('tk', { conditions: ['stunned'] as never });
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'map:token-update',
      expect.objectContaining({ tokenId: 'tk', expectedVersion: 5 })
    );
  });

  it('leaves the version untouched even across several property updates', () => {
    emitTokenUpdate('tk', { name: 'Goblin Boss' });
    emitTokenUpdate('tk', { hasLight: true });
    emitTokenUpdate('tk', { color: '#ff0000' });
    expect(useMapStore.getState().tokens['tk'].version).toBe(5);
  });
});
