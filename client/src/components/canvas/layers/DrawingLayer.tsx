import { useEffect, useState } from 'react';
import { Layer, Line, Rect, Circle, Arrow, Text, Group } from 'react-konva';
import type { Drawing, DrawingGeometry, DrawingKind } from '@dnd-vtt/shared';
import { useDrawStore, type PreviewDrawing } from '../../../stores/useDrawStore';
import { useSessionStore } from '../../../stores/useSessionStore';

/**
 * DrawingLayer — renders all DM / player annotations on top of
 * tokens + effects. Visible drawings are filtered by visibility for
 * the current user; streamed preview strokes from other users are
 * rendered at reduced opacity while they're in flight.
 *
 * Click handling: when the active tool is 'select' and the layer is
 * in draw mode, clicking on a shape selects it (the DrawToolbar then
 * handles delete).
 */
export function DrawingLayer() {
  const drawings = useDrawStore((s) => s.drawings);
  const previews = useDrawStore((s) => s.previews);
  const inProgress = useDrawStore((s) => s.drawingInProgress);
  const selectedId = useDrawStore((s) => s.selectedDrawingId);
  const isDrawMode = useDrawStore((s) => s.isDrawMode);
  const activeTool = useDrawStore((s) => s.activeTool);
  const userId = useSessionStore((s) => s.userId);
  const isDM = useSessionStore((s) => s.isDM);

  // Tick every ~100ms so ephemeral fades animate smoothly without
  // re-rendering the whole canvas every frame.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const hasEphemeral = Object.values(drawings).some((d) => d.fadeAfterMs != null);
    if (!hasEphemeral) return;
    const interval = setInterval(() => forceTick((t) => t + 1), 100);
    return () => clearInterval(interval);
  }, [drawings]);

  // Filter by visibility. `shared` → always; `dm-only` → DMs only;
  // `player-only` → creator + DMs.
  const visible = Object.values(drawings).filter((d) => {
    if (d.visibility === 'shared') return true;
    if (d.visibility === 'dm-only') return isDM;
    return d.creatorUserId === userId || isDM;
  });

  const selectable = isDrawMode && activeTool === 'select';

  return (
    <Layer listening={selectable}>
      {/* Committed drawings */}
      {visible.map((d) => (
        <DrawingShape
          key={d.id}
          drawing={d}
          opacity={computeOpacity(d)}
          selected={d.id === selectedId}
          selectable={selectable}
        />
      ))}

      {/* Streamed previews from other users */}
      {Object.values(previews).map((p) => (
        <PreviewShape key={p.tempId} preview={p} />
      ))}

      {/* Current user's in-progress stroke */}
      {inProgress && (
        <DrawingShape
          drawing={{
            id: 'in-progress',
            mapId: '',
            creatorUserId: userId ?? '',
            creatorRole: isDM ? 'dm' : 'player',
            kind: inProgress.kind,
            visibility: inProgress.visibility,
            color: inProgress.color,
            strokeWidth: inProgress.strokeWidth,
            geometry: inProgress.geometry,
            gridSnapped: inProgress.gridSnapped,
            createdAt: Date.now(),
            fadeAfterMs: null,
          }}
          opacity={1}
        />
      )}
    </Layer>
  );
}

/**
 * Ephemeral drawings fade out over the last 2s of their lifetime.
 * Permanent drawings always return 1.0.
 */
function computeOpacity(d: Drawing): number {
  if (d.fadeAfterMs == null) return 1;
  const remaining = d.createdAt + d.fadeAfterMs - Date.now();
  if (remaining <= 0) return 0;
  if (remaining >= 2000) return 1;
  return remaining / 2000;
}

/**
 * Renders a single committed Drawing (or an in-progress preview) as
 * the appropriate Konva shape. Selection ring is added underneath
 * when `selected` is true.
 */
function DrawingShape({
  drawing,
  opacity,
  selected,
  selectable,
}: {
  drawing: Drawing;
  opacity: number;
  selected?: boolean;
  selectable?: boolean;
}) {
  const onClick = selectable
    ? () => useDrawStore.getState().selectDrawing(drawing.id)
    : undefined;

  return (
    <Group
      opacity={opacity}
      onClick={onClick}
      onTap={onClick}
      listening={selectable}
    >
      {selected && <SelectionRing drawing={drawing} />}
      {renderShape(drawing)}
    </Group>
  );
}

