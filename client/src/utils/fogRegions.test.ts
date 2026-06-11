import { describe, expect, it } from 'vitest';
import { splitManualFogRegions } from './fogRegions';

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
