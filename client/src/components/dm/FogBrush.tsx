import { useCallback, useRef, useState } from 'react';
import { Group, Line, Rect } from 'react-konva';
import type Konva from 'konva';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitFogReveal, emitFogHide } from '../../socket/emitters';
import { theme } from '../../styles/theme';

type BrushMode = 'reveal' | 'hide';

/**
 * FogBrush renders DM controls for painting fog reveal/hide areas,
 * plus a Konva-compatible hook for handling canvas interaction.
 *
 * The brush accumulates points as the DM clicks and drags on the map.
 * On mouse-up, the polygon is emitted to the server as a fog reveal or hide event.
 */
export function FogBrush() {
  const isDM = useSessionStore((s) => s.isDM);
  const activeTool = useMapStore((s) => s.activeTool);
  const fogBrushSize = useMapStore((s) => s.fogBrushSize);
  const isFogTool = activeTool === 'fog-reveal' || activeTool === 'fog-hide';
  const brushMode: BrushMode = activeTool === 'fog-hide' ? 'hide' : 'reveal';

  if (!isDM || !isFogTool) return null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>Fog Brush</div>

      {/* Mode toggle */}
      <div style={styles.modeRow}>
        <button
          style={{
            ...styles.modeButton,
            ...(brushMode === 'reveal' ? styles.modeActive : {}),
          }}
          onClick={() => {
            useMapStore.getState().setTool('fog-reveal');
          }}
        >
          Reveal
        </button>
        <button
          style={{
            ...styles.modeButton,
            ...(brushMode === 'hide' ? styles.modeHideActive : {}),
          }}
          onClick={() => {
            useMapStore.getState().setTool('fog-hide');
          }}
        >
          Hide
        </button>
      </div>

      {/* Brush size slider */}
      <div style={styles.sliderSection}>
        <label style={styles.label}>Brush Size: {fogBrushSize}px</label>
        <input
          type="range"
          min={20}
          max={400}
          step={10}
          value={fogBrushSize}
          onChange={(e) => useMapStore.getState().setFogBrushSize(Number(e.target.value))}
          style={styles.slider}
        />
      </div>

      <div style={styles.hint}>
        Click and drag on the map to {brushMode === 'reveal' ? 'reveal' : 're-fog'} an area.
      </div>

      <button
        type="button"
        style={styles.doneButton}
        onClick={() => useMapStore.getState().setTool('select')}
      >
        Exit Fog Brush
      </button>
    </div>
  );
}

export function FogBrushLayer() {
  const isDM = useSessionStore((s) => s.isDM);
  const activeTool = useMapStore((s) => s.activeTool);
  const currentMap = useMapStore((s) => s.currentMap);
  const fogBrushSize = useMapStore((s) => s.fogBrushSize);
  const { brushPoints, previewPoints, onMouseDown, onMouseMove, onMouseUp } =
    useFogBrush(fogBrushSize);

  const isFogTool = activeTool === 'fog-reveal' || activeTool === 'fog-hide';

  if (!isDM) return null;

  return (
    <Group
      listening={isFogTool}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {isFogTool && currentMap && (
        <Rect
          x={0}
          y={0}
          width={currentMap.width}
          height={currentMap.height}
          fill="rgba(0,0,0,0.001)"
          listening
        />
      )}
      {previewPoints.length >= 6 && (
        <Line
          points={previewPoints}
          closed
          fill={activeTool === 'fog-hide' ? 'rgba(0,0,0,0.45)' : 'rgba(39,174,96,0.22)'}
          stroke={activeTool === 'fog-hide' ? theme.danger : theme.heal}
          strokeWidth={2}
          dash={[10, 6]}
          listening={false}
        />
      )}
      {brushPoints.length >= 2 && (
        <Line
          points={brushPoints}
          stroke={activeTool === 'fog-hide' ? theme.danger : theme.heal}
          strokeWidth={Math.max(2, fogBrushSize)}
          opacity={0.18}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      )}
    </Group>
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
  const brushPointsRef = useRef<number[]>([]);
  const isDrawing = useRef(false);
  const activeTool = useMapStore((s) => s.activeTool);

  const onMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (activeTool !== 'fog-reveal' && activeTool !== 'fog-hide') return;
      const pos = getMapPointer(e);
      if (!pos) return;

      e.evt.preventDefault();
      isDrawing.current = true;
      brushPointsRef.current = [pos.x, pos.y];
      setBrushPoints(brushPointsRef.current);
    },
    [activeTool]
  );

  const onMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (!isDrawing.current) return;
      if (activeTool !== 'fog-reveal' && activeTool !== 'fog-hide') return;
      const pos = getMapPointer(e);
      if (!pos) return;

      e.evt.preventDefault();
      const lastX = brushPointsRef.current[brushPointsRef.current.length - 2];
      const lastY = brushPointsRef.current[brushPointsRef.current.length - 1];
      if (lastX !== undefined && lastY !== undefined) {
        const minStep = Math.max(8, brushSize / 4);
        if (Math.hypot(pos.x - lastX, pos.y - lastY) < minStep) return;
      }
      brushPointsRef.current = [...brushPointsRef.current, pos.x, pos.y];
      setBrushPoints(brushPointsRef.current);
    },
    [activeTool, brushSize]
  );

  const onMouseUp = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;

    const points = brushPointsRef.current;
    if (points.length < 2) {
      brushPointsRef.current = [];
      setBrushPoints([]);
      return;
    }

    const polygon = computeBrushPolygon(points, brushSize);

    if (activeTool === 'fog-reveal') {
      emitFogReveal(polygon);
    } else if (activeTool === 'fog-hide') {
      emitFogHide(polygon);
    }

    brushPointsRef.current = [];
    setBrushPoints([]);
  }, [activeTool, brushSize]);

  return {
    brushPoints,
    previewPoints: computeBrushPolygon(brushPoints, brushSize),
    onMouseDown,
    onMouseMove,
    onMouseUp,
  };
}

function getMapPointer(e: Konva.KonvaEventObject<MouseEvent>): { x: number; y: number } | null {
  const stage = e.target.getStage();
  const pos = stage?.getPointerPosition();
  if (!stage || !pos) return null;
  const transform = stage.getAbsoluteTransform().copy().invert();
  return transform.point(pos);
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
    position: 'absolute',
    top: 76,
    right: 16,
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: 260,
    padding: 12,
    background: 'rgba(18, 14, 9, 0.92)',
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
    pointerEvents: 'auto',
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
  doneButton: {
    padding: '7px 10px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.hover,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: theme.font.body,
  },
};
