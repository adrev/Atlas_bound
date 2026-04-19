import { create } from 'zustand';
import type {
  Drawing, DrawingKind, DrawingVisibility, DrawingGeometry,
  DrawingStreamPayload,
} from '@dnd-vtt/shared';

/**
 * useDrawStore — all state for the DM / player drawing tool.
 *
 * Contains:
 *   - current "draw mode" on/off flag and the active tool/color/width
 *   - committed drawings for the current map (server-authoritative)
 *   - the current user's in-progress stroke (local only until commit)
 *   - streamed previews from other users (live-ghost strokes)
 *   - selection + undo/redo stacks (per-session, in-memory only)
 *
 * Network side-effects (emit events) are handled in socket/emitters.ts
 * and wired into the actions here via lazy imports to avoid circular
 * dependencies between the store module and the emitter module.
 */

export type ActiveDrawTool =
  | 'select'
  | 'freehand'
  | 'rect'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'text'
  | 'ephemeral';

/** Default lifetime for ephemeral strokes, in milliseconds. */
export const EPHEMERAL_FADE_MS = 10000;

/**
 * Preset color swatches shown in the toolbar. First swatch is the
 * default on draw-mode entry.
 */
export const DRAW_COLOR_PRESETS = [
  '#ff3b3b', // red
  '#3bb9ff', // blue
  '#3bff6a', // green
  '#ffe03b', // yellow
  '#ff8c3b', // orange
  '#c93bff', // purple
  '#ffffff', // white
  '#1a1a1a', // black
];

/**
 * An undoable operation. Only tracks operations the CURRENT user
 * performed — we never undo another user's work. Each op reliably
 * inverts through the same server events:
 *   create → delete; delete → create.
 */
type UndoOp =
  | { type: 'create'; drawing: Drawing }
  | { type: 'delete'; drawing: Drawing };

/** Shape of streamed previews held in the store. */
export interface PreviewDrawing {
  tempId: string;
  creatorUserId: string;
  kind: DrawingKind;
  color: string;
  strokeWidth: number;
  geometry: DrawingGeometry;
  receivedAt: number;
}

interface DrawStore {
  // Draw mode state
  isDrawMode: boolean;
  activeTool: ActiveDrawTool;
  activeColor: string;
  activeWidth: number;
  activeVisibility: DrawingVisibility;
  gridSnap: boolean;

  // Committed drawings for the CURRENT map. Cleared when a new map is
  // loaded; rehydrated via loadDrawings() from the server.
  drawings: Record<string, Drawing>;

  // In-progress stroke by THIS user. Rendered by DrawingLayer as a
  // live preview; becomes a committed drawing on commitStroke().
  drawingInProgress: {
    tempId: string;
    kind: DrawingKind;
    color: string;
    strokeWidth: number;
    visibility: DrawingVisibility;
    geometry: DrawingGeometry;
    gridSnapped: boolean;
    startX?: number;
    startY?: number;
  } | null;

  // Preview strokes streamed from OTHER users, keyed by tempId.
  previews: Record<string, PreviewDrawing>;

  // Selection (only in draw mode, for the select tool)
  selectedDrawingId: string | null;

  // Undo / redo stacks. Only the current user's own operations.
  undoStack: UndoOp[];
  redoStack: UndoOp[];

  // ── Actions ────────────────────────────────────────────────────

  enterDrawMode(): void;
  exitDrawMode(): void;
  setTool(tool: ActiveDrawTool): void;
  setColor(color: string): void;
  setWidth(width: number): void;
  setVisibility(v: DrawingVisibility): void;
  toggleGridSnap(): void;

  /** Start a new stroke at the given world coordinates. */
  beginStroke(x: number, y: number): void;
  /** Update the in-progress stroke as the cursor moves. */
  updateStroke(x: number, y: number): void;
  /** Commit the in-progress stroke as a permanent (or ephemeral)
   *  drawing. Emits to the server and pushes to undoStack. */
  commitStroke(opts?: { textContent?: string }): void;
  /** Throw away the in-progress stroke without committing. */
  cancelStroke(): void;

  // Applied from server broadcasts
  addDrawing(d: Drawing): void;
  removeDrawing(id: string): void;
  /**
   * Apply a geometry-only update to an existing drawing. Used by both
   * the local drag handler (optimistic) and the `drawing:updated`
   * socket listener. No-op if the id is unknown.
   */
  applyDrawingUpdate(id: string, geometry: Drawing['geometry']): void;
  loadDrawings(list: Drawing[]): void;
  clearAllLocal(scope: 'all' | 'mine', userId?: string, currentUserId?: string): void;

