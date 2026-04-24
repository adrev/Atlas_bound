import { useEffect, useState } from 'react';
import { Line, Rect, Circle, Arrow, Text, Group, Wedge } from 'react-konva';
import type Konva from 'konva';
import type { Drawing, DrawingGeometry, DrawingKind } from '@dnd-vtt/shared';
import { useDrawStore, type PreviewDrawing } from '../../../stores/useDrawStore';
import { useSessionStore } from '../../../stores/useSessionStore';
import { emitDrawingUpdate } from '../../../socket/emitters';

/**
 * Element-to-gradient palette for the `aoe-*` drawings. Keyed off
 * `geometry.element` so the DM's "Fireball" reads hot orange while
 * "Cone of Cold" reads cold cyan. Falls back to `color` when the
 * element isn't provided (legacy drawings without an element hint).
 */
const AOE_PALETTE: Record<string, { fill: string; stroke: string; glow: string }> = {
  fire:      { fill: 'rgba(255, 140, 40, 0.40)',  stroke: 'rgba(255, 100, 20, 0.9)',   glow: '#ff6a20' },
  cold:      { fill: 'rgba(180, 220, 255, 0.40)', stroke: 'rgba(120, 180, 240, 0.9)',  glow: '#a0c8ff' },
  lightning: { fill: 'rgba(255, 255, 180, 0.40)', stroke: 'rgba(200, 220, 255, 0.9)',  glow: '#ffffa0' },
  acid:      { fill: 'rgba(160, 220, 60, 0.40)',  stroke: 'rgba(110, 180, 40, 0.9)',   glow: '#a0dc3c' },
  poison:    { fill: 'rgba(110, 180, 70, 0.40)',  stroke: 'rgba(60, 130, 50, 0.9)',    glow: '#6eb446' },
  radiant:   { fill: 'rgba(255, 230, 140, 0.40)', stroke: 'rgba(230, 200, 100, 0.9)',  glow: '#ffe68c' },
  necrotic:  { fill: 'rgba(120, 60, 140, 0.45)',  stroke: 'rgba(60, 30, 80, 0.9)',     glow: '#783c8c' },
  thunder:   { fill: 'rgba(200, 220, 255, 0.40)', stroke: 'rgba(140, 160, 200, 0.9)',  glow: '#c8dcff' },
  force:     { fill: 'rgba(230, 210, 255, 0.40)', stroke: 'rgba(170, 140, 230, 0.9)',  glow: '#e6d2ff' },
  psychic:   { fill: 'rgba(255, 180, 220, 0.40)', stroke: 'rgba(200, 120, 180, 0.9)',  glow: '#ffb4dc' },
  neutral:   { fill: 'rgba(220, 220, 230, 0.35)', stroke: 'rgba(180, 180, 200, 0.8)',  glow: '#dcdce6' },
};

