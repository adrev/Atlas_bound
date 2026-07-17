import { describe, it, expect, beforeEach } from 'vitest';
import type { Token } from '@dnd-vtt/shared';
import { useMapStore } from './useMapStore';

const tok = (id: string, x = 0, y = 0): Token =>
  ({
    id,
    mapId: 'm1',
    characterId: null,
    name: id,
    x,
    y,
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
    createdAt: new Date().toISOString(),
  }) as Token;

beforeEach(() => {
  useMapStore.setState({ tokens: {} });
});

describe('useMapStore.moveToken (audit #5)', () => {
  it('updates the position of a known token', () => {
    useMapStore.setState({ tokens: { a: tok('a', 1, 1) } });
    useMapStore.getState().moveToken('a', 50, 75);
    const t = useMapStore.getState().tokens['a'];
    expect(t).toBeDefined();
    expect([t.x, t.y]).toEqual([50, 75]);
  });

  it('ignores a move for an unknown token — never inserts an undefined entry', () => {
    // The exact crash scenario: a map:token-moved for a token that arrives
    // before map:loaded populates the store.
    useMapStore.setState({ tokens: {} });
    useMapStore.getState().moveToken('ghost', 10, 20);

    const { tokens } = useMapStore.getState();
    expect(Object.prototype.hasOwnProperty.call(tokens, 'ghost')).toBe(false);
    // No undefined values leak into the map (would crash t.characterId).
    expect(Object.values(tokens).every((t) => t !== undefined)).toBe(true);
    expect(Object.keys(tokens)).toHaveLength(0);
  });

  it('leaves other tokens untouched when moving a known one', () => {
    useMapStore.setState({ tokens: { a: tok('a'), b: tok('b', 5, 5) } });
    useMapStore.getState().moveToken('a', 99, 99);
    const { tokens } = useMapStore.getState();
    expect([tokens['b'].x, tokens['b'].y]).toEqual([5, 5]);
    expect([tokens['a'].x, tokens['a'].y]).toEqual([99, 99]);
  });
});
