import { describe, expect, it } from 'vitest';
import { pickAutoActiveHero } from './heroSelection';

describe('pickAutoActiveHero', () => {
  const ownA = { id: 'own-a', userId: 'user-1' };
  const ownB = { id: 'own-b', userId: 'user-1' };

  it('keeps an already-active owned character that is still available', () => {
    expect(pickAutoActiveHero({
      current: ownA,
      candidates: [ownA, ownB],
      savedId: 'own-b',
      userId: 'user-1',
      isDM: false,
    })).toBeNull();
  });

  it('replaces a stale character from another user with the saved owned character', () => {
    expect(pickAutoActiveHero({
      current: { id: 'other', userId: 'user-2' },
      candidates: [ownA, ownB],
      savedId: 'own-b',
      userId: 'user-1',
      isDM: false,
    })).toEqual(ownB);
  });

  it('falls back to the first owned character when the saved id is missing', () => {
    expect(pickAutoActiveHero({
      current: null,
      candidates: [ownA, ownB],
      savedId: 'deleted',
      userId: 'user-1',
      isDM: false,
    })).toEqual(ownA);
  });

  it('does not overwrite a DM-selected party character', () => {
    expect(pickAutoActiveHero({
      current: { id: 'party-member', userId: 'user-2' },
      candidates: [ownA, ownB],
      savedId: 'own-b',
      userId: 'user-1',
      isDM: true,
    })).toBeNull();
  });
});