function renderShape(drawing: Drawing) {
  const { kind, geometry, color, strokeWidth } = drawing;

  if ((kind === 'freehand' || kind === 'ephemeral') && geometry.points) {
    return (
      <Line
        points={geometry.points}
        stroke={color}
        strokeWidth={strokeWidth}
        lineCap="round"
        lineJoin="round"
        tension={0.4}
      />
    );
  }

  if (kind === 'rect' && geometry.rect) {
    const r = geometry.rect;
    return (
      <Rect
        x={r.x}
        y={r.y}
        width={r.width}
        height={r.height}
        stroke={color}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (kind === 'circle' && geometry.circle) {
    const c = geometry.circle;
    return (
      <Circle
        x={c.x}
        y={c.y}
        radius={c.radius}
        stroke={color}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (kind === 'line' && geometry.points) {
    return (
      <Line
        points={geometry.points}
        stroke={color}
        strokeWidth={strokeWidth}
        lineCap="round"
      />
    );
  }

  if (kind === 'arrow' && geometry.points) {
    return (
      <Arrow
        points={geometry.points}
        stroke={color}
        fill={color}
        strokeWidth={strokeWidth}
        pointerLength={Math.max(10, strokeWidth * 3)}
        pointerWidth={Math.max(10, strokeWidth * 3)}
      />
    );
  }

  if (kind === 'text' && geometry.text) {
    return (
      <Text
        x={geometry.text.x}
        y={geometry.text.y}
        text={geometry.text.content}
        fontSize={geometry.text.fontSize}
        fill={color}
        fontStyle="bold"
        shadowColor="#000"
        shadowBlur={3}
        shadowOpacity={0.6}
      />
    );
  }

  return null;
}

/**
 * Selection ring — draws an oversized dashed outline around the
 * selected drawing's bounding geometry so the DM knows what they've
 * got targeted.
 */
function SelectionRing({ drawing }: { drawing: Drawing }) {
  const ring = getSelectionBounds(drawing);
  if (!ring) return null;
  return (
    <Rect
      x={ring.x - 4}
      y={ring.y - 4}
      width={ring.width + 8}
      height={ring.height + 8}
      stroke="#d4a843"
      strokeWidth={2}
      dash={[6, 4]}
      listening={false}
    />
  );
}

function getSelectionBounds(d: Drawing): { x: number; y: number; width: number; height: number } | null {
  const g = d.geometry;
  if (g.rect) return g.rect;
  if (g.circle) {
    return {
      x: g.circle.x - g.circle.radius,
      y: g.circle.y - g.circle.radius,
      width: g.circle.radius * 2,
      height: g.circle.radius * 2,
    };
  }
  if (g.points && g.points.length >= 2) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < g.points.length; i += 2) {
      const x = g.points[i];
      const y = g.points[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  if (g.text) {
    // Approximate text bounds. Konva.Text measures better but we
    // don't have a ref here; a small fixed box is fine for a
    // selection hint.
    const w = g.text.content.length * g.text.fontSize * 0.6;
    return { x: g.text.x, y: g.text.y, width: w, height: g.text.fontSize + 4 };
  }
  return null;
}

/**
 * Render a streamed preview from another user at 75% opacity and
 * use the same shape vocabulary as committed drawings.
 */
function PreviewShape({ preview }: { preview: PreviewDrawing }) {
  const drawing: Drawing = {
    id: preview.tempId,
    mapId: '',
    creatorUserId: preview.creatorUserId,
    creatorRole: 'player',
    kind: preview.kind,
    visibility: 'shared',
    color: preview.color,
    strokeWidth: preview.strokeWidth,
    geometry: preview.geometry,
    gridSnapped: false,
    createdAt: preview.receivedAt,
    fadeAfterMs: null,
  };
  return <Group opacity={0.75}>{renderShape(drawing)}</Group>;
}
