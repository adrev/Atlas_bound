import { describe, expect, it } from 'vitest';
import type { FogPolygon } from '@dnd-vtt/shared';
import {
  splitManualFogRegions,
  orderedRenderableFogRegions,
  isRenderableFogRegion,
  MIN_FOG_POLYGON_NUMBERS,
} from './fogRegions';

const tri = (mode?: 'reveal' | 'hide'): FogPolygon => ({
  points: [0, 0, 10, 0, 10, 10], // 3 vertices
  ...(mode ? { mode } : {}),
});
const degenerateClick: FogPolygon = { points: [5, 5], mode: 'reveal' }; // 1 vertex
const degenerateLine: FogPolygon = { points: [5, 5, 6, 6], mode: 'reveal' }; // 2 vertices

describe('splitManualFogRegions', () => {
  it('treats legacy fog polygons as reveal regions', () => {
    const result = splitManualFogRegions([
      { points: [0, 0, 70, 0, 70, 70] },
      { points: [10, 10, 80, 10, 80, 80], mode: 'hide' },
      { points: [20, 20, 90, 20, 90, 90], mode: 'reveal' },
    ]);

    expect(result.revealRegions).toEqual([
      { points: [0, 0, 70, 0, 70, 70] },
      { points: [20, 20, 90, 20, 90, 90], mode: 'reveal' },
    ]);
    expect(result.hideRegions).toEqual([{ points: [10, 10, 80, 10, 80, 80], mode: 'hide' }]);
  });
});

describe('isRenderableFogRegion', () => {
  it('requires at least 3 vertices (6 flat numbers)', () => {
    expect(MIN_FOG_POLYGON_NUMBERS).toBe(6);
    expect(isRenderableFogRegion(tri())).toBe(true);
    expect(isRenderableFogRegion(degenerateClick)).toBe(false);
    expect(isRenderableFogRegion(degenerateLine)).toBe(false);
  });
});

describe('orderedRenderableFogRegions', () => {
  it('drops degenerate regions so a stray click cannot force base fog (audit #1)', () => {
    const kept = orderedRenderableFogRegions([degenerateClick]);
    expect(kept).toHaveLength(0);
    expect(kept.some((r) => r.mode !== 'hide')).toBe(false);
  });

  it('preserves paint order so a reveal after a hide wins (audit #2)', () => {
    const hide: FogPolygon = { points: [0, 0, 20, 0, 20, 20], mode: 'hide' };
    const reveal: FogPolygon = { points: [0, 0, 20, 0, 20, 20], mode: 'reveal' };
    const ordered = orderedRenderableFogRegions([hide, reveal]);
    expect(ordered.map((r) => r.mode)).toEqual(['hide', 'reveal']);
    expect(ordered[ordered.length - 1].mode).toBe('reveal');
  });

  it('keeps valid regions in order while dropping junk between them', () => {
    const a = tri('reveal');
    const b = tri('hide');
    expect(orderedRenderableFogRegions([a, degenerateClick, b])).toEqual([a, b]);
  });

  it('keeps a mode-less legacy region when renderable', () => {
    const legacy = tri();
    const ordered = orderedRenderableFogRegions([legacy]);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].mode).toBeUndefined();
  });
});
