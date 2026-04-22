import type { GameMap, AmbientLight, FogPolygon, WallSegment } from '@dnd-vtt/shared';
import { safeParseJSON } from './safeJson.js';

/**
 * Central DB-row → GameMap mapper. Before this mapper existed, the
 * shape was hand-inlined in six places: routes/maps.ts (three sites),
 * socket/sceneEvents.ts (two sites), socket/sessionEvents.ts (one
 * site). Adding a new column (display_order, thumbnail_url,
 * ambient_light, ...) meant hunting each one down.
 *
 * Keeping it here ensures JSON columns (walls, fog_state) go through
 * safeParseJSON uniformly, and new columns land everywhere at once.
 *
 * NOTE: Callers that only project a subset of columns (e.g. a map
 * list endpoint that skips walls/fog_state for bandwidth) should
 * still use this mapper — row-missing columns become defaults.
 */
export function rowToMap(r: Record<string, unknown>): GameMap {
  const ambientRaw = (r.ambient_light as string | null | undefined) ?? 'bright';
  const ambient: AmbientLight = ['bright', 'dim', 'dark', 'custom'].includes(ambientRaw)
    ? (ambientRaw as AmbientLight)
    : 'bright';
  const opacityRaw = r.ambient_opacity;
  const ambientOpacity = typeof opacityRaw === 'number' && Number.isFinite(opacityRaw)
    ? Math.max(0, Math.min(1, opacityRaw))
    : undefined;
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    name: r.name as string,
    imageUrl: (r.image_url as string | null) ?? null,
    width: (r.width as number) ?? 1400,
    height: (r.height as number) ?? 1050,
    gridSize: (r.grid_size as number) ?? 70,
    gridType: ((r.grid_type as string) ?? 'square') as 'square' | 'hex',
    gridOffsetX: (r.grid_offset_x as number) ?? 0,
    gridOffsetY: (r.grid_offset_y as number) ?? 0,
    walls: safeParseJSON<WallSegment[]>(r.walls, [], 'maps.walls'),
    fogState: safeParseJSON<FogPolygon[]>(r.fog_state, [], 'maps.fog_state'),
    createdAt: r.created_at as string,
    ambientLight: ambient,
    ambientOpacity,
  };
}
