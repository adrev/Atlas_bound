import type { FogPolygon } from '@dnd-vtt/shared';

/** A polygon needs at least 3 vertices (6 flat numbers) to enclose area. */
export const MIN_FOG_POLYGON_NUMBERS = 6;

/** True when a region has enough vertices to actually enclose an area. */
export function isRenderableFogRegion(region: FogPolygon): boolean {
  return region.points.length >= MIN_FOG_POLYGON_NUMBERS;
}

export function splitManualFogRegions(regions: FogPolygon[]): {
  revealRegions: FogPolygon[];
  hideRegions: FogPolygon[];
} {
  return {
    revealRegions: regions.filter((region) => region.mode !== 'hide'),
    hideRegions: regions.filter((region) => region.mode === 'hide'),
  };
}

/**
 * Manual fog strokes in the order the DM painted them, with degenerate
 * regions dropped.
 *
 * Two bugs this guards against:
 *  - A no-drag click used to persist a 1–2 vertex "polygon" that draws
 *    nothing but still flipped the whole map to base fog. Filtering to
 *    >= 3 vertices makes any such already-persisted junk inert (self-heals
 *    old maps.fog_state without a migration).
 *  - Rendering all reveals and then all hides discarded stroke order, so
 *    a reveal painted AFTER a hide over the same area could never win.
 *    Preserving insertion order lets the caller apply reveal (cut) / hide
 *    (paint) in sequence, so the latest stroke over an area is authoritative.
 */
export function orderedRenderableFogRegions(regions: FogPolygon[]): FogPolygon[] {
  return regions.filter(isRenderableFogRegion);
}
