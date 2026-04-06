import { useMemo } from 'react';
import { Layer, Group, Rect, Line, Text, Circle } from 'react-konva';
import { useMapStore } from '../../../stores/useMapStore';
import { useEffectStore } from '../../../stores/useEffectStore';
import { useCombatStore } from '../../../stores/useCombatStore';
import { gridToPixel } from '@dnd-vtt/shared';

// BG3-inspired movement range colors
const COLORS = {
  reachable: 'rgba(50, 205, 100, 0.22)',
  reachableBorder: 'rgba(50, 205, 100, 0.35)',
  dash: 'rgba(230, 180, 40, 0.18)',
  dashBorder: 'rgba(230, 180, 40, 0.30)',
  pathLine: '#32cd64',
  pathLineShadow: 'rgba(50, 205, 100, 0.5)',
  pathDot: '#ffffff',
  distanceBg: 'rgba(10, 10, 18, 0.85)',
  distanceText: '#e8e6e3',
  distanceGood: '#32cd64',
  distanceDash: '#e6b428',
  distanceOver: '#c0392b',
} as const;

export function MovementRangeLayer() {
  const currentMap = useMapStore((s) => s.currentMap);
  const showMovementRange = useEffectStore((s) => s.showMovementRange);
  const reachableCells = useEffectStore((s) => s.reachableCells);
  const dashReachableCells = useEffectStore((s) => s.dashReachableCells);
  const movementPath = useEffectStore((s) => s.movementPath);
  const actionEconomy = useCombatStore((s) => s.actionEconomy);

  const gridSize = currentMap?.gridSize ?? 70;
  const gridOffsetX = currentMap?.gridOffsetX ?? 0;
  const gridOffsetY = currentMap?.gridOffsetY ?? 0;
  const feetPerCell = 5;

  // Build a set of reachable cell keys for fast lookup
  const reachableSet = useMemo(() => {
    const set = new Set<string>();
    for (const cell of reachableCells) {
      set.add(`${cell.col},${cell.row}`);
    }
    return set;
  }, [reachableCells]);

  // Convert movement path to pixel coordinates (cell centers)
  const pathPoints = useMemo(() => {
    if (movementPath.length < 2) return [];
    return movementPath.map((cell) => {
      const pos = gridToPixel(cell.col, cell.row, gridSize, gridOffsetX, gridOffsetY);
      return { x: pos.x + gridSize / 2, y: pos.y + gridSize / 2 };
    });
  }, [movementPath, gridSize, gridOffsetX, gridOffsetY]);

  // Flatten for Konva Line
  const pathLinePoints = useMemo(
    () => pathPoints.flatMap((p) => [p.x, p.y]),
    [pathPoints]
  );

  // Distance calculation: count cells in path (approximating diagonals)
  const pathDistanceFeet = useMemo(() => {
    if (movementPath.length < 2) return 0;
    let totalCost = 0;
    for (let i = 1; i < movementPath.length; i++) {
      const dc = Math.abs(movementPath[i].col - movementPath[i - 1].col);
      const dr = Math.abs(movementPath[i].row - movementPath[i - 1].row);
      const isDiagonal = dc !== 0 && dr !== 0;
      totalCost += isDiagonal ? 1.5 : 1;
    }
    return Math.round(totalCost * feetPerCell);
  }, [movementPath]);

  // Determine distance label color
  const distanceColor = useMemo(() => {
    if (pathDistanceFeet <= actionEconomy.movementRemaining) {
      return COLORS.distanceGood;
    }
    if (pathDistanceFeet <= actionEconomy.movementRemaining + actionEconomy.movementMax) {
      return COLORS.distanceDash;
    }
    return COLORS.distanceOver;
  }, [pathDistanceFeet, actionEconomy.movementRemaining, actionEconomy.movementMax]);

  if (!currentMap || !showMovementRange) return null;

  return (
    <Layer listening={false}>
      {/* Normal movement range cells (green) */}
      {reachableCells.map((cell) => {
        const pos = gridToPixel(cell.col, cell.row, gridSize, gridOffsetX, gridOffsetY);
        return (
          <Rect
            key={`mv-${cell.col}-${cell.row}`}
            x={pos.x + 1}
            y={pos.y + 1}
            width={gridSize - 2}
            height={gridSize - 2}
            fill={COLORS.reachable}
            stroke={COLORS.reachableBorder}
            strokeWidth={1}
            cornerRadius={2}
            perfectDrawEnabled={false}
          />
        );
      })}

      {/* Dash range cells (yellow/orange) -- only those not already in normal range */}
      {dashReachableCells.map((cell) => {
        const key = `${cell.col},${cell.row}`;
        if (reachableSet.has(key)) return null;
        const pos = gridToPixel(cell.col, cell.row, gridSize, gridOffsetX, gridOffsetY);
        return (
          <Rect
            key={`dash-${cell.col}-${cell.row}`}
            x={pos.x + 1}
            y={pos.y + 1}
            width={gridSize - 2}
            height={gridSize - 2}
            fill={COLORS.dash}
            stroke={COLORS.dashBorder}
            strokeWidth={1}
            cornerRadius={2}
            perfectDrawEnabled={false}
          />
        );
      })}

      {/* Movement path line */}
      {pathLinePoints.length >= 4 && (
        <Group>
          {/* Path shadow/glow */}
          <Line
            points={pathLinePoints}
            stroke={COLORS.pathLineShadow}
            strokeWidth={6}
            lineCap="round"
            lineJoin="round"
            perfectDrawEnabled={false}
          />
          {/* Path line */}
          <Line
            points={pathLinePoints}
            stroke={COLORS.pathLine}
            strokeWidth={2.5}
            lineCap="round"
            lineJoin="round"
            dash={[8, 6]}
            perfectDrawEnabled={false}
          />

          {/* Waypoint dots along path */}
          {pathPoints.map((p, i) => {
            // Only show dots at start, end, and every few cells
            if (i !== 0 && i !== pathPoints.length - 1 && i % 3 !== 0) return null;
            return (
              <Circle
                key={`wp-${i}`}
                x={p.x}
                y={p.y}
                radius={i === pathPoints.length - 1 ? 4 : 2.5}
                fill={COLORS.pathDot}
                opacity={i === pathPoints.length - 1 ? 0.9 : 0.5}
                perfectDrawEnabled={false}
              />
            );
          })}
        </Group>
      )}

      {/* Distance label at the end of the path */}
      {pathPoints.length >= 2 && pathDistanceFeet > 0 && (() => {
        const endPoint = pathPoints[pathPoints.length - 1];
        const labelText = `${pathDistanceFeet} ft`;
        const labelWidth = labelText.length * 7 + 16;
        return (
          <Group x={endPoint.x + 12} y={endPoint.y - 24}>
            {/* Background pill */}
            <Rect
              x={0}
              y={0}
              width={labelWidth}
              height={22}
              fill={COLORS.distanceBg}
              cornerRadius={11}
              stroke={distanceColor}
              strokeWidth={1}
              shadowColor="rgba(0,0,0,0.5)"
              shadowBlur={4}
              shadowOffset={{ x: 0, y: 2 }}
              shadowEnabled
            />
            {/* Distance text */}
            <Text
              x={0}
              y={4}
              width={labelWidth}
              align="center"
              text={labelText}
              fontSize={12}
              fontStyle="bold"
              fill={distanceColor}
            />
          </Group>
        );
      })()}
    </Layer>
  );
}
