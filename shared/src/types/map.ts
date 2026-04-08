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

export interface FogPolygon {
  points: number[];
}

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
  createdAt: string;
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
  width: number;
  height: number;
  gridSize: number;
  /** Number of tokens currently on this map (for the thumbnail badge) */
  tokenCount: number;
  createdAt: string;
  /** True if this map is currently the "player ribbon" (where the party is) */
  isPlayerMap: boolean;
}
