import { describe, it, expect } from 'vitest';
import { computeSpawnAnchor, computeTokenPosition } from './zoneSpawn';

describe('computeSpawnAnchor', () => {
  it('uses map center + infinite offsets when no zone is given', () => {
    const a = computeSpawnAnchor({ width: 2000, height: 1500 }, null);
    expect(a.centerX).toBe(1000);
    expect(a.centerY).toBe(750);
    expect(a.maxOffsetX).toBe(Number.POSITIVE_INFINITY);
    expect(a.maxOffsetY).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses zone center when a zone is provided', () => {
    const a = computeSpawnAnchor(
      { width: 2000, height: 1500, gridSize: 70 },
      { x: 300, y: 200, width: 500, height: 400 },
    );
    expect(a.centerX).toBe(550);
    expect(a.centerY).toBe(400);
  });

  it('clamps offsets to fit inside the zone', () => {
    const a = computeSpawnAnchor(
      { width: 2000, height: 1500, gridSize: 70 },
      { x: 0, y: 0, width: 500, height: 200 },
    );
    // Half-width minus half-token = 250 - 35 = 215; height side is 100 - 35 = 65.
    expect(a.maxOffsetX).toBe(215);
    expect(a.maxOffsetY).toBe(65);
  });

  it('clamps offsets to 0 for a zone narrower than the token (prevents spill)', () => {
    const a = computeSpawnAnchor(
      { width: 2000, height: 1500, gridSize: 70 },
      { x: 0, y: 0, width: 60, height: 60 },
    );
    expect(a.maxOffsetX).toBe(0);
    expect(a.maxOffsetY).toBe(0);
  });

  it('reserves more margin when larger tokens are spawned', () => {
    // 3-cell (Huge) token in a 700x700 zone: half-width 350 - 105 = 245.
    const a = computeSpawnAnchor(
      { width: 2000, height: 1500, gridSize: 70 },
      { x: 0, y: 0, width: 700, height: 700 },
      3,
    );
    expect(a.maxOffsetX).toBe(245);
    expect(a.maxOffsetY).toBe(245);
  });
});

describe('computeTokenPosition', () => {
  const anchor = {
    centerX: 500,
    centerY: 500,
    maxOffsetX: Number.POSITIVE_INFINITY,
    maxOffsetY: Number.POSITIVE_INFINITY,
  };

  it('places a single token at the anchor', () => {
    const p = computeTokenPosition(0, 1, anchor, 70);
    expect(p).toEqual({ x: 500, y: 500 });
  });

  it('lays 9 tokens out in a 3x3 grid around the anchor', () => {
    const positions = Array.from({ length: 9 }, (_, i) =>
      computeTokenPosition(i, 9, anchor, 70),
    );
    // The unique x/y offsets should be {-70, 0, +70} in each axis.
    const xs = Array.from(new Set(positions.map((p) => p.x))).sort((a, b) => a - b);
    const ys = Array.from(new Set(positions.map((p) => p.y))).sort((a, b) => a - b);
    expect(xs).toEqual([430, 500, 570]);
    expect(ys).toEqual([430, 500, 570]);
  });

  it('clamps token positions to zone bounds when the grid is wider than the zone', () => {
    const zoned = {
      centerX: 500,
      centerY: 500,
      maxOffsetX: 50,
      maxOffsetY: 50,
    };
    const p = computeTokenPosition(0, 16, zoned, 70);
    // A 4-col grid at grid=70 would place the (0,0) token at -140 offset;
    // clamped to -50 it should land at 450.
    expect(p.x).toBeGreaterThanOrEqual(450);
    expect(p.x).toBeLessThanOrEqual(550);
    expect(p.y).toBeGreaterThanOrEqual(450);
    expect(p.y).toBeLessThanOrEqual(550);
  });
});
