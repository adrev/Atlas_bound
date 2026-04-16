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
 * Resolve a map's thumbnail src in priority order:
 *   1. `thumbnailUrl` — set on custom uploads via the new
 *      generate-map-thumbnail pipeline (480-px JPEG, ~40 KB).
 *   2. `imageUrl` — full-resolution custom upload, used as a
 *      fallback for legacy uploads that pre-date the thumbnail tier.
 *   3. PREBUILT_THUMBNAIL[name] — GCS JPEG for prebuilts.
 *   4. null — caller renders a placeholder icon.
 *
 * `thumbnailUrl` is optional in the input type so existing call sites
 * that pass {imageUrl, name} only (e.g. before the server picks up
 * the new column) keep compiling.
 */
export function getMapThumbnail(
  map: { imageUrl: string | null; name: string; thumbnailUrl?: string | null },
): string | null {
  return map.thumbnailUrl ?? map.imageUrl ?? PREBUILT_THUMBNAIL[map.name] ?? null;
}
