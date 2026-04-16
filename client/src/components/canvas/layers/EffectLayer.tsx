import { useMemo } from 'react';
import { Group, Rect, Line, Circle, Wedge, Text } from 'react-konva';
import { useMapStore } from '../../../stores/useMapStore';
import { useEffectStore } from '../../../stores/useEffectStore';
import type { AoeType } from '../../../stores/useEffectStore';

// --- Geometry helpers for AoE templates ---

/** Convert AoE size in feet to pixels given gridSize (1 cell = 5ft) */
function feetToPixels(feet: number, gridSize: number): number {
  return (feet / 5) * gridSize;
}

/**
 * Compute which grid cells are affected by an AoE shape.
 * Returns array of { col, row } for cells whose center falls inside the shape.
 */
function getAffectedCells(
  aoeType: AoeType,
  originX: number,
  originY: number,
  sizePixels: number,
  rotation: number,
  gridSize: number,
  mapWidth: number,
  mapHeight: number
): { col: number; row: number }[] {
  const affected: { col: number; row: number }[] = [];
  const cols = Math.ceil(mapWidth / gridSize);
  const rows = Math.ceil(mapHeight / gridSize);

  // Only check cells within bounding box of the AoE (+1 cell buffer)
  const searchRadius = sizePixels + gridSize;
  const minCol = Math.max(0, Math.floor((originX - searchRadius) / gridSize));
  const maxCol = Math.min(cols - 1, Math.ceil((originX + searchRadius) / gridSize));
  const minRow = Math.max(0, Math.floor((originY - searchRadius) / gridSize));
  const maxRow = Math.min(rows - 1, Math.ceil((originY + searchRadius) / gridSize));

  for (let c = minCol; c <= maxCol; c++) {
    for (let r = minRow; r <= maxRow; r++) {
      const cx = c * gridSize + gridSize / 2;
      const cy = r * gridSize + gridSize / 2;

      if (isCellInAoe(aoeType, originX, originY, sizePixels, rotation, cx, cy)) {
        affected.push({ col: c, row: r });
      }
    }
  }

  return affected;
}

function isCellInAoe(
  aoeType: AoeType,
  ox: number,
  oy: number,
  size: number,
  rotation: number,
  cx: number,
  cy: number
): boolean {
  const dx = cx - ox;
  const dy = cy - oy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  switch (aoeType) {
    case 'sphere': {
      return dist <= size;
    }
    case 'cube': {
      // Cube is axis-aligned with side length = size, centered at origin
      const halfSize = size / 2;
      // Rotate point into local space
      const rad = (-rotation * Math.PI) / 180;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      return Math.abs(lx) <= halfSize && Math.abs(ly) <= halfSize;
    }
    case 'cone': {
      // Cone: 53-degree angle (D&D 5e standard), length = size
      if (dist > size) return false;
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      let diff = angle - rotation;
      // Normalize to [-180, 180]
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      return Math.abs(diff) <= 26.5; // half of 53 degrees
    }
    case 'line': {
      // Line: extends from origin in rotation direction, 5ft wide
      const rad = (rotation * Math.PI) / 180;
      const lineDir = { x: Math.cos(rad), y: Math.sin(rad) };
      // Project point onto line direction
      const proj = dx * lineDir.x + dy * lineDir.y;
      if (proj < 0 || proj > size) return false;
      // Perpendicular distance
      const perpDist = Math.abs(dx * lineDir.y - dy * lineDir.x);
      return perpDist <= 5; // ~5px half-width, adjust with grid
    }
  }
}

// --- Spell Template shapes ---

interface SpellTemplateProps {
  aoeType: AoeType;
  x: number;
  y: number;
  sizePixels: number;
  rotation: number;
  color: string;
  gridSize: number;
  mapWidth: number;
  mapHeight: number;
}

