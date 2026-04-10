import type { Token, Condition, Drawing } from '@dnd-vtt/shared';
import type { CombatState, ActionEconomy } from '@dnd-vtt/shared';

export interface RoomPlayer {
  userId: string;
  displayName: string;
  socketId: string;
  role: 'dm' | 'player';
  characterId: string | null;
}

/**
 * Per-token, per-condition metadata stored alongside the token's
 * conditions array. Tracks duration, source, and save retry rules so
 * the combat loop can decrement turns, re-roll Hold Person saves, and
 * auto-clear concentration spells when the caster drops focus.
 *
 * Stored as `roomState.conditionMeta.get(tokenId).get(conditionName)`.
 * Living in memory only — not persisted to DB. Lost on server restart.
 */
export interface ConditionMetadata {
  /** Lowercase condition name, matches token.conditions[i] */
  name: string;
  /** Spell name or 'manual' */
  source: string;
  /** TokenId of the caster (for concentration cleanup), if any */
  casterTokenId?: string;
  /** Combat round when this condition was applied */
  appliedRound: number;
  /** Combat round AFTER which it auto-expires (e.g. 1-min spell at round 1 → expiresAfter 10) */
  expiresAfterRound?: number;
  /** Save the target rolls at end of their turn — Hold Person etc. */
  saveAtEndOfTurn?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number; advantage?: boolean };
  /** Spell ends when the target takes any damage (Sleep) */
  endsOnDamage?: boolean;
}

export interface RoomState {
  sessionId: string;
  roomCode: string;
  dmUserId: string;
  players: Map<string, RoomPlayer>;
  gameMode: 'free-roam' | 'combat';
  /**
   * Active ready check state. Non-null while a DM-initiated ready
   * check is in progress. Cleared once all players respond or the
   * 15-second timeout fires.
   */
  readyCheck: {
    tokenIds: string[];
    responses: Map<string, boolean>; // userId -> ready
    timeout: ReturnType<typeof setTimeout> | null;
  } | null;
  /**
   * The map the players are currently rendering ("yellow ribbon").
   * This is what gets hydrated from `sessions.player_map_id` and is
   * the canonical source of truth for "where the party is".
   *
   * All player-facing broadcasts (initiative, combat, HP changes,
   * token moves on the active scene) fan out to sockets on this
   * map. When the DM clicks "Move Players Here" the ribbon moves
   * to the new map and this field is updated.
   */
  playerMapId: string | null;
  /**
   * Per-DM ephemeral "viewing" cursor. Key = userId. Only populated
   * for DMs who have navigated away from the player ribbon to preview
   * a different map (to set up the next encounter, etc.). When absent,
   * the DM is viewing the player ribbon map.
   *
   * Cleared on disconnect (after a short grace period so mid-session
   * refreshes don't lose the preview). Players never have entries.
   */
  dmViewingMap: Map<string, string>;
  /**
   * @deprecated Kept for backward compat. Was the single map-cursor
   * for the whole room; now only used as a fallback hint for the DM's
   * rehydration on rejoin. New code should read `playerMapId` for the
   * ribbon or `dmViewingMap.get(userId)` for a DM's current view.
   */
  currentMapId: string | null;
  tokens: Map<string, Token>;
  combatState: CombatState | null;
  actionEconomies: Map<string, ActionEconomy>;
  /**
   * tokenId → conditionName → metadata. Used by the duration tracker
   * to expire conditions on round/turn transitions and to clean up
   * concentration-anchored spells when the caster drops focus.
   */
  conditionMeta: Map<string, Map<string, ConditionMetadata>>;
  /**
   * drawingId → Drawing. All drawings for the CURRENT map, including
   * ephemeral ones (those exist in memory only and auto-expire on the
   * clients). Permanent drawings are also mirrored to the `drawings`
   * SQLite table so they survive a server restart.
   */
  drawings: Map<string, Drawing>;
}

// ── Rate limiting ──────────────────────────────────────────
const _rateLimitCounters = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(socketId: string, event: string, maxPerWindow: number, windowMs: number = 1000): boolean {
  const key = `${socketId}:${event}`;
  const now = Date.now();
  const entry = _rateLimitCounters.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    _rateLimitCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= maxPerWindow;
}

const rooms = new Map<string, RoomState>();
const roomCodeIndex = new Map<string, string>();

export function createRoom(
  sessionId: string,
  roomCode: string,
  dmUserId: string,
): RoomState {
  const room: RoomState = {
    sessionId,
    roomCode,
    dmUserId,
    players: new Map(),
    gameMode: 'free-roam',
    readyCheck: null,
    playerMapId: null,
    dmViewingMap: new Map(),
    currentMapId: null,
    tokens: new Map(),
    combatState: null,
    actionEconomies: new Map(),
    conditionMeta: new Map(),
    drawings: new Map(),
  };
  rooms.set(sessionId, room);
  roomCodeIndex.set(roomCode, sessionId);
  return room;
}

