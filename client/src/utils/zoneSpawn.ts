/**
 * Zone-aware encounter spawn positioning.
 *
 * Given a total creature count and an optional `MapZone`, return the
 * anchor point + clamped max per-token offsets the EncounterBuilder
 * should use when laying tokens out in a grid.
 *
 * Extracted so the math is testable without mocking React/socket state.
 */
export interface SpawnZoneLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpawnAnchor {
  centerX: number;
  centerY: number;
  maxOffsetX: number;
  maxOffsetY: number;
}

export function computeSpawnAnchor(
  map: { width: number; height: number; gridSize?: number | null },
  zone: SpawnZoneLike | null,
  /**
   * Approx. largest token size (in cells) being placed, used to reserve
   * a margin so no token's bounding box pokes outside the zone. Defaults
   * to 1 \u2014 pass 2+ when deploying Large creatures.
   */
  tokenSizeCells = 1,
): SpawnAnchor {
  const gridSize = map.gridSize ?? 70;
  if (!zone) {
    return {
      centerX: map.width / 2,
      centerY: map.height / 2,
      maxOffsetX: Number.POSITIVE_INFINITY,
      maxOffsetY: Number.POSITIVE_INFINITY,
    };
  }
  // Reserve half a token worth of margin from each side so a clamped
  // token's full footprint stays inside the zone. For a zone narrower
  // than the token itself this clamps the offset to 0 \u2014 every token
  // will land on the zone center, which is the correct degenerate
  // behavior (rather than spilling outside).
  const halfToken = (tokenSizeCells * gridSize) / 2;
  const maxOffsetX = Math.max(0, zone.width / 2 - halfToken);
  const maxOffsetY = Math.max(0, zone.height / 2 - halfToken);
  return {
    centerX: zone.x + zone.width / 2,
    centerY: zone.y + zone.height / 2,
    maxOffsetX,
    maxOffsetY,
  };
}

/**
 * Compute one token's (x, y) given its index, total count, and a
 * spawn anchor. Lays tokens out in a roughly-square grid around the
 * anchor, clamped to the anchor's max offsets.
 */
export function computeTokenPosition(
  index: number,
  total: number,
  anchor: SpawnAnchor,
  gridSize: number,
): { x: number; y: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, total))));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const rawX = (col - Math.floor(cols / 2)) * gridSize;
  const rawY = (row - Math.floor(cols / 2)) * gridSize;
  const dx = Math.max(-anchor.maxOffsetX, Math.min(anchor.maxOffsetX, rawX));
  const dy = Math.max(-anchor.maxOffsetY, Math.min(anchor.maxOffsetY, rawY));
  return { x: anchor.centerX + dx, y: anchor.centerY + dy };
}
