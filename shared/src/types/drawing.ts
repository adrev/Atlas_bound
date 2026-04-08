/**
 * DM / Player drawing annotations.
 *
 * A `Drawing` is a persistent (or ephemeral) mark on the current map
 * that one or more clients can see. The DM uses these to annotate the
 * battlefield during play — mark enemy zones, draw tactical paths,
 * label rooms, etc. Players can optionally draw on their own personal
 * layer (only they and the DM see their marks by default).
 *
 * The Drawing lives in `server/drawings` table (SQLite) when not
 * ephemeral, and is broadcast via `drawing:*` socket events. Ephemeral
 * drawings are never persisted; every client runs its own `setTimeout`
 * to remove them once `createdAt + fadeAfterMs` has passed.
 */

export type DrawingKind =
  | 'freehand'    // Pencil — smoothed polyline
  | 'rect'        // Rectangle (hollow by default)
  | 'circle'      // Circle (hollow by default)
  | 'line'        // Straight line, two endpoints
  | 'arrow'       // Line with an arrowhead at end
  | 'text'        // Text label
  | 'ephemeral';  // Quick-sketch pencil that fades after fadeAfterMs

export type DrawingVisibility =
  /** Everyone in the room sees the drawing */
  | 'shared'
  /** Only DMs see (DM private notes) */
  | 'dm-only'
  /** Only the creator + all DMs see (player personal annotations) */
  | 'player-only';

/**
 * One-of union of geometry fields. Which field is populated depends on
 * the `kind` of drawing:
 *   freehand / ephemeral → points (polyline)
 *   line / arrow         → points (two endpoints: [x1,y1,x2,y2])
 *   rect                 → rect
 *   circle               → circle
 *   text                 → text
 */
export interface DrawingGeometry {
  /** Flat array of xy-pairs for freehand/line/arrow: [x1,y1,x2,y2,...] */
  points?: number[];
  rect?: { x: number; y: number; width: number; height: number };
  circle?: { x: number; y: number; radius: number };
  text?: { x: number; y: number; content: string; fontSize: number };
}

export interface Drawing {
  id: string;
  mapId: string;
  creatorUserId: string;
  creatorRole: 'dm' | 'player';
  kind: DrawingKind;
  visibility: DrawingVisibility;
  /** Hex color string, e.g. '#ff3b3b' */
  color: string;
  /** Stroke / font width in world pixels */
  strokeWidth: number;
  geometry: DrawingGeometry;
  /** True if the shape endpoints were snapped to the grid when created */
  gridSnapped: boolean;
  /** Epoch ms the server stamped at creation */
  createdAt: number;
  /** Ephemeral only. When non-null, clients remove the drawing after
   *  createdAt + fadeAfterMs. Null for permanent drawings. */
  fadeAfterMs: number | null;
}

/**
 * In-progress stroke preview payload used by `drawing:stream` events.
 * Lightweight — no id, no persistence, just enough to render a ghost
 * of the stroke on remote clients while the creator is mid-drag.
 */
export interface DrawingStreamPayload {
  tempId: string;
  creatorUserId: string;
  kind: DrawingKind;
  visibility: DrawingVisibility;
  color: string;
  strokeWidth: number;
  geometry: DrawingGeometry;
}
