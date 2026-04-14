/**
 * Prebuilt map name → thumbnail asset path.
 *
 * Prebuilt maps are stored in the DB with `image_url = null` because
 * the image is a client-side asset, not an uploaded file. Any UI that
 * wants to show a thumbnail for a prebuilt map has to look up the name
 * here and fall back to this path.
 *
 * Used by:
 *   • The Scene Manager sidebar (SceneManager.tsx)
 *   • The Map Browser "Your Maps" list (MapBrowser.tsx)
 *   • The map:loaded listener for canvas rendering (listeners.ts)
 *
 * Keep in sync with client/src/components/mapbrowser/PrebuiltMapGallery.tsx
 * which is the canonical source of truth for prebuilt map names.
 */
const MAPS_CDN = 'https://storage.googleapis.com/atlas-bound-data/maps';

export const PREBUILT_THUMBNAIL: Record<string, string> = {
  'Apothecary Shop': `${MAPS_CDN}/apothecary-shop.png`,
  'The Elfsong Tavern': `${MAPS_CDN}/elfsong-tavern.png`,
  'Cathedral of Lathander': `${MAPS_CDN}/cathedral-lathander.png`,
  'Druid Grove': `${MAPS_CDN}/druid-grove.png`,
  'Forest Road Ambush': `${MAPS_CDN}/forest-road-ambush.png`,
  'Moonrise Towers': `${MAPS_CDN}/moonrise-towers.png`,
};

/**
 * Resolve a map's thumbnail src. Prefers the stored imageUrl (for
 * uploaded custom maps), falls back to the prebuilt thumbnail lookup
 * by name, returns null when neither is available so callers can
 * render a placeholder.
 */
export function getMapThumbnail(map: { imageUrl: string | null; name: string }): string | null {
  return map.imageUrl ?? PREBUILT_THUMBNAIL[map.name] ?? null;
}
