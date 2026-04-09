import { useState, useEffect, useCallback } from 'react';
import { Layer, Line, Text, Circle, Group } from 'react-konva';
import type { WallSegment } from '@dnd-vtt/shared';
import { useMapStore } from '../../../stores/useMapStore';
import { useSessionStore } from '../../../stores/useSessionStore';
import { theme } from '../../../styles/theme';
import { emitWallAdd } from '../../../socket/emitters';

/**
 * Combined layer for Measure Distance and Wall Drawing tools.
 * Both use the same interaction: click start point, move mouse to see preview, click to finish.
 */
export function MeasureWallLayer() {
  const activeTool = useMapStore((s) => s.activeTool);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);
  const walls = useMapStore((s) => s.walls);
  const isDM = useSessionStore((s) => s.isDM);

  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentPoint, setCurrentPoint] = useState<{ x: number; y: number } | null>(null);

  const isActive = activeTool === 'measure' || (activeTool === 'wall' && isDM);

  // Reset when tool changes
  useEffect(() => {
    setStartPoint(null);
    setCurrentPoint(null);
  }, [activeTool]);

  // Listen for stage clicks via custom events
  useEffect(() => {
    if (!isActive) return;

    const handleStageClick = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const { mapX, mapY } = detail;

      if (!startPoint) {
        // First click - set start
        setStartPoint({ x: mapX, y: mapY });
      } else {
        // Second click - complete
        if (activeTool === 'wall' && isDM) {
          emitWallAdd({ x1: startPoint.x, y1: startPoint.y, x2: mapX, y2: mapY });
        }
        setStartPoint(null);
        setCurrentPoint(null);
      }
    };

    const handleStageMove = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && startPoint) {
        setCurrentPoint({ x: detail.mapX, y: detail.mapY });
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setStartPoint(null);
        setCurrentPoint(null);
        useMapStore.getState().setTool('select');
      }
    };

    window.addEventListener('canvas-click', handleStageClick);
    window.addEventListener('canvas-mousemove', handleStageMove);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('canvas-click', handleStageClick);
      window.removeEventListener('canvas-mousemove', handleStageMove);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isActive, startPoint, activeTool, isDM]);

  if (!isActive) return null;

  const isMeasure = activeTool === 'measure';
  const isWall = activeTool === 'wall';

  // Calculate distance in feet (5ft per grid cell)
  const getDistanceFt = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) / gridSize;
    const dy = (y2 - y1) / gridSize;
    return Math.round(Math.sqrt(dx * dx + dy * dy) * 5);
  };

  // Midpoint for label
  const getMidpoint = (x1: number, y1: number, x2: number, y2: number) => ({
    x: (x1 + x2) / 2,
    y: (y1 + y2) / 2,
  });

  const [draggingWall, setDraggingWall] = useState<{ wallIndex: number; endpoint: 'start' | 'end' } | null>(null);

  return (
    <Layer listening={true}>
      {/* Existing walls with interactive endpoints (wall tool only) */}
      {isWall && walls.map((w, i) => (
        <WallSegmentDisplay
          key={`wall-${i}`}
          wall={w}
          index={i}
          gridSize={gridSize}
          onDeleteWall={(idx) => {
            // Remove wall via socket
            import('../../../socket/emitters').then(({ emitWallRemove }) => {
              emitWallRemove(idx);
            });
          }}
          onDragEndpoint={(idx, endpoint, newX, newY) => {
            // Update wall by removing old and adding new
            import('../../../socket/emitters').then(({ emitWallRemove, emitWallAdd }) => {
              const old = walls[idx];
              emitWallRemove(idx);
              // Small delay to avoid race condition
              setTimeout(() => {
                if (endpoint === 'start') {
                  emitWallAdd({ x1: newX, y1: newY, x2: old.x2, y2: old.y2 });
                } else {
                  emitWallAdd({ x1: old.x1, y1: old.y1, x2: newX, y2: newY });
                }
              }, 50);
            });
          }}
        />
      ))}

      {/* Preview line while drawing */}
      {startPoint && currentPoint && (
        <>
          {/* The line */}
          <Line
            points={[startPoint.x, startPoint.y, currentPoint.x, currentPoint.y]}
            stroke={isMeasure ? '#d4a843' : '#c53131'}
            strokeWidth={isMeasure ? 2 : 4}
            dash={isMeasure ? [8, 4] : undefined}
            opacity={0.9}
            shadowColor={isMeasure ? '#d4a843' : '#c53131'}
            shadowBlur={6}
            shadowEnabled
          />

          {/* Start point dot */}
          <Circle
            x={startPoint.x}
            y={startPoint.y}
            radius={5}
            fill={isMeasure ? '#d4a843' : '#c53131'}
          />

          {/* End point dot */}
          <Circle
            x={currentPoint.x}
            y={currentPoint.y}
            radius={5}
            fill={isMeasure ? '#d4a843' : '#c53131'}
          />

          {/* Distance label */}
          {isMeasure && (() => {
            const dist = getDistanceFt(startPoint.x, startPoint.y, currentPoint.x, currentPoint.y);
            const mid = getMidpoint(startPoint.x, startPoint.y, currentPoint.x, currentPoint.y);
            const cells = Math.round(dist / 5);
            return (
              <>
                {/* Background for text */}
                <Text
                  x={mid.x - 40}
                  y={mid.y - 22}
                  width={80}
                  height={20}
                  text={`${dist} ft (${cells} cells)`}
                  fontSize={18}
                  fontStyle="bold"
                  fill="#d4a843"
                  align="center"
                  shadowColor="#000"
                  shadowBlur={4}
                  shadowEnabled
                />
              </>
            );
          })()}

          {/* Wall length label */}
          {isWall && (() => {
            const dist = getDistanceFt(startPoint.x, startPoint.y, currentPoint.x, currentPoint.y);
            const mid = getMidpoint(startPoint.x, startPoint.y, currentPoint.x, currentPoint.y);
            return (
              <Text
                x={mid.x - 30}
                y={mid.y - 20}
                width={60}
                text={`${dist} ft`}
                fontSize={16}
                fontStyle="bold"
                fill="#c53131"
                align="center"
                shadowColor="#000"
                shadowBlur={4}
                shadowEnabled
              />
            );
          })()}
        </>
      )}

      {/* Instruction text when tool active but no start point */}
      {!startPoint && (
        <Text
          x={10}
          y={10}
          text={isMeasure ? 'Click to set start point (Esc to cancel)' : 'Click to set wall start (Esc to cancel)'}
          fontSize={16}
          fill={isMeasure ? '#d4a843' : '#c53131'}
          opacity={0.8}
          shadowColor="#000"
          shadowBlur={3}
          shadowEnabled
        />
      )}

      {startPoint && (
        <Text
          x={10}
          y={10}
          text={isMeasure ? 'Click to measure (Esc to cancel)' : 'Click to place wall end (Esc to cancel)'}
          fontSize={16}
          fill={isMeasure ? '#d4a843' : '#c53131'}
          opacity={0.8}
          shadowColor="#000"
          shadowBlur={3}
          shadowEnabled
        />
      )}
    </Layer>
  );
}

