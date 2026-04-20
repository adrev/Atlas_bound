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
  /**
   * When true, the DM sees the players' fog-of-war as a translucent
   * overlay (so they can narrate from the party's perspective).
   * Defaults to false — DMs traditionally see the whole map.
   */
  dmSeesPlayerFog?: boolean;
  /**
   * Per-token vision radius in grid cells (5 ft per cell). Defaults
   * to 8 (40 ft) which matches basic D&D ambient torchlight + dim
   * vision. DM may bump higher for outdoor scenes or lower for
   * dark-vision-disabled modules.
   */
  fogVisionCells?: number;
  /**
   * Which rulebooks the engine enforces. Every rule handler declares
   * the source it comes from; rules whose source isn't in this list
   * are skipped by the modifier pipeline and hidden in the wiki. PHB
   * is implicitly always enabled (defaulting here keeps legacy sessions
   * working without a migration).
   *
   * Codes are short: 'phb', 'dmg', 'mm', 'xge' (Xanathar's Guide to
   * Everything), 'tce' (Tasha's Cauldron of Everything), 'vgm' (Volo's
   * Guide to Monsters), 'mmm' (Monsters of the Multiverse), 'ua'
   * (Unearthed Arcana playtest content).
   */
  ruleSources?: RuleSource[];
}

export type RuleSource = 'phb' | 'dmg' | 'mm' | 'xge' | 'tce' | 'vgm' | 'mmm' | 'ua';

export interface RuleSourceInfo {
  code: RuleSource;
  name: string;
  description: string;
}

/** Canonical metadata for the rulebook selector UI. */
export const RULE_SOURCES: RuleSourceInfo[] = [
  { code: 'phb', name: "Player's Handbook",       description: 'Core rules — classes, races, spells, combat. Always enabled by default.' },
  { code: 'dmg', name: "Dungeon Master's Guide",  description: 'Optional rules: encumbrance variant, wounds, insanity, downtime.' },
  { code: 'mm',  name: 'Monster Manual',          description: 'Monster stat blocks (wiki surface only — creature mechanics always enforced).' },
  { code: 'xge', name: "Xanathar's Guide",        description: 'Class optional features, extra feats, sleep/chase rules.' },
  { code: 'tce', name: "Tasha's Cauldron",        description: 'Custom background rule, origin feats, ability-score flexibility.' },
  { code: 'vgm', name: "Volo's Guide to Monsters", description: 'Extra playable races.' },
  { code: 'mmm', name: 'Monsters of the Multiverse', description: 'Rewritten race traits.' },
  { code: 'ua',  name: 'Unearthed Arcana',        description: 'Playtest content. Unstable by design.' },
];

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  gridSize: 70,
  gridType: 'square',
  gridOpacity: 0.15,
  enableFogOfWar: true,
  enableDynamicLighting: false,
  allowPlayerRest: true,
  showCreatureStatsToPlayers: true,
  showPlayersToPlayers: true,
  // PHB is implicitly always on; listing it here as the default lets
  // existing settings UI treat the set uniformly.
  ruleSources: ['phb'],
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
