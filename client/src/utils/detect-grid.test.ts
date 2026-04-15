import { describe, it, expect } from 'vitest';
import { dominantPeriod } from './detect-grid';

// detectGrid() needs a browser DOM (Image + Canvas.getImageData) so the
// integration test lives in an e2e harness; here we pin the pure
// autocorrelation math that decides what grid pitch to pick.

describe('dominantPeriod', () => {
  it('picks a period of 70 from a signal with peaks every 70 samples', () => {
    const n = 500;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sig[i] = (i % 70 === 0 ? 1 : 0) + 0.02 * Math.sin(i);
    }
    const { lag, confidence } = dominantPeriod(sig);
    expect(Math.round(lag)).toBe(70);
    expect(confidence).toBeGreaterThan(0.3);
  });

  it('picks a period of 50 for tight-spaced peaks', () => {
    const n = 500;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = (i % 50 === 0 ? 1 : 0);
    const { lag } = dominantPeriod(sig);
    expect(Math.round(lag)).toBe(50);
  });

  it('reports low confidence for pure noise', () => {
    const n = 500;
    const sig = new Float32Array(n);
    // Deterministic pseudo-noise so this doesn't flake.
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      sig[i] = seed / 233280;
    }
    const { confidence } = dominantPeriod(sig);
    expect(confidence).toBeLessThan(0.3);
  });

  it('zero-length signal returns zero lag/confidence', () => {
    const { lag, confidence } = dominantPeriod(new Float32Array(0));
    expect(lag).toBe(0);
    expect(confidence).toBe(0);
  });

  it('signal at exactly the min-lag floor (30) is detected', () => {
    const n = 500;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = (i % 30 === 0 ? 1 : 0);
    const { lag } = dominantPeriod(sig);
    expect(Math.round(lag)).toBe(30);
  });
});
