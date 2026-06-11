import type { FogPolygon } from '@dnd-vtt/shared';

export function splitManualFogRegions(regions: FogPolygon[]): {
  revealRegions: FogPolygon[];
  hideRegions: FogPolygon[];
} {
  return {
    revealRegions: regions.filter((region) => region.mode !== 'hide'),
    hideRegions: regions.filter((region) => region.mode === 'hide'),
  };
}
