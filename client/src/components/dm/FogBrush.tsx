import { useState, useCallback, useRef } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { emitFogReveal, emitFogHide } from '../../socket/emitters';
import { theme } from '../../styles/theme';

type BrushMode = 'reveal' | 'hide';

interface FogBrushState {
  brushSize: number;
  brushMode: BrushMode;
}

/**
 * FogBrush renders DM controls for painting fog reveal/hide areas,
 * plus a Konva-compatible hook for handling canvas interaction.
 *
 * The brush accumulates points as the DM clicks and drags on the map.
 * On mouse-up, the polygon is emitted to the server as a fog reveal or hide event.
 */
export function FogBrush() {
  const [state, setState] = useState<FogBrushState>({
    brushSize: 70,
    brushMode: 'reveal',
  });

  const activeTool = useMapStore((s) => s.activeTool);
  const isFogTool = activeTool === 'fog-reveal' || activeTool === 'fog-hide';

  if (!isFogTool) return null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>Fog Brush</div>

      {/* Mode toggle */}
      <div style={styles.modeRow}>
        <button
          style={{
            ...styles.modeButton,
            ...(state.brushMode === 'reveal' ? styles.modeActive : {}),
          }}
          onClick={() => {
            setState((s) => ({ ...s, brushMode: 'reveal' }));
            useMapStore.getState().setTool('fog-reveal');
          }}
        >
          Reveal
        </button>
        <button
          style={{
            ...styles.modeButton,
            ...(state.brushMode === 'hide' ? styles.modeHideActive : {}),
          }}
          onClick={() => {
            setState((s) => ({ ...s, brushMode: 'hide' }));
            useMapStore.getState().setTool('fog-hide');
          }}
        >
          Hide
        </button>
      </div>

      {/* Brush size slider */}
      <div style={styles.sliderSection}>
        <label style={styles.label}>
          Brush Size: {state.brushSize}px
        </label>
        <input
          type="range"
          min={20}
          max={400}
          step={10}
          value={state.brushSize}
          onChange={(e) =>
            setState((s) => ({ ...s, brushSize: Number(e.target.value) }))
          }
          style={styles.slider}
        />
      </div>

      <div style={styles.hint}>
        Click and drag on the map to {state.brushMode} fog.
      </div>
    </div>
  );
}

/**
 * Hook that provides canvas event handlers for fog brush interaction.
 * Attach these to the Konva Stage or a transparent interaction layer.
 *
 * Returns handlers for onMouseDown, onMouseMove, onMouseUp, and the
 * current brush polygon points for preview rendering.
 */
export function useFogBrush(brushSize: number) {
  const [brushPoints, setBrushPoints] = useState<number[]>([]);
  const isDrawing = useRef(false);
  const activeTool = useMapStore((s) => s.activeTool);

  const onMouseDown = useCallback(
    (e: { evt: MouseEvent; target: { getStage: () => { getPointerPosition: () => { x: number; y: number } | null } | null } }) => {
      if (activeTool !== 'fog-reveal' && activeTool !== 'fog-hide') return;
      const stage = e.target.getStage?.();
      const pos = stage?.getPointerPosition();
      if (!pos) return;

      isDrawing.current = true;

      // Create a square brush stamp centered on click position
      const half = brushSize / 2;
      const stampPoints = [
        pos.x - half, pos.y - half,
        pos.x + half, pos.y - half,
        pos.x + half, pos.y + half,
        pos.x - half, pos.y + half,
      ];
      setBrushPoints(stampPoints);
    },
    [activeTool, brushSize]
  );

  const onMouseMove = useCallback(
    (e: { evt: MouseEvent; target: { getStage: () => { getPointerPosition: () => { x: number; y: number } | null } | null } }) => {
      if (!isDrawing.current) return;
      if (activeTool !== 'fog-reveal' && activeTool !== 'fog-hide') return;
      const stage = e.target.getStage?.();
      const pos = stage?.getPointerPosition();
      if (!pos) return;

      // Accumulate points along the drag path to build a polygon
      setBrushPoints((prev) => [...prev, pos.x, pos.y]);
    },
    [activeTool]
  );

  const onMouseUp = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;

    if (brushPoints.length < 6) {
      setBrushPoints([]);
      return;
    }

    // Build a convex hull-ish polygon from accumulated brush points
    // For simplicity, send all accumulated points as the fog polygon
    const points = computeBrushPolygon(brushPoints, brushSize);

    if (activeTool === 'fog-reveal') {
      emitFogReveal(points);
    } else if (activeTool === 'fog-hide') {
      emitFogHide(points);
    }

    setBrushPoints([]);
  }, [brushPoints, activeTool, brushSize]);

  return { brushPoints, onMouseDown, onMouseMove, onMouseUp };
}

/**
 * Given accumulated brush points from a drag stroke, compute a closed
 * polygon that covers the brushed area. Uses a simplified convex hull
 * to create a clean polygon from the stroke path.
 */
function computeBrushPolygon(rawPoints: number[], brushSize: number): number[] {
  if (rawPoints.length < 4) return rawPoints;

  // Extract (x,y) pairs
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < rawPoints.length; i += 2) {
    pts.push({ x: rawPoints[i], y: rawPoints[i + 1] });
  }

  // Offset points perpendicular to the path direction to create brush width
  const half = brushSize / 2;
  const outline: { x: number; y: number }[] = [];

  // Forward pass: offset left
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const curr = pts[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    outline.push({
      x: curr.x + (-dy / len) * half,
      y: curr.y + (dx / len) * half,
    });
  }

  // Backward pass: offset right
  for (let i = pts.length - 1; i >= 0; i--) {
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const curr = pts[i];
    const dx = next.x - curr.x;
    const dy = next.y - curr.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    outline.push({
      x: curr.x - (-dy / len) * half,
      y: curr.y - (dx / len) * half,
    });
  }

  // Flatten back to number array
  const result: number[] = [];
  for (const p of outline) {
    result.push(p.x, p.y);
  }

  return result;
}

// --- Styles ---

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px 0',
  },
  header: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  modeRow: {
    display: 'flex',
    gap: 4,
  },
  modeButton: {
    flex: 1,
    padding: '6px 12px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: theme.font.body,
    transition: 'all 0.15s',
  },
  modeActive: {
    background: 'rgba(39, 174, 96, 0.2)',
    borderColor: theme.heal,
    color: theme.heal,
  },
  modeHideActive: {
    background: 'rgba(192, 57, 43, 0.2)',
    borderColor: theme.danger,
    color: theme.danger,
  },
  sliderSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  label: {
    fontSize: 12,
    color: theme.text.secondary,
  },
  slider: {
    width: '100%',
    accentColor: theme.gold.primary,
  },
  hint: {
    fontSize: 11,
    color: theme.text.muted,
    fontStyle: 'italic',
  },
};
