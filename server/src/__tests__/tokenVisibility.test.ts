import { describe, it, expect } from 'vitest';
import type { Token } from '@dnd-vtt/shared';
import { tokenVisibleToPlayer } from '../utils/tokenVisibility.js';

function token(overrides: Partial<Token>): Token {
  return {
    id: 'tok-1',
    mapId: 'map-1',
    characterId: null,
    name: 'Token',
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#fff',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    conditions: [],
    ownerUserId: null,
    createdAt: 'now',
    ...overrides,
  };
}

describe('tokenVisibleToPlayer', () => {
  it('hides explicitly hidden tokens', () => {
    expect(tokenVisibleToPlayer(token({ visible: false }), 'player-1')).toBe(false);
  });

  it('hides invisible unoutlined tokens from other players', () => {
    expect(tokenVisibleToPlayer(
      token({ conditions: ['invisible'], ownerUserId: 'player-2' }),
      'player-1',
    )).toBe(false);
  });

  it('keeps invisible owned tokens visible to their owner', () => {
    expect(tokenVisibleToPlayer(
      token({ conditions: ['invisible'], ownerUserId: 'player-1' }),
      'player-1',
    )).toBe(true);
  });

  it('keeps outlined invisible tokens visible', () => {
    expect(tokenVisibleToPlayer(
      token({ conditions: ['invisible', 'outlined' as never], ownerUserId: 'player-2' }),
      'player-1',
    )).toBe(true);
  });
});
