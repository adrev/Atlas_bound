import { describe, expect, it } from 'vitest';
import { findPath, getReachableCells, gridDistance } from './grid-math.js';

describe('grid movement distance', () => {
  it('counts one diagonal square as 5 feet by default', () => {
    expect(gridDistance(0, 0, 70, 70, 70)).toBe(5);
    expect(gridDistance(0, 0, 210, 140, 70)).toBe(15);
  });

  it('includes diagonal cells inside normal movement range', () => {
    const reachable = getReachableCells(0, 0, 10, 3, 3, new Set());
    expect(reachable).toContainEqual({ col: 1, row: 1, cost: 1 });
    expect(reachable).toContainEqual({ col: 2, row: 2, cost: 2 });
  });

  it('paths use the same one-square diagonal cost model', () => {
    const path = findPath(0, 0, 2, 2, 3, 3, new Set());
    expect(path).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 1 },
      { col: 2, row: 2 },
    ]);
  });
});
