import { describe, it, expect, beforeEach } from 'vitest';
import { useMapStore } from './useMapStore';

// Pin the multi-select semantics so the shift-click contract doesn't
// regress silently — a bad `additive` branch could either wipe the
// user's group mid-build or fail to remove a deselected token.

beforeEach(() => {
  useMapStore.setState({ selectedTokenId: null, selectedTokenIds: [] });
});

describe('useMapStore.selectToken', () => {
  it('single-select replaces the selection', () => {
    useMapStore.getState().selectToken('a');
    expect(useMapStore.getState().selectedTokenId).toBe('a');
    expect(useMapStore.getState().selectedTokenIds).toEqual(['a']);

    useMapStore.getState().selectToken('b');
    expect(useMapStore.getState().selectedTokenId).toBe('b');
    expect(useMapStore.getState().selectedTokenIds).toEqual(['b']);
  });

  it('passing null clears the selection', () => {
    useMapStore.getState().selectToken('a');
    useMapStore.getState().selectToken(null);
    expect(useMapStore.getState().selectedTokenId).toBeNull();
    expect(useMapStore.getState().selectedTokenIds).toEqual([]);
  });

  it('additive on an empty selection starts a group of one', () => {
    useMapStore.getState().selectToken('a', true);
    expect(useMapStore.getState().selectedTokenIds).toEqual(['a']);
    expect(useMapStore.getState().selectedTokenId).toBe('a');
  });

  it('additive adds to the group and keeps primary pinned', () => {
    useMapStore.getState().selectToken('a');
    useMapStore.getState().selectToken('b', true);
    useMapStore.getState().selectToken('c', true);
    expect(useMapStore.getState().selectedTokenIds).toEqual(['a', 'b', 'c']);
    // primary stays on the first-selected token so TokenActionPanel
    // doesn't thrash.
    expect(useMapStore.getState().selectedTokenId).toBe('a');
  });

  it('additive re-click removes the token (XOR)', () => {
    useMapStore.getState().selectToken('a');
    useMapStore.getState().selectToken('b', true);
    useMapStore.getState().selectToken('b', true);
    expect(useMapStore.getState().selectedTokenIds).toEqual(['a']);
    expect(useMapStore.getState().selectedTokenId).toBe('a');
  });

  it('removing the primary via XOR picks a new primary', () => {
    useMapStore.getState().selectToken('a');
    useMapStore.getState().selectToken('b', true);
    useMapStore.getState().selectToken('c', true);
    useMapStore.getState().selectToken('a', true); // XOR-remove primary
    expect(useMapStore.getState().selectedTokenIds).toEqual(['b', 'c']);
    // First remaining becomes primary.
    expect(useMapStore.getState().selectedTokenId).toBe('b');
  });

  it('clearing back to empty via XOR leaves primary null', () => {
    useMapStore.getState().selectToken('a', true);
    useMapStore.getState().selectToken('a', true);
    expect(useMapStore.getState().selectedTokenIds).toEqual([]);
    expect(useMapStore.getState().selectedTokenId).toBeNull();
  });
});
