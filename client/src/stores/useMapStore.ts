import { create } from 'zustand';
import type { Token, WallSegment, FogPolygon } from '@dnd-vtt/shared';

type ActiveTool = 'select' | 'measure' | 'fog-reveal' | 'fog-hide' | 'wall' | 'ping';

interface MapData {
  id: string;
  name: string;
  imageUrl: string | null;
  width: number;
  height: number;
  gridSize: number;
  gridType: 'square' | 'hex';
  gridOffsetX: number;
  gridOffsetY: number;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

interface PingData {
  x: number;
  y: number;
  userId: string;
  displayName: string;
  timestamp: number;
}

/**
 * Drag preview state — set while a token is being actively dragged.
 * Used by TokenLayer to render a low-opacity ghost at the original
 * position plus a blue distance line to the cursor (Roll20-style).
 */
interface DragPreview {
  tokenId: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface MapState {
  /**
   * The map the CURRENT client is looking at. For players this is
   * always the same as `playerMapId` (the ribbon). For DMs it may
   * be a different map they're previewing.
   */
  currentMap: MapData | null;
  tokens: Record<string, Token>;
  selectedTokenId: string | null;
  activeTool: ActiveTool;
  viewport: Viewport;
  walls: WallSegment[];
  fogRegions: FogPolygon[];
  hoveredTokenId: string | null;
  hoverPosition: { x: number; y: number } | null;
  contextMenuTokenId: string | null;
  contextMenuPosition: { x: number; y: number } | null;
  activePings: PingData[];
  copiedToken: Token | null;
  lockedTokenIds: Set<string>;
  isTargeting: boolean;
  targetingData: { spell?: any; weapon?: any; action?: any; casterTokenId: string; casterName: string } | null;
  dragPreview: DragPreview | null;
  /**
   * Ghost hero tokens staged by the DM on a preview map before
   * activating it. Each entry represents a PC that will be placed
   * as a real token when the DM clicks "Move Players Here".
   */
  stagedHeroes: Array<{
    characterId: string;
    name: string;
    portraitUrl: string | null;
    x: number;
    y: number;
    ownerUserId: string;
  }>;
  /**
   * The id of the map the PLAYERS are currently on ("yellow ribbon").
   * For players this is always equal to `currentMap?.id`. For DMs it
   * may differ when they're previewing a different map. Drives the
   * preview-mode banner and the scene manager's ribbon indicator.
   */
  playerMapId: string | null;
  /**
   * True when this is a DM who is currently viewing a different map
   * from the players. Derived from `currentMap.id !== playerMapId`.
   * When true, the spell cast resolver refuses to cast (can't target
   * creatures on a different map) and the PreviewModeBanner shows.
   */
  isDmPreviewingDifferentMap: boolean;
}

interface MapActions {
  setMap: (map: MapData | null) => void;
  setTokens: (tokens: Token[]) => void;
  moveToken: (tokenId: string, x: number, y: number) => void;
  addToken: (token: Token) => void;
  removeToken: (tokenId: string) => void;
  updateToken: (tokenId: string, changes: Partial<Token>) => void;
  selectToken: (tokenId: string | null) => void;
  setTool: (tool: ActiveTool) => void;
  setViewport: (viewport: Partial<Viewport>) => void;
  updateFog: (fogState: FogPolygon[]) => void;
  updateWalls: (walls: WallSegment[]) => void;
  setHoveredToken: (id: string | null, pos?: { x: number; y: number }) => void;
  setContextMenu: (tokenId: string | null, pos: { x: number; y: number } | null) => void;
  addPing: (ping: Omit<PingData, 'timestamp'>) => void;
  removePing: (timestamp: number) => void;
  toggleLockToken: (id: string) => void;
  copyToken: (token: Token) => void;
  startTargetingMode: (data: { spell?: any; weapon?: any; action?: any; casterTokenId: string; casterName: string }) => void;
  cancelTargetingMode: () => void;
  beginDragPreview: (preview: DragPreview) => void;
  updateDragPreview: (currentX: number, currentY: number) => void;
  endDragPreview: () => void;
  /** Replace the staged heroes array wholesale. */
  stageHeroes: (heroes: MapState['stagedHeroes']) => void;
  /** Update a single staged hero's position (after drag). */
  moveStagedHero: (characterId: string, x: number, y: number) => void;
  /** Clear all staged heroes. */
  clearStagedHeroes: () => void;
  /**
   * Update the id of the "player ribbon" map. Called whenever the
   * server tells us the ribbon has moved (via `map:player-map-changed`
   * or the initial `map:loaded` for a player). Also recomputes
   * `isDmPreviewingDifferentMap` based on the current view.
   */
  setPlayerMapId: (mapId: string | null) => void;
  /**
   * Apply an incoming `map:loaded` payload. Handles both the normal
   * "players are loading the ribbon" case and the "DM previewing a
   * different map" case (distinguished by `isPreview`). Updates
   * `currentMap`, tokens, walls, fog, AND the derived preview flag.
   */
  applyMapLoad: (args: {
    map: MapData & { walls: WallSegment[]; fogState: FogPolygon[] };
    tokens: Token[];
    isPreview?: boolean;
  }) => void;
}

const initialState: MapState = {
  currentMap: null,
  tokens: {},
  selectedTokenId: null,
  activeTool: 'select',
  viewport: { x: 0, y: 0, scale: 1 },
  walls: [],
  fogRegions: [],
  hoveredTokenId: null,
  hoverPosition: null,
  contextMenuTokenId: null,
  contextMenuPosition: null,
  activePings: [],
  copiedToken: null,
  lockedTokenIds: new Set(),
  stagedHeroes: [],
  isTargeting: false,
  targetingData: null,
  dragPreview: null,
  playerMapId: null,
  isDmPreviewingDifferentMap: false,
};

export const useMapStore = create<MapState & MapActions>((set) => ({
  ...initialState,

  setMap: (map) => set({ currentMap: map }),

  setTokens: (tokens) =>
    set({
      tokens: tokens.reduce(
        (acc, t) => ({ ...acc, [t.id]: t }),
        {} as Record<string, Token>
      ),
    }),

  moveToken: (tokenId, x, y) =>
    set((state) => ({
      tokens: {
        ...state.tokens,
        [tokenId]: state.tokens[tokenId]
          ? { ...state.tokens[tokenId], x, y }
          : state.tokens[tokenId],
      },
    })),

  addToken: (token) =>
    set((state) => ({
      tokens: { ...state.tokens, [token.id]: token },
    })),

  removeToken: (tokenId) =>
    set((state) => {
      const { [tokenId]: _, ...rest } = state.tokens;
      return {
        tokens: rest,
        selectedTokenId:
          state.selectedTokenId === tokenId ? null : state.selectedTokenId,
      };
    }),

  updateToken: (tokenId, changes) =>
    set((state) => ({
      tokens: state.tokens[tokenId]
        ? {
            ...state.tokens,
            [tokenId]: { ...state.tokens[tokenId], ...changes },
          }
        : state.tokens,
    })),

  selectToken: (tokenId) => set({ selectedTokenId: tokenId }),

  setTool: (tool) => set({ activeTool: tool }),

  setViewport: (viewport) =>
    set((state) => ({
      viewport: { ...state.viewport, ...viewport },
    })),

  updateFog: (fogState) => set({ fogRegions: fogState }),

  updateWalls: (walls) => set({ walls }),

  setHoveredToken: (id, pos) =>
    set({
      hoveredTokenId: id,
      hoverPosition: pos ?? null,
    }),

  setContextMenu: (tokenId, pos) =>
    set({
      contextMenuTokenId: tokenId,
      contextMenuPosition: pos,
    }),

  addPing: (ping) =>
    set((state) => ({
      activePings: [...state.activePings, { ...ping, timestamp: Date.now() }],
    })),

  removePing: (timestamp) =>
    set((state) => ({
      activePings: state.activePings.filter((p) => p.timestamp !== timestamp),
    })),

  copyToken: (token) => set({ copiedToken: token }),

  startTargetingMode: (data) => {
    // Block spell casts when the DM is previewing a different map
    // from the players — casting here would try to apply damage /
    // conditions to creatures that aren't in the current scene.
    // Weapons and melee actions are still allowed since they're
    // local to whatever token is selected.
    const state = useMapStore.getState();
    if (data.spell && state.isDmPreviewingDifferentMap) {
      // The PreviewModeBanner is already visible in this mode so
      // the DM has context — a browser alert ensures they get the
      // "why did nothing happen" signal without introducing a new
      // toast subsystem.
      console.warn('[SceneManager] Cast blocked: previewing a different map');
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(
          'Cannot cast spells while previewing a different map.\n\nMove the players here first (use "Move Players Here" in the preview banner or the scene manager).',
        );
      }
      return;
    }
    set({ isTargeting: true, targetingData: data });
  },
  cancelTargetingMode: () => set({ isTargeting: false, targetingData: null }),

  beginDragPreview: (preview) => set({ dragPreview: preview }),
  updateDragPreview: (currentX, currentY) =>
    set((state) =>
      state.dragPreview
        ? { dragPreview: { ...state.dragPreview, currentX, currentY } }
        : state,
    ),
  endDragPreview: () => set({ dragPreview: null }),

  stageHeroes: (heroes) => set({ stagedHeroes: heroes }),
  moveStagedHero: (characterId, x, y) =>
    set((state) => ({
      stagedHeroes: state.stagedHeroes.map((h) =>
        h.characterId === characterId ? { ...h, x, y } : h,
      ),
    })),
  clearStagedHeroes: () => set({ stagedHeroes: [] }),

  toggleLockToken: (id) =>
    set((state) => {
      const next = new Set(state.lockedTokenIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { lockedTokenIds: next };
    }),

  setPlayerMapId: (mapId) =>
    set((state) => ({
      playerMapId: mapId,
      // Recompute the preview flag: true when we're looking at
      // something OTHER than the ribbon. Both must be non-null for
      // a "different map" condition to be meaningful.
      isDmPreviewingDifferentMap:
        !!state.currentMap && !!mapId && state.currentMap.id !== mapId,
    })),

  applyMapLoad: ({ map, tokens, isPreview }) => {
    set((state) => {
      // If this is a preview payload, leave playerMapId untouched —
      // we're just peeking at a different map. Otherwise (normal
      // load), the incoming map IS the ribbon, so sync playerMapId.
      const nextPlayerMapId = isPreview ? state.playerMapId : map.id;
      return {
        currentMap: {
          id: map.id,
          name: map.name,
          imageUrl: map.imageUrl,
          width: map.width,
          height: map.height,
          gridSize: map.gridSize,
          gridType: map.gridType,
          gridOffsetX: map.gridOffsetX,
          gridOffsetY: map.gridOffsetY,
        },
        tokens: tokens.reduce(
          (acc, t) => ({ ...acc, [t.id]: t }),
          {} as Record<string, Token>,
        ),
        walls: map.walls ?? [],
        fogRegions: map.fogState ?? [],
        playerMapId: nextPlayerMapId,
        isDmPreviewingDifferentMap:
          !!nextPlayerMapId && map.id !== nextPlayerMapId,
      };
    });
  },
}));
