import { create } from 'zustand';
import type {
  Player, SessionSettings, GameMode, SessionVisibility, SessionBan,
} from '@dnd-vtt/shared';

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
  /** The currently-playing music track id, synced from the DM via socket. */
  currentTrack: string | null;
  /** Index of the specific file within the theme, or null for auto-shuffle. */
  currentTrackFileIndex: number | null;

  // --- Privacy + role hierarchy ---
  /** Session visibility \u2014 'public' means room-code-only; 'private' requires
   *  a password or invite token to join (returning members always skip it). */
  visibility: SessionVisibility;
  hasPassword: boolean;
  /** Shareable invite token. DMs see this; players don't need it. */
  inviteCode: string | null;
  /** `sessions.dm_user_id` \u2014 the owner of the session. Distinct from
   *  co-DMs which share `role='dm'` but not the owner flag. */
  ownerUserId: string | null;
  /** True when the current user is the owner (not merely a co-DM). */
  isOwner: boolean;
  /** Current ban list. Lazy-loaded on session enter + kept live by
   *  `session:bans-updated` broadcasts. */
  bans: SessionBan[];
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
    visibility?: SessionVisibility;
    hasPassword?: boolean;
    inviteCode?: string | null;
    ownerUserId?: string;
    bans?: SessionBan[];
  }) => void;
  setDisplayName: (name: string) => void;
  addPlayer: (player: Player) => void;
  removePlayer: (userId: string) => void;
  updateSettings: (settings: SessionSettings) => void;
  setGameMode: (mode: GameMode) => void;
  setCurrentMapId: (mapId: string | null) => void;
  setDmIgnoreSpellSlots: (val: boolean) => void;
  setCurrentTrack: (track: string | null) => void;
  setCurrentTrackFileIndex: (index: number | null) => void;
  reset: () => void;

  // --- Privacy + role hierarchy ---
  updatePrivacy: (privacy: {
    visibility?: SessionVisibility;
    hasPassword?: boolean;
    inviteCode?: string | null;
  }) => void;
  setBans: (bans: SessionBan[]) => void;
  setPlayerRole: (userId: string, role: 'dm' | 'player') => void;
  setOwner: (newOwnerId: string) => void;
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
  currentTrack: null,
  currentTrackFileIndex: null,
  visibility: 'public',
  hasPassword: false,
  inviteCode: null,
  ownerUserId: null,
  isOwner: false,
  bans: [],
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
      visibility: data.visibility ?? 'public',
      hasPassword: data.hasPassword ?? false,
      inviteCode: data.inviteCode ?? null,
      ownerUserId: data.ownerUserId ?? null,
      isOwner: !!data.ownerUserId && data.ownerUserId === data.userId,
      bans: data.bans ?? [],
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

  setCurrentTrack: (track) => set({ currentTrack: track }),

  setCurrentTrackFileIndex: (index) => set({ currentTrackFileIndex: index }),

  updatePrivacy: (privacy) =>
    set((state) => ({
      visibility: privacy.visibility ?? state.visibility,
      hasPassword: privacy.hasPassword ?? state.hasPassword,
      inviteCode: privacy.inviteCode !== undefined ? privacy.inviteCode : state.inviteCode,
    })),

  setBans: (bans) => set({ bans }),

  setPlayerRole: (userId, role) =>
    set((state) => {
      const players = state.players.map((p) =>
        p.userId === userId ? { ...p, role } : p,
      );
      const nextIsDM = userId === state.userId
        ? role === 'dm'
        : state.isDM;
      return { players, isDM: nextIsDM };
    }),

  setOwner: (newOwnerId) =>
    set((state) => ({
      ownerUserId: newOwnerId,
      isOwner: state.userId === newOwnerId,
      // The new owner is guaranteed DM; ensure local copy reflects it.
      isDM: state.userId === newOwnerId ? true : state.isDM,
      players: state.players.map((p) =>
        p.userId === newOwnerId && p.role !== 'dm' ? { ...p, role: 'dm' as const } : p,
      ),
    })),

  reset: () => set(initialState),
}));