export function getRoom(sessionId: string): RoomState | undefined {
  return rooms.get(sessionId);
}

export function getRoomByCode(roomCode: string): RoomState | undefined {
  const sessionId = roomCodeIndex.get(roomCode);
  if (!sessionId) return undefined;
  return rooms.get(sessionId);
}

export function addPlayerToRoom(
  sessionId: string,
  player: RoomPlayer,
): void {
  const room = rooms.get(sessionId);
  if (!room) return;
  room.players.set(player.userId, player);
}

export function removePlayerFromRoom(
  sessionId: string,
  userId: string,
): void {
  const room = rooms.get(sessionId);
  if (!room) return;
  room.players.delete(userId);

  // If room is empty, clean up
  if (room.players.size === 0) {
    rooms.delete(sessionId);
    roomCodeIndex.delete(room.roomCode);
  }
}

export function getPlayerBySocketId(
  socketId: string,
): { room: RoomState; player: RoomPlayer } | undefined {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (player.socketId === socketId) {
        return { room, player };
      }
    }
  }
  return undefined;
}

export function getAllRooms(): Map<string, RoomState> {
  return rooms;
}

// ── Permission helpers ──────────────────────────────────────
// Used by socket event handlers to enforce server-side access
// control. All return booleans — callers should silently return
// on false (matching the existing pattern in mapEvents/sceneEvents).

type PlayerContext = { room: RoomState; player: RoomPlayer };

/** True if the player is the DM. */
export function playerIsDM(ctx: PlayerContext): boolean {
  return ctx.player.role === 'dm';
}

/** True if the player owns the specified token OR is DM. */
export function isTokenOwnerOrDM(ctx: PlayerContext, tokenId: string): boolean {
  if (ctx.player.role === 'dm') return true;
  const token = ctx.room.tokens.get(tokenId);
  if (!token) return false;
  return token.ownerUserId === ctx.player.userId;
}

/**
 * True if the player can damage/target the specified token.
 * DM can damage anyone. Players can damage:
 *   - NPCs (no ownerUserId) — standard enemy targeting
 *   - Their own tokens — self-damage from spells etc.
 * Players CANNOT damage other players' tokens (anti-grief).
 */
export function canTargetToken(ctx: PlayerContext, tokenId: string): boolean {
  if (ctx.player.role === 'dm') return true;
  const token = ctx.room.tokens.get(tokenId);
  if (!token) return false;
  // NPC tokens (no owner) are fair game for any player
  if (!token.ownerUserId) return true;
  // Players can only target their own tokens
  return token.ownerUserId === ctx.player.userId;
}

/** True if the player owns the current-turn combatant OR is DM. */
export function isCurrentTurnOwnerOrDM(ctx: PlayerContext): boolean {
  if (ctx.player.role === 'dm') return true;
  const state = ctx.room.combatState;
  if (!state) return false;
  const current = state.combatants[state.currentTurnIndex];
  if (!current) return false;
  const token = ctx.room.tokens.get(current.tokenId);
  if (!token) return false;
  return token.ownerUserId === ctx.player.userId;
}

/**
 * Resolve "which map is this player currently rendering?".
 *
 *   • Players always see the player ribbon map (`room.playerMapId`).
 *   • DMs see whatever they've previewed in `dmViewingMap`; if they
 *     haven't previewed anything, they default to the player ribbon.
 *
 * Used by the map/token/wall/fog/drawing handlers to decide which
 * map a given edit should persist to AND which sockets should
 * receive the resulting broadcast.
 */
export function resolveViewingMapId(
  room: RoomState,
  userId: string,
  role: 'dm' | 'player',
): string | null {
  if (role === 'dm') {
    const preview = room.dmViewingMap.get(userId);
    if (preview) return preview;
  }
  return room.playerMapId ?? room.currentMapId;
}

/**
 * Return the socket ids of every player currently rendering a given
 * map. A socket is "rendering" a map if:
 *   • It's a player and the map is the player ribbon
 *   • It's a DM and the map is either their current preview OR the
 *     player ribbon (if they have no active preview)
 *
 * Used by broadcast helpers to filter token/wall/fog/drawing updates
 * so they only reach sockets that actually see that map.
 */
export function socketsOnMap(room: RoomState, mapId: string): string[] {
  const out: string[] = [];
  for (const player of room.players.values()) {
    if (player.role === 'dm') {
      const preview = room.dmViewingMap.get(player.userId);
      if (preview) {
        if (preview === mapId) out.push(player.socketId);
      } else {
        // No preview — DM is on the ribbon
        if (room.playerMapId === mapId) out.push(player.socketId);
      }
    } else {
      // Player
      if (room.playerMapId === mapId) out.push(player.socketId);
    }
  }
  return out;
}
