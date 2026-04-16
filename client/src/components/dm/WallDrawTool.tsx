import { useState, useCallback, useMemo } from 'react';
import { Line, Circle, Group, Text, Rect } from 'react-konva';
import type { WallSegment } from '@dnd-vtt/shared';
import { useMapStore } from '../../stores/useMapStore';
import { emitWallAdd, emitWallRemove } from '../../socket/emitters';
import { theme } from '../../styles/theme';

/**
 * WallDrawTool provides DM controls and a Konva layer for drawing, viewing,
 * and deleting wall segments. Walls block light and visibility raycasting.
 *
 * Interaction:
 * - First click sets the wall start point
 * - Second click sets the end point and emits the wall to the server
 * - Existing walls are shown as red lines with delete buttons
 */

// ---- Sidebar Controls ----

export function WallControls() {
  const walls = useMapStore((s) => s.walls);
  const activeTool = useMapStore((s) => s.activeTool);

  if (activeTool !== 'wall') return null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>Wall Drawing</div>

      <div style={styles.instructions}>
        Click on the map to place the start point, then click again to complete the wall segment.
      </div>

      <div style={styles.wallCount}>
        {walls.length} wall{walls.length !== 1 ? 's' : ''} placed
      </div>

      {walls.length > 0 && (
        <div style={styles.wallList}>
          {walls.map((wall, idx) => (
            <div key={idx} style={styles.wallItem}>
              <span style={styles.wallLabel}>
                Wall {idx + 1}: ({Math.round(wall.x1)},{Math.round(wall.y1)}) to ({Math.round(wall.x2)},{Math.round(wall.y2)})
              </span>
              <button
                style={styles.deleteButton}
                onClick={() => emitWallRemove(idx)}
                title="Remove wall"
              >
                X
              </button>
            </div>
          ))}
        </div>
      )}

      {walls.length > 0 && (
        <button
          style={styles.clearAllButton}
          onClick={() => {
            // Remove all walls from last to first to maintain correct indices
            for (let i = walls.length - 1; i >= 0; i--) {
              emitWallRemove(i);
            }
          }}
        >
          Clear All Walls
        </button>
      )}
    </div>
  );
}

// ---- Canvas Layer ----

interface WallDrawLayerProps {
  /** Snap positions to grid if provided */
  gridSize?: number;
}

/**
 * Konva layer that renders existing walls and handles click-to-draw interaction.
 * Shown only when the wall tool is active.
 */
export function WallDrawLayer({ gridSize }: WallDrawLayerProps) {
  const walls = useMapStore((s) => s.walls);
  const activeTool = useMapStore((s) => s.activeTool);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [previewEnd, setPreviewEnd] = useState<{ x: number; y: number } | null>(null);
  const [hoveredWall, setHoveredWall] = useState<number | null>(null);

  const snap = useCallback(
    (x: number, y: number) => {
      if (!gridSize) return { x, y };
      return {
        x: Math.round(x / gridSize) * gridSize,
        y: Math.round(y / gridSize) * gridSize,
      };
    },
    [gridSize]
  );

  const handleClick = useCallback(
    (e: { target: { getStage: () => { getPointerPosition: () => { x: number; y: number } | null } | null } }) => {
      if (activeTool !== 'wall') return;
      const stage = e.target.getStage?.();
      const pos = stage?.getPointerPosition();
      if (!pos) return;

      const snapped = snap(pos.x, pos.y);

      if (!startPoint) {
        // First click: set start point
        setStartPoint(snapped);
      } else {
        // Second click: complete the wall
        const wall: WallSegment = {
          x1: startPoint.x,
          y1: startPoint.y,
          x2: snapped.x,
          y2: snapped.y,
        };
        emitWallAdd(wall);
        setStartPoint(null);
        setPreviewEnd(null);
      }
    },
    [activeTool, startPoint, snap]
  );

  const handleMouseMove = useCallback(
    (e: { target: { getStage: () => { getPointerPosition: () => { x: number; y: number } | null } | null } }) => {
      if (activeTool !== 'wall' || !startPoint) return;
      const stage = e.target.getStage?.();
      const pos = stage?.getPointerPosition();
      if (!pos) return;

      setPreviewEnd(snap(pos.x, pos.y));
    },
    [activeTool, startPoint, snap]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setStartPoint(null);
        setPreviewEnd(null);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (hoveredWall !== null) {
          emitWallRemove(hoveredWall);
          setHoveredWall(null);
        }
      }
    },
    [hoveredWall]
  );

  // Attach keyboard listener
  useMemo(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const isWallTool = activeTool === 'wall';

  return (
    <Group listening={isWallTool}>
      {/* Existing walls rendered as red lines */}
      {walls.map((wall, idx) => (
        <Group key={`wall-${idx}`}>
          <Line
            points={[wall.x1, wall.y1, wall.x2, wall.y2]}
            stroke={hoveredWall === idx ? '#ff6b6b' : '#e74c3c'}
            strokeWidth={hoveredWall === idx ? 4 : 3}
            lineCap="round"
            opacity={0.9}
            onMouseEnter={() => setHoveredWall(idx)}
            onMouseLeave={() => setHoveredWall(null)}
            hitStrokeWidth={12}
          />
          {/* Wall endpoints */}
          <Circle
            x={wall.x1}
            y={wall.y1}
            radius={4}
            fill="#e74c3c"
            stroke="#fff"
            strokeWidth={1}
            opacity={0.8}
          />
          <Circle
            x={wall.x2}
            y={wall.y2}
            radius={4}
            fill="#e74c3c"
            stroke="#fff"
            strokeWidth={1}
            opacity={0.8}
          />
          {/* Delete indicator on hover */}
          {hoveredWall === idx && (
            <Group x={(wall.x1 + wall.x2) / 2} y={(wall.y1 + wall.y2) / 2 - 16}>
              <Rect
                x={-24}
                y={-10}
                width={48}
                height={20}
                fill="rgba(192, 57, 43, 0.9)"
                cornerRadius={4}
              />
              <Text
                x={-24}
                y={-10}
                width={48}
                height={20}
                text="Delete"
                fontSize={10}
                fill="white"
                align="center"
                verticalAlign="middle"
              />
            </Group>
          )}
        </Group>
      ))}

      {/* Start point indicator when placing first point */}
      {isWallTool && startPoint && (
        <>
          <Circle
            x={startPoint.x}
            y={startPoint.y}
            radius={6}
            fill={theme.gold.primary}
            stroke="white"
            strokeWidth={2}
            shadowColor={theme.gold.primary}
            shadowBlur={10}
            shadowEnabled
          />

          {/* Preview line from start to cursor */}
          {previewEnd && (
            <>
              <Line
                points={[startPoint.x, startPoint.y, previewEnd.x, previewEnd.y]}
                stroke={theme.gold.primary}
                strokeWidth={3}
                dash={[8, 4]}
                opacity={0.7}
                lineCap="round"
              />
              <Circle
                x={previewEnd.x}
                y={previewEnd.y}
                radius={5}
                fill={theme.gold.primary}
                opacity={0.5}
              />
            </>
          )}
        </>
      )}
    </Group>
  );
}

