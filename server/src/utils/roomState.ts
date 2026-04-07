import type { Token, Condition } from '@dnd-vtt/shared';
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
    currentMapId: null,
    tokens: new Map(),
    combatState: null,
    actionEconomies: new Map(),
    conditionMeta: new Map(),
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
