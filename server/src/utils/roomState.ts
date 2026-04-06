import type { Token, Condition } from '@dnd-vtt/shared';
import type { CombatState, ActionEconomy } from '@dnd-vtt/shared';

export interface RoomPlayer {
  userId: string;
  displayName: string;
  socketId: string;
  role: 'dm' | 'player';
  characterId: string | null;
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