/** Interactive wall segment with draggable endpoints and right-click context menu */
function WallSegmentDisplay({
  wall, index, gridSize, onDeleteWall, onDragEndpoint,
}: {
  wall: WallSegment;
  index: number;
  gridSize: number;
  onDeleteWall: (index: number) => void;
  onDragEndpoint: (index: number, endpoint: 'start' | 'end', x: number, y: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [liveStart, setLiveStart] = useState({ x: wall.x1, y: wall.y1 });
  const [liveEnd, setLiveEnd] = useState({ x: wall.x2, y: wall.y2 });
  const endpointRadius = 10;

  // Sync with prop changes
  useEffect(() => { setLiveStart({ x: wall.x1, y: wall.y1 }); }, [wall.x1, wall.y1]);
  useEffect(() => { setLiveEnd({ x: wall.x2, y: wall.y2 }); }, [wall.x2, wall.y2]);

  return (
    <Group>
      {/* Wall line - updates live during drag */}
      <Line
        points={[liveStart.x, liveStart.y, liveEnd.x, liveEnd.y]}
        stroke={hovered ? '#ff6666' : '#c53131'}
        strokeWidth={hovered ? 8 : 5}
        opacity={0.85}
        hitStrokeWidth={20}
        lineCap="round"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => {
          e.evt.preventDefault();
          e.evt.stopPropagation();
          // Show wall context menu at cursor position
          const stage = e.target.getStage();
          if (!stage) return;
          const pointer = stage.getPointerPosition();
          if (!pointer) return;
          const container = stage.container().getBoundingClientRect();
          window.dispatchEvent(new CustomEvent('wall-context-menu', {
            detail: {
              screenX: pointer.x + container.left,
              screenY: pointer.y + container.top,
              wallIndex: index,
            }
          }));
        }}
      />

      {/* Start endpoint - draggable, updates line live */}
      <Circle
        x={liveStart.x}
        y={liveStart.y}
        radius={endpointRadius}
        fill="#c53131"
        stroke="#fff"
        strokeWidth={3}
        shadowColor="#000"
        shadowBlur={4}
        shadowEnabled
        draggable
        onDragMove={(e) => {
          setLiveStart({ x: e.target.x(), y: e.target.y() });
        }}
        onDragEnd={(e) => {
          onDragEndpoint(index, 'start', e.target.x(), e.target.y());
        }}
        onMouseEnter={(e) => {
          e.target.scale({ x: 1.3, y: 1.3 });
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'grab';
        }}
        onMouseLeave={(e) => {
          e.target.scale({ x: 1, y: 1 });
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'default';
        }}
      />

      {/* End endpoint - draggable, updates line live */}
      <Circle
        x={liveEnd.x}
        y={liveEnd.y}
        radius={endpointRadius}
        fill="#c53131"
        stroke="#fff"
        strokeWidth={3}
        shadowColor="#000"
        shadowBlur={4}
        shadowEnabled
        draggable
        onDragMove={(e) => {
          setLiveEnd({ x: e.target.x(), y: e.target.y() });
        }}
        onDragEnd={(e) => {
          onDragEndpoint(index, 'end', e.target.x(), e.target.y());
        }}
        onMouseEnter={(e) => {
          e.target.scale({ x: 1.3, y: 1.3 });
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'grab';
        }}
        onMouseLeave={(e) => {
          e.target.scale({ x: 1, y: 1 });
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'default';
        }}
      />
    </Group>
  );
}

/** Wall right-click context menu (delete / toggle visibility) */
export function WallContextMenu() {
  const [menu, setMenu] = useState<{ screenX: number; screenY: number; wallIndex: number } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) setMenu(detail);
    };
    window.addEventListener('wall-context-menu', handler);
    return () => window.removeEventListener('wall-context-menu', handler);
  }, []);

  if (!menu) return null;

  const close = () => setMenu(null);

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        onClick={e => { e.stopPropagation(); e.preventDefault(); close(); }}
        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
        onMouseUp={e => e.stopPropagation()}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); close(); }}
      />
      <div
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: Math.min(menu.screenX, window.innerWidth - 180),
          top: Math.min(menu.screenY, window.innerHeight - 100),
          zIndex: 9999,
          background: theme.bg.deep, border: `1px solid ${theme.border.default}`, borderRadius: theme.radius.md,
          boxShadow: theme.shadow.lg, minWidth: 160,
          fontFamily: theme.font.body, fontSize: 13, color: theme.text.primary,
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '6px 12px', borderBottom: `1px solid ${theme.border.default}`, fontSize: 10, color: theme.text.muted }}>
          Wall #{menu.wallIndex + 1}
        </div>
        <div
          onClick={() => {
            import('../../../socket/emitters').then(({ emitWallRemove }) => {
              emitWallRemove(menu.wallIndex);
            });
            close();
          }}
          style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
          onMouseEnter={e => (e.currentTarget.style.background = '#2a2a2a')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <span>🗑️</span>
          <span style={{ color: '#c53131' }}>Delete Wall</span>
        </div>
      </div>
    </>
  );
}
