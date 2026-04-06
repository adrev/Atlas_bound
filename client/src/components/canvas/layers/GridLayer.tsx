import { useMemo } from 'react';
import { Layer, Line } from 'react-konva';

interface GridLayerProps {
  mapWidth: number;
  mapHeight: number;
  gridSize: number;
  gridOpacity?: number;
  viewport: { x: number; y: number; scaleX: number; scaleY: number };
  stageWidth: number;
  stageHeight: number;
}

export function GridLayer({
  mapWidth,
  mapHeight,
  gridSize,
  gridOpacity = 0.15,
  viewport,
  stageWidth,
  stageHeight,
}: GridLayerProps) {
  const lines = useMemo(() => {
    const scale = viewport.scaleX;
    const offsetX = viewport.x;
    const offsetY = viewport.y;

    // Calculate visible area in map coordinates
    const visibleLeft = Math.max(0, -offsetX / scale);
    const visibleTop = Math.max(0, -offsetY / scale);
    const visibleRight = Math.min(mapWidth, (stageWidth - offsetX) / scale);
    const visibleBottom = Math.min(mapHeight, (stageHeight - offsetY) / scale);

    // Calculate which grid lines to draw
    const startCol = Math.floor(visibleLeft / gridSize);
    const endCol = Math.ceil(visibleRight / gridSize);
    const startRow = Math.floor(visibleTop / gridSize);
    const endRow = Math.ceil(visibleBottom / gridSize);

    const gridLines: { key: string; points: number[] }[] = [];

    // Vertical lines
    for (let col = startCol; col <= endCol; col++) {
      const x = col * gridSize;
      gridLines.push({
        key: `v-${col}`,
        points: [x, Math.max(0, visibleTop), x, Math.min(mapHeight, visibleBottom)],
      });
    }

    // Horizontal lines
    for (let row = startRow; row <= endRow; row++) {
      const y = row * gridSize;
      gridLines.push({
        key: `h-${row}`,
        points: [Math.max(0, visibleLeft), y, Math.min(mapWidth, visibleRight), y],
      });
    }

    return gridLines;
  }, [mapWidth, mapHeight, gridSize, viewport.x, viewport.y, viewport.scaleX, viewport.scaleY, stageWidth, stageHeight]);

  return (
    <Layer listening={false}>
      {lines.map((line) => (
        <Line
          key={line.key}
          points={line.points}
          stroke={`rgba(255, 255, 255, ${gridOpacity})`}
          strokeWidth={1}
          perfectDrawEnabled={false}
          shadowForStrokeEnabled={false}
        />
      ))}
    </Layer>
  );
}
