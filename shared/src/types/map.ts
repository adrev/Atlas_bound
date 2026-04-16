export interface GameMap {
  id: string;
  sessionId: string;
  name: string;
  imageUrl: string | null;
  width: number;
  height: number;
  gridSize: number;
  gridType: 'square' | 'hex';
  gridOffsetX: number;
  gridOffsetY: number;
  walls: WallSegment[];
  fogState: FogPolygon[];
  createdAt: string;
}

export interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Named rectangular region on a map used for encounter spawn anchoring.
 * DM draws a zone by dragging on the canvas; the EncounterBuilder can
 * then deploy an encounter and have its creatures spawn inside the
 * zone in a grid pattern instead of at the map center.
 */
export interface MapZone {
  id: string;
  mapId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FogPolygon {
  points: number[];
}

export type TokenFaction = 'friendly' | 'hostile' | 'neutral';

export interface Token {
  id: string;
  mapId: string;
  characterId: string | null;
  name: string;
  x: number;
  y: number;
  size: number;
  imageUrl: string | null;
  color: string;
  layer: 'token' | 'object' | 'effect';
  visible: boolean;
  hasLight: boolean;
  lightRadius: number;
  lightDimRadius: number;
  lightColor: string;
  conditions: Condition[];
  ownerUserId: string | null;
  /**
   * Faction controls combat-side behavior (who OAs whom).
   * Defaults: PC = friendly, NPC = hostile, loot bag = neutral.
   * DM-togglable from the token overview panel.
   */
  faction?: TokenFaction;
  createdAt: string;
  aura?: TokenAura | null;
}

export interface TokenAura {
  radiusFeet: number;
  color: string;
  opacity: number;
  shape: 'circle' | 'square';
}

export interface LightSource {
  x: number;
  y: number;
  brightRadius: number;
  dimRadius: number;
  color: string;
}

export type Condition =
  | 'blinded'
  | 'charmed'
  | 'deafened'
  | 'frightened'
  | 'grappled'
  | 'incapacitated'
  | 'invisible'
  | 'paralyzed'
  | 'petrified'
  | 'poisoned'
  | 'prone'
  | 'restrained'
  | 'stunned'
  | 'unconscious'
  | 'exhaustion';

export interface PrebuiltMap {
  id: string;
  name: string;
  description: string;
  category: 'combat' | 'social' | 'dungeon';
  imageFile: string;
  width: number;
  height: number;
  gridSize: number;
  walls: WallSegment[];
  lightSources: LightSource[];
  suggestedTokenPositions: { x: number; y: number; label: string }[];
}

export interface MapPing {
  x: number;
  y: number;
  userId: string;
  displayName: string;
  timestamp: number;
}

/**
 * Lightweight summary of a map used by the Scene Manager sidebar.
 * Only includes fields needed for the thumbnail card — no walls,
 * no fog, no per-token data beyond the count badge. Keeps the
 * `map:list-result` payload small even for sessions with 50+ maps.
 */
export interface MapSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  /**
   * Optional 480-px JPEG thumbnail URL for custom-uploaded maps.
   * Generated client-side at upload time and stored at
   * /uploads/maps/thumbnails/{uuid}.jpg. Prebuilt maps don't use
   * this — their thumbnail tier lives on the GCS CDN and is wired
   * up via prebuiltMaps.ts. Null on legacy custom uploads that
   * pre-date the thumbnail column; the Scene Manager falls back
   * to the full image_url for those.
   */
  thumbnailUrl: string | null;
  width: number;
  height: number;
  gridSize: number;
  /** Number of tokens currently on this map (for the thumbnail badge) */
  tokenCount: number;
  /**
   * Number of wall segments drawn on this map. Lets the Scene Manager
   * surface "this scene has X walls" so the DM can spot prep gaps —
   * a combat map with 0 walls usually means line-of-sight isn't set up.
   */
  wallCount: number;
  /**
   * Number of encounter spawn zones drawn on this map. DM-only data;
   * players never see zones, but seeing the count in the sidebar helps
   * the DM know which scenes are encounter-ready vs blank.
   */
  zoneCount: number;
  createdAt: string;
  /** True if this map is currently the "player ribbon" (where the party is) */
  isPlayerMap: boolean;
  /**
   * DM-controlled sort position in the Scene Manager sidebar. Lower = earlier.
   * Legacy maps get a created_at-based backfill, so this is always set.
   */
  displayOrder: number;
}
