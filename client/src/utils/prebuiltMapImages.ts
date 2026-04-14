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
export const PREBUILT_THUMBNAIL: Record<string, string> = {
  'Goblin Camp': '/maps/goblin-camp.png',
  'Underdark Cavern': '/maps/underdark-cavern.png',
  'Druid Grove': '/maps/druid-grove.png',
  'Moonrise Towers': '/maps/moonrise-towers.png',
  'Nautiloid Wreck': '/maps/nautiloid-wreck.png',
  'Grymforge': '/maps/grymforge.png',
  'Forest Road Ambush': '/maps/forest-road-ambush.png',
  'Zhentarim Hideout': '/maps/zhentarim-hideout.png',
  'The Elfsong Tavern': '/maps/elfsong-tavern.png',
  'Last Light Inn': '/maps/last-light-inn.png',
  'Cathedral of Lathander': '/maps/cathedral-lathander.png',
  'Wine Cellar': '/maps/wine-cellar.png',
  'Apothecary Shop': '/maps/apothecary-shop.png',
  'Camp / Long Rest': '/maps/camp-long-rest.png',
  'Merchant Quarter': '/maps/merchant-quarter.png',
  'Dense Forest': '/maps/dense-forest.png',
  'Long Road': '/maps/long-road.png',
  'River Crossing': '/maps/river-crossing.png',
  'Ruined Watchtower': '/maps/ruined-watchtower.png',
  'Swamp Shrine': '/maps/swamp-shrine.png',
  'Frozen Pass': '/maps/frozen-pass.png',
  'Desert Oasis': '/maps/desert-oasis.png',
  'Sewer Junction': '/maps/sewer-junction.png',
  'Crypt of Ash': '/maps/crypt-of-ash.png',
  'Skybridge Ruins': '/maps/skybridge-ruins.png',
  'Pirate Cove': '/maps/pirate-cove.png',
  'Wizard Laboratory': '/maps/wizard-laboratory.png',
  'Noble Manor': '/maps/noble-manor.png',
  'Infernal Gate': '/maps/infernal-gate.png',
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
