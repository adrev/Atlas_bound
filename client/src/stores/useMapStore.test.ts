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

// Regression: applyMapLoad rebuilt `currentMap` field-by-field and DROPPED
// ambientLight/ambientOpacity — every join / refresh / ribbon move rendered
// dark or dim maps fully bright (FogLayer treats undefined as 'bright')
// until the DM re-touched lighting. Found independently by two audits.
describe('useMapStore.applyMapLoad', () => {
  const baseMap = {
    id: 'm1',
    name: 'Cavern',
    imageUrl: null,
    width: 1400,
    height: 1400,
    gridSize: 70,
    gridType: 'square' as const,
    gridOffsetX: 0,
    gridOffsetY: 0,
    walls: [],
    fogState: [],
  };

  beforeEach(() => {
    useMapStore.setState({ currentMap: null, playerMapId: null, tokens: {} });
  });

  it('preserves ambient lighting through a ribbon map load', () => {
    useMapStore.getState().applyMapLoad({
      map: { ...baseMap, ambientLight: 'dark', ambientOpacity: 0.85 },
      tokens: [],
    });
    const m = useMapStore.getState().currentMap!;
    expect(m.ambientLight).toBe('dark');
    expect(m.ambientOpacity).toBe(0.85);
  });

  it('preserves ambient lighting through a DM preview load (ribbon untouched)', () => {
    useMapStore.setState({ playerMapId: 'ribbon-map' });
    useMapStore.getState().applyMapLoad({
      map: { ...baseMap, id: 'preview-map', ambientLight: 'dim' },
      tokens: [],
      isPreview: true,
    });
    expect(useMapStore.getState().currentMap!.ambientLight).toBe('dim');
    expect(useMapStore.getState().playerMapId).toBe('ribbon-map');
  });

  it('leaves legacy maps without ambient fields as undefined (renders bright)', () => {
    useMapStore.getState().applyMapLoad({ map: { ...baseMap }, tokens: [] });
    const m = useMapStore.getState().currentMap!;
    expect(m.ambientLight).toBeUndefined();
    expect(m.ambientOpacity).toBeUndefined();
  });
});