  // Preview handling (from other users' streams)
  setPreview(p: DrawingStreamPayload): void;
  clearPreview(tempId: string): void;

  // Selection + per-shape delete
  selectDrawing(id: string | null): void;
  deleteSelected(): void;

  // Undo / redo
  undo(): void;
  redo(): void;
}

/** Helper: make a random local id for tempIds / drawing ids. */
function randomId(): string {
  return (
    (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID())
    || Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
}

/**
 * Lazy import the emitters so this store file doesn't create a
 * circular dep with socket/emitters (which imports stores in turn).
 */
async function getEmitters() {
  return await import('../socket/emitters');
}

/**
 * Lazy import the session store for the current user id/role when
 * we need it for building Drawings server-side.
 */
async function getSessionInfo(): Promise<{ userId: string; isDM: boolean }> {
  const { useSessionStore } = await import('./useSessionStore');
  const s = useSessionStore.getState();
  return { userId: s.userId ?? '', isDM: !!s.isDM };
}

/**
 * Lazy import the map store for the current mapId + grid info when we
 * need to grid-snap shape endpoints or tag new drawings.
 */
async function getMapInfo(): Promise<{
  mapId: string | null;
  gridSize: number;
  gridOffsetX: number;
  gridOffsetY: number;
}> {
  const { useMapStore } = await import('./useMapStore');
  const s = useMapStore.getState();
  return {
    mapId: s.currentMap?.id ?? null,
    gridSize: s.currentMap?.gridSize ?? 70,
    gridOffsetX: s.currentMap?.gridOffsetX ?? 0,
    gridOffsetY: s.currentMap?.gridOffsetY ?? 0,
  };
}

/**
 * Round a coordinate to the nearest grid cell corner. Used by the
 * rect / circle tools when grid-snap is enabled. Grid snapping lives
 * in @dnd-vtt/shared but that helper snaps to cell centers, while we
 * want corners for shape endpoints.
 */
function snapCornerToGrid(
  x: number,
  y: number,
  gridSize: number,
  offsetX: number,
  offsetY: number,
): { x: number; y: number } {
  const sx = Math.round((x - offsetX) / gridSize) * gridSize + offsetX;
  const sy = Math.round((y - offsetY) / gridSize) * gridSize + offsetY;
  return { x: sx, y: sy };
}

export const useDrawStore = create<DrawStore>((set, get) => ({
  isDrawMode: false,
  activeTool: 'freehand',
  activeColor: DRAW_COLOR_PRESETS[0],
  activeWidth: 3,
  activeVisibility: 'shared',
  gridSnap: false,

  drawings: {},
  drawingInProgress: null,
  previews: {},
  selectedDrawingId: null,
  undoStack: [],
  redoStack: [],

  enterDrawMode: () => {
    set({
      isDrawMode: true,
      activeTool: 'freehand',
      drawingInProgress: null,
      selectedDrawingId: null,
    });
  },

  exitDrawMode: () => {
    set({
      isDrawMode: false,
      drawingInProgress: null,
      selectedDrawingId: null,
      // Clear undo stacks — undo is only meaningful during the
      // current draw session. Once you leave, history resets.
      undoStack: [],
      redoStack: [],
    });
  },

  setTool: (tool) => set({ activeTool: tool, selectedDrawingId: null }),
  setColor: (color) => set({ activeColor: color }),
  setWidth: (width) => set({ activeWidth: Math.max(0.5, Math.min(64, width)) }),
  setVisibility: (v) => set({ activeVisibility: v }),
  toggleGridSnap: () => set((s) => ({ gridSnap: !s.gridSnap })),

  beginStroke: (x, y) => {
    const state = get();
    if (!state.isDrawMode) return;
    if (state.activeTool === 'select' || state.activeTool === 'text') return;

    const tool = state.activeTool;
    const kind: DrawingKind =
      tool === 'freehand' ? 'freehand'
      : tool === 'rect' ? 'rect'
      : tool === 'circle' ? 'circle'
      : tool === 'line' ? 'line'
      : tool === 'arrow' ? 'arrow'
      : tool === 'ephemeral' ? 'ephemeral'
      : 'freehand';

    const geometry: DrawingGeometry = {};
    if (kind === 'freehand' || kind === 'ephemeral') {
      geometry.points = [x, y];
    } else if (kind === 'rect') {
      geometry.rect = { x, y, width: 0, height: 0 };
    } else if (kind === 'circle') {
      geometry.circle = { x, y, radius: 0 };
    } else if (kind === 'line' || kind === 'arrow') {
      geometry.points = [x, y, x, y];
    }

    set({
      drawingInProgress: {
        tempId: randomId(),
        kind,
        color: state.activeColor,
        strokeWidth: state.activeWidth,
        visibility: state.activeVisibility,
        geometry,
        gridSnapped: state.gridSnap && (kind === 'rect' || kind === 'circle'),
        startX: x,
        startY: y,
      },
    });
  },

  updateStroke: (x, y) => {
    const state = get();
    const inProg = state.drawingInProgress;
    if (!inProg) return;

    let geometry: DrawingGeometry = inProg.geometry;

    if (inProg.kind === 'freehand' || inProg.kind === 'ephemeral') {
      const points = geometry.points ? [...geometry.points, x, y] : [x, y];
      geometry = { points };
    } else if (inProg.kind === 'rect') {
      const startX = inProg.startX ?? x;
      const startY = inProg.startY ?? y;
      const rx = Math.min(startX, x);
      const ry = Math.min(startY, y);
      let rw = Math.abs(x - startX);
      let rh = Math.abs(y - startY);
      if (inProg.gridSnapped) {
        // Re-snap the current corner to the nearest grid cell.
        // We can't look up grid size sync, so use a cached copy if
        // the store kicks us ahead of a store lookup — fallback to
        // the raw value and let commitStroke do the final snap.
      }
      geometry = { rect: { x: rx, y: ry, width: rw, height: rh } };
    } else if (inProg.kind === 'circle') {
      const cx = inProg.startX ?? x;
      const cy = inProg.startY ?? y;
      const dx = x - cx;
      const dy = y - cy;
      const radius = Math.sqrt(dx * dx + dy * dy);
      geometry = { circle: { x: cx, y: cy, radius } };
    } else if (inProg.kind === 'line' || inProg.kind === 'arrow') {
      const startX = inProg.startX ?? x;
      const startY = inProg.startY ?? y;
      geometry = { points: [startX, startY, x, y] };
    }

    set({
      drawingInProgress: { ...inProg, geometry },
    });
  },

  commitStroke: (_opts) => {
    const state = get();
    const inProg = state.drawingInProgress;
    if (!inProg && state.activeTool !== 'text') return;

    (async () => {
      const { userId, isDM } = await getSessionInfo();
      if (!userId) return;
      const { mapId, gridSize, gridOffsetX, gridOffsetY } = await getMapInfo();
      if (!mapId) return;

      // Text tool is a special case — commitStroke is called directly
      // with no in-progress stroke because the tool is single-click-
      // and-type. The DrawToolbar / BattleMap set up the text via a
      // synthetic in-progress stroke before calling this.
      let kind: DrawingKind;
      let color: string;
      let strokeWidth: number;
      let visibility: DrawingVisibility;
      let geometry: DrawingGeometry;
      let gridSnapped: boolean;

      if (inProg) {
        kind = inProg.kind;
        color = inProg.color;
        strokeWidth = inProg.strokeWidth;
        visibility = inProg.visibility;
        geometry = inProg.geometry;
        gridSnapped = inProg.gridSnapped;
      } else {
        return;
      }

      // If grid-snap was requested for a rect/circle, snap the final
      // endpoints now that we have access to the grid.
      if (gridSnapped && geometry.rect) {
        const topLeft = snapCornerToGrid(geometry.rect.x, geometry.rect.y, gridSize, gridOffsetX, gridOffsetY);
        const bottomRight = snapCornerToGrid(
          geometry.rect.x + geometry.rect.width,
          geometry.rect.y + geometry.rect.height,
          gridSize, gridOffsetX, gridOffsetY,
        );
        geometry = {
          rect: {
            x: topLeft.x,
            y: topLeft.y,
            width: bottomRight.x - topLeft.x,
            height: bottomRight.y - topLeft.y,
          },
        };
      }
      if (gridSnapped && geometry.circle) {
        // Snap radius to nearest half-cell
        const halfCell = gridSize / 2;
        const r = Math.round(geometry.circle.radius / halfCell) * halfCell;
        geometry = { circle: { ...geometry.circle, radius: Math.max(halfCell, r) } };
      }

      // Never commit degenerate shapes — tiny ones are accidental
      // clicks. The min-size is measured in WORLD pixels but has to
      // be at least large enough that a 2-pixel screen click doesn't
      // commit at any zoom level. Half a grid cell is a good floor:
      // it represents a clearly-intentional drag and scales with the
      // map. For freehand strokes we require a bounding box ≥ 0.5
      // grid cells in at least one dimension.
      const MIN_PX = Math.max(10, gridSize * 0.5);
      if (geometry.rect) {
        const w = geometry.rect.width;
        const h = geometry.rect.height;
        if (w < MIN_PX && h < MIN_PX) {
          set({ drawingInProgress: null });
          return;
        }
      }
      if (geometry.circle && geometry.circle.radius < MIN_PX) {
        set({ drawingInProgress: null });
        return;
      }
      if (
        (kind === 'line' || kind === 'arrow') &&
        geometry.points && geometry.points.length === 4
      ) {
        const [x1, y1, x2, y2] = geometry.points;
        const dx = Math.abs(x1 - x2);
        const dy = Math.abs(y1 - y2);
        if (dx < MIN_PX && dy < MIN_PX) {
          set({ drawingInProgress: null });
          return;
        }
      }
      if ((kind === 'freehand' || kind === 'ephemeral') && geometry.points) {
        const pts = geometry.points;
        if (pts.length < 4) {
          set({ drawingInProgress: null });
          return;
        }
        // Require the stroke to span at least MIN_PX in bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < pts.length; i += 2) {
          const px = pts[i];
          const py = pts[i + 1];
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }
        const dx = maxX - minX;
        const dy = maxY - minY;
        if (dx < MIN_PX && dy < MIN_PX) {
          set({ drawingInProgress: null });
          return;
        }
      }

      // Non-DMs always get player-only regardless of what the UI says.
      const finalVisibility: DrawingVisibility = isDM ? visibility : 'player-only';

      const drawing: Drawing = {
        id: randomId(),
        mapId,
        creatorUserId: userId,
        creatorRole: isDM ? 'dm' : 'player',
        kind,
        visibility: finalVisibility,
        color,
        strokeWidth,
        geometry,
        gridSnapped,
        createdAt: Date.now(),
        fadeAfterMs: kind === 'ephemeral' ? EPHEMERAL_FADE_MS : null,
      };

      // Apply locally first for responsiveness.
      set((s) => ({
        drawings: { ...s.drawings, [drawing.id]: drawing },
        drawingInProgress: null,
        undoStack: [...s.undoStack, { type: 'create' as const, drawing }].slice(-64),
        redoStack: [],
      }));

      // Schedule ephemeral auto-fade.
      if (drawing.fadeAfterMs != null) {
        setTimeout(() => {
          useDrawStore.getState().removeDrawing(drawing.id);
        }, drawing.fadeAfterMs);
      }

      // Fire the server event + stream-end (if any preview was flying).
      const emitters = await getEmitters();
      emitters.emitDrawingCreate(drawing);
      if (inProg.tempId) {
        emitters.emitDrawingStreamEnd(inProg.tempId);
      }
    })();
  },

  cancelStroke: () => set({ drawingInProgress: null }),

  addDrawing: (drawing) => {
    set((s) => ({
      drawings: { ...s.drawings, [drawing.id]: drawing },
    }));
    // Schedule ephemeral auto-fade for incoming ephemerals (either
    // from ourselves or from a broadcast — since addDrawing is called
    // from both paths, this is idempotent because the drawing id is
    // guaranteed stable).
    if (drawing.fadeAfterMs != null) {
      const remaining = drawing.createdAt + drawing.fadeAfterMs - Date.now();
      const delay = Math.max(0, remaining);
      setTimeout(() => {
        useDrawStore.getState().removeDrawing(drawing.id);
      }, delay);
    }
  },

  removeDrawing: (id) => {
    set((s) => {
      const { [id]: _removed, ...rest } = s.drawings;
      return {
        drawings: rest,
        selectedDrawingId: s.selectedDrawingId === id ? null : s.selectedDrawingId,
      };
    });
  },

  applyDrawingUpdate: (id, geometry) => {
    set((s) => {
      const existing = s.drawings[id];
      if (!existing) return s;
      return {
        drawings: { ...s.drawings, [id]: { ...existing, geometry } },
      };
    });
  },

  loadDrawings: (list) => {
    const map: Record<string, Drawing> = {};
    for (const d of list) map[d.id] = d;
    set({ drawings: map });
    // Schedule auto-fades for any incoming ephemerals (rare —
    // ephemerals normally aren't persisted, but defensive).
    for (const d of list) {
      if (d.fadeAfterMs != null) {
        const remaining = d.createdAt + d.fadeAfterMs - Date.now();
        setTimeout(() => {
          useDrawStore.getState().removeDrawing(d.id);
        }, Math.max(0, remaining));
      }
    }
  },

  clearAllLocal: (scope, userId, currentUserId) => {
    set((s) => {
      if (scope === 'all') {
        return { drawings: {}, selectedDrawingId: null };
      }
      // scope === 'mine' — drop all drawings by the targeted user
      const filtered: Record<string, Drawing> = {};
      for (const [id, d] of Object.entries(s.drawings)) {
        if (d.creatorUserId !== userId) filtered[id] = d;
      }
      return {
        drawings: filtered,
        selectedDrawingId: null,
      };
    });
    // Also clear any in-progress/previews belonging to that user.
    if (scope === 'mine' && userId) {
      set((s) => {
        const filteredPreviews: Record<string, PreviewDrawing> = {};
        for (const [id, p] of Object.entries(s.previews)) {
          if (p.creatorUserId !== userId) filteredPreviews[id] = p;
        }
        return { previews: filteredPreviews };
      });
    }
    // If currentUserId is the clearing user, also nuke their undo stack
    // — everything that was there referenced drawings we just wiped.
    if (currentUserId && (scope === 'all' || currentUserId === userId)) {
      set({ undoStack: [], redoStack: [] });
    }
  },

  setPreview: (p) => {
    set((s) => ({
      previews: {
        ...s.previews,
        [p.tempId]: {
          tempId: p.tempId,
          creatorUserId: p.creatorUserId,
          kind: p.kind,
          color: p.color,
          strokeWidth: p.strokeWidth,
          geometry: p.geometry,
          receivedAt: Date.now(),
        },
      },
    }));
  },

  clearPreview: (tempId) => {
    set((s) => {
      const { [tempId]: _removed, ...rest } = s.previews;
      return { previews: rest };
    });
  },

  selectDrawing: (id) => set({ selectedDrawingId: id }),

  deleteSelected: () => {
    const state = get();
    const id = state.selectedDrawingId;
    if (!id) return;
    const drawing = state.drawings[id];
    if (!drawing) return;

    // Local optimistic remove
    set((s) => {
      const { [id]: _rm, ...rest } = s.drawings;
      return {
        drawings: rest,
        selectedDrawingId: null,
        undoStack: [...s.undoStack, { type: 'delete' as const, drawing }].slice(-64),
        redoStack: [],
      };
    });

    // Fire server delete
    (async () => {
      const emitters = await getEmitters();
      emitters.emitDrawingDelete(id);
    })();
  },

  undo: () => {
    const state = get();
    const last = state.undoStack[state.undoStack.length - 1];
    if (!last) return;

    set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));

    if (last.type === 'create') {
      // Undo a create → delete the drawing
      set((s) => {
        const { [last.drawing.id]: _rm, ...rest } = s.drawings;
        return {
          drawings: rest,
          redoStack: [...s.redoStack, last],
        };
      });
      (async () => {
        const emitters = await getEmitters();
        emitters.emitDrawingDelete(last.drawing.id);
      })();
    } else {
      // Undo a delete → re-create
      set((s) => ({
        drawings: { ...s.drawings, [last.drawing.id]: last.drawing },
        redoStack: [...s.redoStack, last],
      }));
      (async () => {
        const emitters = await getEmitters();
        emitters.emitDrawingCreate(last.drawing);
      })();
    }
  },

  redo: () => {
    const state = get();
    const last = state.redoStack[state.redoStack.length - 1];
    if (!last) return;

    set((s) => ({ redoStack: s.redoStack.slice(0, -1) }));

    if (last.type === 'create') {
      // Redo a create → re-add
      set((s) => ({
        drawings: { ...s.drawings, [last.drawing.id]: last.drawing },
        undoStack: [...s.undoStack, last],
      }));
      (async () => {
        const emitters = await getEmitters();
        emitters.emitDrawingCreate(last.drawing);
      })();
    } else {
      // Redo a delete → delete again
      set((s) => {
        const { [last.drawing.id]: _rm, ...rest } = s.drawings;
        return {
          drawings: rest,
          undoStack: [...s.undoStack, last],
        };
      });
      (async () => {
        const emitters = await getEmitters();
        emitters.emitDrawingDelete(last.drawing.id);
      })();
    }
  },
}));
