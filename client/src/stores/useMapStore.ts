import { create } from 'zustand';
import type { Token, WallSegment, FogPolygon, MapZone, AmbientLight } from '@dnd-vtt/shared';

type ActiveTool = 'select' | 'measure' | 'fog-reveal' | 'fog-hide' | 'wall' | 'ping' | 'zone';

/**
 * Payload handed to `startTargetingMode`. The caster picks a spell,
 * weapon, or action, and the map switches into a "click a target"
 * overlay. The inner shapes are deliberately loose \u2014 TokenActionPanel
 * resolves them against the live spell/weapon engine \u2014 so we cast to
 * any object with a name for the overlay banner and keep specific
 * fields (level, description, etc.) accessible via property lookup.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// The inner spell/weapon/action objects are deliberately `any`: the
// resolver in TokenActionPanel unpacks ~40 different fields across
// DDB, compendium, and ad-hoc shapes. Narrowing them here would
// cascade type errors into 300+ lines of spell-resolver code that
// the store layer doesn't actually need to understand.
export interface TargetingData {
  spell?: any;
  weapon?: any;
  action?: any;
  casterTokenId: string;
  casterName: string;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  /** 5e ambient light tier. Omitted on legacy rows — treat as 'bright'. */
  ambientLight?: AmbientLight;
  /** Only read when ambientLight === 'custom'. 0..1 opacity override. */
  ambientOpacity?: number;
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
  /**
   * Primary (single-select) token id. Still the source-of-truth for
   * the TokenActionPanel and most per-token UI. When the user shift-
   * clicks to build a multi-selection, this stays pinned to the FIRST
   * selected token so the TokenActionPanel doesn't blink; the full
   * selection lives in `selectedTokenIds` alongside.
   */
  selectedTokenId: string | null;
  /**
   * Full selection set (always a superset that includes `selectedTokenId`
   * when that's non-null). Used by the DM group-action bar and any
   * future multi-token canvas ops.
   */
  selectedTokenIds: string[];
  activeTool: ActiveTool;
  viewport: Viewport;
  walls: WallSegment[];
  fogRegions: FogPolygon[];
  zones: MapZone[];
  hoveredTokenId: string | null;
  hoverPosition: { x: number; y: number } | null;
  contextMenuTokenId: string | null;
  contextMenuPosition: { x: number; y: number } | null;
  activePings: PingData[];
  copiedToken: Token | null;
  lockedTokenIds: Set<string>;
  isTargeting: boolean;
  targetingData: TargetingData | null;
  dragPreview: DragPreview | null;
  /**
   * Ghost hero tokens staged by the DM on a preview map before
   * activating it. Each entry represents a PC that will be placed
   * as a real token when the DM clicks "Move Players Here".
   *
   * Keyed by mapId so staging tokens on one preview map doesn't
   * bleed into other maps.
   */
  stagedHeroes: Record<string, Array<{
    characterId: string;
    name: string;
    portraitUrl: string | null;
    x: number;
    y: number;
    ownerUserId: string;
  }>>;
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
  /**
   * When set, the FogLayer draws a gold vision-radius circle on the
   * map showing what the selected player character can see through
   * the fog of war. DM-only feature — toggled from the Players tab.
   */
  fogPreviewCharacterId: string | null;
}

interface MapActions {
  setMap: (map: MapData | null) => void;
  setTokens: (tokens: Token[]) => void;
  moveToken: (tokenId: string, x: number, y: number) => void;
  addToken: (token: Token) => void;
  removeToken: (tokenId: string) => void;
  updateToken: (tokenId: string, changes: Partial<Token>) => void;
  /**
   * Select or clear a token. When `additive` is true (shift-click), the
   * token is XOR'd into the current selection and the primary remains
   * the oldest selected token. When false or omitted, the selection
   * is replaced with just that token (or cleared with `null`).
   */
  selectToken: (tokenId: string | null, additive?: boolean) => void;
  setTool: (tool: ActiveTool) => void;
  setViewport: (viewport: Partial<Viewport>) => void;
  updateFog: (fogState: FogPolygon[]) => void;
  updateWalls: (walls: WallSegment[]) => void;
  updateZones: (zones: MapZone[]) => void;
  setHoveredToken: (id: string | null, pos?: { x: number; y: number }) => void;
  setContextMenu: (tokenId: string | null, pos: { x: number; y: number } | null) => void;
  addPing: (ping: Omit<PingData, 'timestamp'>) => void;
  removePing: (timestamp: number) => void;
  toggleLockToken: (id: string) => void;
  copyToken: (token: Token) => void;
  startTargetingMode: (data: TargetingData) => void;
  cancelTargetingMode: () => void;
  beginDragPreview: (preview: DragPreview) => void;
  updateDragPreview: (currentX: number, currentY: number) => void;
  endDragPreview: () => void;
  /** Replace the staged heroes array for a specific map. */
  stageHeroes: (mapId: string, heroes: MapState['stagedHeroes'][string]) => void;
  /** Update a single staged hero's position (after drag). */
  moveStagedHero: (mapId: string, characterId: string, x: number, y: number) => void;
  /** Clear staged heroes. If mapId is given, clear only that map; otherwise clear all. */
  clearStagedHeroes: (mapId?: string) => void;
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
  /** Set or clear the fog-of-war preview for a specific character. */
  setFogPreview: (characterId: string | null) => void;
  applyMapLoad: (args: {
    map: MapData & { walls: WallSegment[]; fogState: FogPolygon[]; zones?: MapZone[] };
    tokens: Token[];
    isPreview?: boolean;
  }) => void;
}

