/**
 * Canonical prebuilt map library.
 *
 * Every prebuilt map is declared here once. The gallery, scene-manager
 * thumbnails, and socket map-load listener all import from this module
 * so names, thumbnails, and grid sizes stay in sync.
 *
 * Images are hosted on the shared GCS bucket (same as tokens, music,
 * spells, items). To add a new map:
 *   1. Upload `{id}.png` to `gs://atlas-bound-data/maps/`
 *   2. Add an entry below with a clear story anchor in the description
 *   3. Pick a grid size that frames the art well at the default 70px/cell
 */

export type MapCategory = 'combat' | 'social' | 'dungeon' | 'rest';

export interface PrebuiltMap {
  id: string;
  name: string;
  description: string;
  category: MapCategory;
  gridCols: number;
  gridRows: number;
  seed: number;
  imageFile: string;
}

const MAPS_CDN = 'https://storage.googleapis.com/atlas-bound-data/maps';

const map = (
  id: string,
  name: string,
  description: string,
  category: MapCategory,
  gridCols: number,
  gridRows: number,
  seed: number,
): PrebuiltMap => ({
  id,
  name,
  description,
  category,
  gridCols,
  gridRows,
  seed,
  imageFile: `${MAPS_CDN}/${id}.png`,
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const PREBUILT_MAPS: PrebuiltMap[] = [
  // --- Combat / Wilderness -------------------------------------------------
  map('forest-fork', 'Forked Forest Path', 'Wooded Y-junction where a stream crosses under a small footbridge', 'combat', 30, 22, 101),
  map('river-crossing', 'River Crossing', 'Wide river with a wooden bridge, rocky fords, and tree cover on both banks', 'combat', 32, 22, 102),
  map('mountain-pass', 'Snowy Mountain Pass', 'Winter trail winding between cliffs, scattered with a broken cart and boulders', 'combat', 34, 20, 103),
  map('goblin-ambush-road', 'Ambush Road', 'Misty forest road dotted with wreckage and toppled wagons — prime ambush terrain', 'combat', 30, 22, 104),
  map('forest-road-ambush', 'Forest Road Ambush', 'Narrow wooded path with fallen trees and deep cover on either side', 'combat', 40, 20, 707),
  map('forest-ruins-stream', 'Forest Ruins & Stream', 'Overgrown ruins straddling a woodland creek, with tumbled columns for cover', 'combat', 32, 22, 105),
  map('forest-shrine-crossing', 'Forest Shrine Crossing', 'Moss-covered shrine at a forest crossroads, surrounded by ancient trees', 'combat', 30, 22, 106),
  map('coastal-cliffs', 'Coastal Cliffs', 'Windswept cliffside with a beach path and breaking surf below', 'combat', 32, 22, 107),
  map('swamp-hag-causeway', 'Swamp Causeway', 'Boggy wetlands crossed by a raised wooden causeway — ideal hag territory', 'combat', 32, 22, 108),
  map('city-rooftop-chase', 'City Rooftops', 'Tiled-roof labyrinth at twilight, with gaps and narrow alleys between buildings', 'combat', 30, 22, 109),
  map('rooftop-chase', 'Rooftop Chase', 'Rain-slick city rooftops with planks, ladders, laundry lines, and narrow alley drops', 'combat', 28, 28, 501),
  map('city-alley-ambush', 'City Alley Ambush', 'Cramped lantern-lit alley courtyard with rooftops, crates, laundry lines, and a sewer grate', 'combat', 28, 28, 502),
  map('fey-mushroom-clearing', 'Feywild Clearing', 'Magical woodland glade ringed by softly glowing mushrooms', 'combat', 28, 22, 110),
  map('desert-oasis-ruins', 'Desert Oasis Ruins', 'Arid ruins clustered around a palm-shaded waterhole', 'combat', 30, 22, 111),
  map('druid-grove', 'Druid Grove', 'Sacred grove with a stone circle at its heart and branching paths through the trees', 'combat', 35, 35, 303),
  map('chasm-bridge', 'Chasm Bridge', 'Ancient broken bridge over a deep ravine, blocked by a fallen statue and rubble', 'combat', 34, 26, 503),
  map('broken-stone-bridge', 'Broken Stone Bridge', 'Wide ravine crossing with cracked stonework, rope repairs, and exposed ledges', 'combat', 34, 26, 504),
  map('spellfall-crater', 'Spellfall Crater', 'Massive arcane impact crater with black crystal shards, ruined roads, and unstable magic', 'combat', 32, 32, 505),
  map('arcane-quarantine-zone', 'Arcane Quarantine Zone', 'Ruined city block sealed by barricades around a leaking magical obelisk', 'combat', 32, 26, 506),
  map('foundry-district', 'Foundry District', 'Smoky forge quarter with molten channels, cranes, coal piles, and heavy cover', 'combat', 32, 26, 507),
  map('city-gate-checkpoint', 'City Gate Checkpoint', 'Fortified customs gate with barricades, wagons, guard posts, and inspection lanes', 'combat', 30, 30, 508),
  map('docks-warehouse', 'Harbor Warehouse', 'Nighttime dockside warehouse — crates, cranes, and a pier along the water', 'combat', 30, 22, 509),
  map('dockside-warehouse-district', 'Dockside Warehouse District', 'Harbor road with cargo yards, docks, boats, cranes, and warehouse rooftops', 'combat', 24, 30, 510),
  map('ship-deck-boarding', 'Ship Boarding Action', 'Two wooden decks locked in a stormy naval boarding action', 'combat', 30, 22, 511),
  map('pirate-cove', 'Pirate Cove', 'Secluded coastal camp with a pier, bonfire, boats, and pirate cover positions', 'combat', 30, 22, 512),
  map('sandstone-arena', 'Sandstone Arena', 'Sunlit colosseum battle pit with gates, spike traps, broken cover, and tiered stone stands', 'combat', 30, 30, 513),
  map('prison-wagon-ambush', 'Prison Wagon Ambush', 'Muddy woodland road where a barred transport wagon has been wrecked beside ditches and deadfall', 'combat', 36, 24, 514),
  map('ancient-druid-grove', 'Ancient Druid Grove', 'Moonwell clearing ringed by standing stones, branching forest paths, roots, and a hidden cave mouth', 'combat', 30, 30, 515),

  // --- Rest / Camp ---------------------------------------------------------
  map('roadside-night-camp', 'Roadside Night Camp', 'Forest roadside campsite with tents, bedrolls, wagon cover, and campfire light', 'rest', 32, 26, 601),
  map('forest-night-camp', 'Moonlit Forest Camp', 'Quiet forest campsite beside a stream, with tents, bedrolls, fallen logs, and a warm central fire', 'rest', 35, 28, 602),
  map('roadside-wagon-camp', 'Roadside Wagon Camp', 'Muddy country roadside camp with wagons, horse pickets, canvas shelters, crates, and a low campfire', 'rest', 35, 28, 603),
  map('mountain-shelter-camp', 'Mountain Shelter Camp', 'Snowbound mountain trail with a sheltered stone camp, icy stream, boulders, and a small fire', 'rest', 36, 24, 604),
  map('desert-caravan-camp', 'Desert Caravan Camp', 'Lantern-lit caravan camp among dunes and rocky shelves, with tents, carts, supplies, and a fire pit', 'rest', 35, 28, 605),
  map('swamp-stilt-camp', 'Swamp Stilt Camp', 'Raised wooden swamp camp connected by plank walks, surrounded by dark water, reeds, and lurking shapes', 'rest', 28, 28, 606),
  map('ruined-stone-circle-camp', 'Ruined Stone Circle Camp', 'Traveler camp inside mossy circular ruins, where forest paths meet around a glowing fire', 'rest', 24, 30, 607),
  map('riverbank-fishing-camp', 'Riverbank Fishing Camp', 'Twilight riverside camp with fishing racks, tents, a rowboat, reeds, and shoreline paths', 'rest', 35, 28, 608),
  map('snowbound-cabin-camp', 'Snowbound Cabin Camp', 'Winter cabin clearing with snowy pines, sled tracks, a well, outdoor bedrolls, and a smoking hearth', 'rest', 24, 30, 609),
  map('cave-refuge-camp', 'Cave Refuge Camp', 'Rocky cave hideaway with bedrolls, lanterns, supplies, side passages, and a small sheltered fire', 'rest', 35, 28, 610),
  map('underground-safe-camp', 'Underground Safe Camp', 'Deep cavern rest spot with bedrolls arranged around embers, cave pools, stalagmites, and narrow exits', 'rest', 28, 28, 611),

  // --- Dungeon -------------------------------------------------------------
  map('dragon-lair', 'Dragon\u2019s Lair', 'Cavernous treasure chamber heaped with gold, jewels, and bones', 'dungeon', 30, 24, 201),
  map('crypt-catacombs', 'Crypt Catacombs', 'Ancient burial chambers with sarcophagi, alcoves, and grave treasures', 'dungeon', 30, 24, 202),
  map('dark-dungeon', 'Dark Dungeon', 'Classic medieval dungeon — cells, corridors, and a torture chamber', 'dungeon', 30, 24, 203),
  map('sewer-cistern', 'Sewer Cistern', 'Underground drainage chamber with channels, walkways, and rusted grates', 'dungeon', 28, 24, 204),
  map('collapsed-mine', 'Collapsed Mine', 'Abandoned mineshaft, broken supports, and veins of glowing crystal', 'dungeon', 30, 22, 205),
  map('ruined-keep-entrance', 'Ruined Keep Entrance', 'Mossy courtyard outside a crumbling fortress gate — the way in', 'dungeon', 30, 26, 206),
  map('haunted-graveyard', 'Haunted Graveyard', 'Fog-wrapped cemetery clustered around a ruined chapel', 'dungeon', 30, 24, 207),
  map('stormy-temple-ruins', 'Storm-Wracked Temple', 'Crumbling stone temple battered by rain and lightning', 'dungeon', 32, 22, 208),
  map('dwarven-forge', 'Dwarven Forge', 'Volcanic forge hall with lava channels, anvils, and massive bellows', 'dungeon', 30, 24, 209),
  map('cellar-cauldron-cache', 'Witch\u2019s Cellar', 'Low-ceilinged cellar with a bubbling cauldron and shelves of strange cargo', 'dungeon', 22, 18, 210),
  map('moonrise-towers', 'Moonrise Towers', 'Dark fortress courtyard ringed by looming towers', 'dungeon', 40, 40, 404),
  map('guardhouse-jail', 'Guardhouse Jail', 'City watch station with intake desk, armory, captain office, bunks, and barred cells', 'dungeon', 22, 28, 211),
  map('thieves-guild-hideout', 'Thieves Guild Hideout', 'Secret basement with gambling tables, training room, vault, smuggler tunnel, and guild office', 'dungeon', 32, 26, 212),
  map('ritual-boss-chamber', 'Ritual Boss Chamber', 'Circular boss arena with four entries, broken pillars, magic hazards, and a central summoning circle', 'dungeon', 28, 28, 213),
  map('arcane-containment-lab', 'Arcane Containment Lab', 'Dangerous magical lab with cracked containment circle, crystal pylons, cages, and workbenches', 'dungeon', 34, 26, 214),
  map('arcane-laboratory', 'Arcane Laboratory', 'Mage academy lab with experiment hall, potion benches, archive, storage, and blue containment glow', 'dungeon', 34, 26, 215),
  map('underdark-fungal-cavern', 'Underdark Fungal Cavern', 'Bioluminescent cavern with giant mushrooms, spore clouds, black pools, and hidden tunnels', 'dungeon', 24, 30, 216),
  map('frozen-tomb', 'Frozen Tomb', 'Ice-buried crypt with slippery corridors, frozen sarcophagi, frost statues, and a sealed tomb', 'dungeon', 24, 30, 217),
  map('bathhouse-cult-hideout', 'Bathhouse Cult Hideout', 'Luxurious bathhouse hiding cult rooms, service corridors, pools, and a trapdoor route', 'dungeon', 28, 28, 218),
  map('noble-family-crypt', 'Noble Family Crypt', 'Gothic burial vault with chapel ruins, side tombs, blue ghostlight, and a grand sealed sarcophagus', 'dungeon', 24, 30, 219),
  map('ship-belowdecks', 'Ship Belowdecks', 'Cramped sailing-ship interior with cargo hold, crew hammocks, galley, armory, and captain cabin', 'dungeon', 24, 36, 220),
  map('planar-portal-room', 'Planar Portal Room', 'Ancient chamber split by elemental hazards around a glowing central portal and crystal pylons', 'dungeon', 30, 30, 221),
  map('velvet-cult-dungeon', 'Velvet Cult Dungeon', 'Decadent black-marble cult basement with red curtains, masks, wine cellar, restraint chamber, and altar room', 'dungeon', 28, 28, 222),

  // --- Social / Interior ---------------------------------------------------
  map('tavern-common-room', 'Tavern Common Room', 'Warm inn common room with bar, hearth, tables, stage, stairs, and kitchen prep area', 'social', 30, 20, 311),
  map('inn-upper-floor', 'Inn Upper Floor', 'Guest-room hallway with beds, trunks, broken window, loose boards, and a stair landing', 'social', 20, 30, 312),
  map('apothecary-shop', 'Apothecary Shop', 'Cozy shopfront packed with potions, herbs, and a workbench of reagents', 'social', 18, 16, 301),
  map('apothecary-shop-and-cellar', 'Apothecary & Cellar', 'Alchemy shop above a storage cellar — two floors connected by a ladder', 'social', 22, 20, 302),
  map('crossroads-inn-simple', 'Wayside Inn', 'Thatched inn at a rustic country crossroads, with stables and hitching posts', 'social', 28, 22, 303),
  map('crossroads-inn-exterior', 'Crossroads Inn', 'Cozy inn at twilight where four roads meet — classic adventurer hub', 'social', 30, 22, 304),
  map('village-square', 'Village Square', 'Market square with stalls, a fountain, and streets running off in every direction', 'social', 32, 26, 305),
  map('lower-city-market', 'Lower City Market', 'Crowded canal-side market square with stalls, rooftops, awnings, and a central fountain', 'social', 24, 30, 313),
  map('noble-garden-district', 'Noble Garden District', 'Manicured upper-city gardens with hedges, statues, fountains, and gated paths', 'social', 24, 30, 314),
  map('temple-district-plaza', 'Temple District Plaza', 'Bright marble temple square with shrines, reflecting pool, benches, and garden paths', 'social', 32, 32, 316),
  map('noble-manor-ballroom', 'Manor Ballroom', 'Ornate banquet hall with long tables, a dais, and tall arched windows', 'social', 30, 22, 306),
  map('noble-manor-interior', 'Noble Manor Interior', 'Lavish manor floorplan with dining room, study, trophy room, servants route, and hidden vault', 'social', 32, 32, 317),
  map('wizards-study', 'Wizard\u2019s Study', 'Arcane study with bookshelves, a desk, and a ritual circle at the center', 'social', 22, 18, 307),
  map('refugee-camp-outside-walls', 'Refugee Camp Outside the Walls', 'Crowded tent camp outside city gates, split by muddy wagon ruts and cookfires', 'social', 34, 26, 320),
  map('grand-library-archive', 'Grand Library Archive', 'Vast marble archive with reading tables, book stacks, study rooms, stair towers, and an arcane vault', 'social', 36, 24, 321),
  map('council-courthouse', 'Council Courthouse', 'Civic council hall with public benches, magistrate office, evidence room, holding cells, and guarded exits', 'social', 28, 28, 322),
  map('grand-cathedral-interior', 'Grand Cathedral Interior', 'Marble cathedral nave with pews, side chapels, stained-glass light, confession booths, and raised altar', 'social', 24, 36, 323),
  map('elfsong-tavern', 'The Elfsong Tavern', 'Two-floor inn with a long bar, hearth, and private booths upstairs', 'social', 25, 20, 909),
  map('cathedral-lathander', 'Cathedral of Lathander', 'Grand worship hall lit by stained-glass windows, with a raised altar', 'social', 35, 30, 1111),
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Map display-name → GCS image URL. Used by scene manager + map load listener. */
export const PREBUILT_THUMBNAIL: Record<string, string> = Object.fromEntries(
  PREBUILT_MAPS.map((m) => [m.name, m.imageFile]),
);

/** Map id → full entry, for lookups by stable id. */
export const PREBUILT_BY_ID: Record<string, PrebuiltMap> = Object.fromEntries(
  PREBUILT_MAPS.map((m) => [m.id, m]),
);
