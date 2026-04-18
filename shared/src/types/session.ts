export type SessionVisibility = 'public' | 'private';

export interface Session {
  id: string;
  name: string;
  roomCode: string;
  /**
   * The *owner* of the session. Only the owner can promote/demote
   * DMs, transfer ownership, or delete the session. Co-DMs (multiple
   * `role='dm'` rows in session_players) can kick/ban/edit-settings
   * but cannot touch the DM hierarchy itself.
   */
  dmUserId: string;
  currentMapId: string | null;
  combatActive: boolean;
  createdAt: string;
  updatedAt: string;
  settings: SessionSettings;
  visibility: SessionVisibility;
  /** True when a password is set. The hash itself never crosses the wire. */
  hasPassword: boolean;
  /**
   * Stable shareable invite token. Anyone with the link joins without
   * needing the password. Regeneratable by any DM \u2014 regenerating
   * invalidates the old token. Null when the session is public-only
   * and has never had an invite generated.
   */
  inviteCode: string | null;
}

/**
 * Public-facing ban entry shown in the session's Banned section. All
 * session members see reasons and the banner's display name.
 */
export interface SessionBan {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  bannedBy: string;          // display name of the DM who applied the ban
  bannedByUserId: string;
  bannedAt: string;
  reason: string | null;
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
  /**
   * Discord webhook URL for session event notifications. Lives on the
   * sessions row, not inside the settings JSON blob, but we surface it
   * here so the UI can render it as a single "Session Settings" form.
   * `null` / `''` / missing = disabled. Set to a Discord webhook URL
   * to turn on notifications.
   */
  discordWebhookUrl?: string | null;
  /**
   * When false, players can't self-trigger Short / Long Rest from the
   * bottom bar — only the DM can start a rest (which still broadcasts
   * to everyone). Defaults to true so existing sessions keep their
   * prior behaviour.
   */
  allowPlayerRest?: boolean;
  /**
   * When false, players see only the name + portrait of creature
   * (NPC) tokens — stats, attacks, spells, and inventory are hidden.
   * The DM always sees everything. Defaults to true (visible) so
   * existing campaigns don't silently lose information.
   */
  showCreatureStatsToPlayers?: boolean;
  /**
   * When false, players can only open their own character sheet;
   * other players' sheets are blocked. Defaults to true so party
   * members can cross-reference stats during play.
   */
  showPlayersToPlayers?: boolean;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  gridSize: 70,
  gridType: 'square',
  gridOpacity: 0.15,
  enableFogOfWar: true,
  enableDynamicLighting: false,
  allowPlayerRest: true,
  showCreatureStatsToPlayers: true,
  showPlayersToPlayers: true,
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
