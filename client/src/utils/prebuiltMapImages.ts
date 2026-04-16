/**
 * Prebuilt map name → thumbnail asset path.
 *
 * Canonical map data lives in `client/src/data/prebuiltMaps.ts`. This
 * module is kept as a thin compatibility wrapper so existing imports
 * of `getMapThumbnail` / `PREBUILT_THUMBNAIL` keep working.
 *
 * Used by:
 *   • The Scene Manager sidebar (SceneManager.tsx)
 *   • The Map Browser "Your Maps" list (MapBrowser.tsx)
 *   • The map:loaded listener for canvas rendering (listeners.ts)
 */
export { PREBUILT_THUMBNAIL } from '../data/prebuiltMaps';
import { PREBUILT_THUMBNAIL } from '../data/prebuiltMaps';

/**
 * Resolve a map's thumbnail src. Prefers the stored imageUrl (for
 * uploaded custom maps), falls back to the prebuilt thumbnail lookup
 * by name, returns null when neither is available so callers can
 * render a placeholder.
 */
export function getMapThumbnail(map: { imageUrl: string | null; name: string }): string | null {
  return map.imageUrl ?? PREBUILT_THUMBNAIL[map.name] ?? null;
}