/** Provide event handlers for the stage to wire up wall drawing */
export function useWallDraw(gridSize?: number) {
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [previewEnd, setPreviewEnd] = useState<{ x: number; y: number } | null>(null);
  const activeTool = useMapStore((s) => s.activeTool);

  const snap = useCallback(
    (x: number, y: number) => {
      if (!gridSize) return { x, y };
      return {
        x: Math.round(x / gridSize) * gridSize,
        y: Math.round(y / gridSize) * gridSize,
      };
    },
    [gridSize]
  );

  const onClick = useCallback(
    (pos: { x: number; y: number }) => {
      if (activeTool !== 'wall') return;
      const snapped = snap(pos.x, pos.y);

      if (!startPoint) {
        setStartPoint(snapped);
      } else {
        emitWallAdd({
          x1: startPoint.x,
          y1: startPoint.y,
          x2: snapped.x,
          y2: snapped.y,
        });
        setStartPoint(null);
        setPreviewEnd(null);
      }
    },
    [activeTool, startPoint, snap]
  );

  const onMove = useCallback(
    (pos: { x: number; y: number }) => {
      if (activeTool !== 'wall' || !startPoint) return;
      setPreviewEnd(snap(pos.x, pos.y));
    },
    [activeTool, startPoint, snap]
  );

  const cancel = useCallback(() => {
    setStartPoint(null);
    setPreviewEnd(null);
  }, []);

  return { startPoint, previewEnd, onClick, onMove, cancel };
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
  instructions: {
    fontSize: 12,
    color: theme.text.muted,
    lineHeight: '1.4',
  },
  wallCount: {
    fontSize: 12,
    color: theme.text.secondary,
    padding: '4px 8px',
    background: theme.bg.deep,
    borderRadius: theme.radius.sm,
  },
  wallList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 180,
    overflowY: 'auto',
  },
  wallItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '3px 6px',
    background: theme.bg.deep,
    borderRadius: theme.radius.sm,
    fontSize: 11,
  },
  wallLabel: {
    color: theme.text.muted,
    fontFamily: 'monospace',
    fontSize: 10,
  },
  deleteButton: {
    padding: '2px 6px',
    border: 'none',
    borderRadius: theme.radius.sm,
    background: 'rgba(192, 57, 43, 0.3)',
    color: theme.danger,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 'bold',
    fontFamily: theme.font.body,
  },
  clearAllButton: {
    padding: '6px 12px',
    border: `1px solid ${theme.danger}`,
    borderRadius: theme.radius.sm,
    background: 'rgba(192, 57, 43, 0.15)',
    color: theme.danger,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: theme.font.body,
    transition: 'all 0.15s',
  },
};
