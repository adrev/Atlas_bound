import { describe, expect, it } from 'vitest';
import { getVisibleMapRect } from './visibleMapRect';

describe('getVisibleMapRect', () => {
  it('returns the visible stage-sized map area at normal zoom', () => {
    expect(getVisibleMapRect(
      1400,
      900,
      { x: 0, y: 0, scaleX: 1, scaleY: 1 },
      800,
      600,
    )).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it('accounts for pan offsets in map coordinates', () => {
    expect(getVisibleMapRect(
      1400,
      900,
      { x: -210, y: -140, scaleX: 1, scaleY: 1 },
      800,
      600,
    )).toEqual({
      x: 210,
      y: 140,
      width: 800,
      height: 600,
    });
  });

  it('shrinks the visible rect when zoomed in', () => {
    expect(getVisibleMapRect(
      1400,
      900,
      { x: -400, y: -200, scaleX: 2, scaleY: 2 },
      800,
      600,
    )).toEqual({
      x: 200,
      y: 100,
      width: 400,
      height: 300,
    });
  });

  it('clamps to the full map when zoomed out beyond the map extents', () => {
    expect(getVisibleMapRect(
      1000,
      700,
      { x: 100, y: 50, scaleX: 0.5, scaleY: 0.5 },
      1200,
      900,
    )).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 700,
    });
  });

  it('returns null when the map is completely outside the viewport', () => {
    expect(getVisibleMapRect(
      1000,
      700,
      { x: -1400, y: 0, scaleX: 1, scaleY: 1 },
      300,
      300,
    )).toBeNull();
  });
});
