import { describe, expect, it } from 'vitest';
import { computeAudioPopoverPosition } from './AudioPopover';

describe('computeAudioPopoverPosition', () => {
  it('opens below top-bar speaker buttons instead of off-screen', () => {
    const pos = computeAudioPopoverPosition(
      { top: 12, bottom: 40, right: 1220 } as DOMRect,
      1280,
      720,
    );

    expect(pos.top).toBeGreaterThanOrEqual(40);
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + 260).toBeLessThanOrEqual(1272);
  });

  it('still opens above controls near the bottom edge', () => {
    const pos = computeAudioPopoverPosition(
      { top: 680, bottom: 708, right: 1220 } as DOMRect,
      1280,
      720,
    );

    expect(pos.top).toBe(492);
  });

  it('clamps horizontally on narrow viewports', () => {
    const pos = computeAudioPopoverPosition(
      { top: 12, bottom: 40, right: 120 } as DOMRect,
      320,
      720,
    );

    expect(pos.left).toBe(8);
    expect(pos.left + 260).toBeLessThanOrEqual(312);
  });
});
