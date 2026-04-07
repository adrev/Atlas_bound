import { create } from 'zustand';
import type { Player, SessionSettings, GameMode } from '@dnd-vtt/shared';

interface SessionState {
  sessionId: string | null;
  roomCode: string | null;
  userId: string | null;
  displayName: string | null;
  isDM: boolean;
  players: Player[];
  gameMode: GameMode;
  settings: SessionSettings;
  currentMapId: string | null;
  /**
   * DM-only override that bypasses spell-slot consumption AND requirements.
   * When true, ANY spell on ANY character can be cast even if no slot is
   * available; the cast still rolls dice and applies effects normally,
   * but doesn't consume slots and isn't blocked. Used for testing and
   * for "story moments" where the DM wants to grant a temporary spell
   * awakening or similar narrative effect.
   *
   * Lives in client state only, not synced to other players. Each DM has
   * their own setting; players never see the toggle and can't enable it.
   */
  dmIgnoreSpellSlots: boolean;
}

interface SessionActions {
  setSession: (data: {
    sessionId: string;
    roomCode: string;
    userId: string;
    isDM: boolean;
    players: Player[];
    settings: SessionSettings;
    currentMapId: string | null;
    gameMode: GameMode;
  }) => void;
  setDisplayName: (name: string) => void;
  addPlayer: (player: Player) => void;
  removePlayer: (userId: string) => void;
  updateSettings: (settings: SessionSettings) => void;
  setGameMode: (mode: GameMode) => void;
  setCurrentMapId: (mapId: string | null) => void;
  setDmIgnoreSpellSlots: (val: boolean) => void;
  reset: () => void;
}

const initialState: SessionState = {
  sessionId: null,
  roomCode: null,
  userId: null,
  displayName: null,
  isDM: false,
  players: [],
  gameMode: 'free-roam',
  settings: {
    gridSize: 70,
    gridType: 'square',
    gridOpacity: 0.15,
    enableFogOfWar: true,
    enableDynamicLighting: true,
  },
  currentMapId: null,
  dmIgnoreSpellSlots: false,
};

export const useSessionStore = create<SessionState & SessionActions>((set) => ({
  ...initialState,

  setSession: (data) =>
    set({
      sessionId: data.sessionId,
      roomCode: data.roomCode,
      userId: data.userId,
      isDM: data.isDM,
      players: data.players,
      settings: data.settings,
      currentMapId: data.currentMapId,
      gameMode: data.gameMode,
    }),

  setDisplayName: (name) => set({ displayName: name }),

  addPlayer: (player) =>
    set((state) => ({
      players: state.players.some((p) => p.userId === player.userId)
        ? state.players.map((p) =>
            p.userId === player.userId ? player : p
          )
        : [...state.players, player],
    })),

  removePlayer: (userId) =>
    set((state) => ({
      players: state.players.filter((p) => p.userId !== userId),
    })),

  updateSettings: (settings) => set({ settings }),

  setGameMode: (mode) => set({ gameMode: mode }),

  setCurrentMapId: (mapId) => set({ currentMapId: mapId }),

  setDmIgnoreSpellSlots: (val) => set({ dmIgnoreSpellSlots: val }),

  reset: () => set(initialState),
}));
