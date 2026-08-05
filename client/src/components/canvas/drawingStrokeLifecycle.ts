export interface DrawingStrokeRef {
  current: boolean;
}

export interface DrawingStrokeState {
  drawingInProgress: unknown | null;
  commitStroke(): void;
}

/**
 * Finish a stroke exactly once, regardless of how many release events fire.
 * Returns whether an active stroke was consumed.
 */
export function finalizeDrawingStroke(
  activeStroke: DrawingStrokeRef,
  getState: () => DrawingStrokeState
): boolean {
  if (!activeStroke.current) return false;

  activeStroke.current = false;
  const state = getState();
  if (state.drawingInProgress) state.commitStroke();
  return true;
}
