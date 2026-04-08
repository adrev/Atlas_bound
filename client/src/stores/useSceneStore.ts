import { create } from 'zustand';
import type { MapSummary } from '@dnd-vtt/shared';

/**
 * Scene Manager state — lightweight sidebar that shows all maps in
 * the session with the "yellow ribbon" highlight on whichever map
 * the players are currently on.
 *
 * The list is refreshed via `map:list` → `map:list-result` and
 * lightweight ribbon moves via `map:player-map-changed`. Kept as a
 * dedicated store so subscribing components only re-render when the
 * scene library or ribbon changes, not on every token tick.
 */
interface SceneState {
  maps: MapSummary[];
  loaded: boolean;
  loading: boolean;
  setMaps(maps: MapSummary[], playerMapId: string | null): void;
  /** Update the ribbon indicator without re-fetching the list */
  updatePlayerMap(mapId: string): void;
  /** Mark loading true until a list-result arrives */
  markLoading(): void;
  /** Remove a map locally (used when optimistic-updating after delete) */
  removeMap(mapId: string): void;
}

export const useSceneStore = create<SceneState>((set) => ({
  maps: [],
  loaded: false,
  loading: false,

  setMaps: (maps, playerMapId) => {
    // Stamp isPlayerMap based on the authoritative playerMapId we
    // received alongside the list. The server also populates this
    // on each row but this keeps us consistent if the client ever
    // updates maps without a new playerMapId.
    const stamped = maps.map((m) => ({
      ...m,
      isPlayerMap: m.id === playerMapId,
    }));
    set({ maps: stamped, loaded: true, loading: false });
  },

  updatePlayerMap: (mapId) =>
    set((state) => ({
      maps: state.maps.map((m) => ({
        ...m,
        isPlayerMap: m.id === mapId,
      })),
    })),

  markLoading: () => set({ loading: true }),

  removeMap: (mapId) =>
    set((state) => ({
      maps: state.maps.filter((m) => m.id !== mapId),
    })),
}));