const initialState: MapState = {
  currentMap: null,
  tokens: {},
  selectedTokenId: null,
  selectedTokenIds: [],
  activeTool: 'select',
  viewport: { x: 0, y: 0, scale: 1 },
  walls: [],
  fogRegions: [],
  zones: [],
  hoveredTokenId: null,
  hoverPosition: null,
  contextMenuTokenId: null,
  contextMenuPosition: null,
  activePings: [],
  copiedToken: null,
  lockedTokenIds: new Set(),
  stagedHeroes: {},
  isTargeting: false,
  targetingData: null,
  dragPreview: null,
  playerMapId: null,
  isDmPreviewingDifferentMap: false,
  fogPreviewCharacterId: null,
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
      const selectedTokenIds = state.selectedTokenIds.filter((id) => id !== tokenId);
      return {
        tokens: rest,
        selectedTokenId:
          state.selectedTokenId === tokenId ? null : state.selectedTokenId,
        selectedTokenIds,
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

  selectToken: (tokenId, additive = false) => set((state) => {
    if (tokenId === null) return { selectedTokenId: null, selectedTokenIds: [] };
    if (!additive) {
      return { selectedTokenId: tokenId, selectedTokenIds: [tokenId] };
    }
    // Additive (shift-click) — XOR into the current selection.
    const exists = state.selectedTokenIds.includes(tokenId);
    const nextIds = exists
      ? state.selectedTokenIds.filter((id) => id !== tokenId)
      : [...state.selectedTokenIds, tokenId];
    // Primary stays pinned to the oldest selected token so the
    // TokenActionPanel doesn't thrash as the user builds a group.
    const primary = nextIds.length === 0
      ? null
      : state.selectedTokenId && nextIds.includes(state.selectedTokenId)
        ? state.selectedTokenId
        : nextIds[0];
    return { selectedTokenId: primary, selectedTokenIds: nextIds };
  }),

  setTool: (tool) => set({ activeTool: tool }),

  setViewport: (viewport) =>
    set((state) => ({
      viewport: { ...state.viewport, ...viewport },
    })),

  updateFog: (fogState) => set({ fogRegions: fogState }),

  updateWalls: (walls) => set({ walls }),

  updateZones: (zones) => set({ zones }),

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
      console.warn('[SceneManager] Cast blocked: previewing a different map');
      // Surface to the DM via toast so the "nothing happened" isn't silent.
      // Lazy import avoids pulling the UI bundle into the store.
      import('../components/ui/Toast').then(({ showToast }) => {
        showToast({
          message: 'Cannot cast spells while previewing a different map. Move the players here first.',
          variant: 'warning',
          emoji: '\u26A0\uFE0F',
          duration: 5000,
        });
      });
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

  stageHeroes: (mapId, heroes) =>
    set((state) => ({
      stagedHeroes: { ...state.stagedHeroes, [mapId]: heroes },
    })),
  moveStagedHero: (mapId, characterId, x, y) =>
    set((state) => ({
      stagedHeroes: {
        ...state.stagedHeroes,
        [mapId]: (state.stagedHeroes[mapId] ?? []).map((h) =>
          h.characterId === characterId ? { ...h, x, y } : h,
        ),
      },
    })),
  clearStagedHeroes: (mapId) =>
    set((state) => {
      if (mapId) {
        const { [mapId]: _, ...rest } = state.stagedHeroes;
        return { stagedHeroes: rest };
      }
      return { stagedHeroes: {} };
    }),

  toggleLockToken: (id) =>
    set((state) => {
      const next = new Set(state.lockedTokenIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { lockedTokenIds: next };
    }),

  setFogPreview: (characterId) => set({ fogPreviewCharacterId: characterId }),

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
        zones: map.zones ?? [],
        playerMapId: nextPlayerMapId,
        isDmPreviewingDifferentMap:
          !!nextPlayerMapId && map.id !== nextPlayerMapId,
      };
    });
  },
}));
