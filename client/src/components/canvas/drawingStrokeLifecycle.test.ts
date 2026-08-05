import { describe, expect, it, vi } from 'vitest';
import { finalizeDrawingStroke } from './drawingStrokeLifecycle';

describe('finalizeDrawingStroke', () => {
  it('commits an active stroke exactly once across duplicate release events', () => {
    const activeStroke = { current: true };
    const commitStroke = vi.fn();
    const getState = () => ({ drawingInProgress: { tempId: 'stroke-1' }, commitStroke });

    expect(finalizeDrawingStroke(activeStroke, getState)).toBe(true);
    expect(finalizeDrawingStroke(activeStroke, getState)).toBe(false);
    expect(commitStroke).toHaveBeenCalledTimes(1);
  });

  it('clears the active flag without committing if the store already cancelled the stroke', () => {
    const activeStroke = { current: true };
    const commitStroke = vi.fn();

    expect(
      finalizeDrawingStroke(activeStroke, () => ({ drawingInProgress: null, commitStroke }))
    ).toBe(true);
    expect(activeStroke.current).toBe(false);
    expect(commitStroke).not.toHaveBeenCalled();
  });

  it('does nothing when no stroke is active', () => {
    const commitStroke = vi.fn();

    expect(
      finalizeDrawingStroke({ current: false }, () => ({
        drawingInProgress: { tempId: 'stroke-1' },
        commitStroke,
      }))
    ).toBe(false);
    expect(commitStroke).not.toHaveBeenCalled();
  });
});