function aoeStyle(drawing: Drawing): { fill: string; stroke: string; glow: string } {
  const el = drawing.geometry.element;
  if (el && AOE_PALETTE[el]) return AOE_PALETTE[el];
  // Fallback: use drawing.color (hex) for all three slots with different alphas.
  const hex = drawing.color.replace('#', '');
  const r = parseInt(hex.slice(0, 2) || '80', 16);
  const g = parseInt(hex.slice(2, 4) || '80', 16);
  const b = parseInt(hex.slice(4, 6) || '80', 16);
  return {
    fill: `rgba(${r}, ${g}, ${b}, 0.35)`,
    stroke: `rgba(${r}, ${g}, ${b}, 0.9)`,
    glow: drawing.color,
  };
}

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

  // Now nested inside BattleMap's `<Layer>` for tools — that parent
  // layer is always listening, but each drawing shape opts in/out
  // individually via the `selectable` flag passed below. The previous
  // `<Layer listening={selectable}>` toggling moves to per-shape now.
  return (
    <Group listening={selectable}>
      {/* Committed drawings */}
      {visible.map((d) => (
        <DrawingShape
          key={d.id}
          drawing={d}
          opacity={computeOpacity(d)}
          selected={d.id === selectedId}
          selectable={selectable}
          // DM can reposition anything; players can only drag drawings
          // they authored themselves. Drag is only armed while the
          // select tool is active (Draw Mode → Select) so a normal
          // token-drag session doesn't accidentally pick up a nearby
          // drawing.
          draggable={selectable && (isDM || d.creatorUserId === userId)}
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
    </Group>
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
  draggable,
}: {
  drawing: Drawing;
  opacity: number;
  selected?: boolean;
  selectable?: boolean;
  draggable?: boolean;
}) {
  const onClick = selectable
    ? () => useDrawStore.getState().selectDrawing(drawing.id)
    : undefined;

  // When the user drops the drawing we compute the delta the Group has
  // moved (Konva translates the whole Group during drag) and apply
  // that offset to every geometry field, then reset the Group back to
  // origin so the shape's own coordinates are authoritative again.
  // The store is updated optimistically; the server broadcast just
  // echoes what we already did.
  const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    if (dx === 0 && dy === 0) return;
    const nextGeometry = translateGeometry(drawing.geometry, dx, dy);
    node.position({ x: 0, y: 0 });
    useDrawStore.getState().applyDrawingUpdate(drawing.id, nextGeometry);
    emitDrawingUpdate(drawing.id, nextGeometry);
  };

  return (
    <Group
      opacity={opacity}
      onClick={onClick}
      onTap={onClick}
      listening={selectable}
      draggable={draggable}
      onDragEnd={draggable ? handleDragEnd : undefined}
    >
      {selected && <SelectionRing drawing={drawing} />}
      {renderShape(drawing)}
    </Group>
  );
}

// Translate every coordinate field of a DrawingGeometry by (dx, dy).
// Works uniformly across freehand points, rect / circle / text origins.
function translateGeometry(g: Drawing['geometry'], dx: number, dy: number): Drawing['geometry'] {
  const next: Drawing['geometry'] = {};
  if (g.points) {
    const out: number[] = new Array(g.points.length);
    for (let i = 0; i < g.points.length; i += 2) {
      out[i] = g.points[i] + dx;
      out[i + 1] = g.points[i + 1] + dy;
    }
    next.points = out;
  }
  if (g.rect) next.rect = { ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy };
  if (g.circle) next.circle = { ...g.circle, x: g.circle.x + dx, y: g.circle.y + dy };
  if (g.text) next.text = { ...g.text, x: g.text.x + dx, y: g.text.y + dy };
  return next;
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

  // ── Filled AoE footprints ─────────────────────────────────────
  // Render each with element-tinted fill + rim stroke + soft glow so
  // a dropped fireball actually reads "this is a fire effect" at a
  // glance. Style lookup lives in aoeStyle() above.
  if (kind === 'aoe-sphere' && geometry.circle) {
    const style = aoeStyle(drawing);
    const c = geometry.circle;
    return (
      <Circle
        x={c.x}
        y={c.y}
        radius={c.radius}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={2}
        shadowColor={style.glow}
        shadowBlur={16}
        shadowEnabled
      />
    );
  }

  if (kind === 'aoe-cone' && geometry.cone) {
    const style = aoeStyle(drawing);
    const w = geometry.cone;
    return (
      <Wedge
        x={w.x}
        y={w.y}
        radius={w.radius}
        angle={53}
        rotation={w.rotation - 26.5}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={2}
        shadowColor={style.glow}
        shadowBlur={16}
        shadowEnabled
      />
    );
  }

  if (kind === 'aoe-cube' && geometry.orientedRect) {
    const style = aoeStyle(drawing);
    const r = geometry.orientedRect;
    return (
      <Rect
        x={r.x}
        y={r.y}
        width={r.width}
        height={r.height}
        offsetX={r.width / 2}
        offsetY={r.height / 2}
        rotation={r.rotation}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={2}
        shadowColor={style.glow}
        shadowBlur={16}
        shadowEnabled
      />
    );
  }

  if (kind === 'aoe-line' && geometry.points && geometry.points.length >= 4) {
    // Two-point payload: [x1,y1,x2,y2]. Render as a thick rounded
    // strip (5 ft wide) instead of a hair-thin stroke.
    const style = aoeStyle(drawing);
    return (
      <Line
        points={geometry.points}
        stroke={style.fill}
        strokeWidth={Math.max(strokeWidth, 18)}
        lineCap="round"
        lineJoin="round"
        shadowColor={style.glow}
        shadowBlur={16}
        shadowEnabled
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
