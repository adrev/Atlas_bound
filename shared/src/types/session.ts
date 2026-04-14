export interface Session {
  id: string;
  name: string;
  roomCode: string;
  dmUserId: string;
  currentMapId: string | null;
  combatActive: boolean;
  createdAt: string;
  updatedAt: string;
  settings: SessionSettings;
}

export interface SessionSettings {
  gridSize: number;
  gridType: 'square' | 'hex';
  gridOpacity: number;
  enableFogOfWar: boolean;
  enableDynamicLighting: boolean;
  showTokenLabels?: boolean;
  turnTimerEnabled?: boolean;
  turnTimerSeconds?: number;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  gridSize: 70,
  gridType: 'square',
  gridOpacity: 0.15,
  enableFogOfWar: true,
  enableDynamicLighting: false,
};

export interface Player {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'dm' | 'player';
  characterId: string | null;
  connected: boolean;
}

export type GameMode = 'free-roam' | 'combat';