function SpellTemplate({
  aoeType,
  x,
  y,
  sizePixels,
  rotation,
  color,
  gridSize,
  mapWidth,
  mapHeight,
}: SpellTemplateProps) {
  const affectedCells = useMemo(
    () =>
      getAffectedCells(
        aoeType,
        x,
        y,
        sizePixels,
        rotation,
        gridSize,
        mapWidth,
        mapHeight
      ),
    [aoeType, x, y, sizePixels, rotation, gridSize, mapWidth, mapHeight]
  );

  return (
    <Group>
      {/* Affected cell highlights */}
      {affectedCells.map((cell) => (
        <Rect
          key={`aoe-${cell.col}-${cell.row}`}
          x={cell.col * gridSize}
          y={cell.row * gridSize}
          width={gridSize}
          height={gridSize}
          fill={color}
          opacity={0.2}
          perfectDrawEnabled={false}
        />
      ))}

      {/* AoE shape outline */}
      {aoeType === 'sphere' && (
        <Circle
          x={x}
          y={y}
          radius={sizePixels}
          stroke={color}
          strokeWidth={2}
          fill={color}
          opacity={0.15}
          dash={[8, 4]}
          shadowColor={color}
          shadowBlur={12}
          shadowEnabled
        />
      )}

      {aoeType === 'cone' && (
        <Wedge
          x={x}
          y={y}
          radius={sizePixels}
          angle={53}
          rotation={rotation - 26.5}
          stroke={color}
          strokeWidth={2}
          fill={color}
          opacity={0.15}
          dash={[8, 4]}
          shadowColor={color}
          shadowBlur={12}
          shadowEnabled
        />
      )}

      {aoeType === 'cube' && (
        <Rect
          x={x - sizePixels / 2}
          y={y - sizePixels / 2}
          width={sizePixels}
          height={sizePixels}
          rotation={rotation}
          offsetX={0}
          offsetY={0}
          stroke={color}
          strokeWidth={2}
          fill={color}
          opacity={0.15}
          dash={[8, 4]}
          shadowColor={color}
          shadowBlur={12}
          shadowEnabled
        />
      )}

      {aoeType === 'line' && (() => {
        const rad = (rotation * Math.PI) / 180;
        const endX = x + Math.cos(rad) * sizePixels;
        const endY = y + Math.sin(rad) * sizePixels;
        const perpX = Math.sin(rad) * 5;
        const perpY = -Math.cos(rad) * 5;
        return (
          <>
            <Line
              points={[
                x + perpX, y + perpY,
                endX + perpX, endY + perpY,
                endX - perpX, endY - perpY,
                x - perpX, y - perpY,
              ]}
              closed
              stroke={color}
              strokeWidth={2}
              fill={color}
              opacity={0.15}
              dash={[8, 4]}
              shadowColor={color}
              shadowBlur={12}
              shadowEnabled
            />
          </>
        );
      })()}

      {/* Origin marker */}
      <Circle
        x={x}
        y={y}
        radius={4}
        fill={color}
        opacity={0.8}
        shadowColor={color}
        shadowBlur={8}
        shadowEnabled
      />

      {/* Size label */}
      <Text
        x={x + 8}
        y={y - 20}
        text={`${Math.round((sizePixels / gridSize) * 5)}ft`}
        fontSize={12}
        fontStyle="bold"
        fill={color}
        shadowColor="black"
        shadowBlur={4}
        shadowEnabled
      />
    </Group>
  );
}

// --- Main EffectLayer ---

export function EffectLayer() {
  const currentMap = useMapStore((s) => s.currentMap);
  const targetingSpell = useEffectStore((s) => s.targetingSpell);
  const targetPosition = useEffectStore((s) => s.targetPosition);
  const targetRotation = useEffectStore((s) => s.targetRotation);

  if (!currentMap) return null;

  const gridSize = currentMap.gridSize;

  return (
    <Group listening={false}>
      {/* Spell targeting template */}
      {targetingSpell && targetPosition && (
        <SpellTemplate
          aoeType={targetingSpell.aoeType}
          x={targetPosition.x}
          y={targetPosition.y}
          sizePixels={feetToPixels(targetingSpell.aoeSize, gridSize)}
          rotation={targetRotation}
          color={targetingSpell.color}
          gridSize={gridSize}
          mapWidth={currentMap.width}
          mapHeight={currentMap.height}
        />
      )}
    </Group>
  );
}
