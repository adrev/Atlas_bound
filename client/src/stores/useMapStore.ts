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

interface MapState {
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
  isTargeting: false,
  targetingData: null,
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

  startTargetingMode: (data) => set({ isTargeting: true, targetingData: data }),
  cancelTargetingMode: () => set({ isTargeting: false, targetingData: null }),

  toggleLockToken: (id) =>
    set((state) => {
      const next = new Set(state.lockedTokenIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { lockedTokenIds: next };
    }),
}));
