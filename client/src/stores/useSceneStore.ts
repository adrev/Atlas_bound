import { create } from 'zustand';
import type { MapSummary, MapFolder } from '@dnd-vtt/shared';

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
  folders: MapFolder[];
  loaded: boolean;
  loading: boolean;
  setMaps(maps: MapSummary[], playerMapId: string | null): void;
  /** Replace the full folder list (fetched via REST). */
  setFolders(folders: MapFolder[]): void;
  /** Optimistic folder updates */
  addFolder(folder: MapFolder): void;
  renameFolder(id: string, name: string): void;
  removeFolder(id: string): void;
  /** Move a map between folders locally; server broadcast will reconcile. */
  moveMapToFolder(mapId: string, folderId: string | null): void;
  /** Update the ribbon indicator without re-fetching the list */
  updatePlayerMap(mapId: string): void;
  /** Mark loading true until a list-result arrives */
  markLoading(): void;
  /** Remove a map locally (used when optimistic-updating after delete) */
  removeMap(mapId: string): void;
}

export const useSceneStore = create<SceneState>((set) => ({
  maps: [],
  folders: [],
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

  setFolders: (folders) => set({ folders }),
  addFolder: (folder) => set((state) => ({ folders: [...state.folders, folder] })),
  renameFolder: (id, name) =>
    set((state) => ({
      folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f)),
    })),
  removeFolder: (id) =>
    set((state) => ({
      folders: state.folders.filter((f) => f.id !== id),
      // Maps in the deleted folder fall back to root locally — server
      // already does SET NULL, and broadcasts the new map list shortly.
      maps: state.maps.map((m) => (m.folderId === id ? { ...m, folderId: null } : m)),
    })),
  moveMapToFolder: (mapId, folderId) =>
    set((state) => ({
      maps: state.maps.map((m) => (m.id === mapId ? { ...m, folderId } : m)),
    })),

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
