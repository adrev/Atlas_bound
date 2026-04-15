/**
 * Client-side grid-pitch detection for map uploads.
 *
 * Many VTT maps ship with visible grid lines. We scan the image for
 * periodic horizontal-edge peaks and use the dominant period as the
 * auto-detected cell size. Runs in ~50ms for a 1400×1050 map on a
 * 2020 MBP.
 *
 * Algorithm:
 *   1. Draw the image into an offscreen canvas, downscaled to at
 *      most 1024px on the long edge (speeds up the 1D scan).
 *   2. Compute a per-row edge-intensity signal: for each row y, sum
 *      |L(x,y) - L(x,y-1)| across a small vertical kernel. Rows
 *      sitting on a grid line have high values.
 *   3. Autocorrelation of the 1D signal picks out the strongest
 *      periodic lag. That lag × (origWidth / scaledWidth) = pixel
 *      count per grid cell in the original image.
 *   4. Confidence is the normalised peak-to-mean ratio of the
 *      autocorrelation at the winning lag. We only return a result
 *      when it's above a threshold (0.25 empirically works for the
 *      Forgotten Adventures / CzePeku style maps; below that we
 *      refuse and the UI keeps the default).
 *
 * Returns null when:
 *   - the image can't be loaded
 *   - confidence is too low to call
 *   - the detected period is outside [32, 180] px (the grid pitch
 *     on realistic VTT maps).
 */
export interface DetectedGrid {
  cellSize: number;
  confidence: number;
}

export async function detectGrid(imageUrl: string): Promise<DetectedGrid | null> {
  const img = await loadImage(imageUrl);
  if (!img) return null;

  const maxSize = 1024;
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // getImageData can throw on cross-origin images. Dev path usually
    // works because our uploads come from blob URLs.
    return null;
  }

  // Row-edge signal — horizontal line strength.
  const rowSignal = rowEdgeSignal(data, w, h);
  const rowRes = dominantPeriod(rowSignal);
  // Col-edge signal — vertical line strength.
  const colSignal = colEdgeSignal(data, w, h);
  const colRes = dominantPeriod(colSignal);

  // Use whichever axis had the stronger peak — maps with only one
  // strong axis still produce a good reading, and averaging them
  // biases toward wrong answers when one axis has no grid.
  const best = rowRes.confidence >= colRes.confidence ? rowRes : colRes;

  if (best.lag <= 0) return null;
  const cellSize = Math.round(best.lag / scale);
  if (cellSize < 32 || cellSize > 180) return null;
  if (best.confidence < 0.25) return null;

  return { cellSize, confidence: best.confidence };
}

// --- helpers ------------------------------------------------------

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function luma(data: Uint8ClampedArray, i: number): number {
  // BT.601 grayscale on the RGBA pixel starting at index i.
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

function rowEdgeSignal(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const sig = new Float32Array(h);
  // Sample every 4th pixel horizontally for speed.
  const step = 4;
  for (let y = 1; y < h; y++) {
    let sum = 0;
    const rowStart = y * w * 4;
    const prevRowStart = (y - 1) * w * 4;
    for (let x = 0; x < w; x += step) {
      const cur = luma(data, rowStart + x * 4);
      const prev = luma(data, prevRowStart + x * 4);
      sum += Math.abs(cur - prev);
    }
    sig[y] = sum;
  }
  return sig;
}

function colEdgeSignal(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const sig = new Float32Array(w);
  const step = 4;
  for (let x = 1; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < h; y += step) {
      const rowStart = y * w * 4;
      const cur = luma(data, rowStart + x * 4);
      const prev = luma(data, rowStart + (x - 1) * 4);
      sum += Math.abs(cur - prev);
    }
    sig[x] = sum;
  }
  return sig;
}

/**
 * Autocorrelate a 1D signal and pick the strongest non-zero lag in
 * the grid-cell-plausible range [30..200]. We normalise by the
 * autocorrelation at lag 0 so the returned confidence is comparable
 * across images. Exported for test coverage.
 */
export function dominantPeriod(signal: Float32Array): { lag: number; confidence: number } {
  const n = signal.length;
  // Zero-mean the signal so correlation tracks edges, not DC offset.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;
  const centred = new Float32Array(n);
  for (let i = 0; i < n; i++) centred[i] = signal[i] - mean;

  // Self-correlation at lag 0 for normalisation.
  let c0 = 0;
  for (let i = 0; i < n; i++) c0 += centred[i] * centred[i];
  if (c0 <= 0) return { lag: 0, confidence: 0 };

  const minLag = 30;
  const maxLag = Math.min(200, Math.floor(n / 3));
  let bestLag = 0;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < n - lag; i++) c += centred[i] * centred[i + lag];
    if (c > bestCorr) { bestCorr = c; bestLag = lag; }
  }
  // Simple parabolic refinement: fit a quadratic to the three points
  // around the peak to sub-pixel the lag. Handles scale-reduced images
  // where the true grid pitch falls between two integer lags.
  if (bestLag > minLag && bestLag < maxLag) {
    const ym1 = corrAt(centred, bestLag - 1);
    const y0 = bestCorr;
    const yp1 = corrAt(centred, bestLag + 1);
    const denom = (ym1 - 2 * y0 + yp1);
    if (denom !== 0) {
      const delta = 0.5 * (ym1 - yp1) / denom;
      if (Math.abs(delta) < 1) bestLag += delta;
    }
  }
  return { lag: bestLag, confidence: bestCorr / c0 };
}

function corrAt(centred: Float32Array, lag: number): number {
  let c = 0;
  for (let i = 0; i < centred.length - lag; i++) c += centred[i] * centred[i + lag];
  return c;
}
