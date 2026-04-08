import type { Player, SessionSettings, GameMode } from './session.js';
import type { Token, WallSegment, FogPolygon, Condition, MapPing, MapSummary } from './map.js';
import type { Combatant, ActionType, InitiativeRollResult, SpellCastEvent, ActionEconomy } from './combat.js';
import type { ChatMessage, DiceRollData } from './chat.js';
import type { Character } from './character.js';
import type { Drawing, DrawingStreamPayload } from './drawing.js';

// --- Session Events ---
export interface ClientSessionEvents {
  'session:join': { roomCode: string; displayName: string };
  'session:leave': {};
  'session:kick': { targetUserId: string };
  'session:update-settings': Partial<SessionSettings>;
}

export interface ServerSessionEvents {
  'session:state-sync': {
    sessionId: string;
    roomCode: string;
    userId: string;
    isDM: boolean;
    players: Player[];
    settings: SessionSettings;
    currentMapId: string | null;
    gameMode: GameMode;
  };
  'session:player-joined': Player;
  'session:player-left': { userId: string };
  'session:kicked': { userId: string };
  'session:settings-updated': SessionSettings;
  'session:error': { message: string };
}

// --- Map Events ---
export interface ClientMapEvents {
  'map:load': { mapId: string };
  'map:token-move': { tokenId: string; x: number; y: number };
  'map:token-add': Omit<Token, 'id' | 'createdAt'>;
  'map:token-remove': { tokenId: string };
  'map:token-update': { tokenId: string; changes: Partial<Token> };
  'map:fog-reveal': { points: number[] };
  'map:fog-hide': { points: number[] };
  'map:wall-add': WallSegment;
  'map:wall-remove': { index: number };
  'map:ping': { x: number; y: number };

  // --- Scene Manager (Player Ribbon / DM preview) events ---
  /** Request the full list of maps in this session for the scene manager sidebar */
  'map:list': {};
  /** DM-only: load a map into this DM's private preview view. Does NOT
   *  move the player ribbon, does NOT broadcast to other clients. */
  'map:preview-load': { mapId: string };
  /** DM-only: move the player ribbon to this map. Broadcasts `map:loaded`
   *  to every player and every DM who isn't already viewing it. */
  'map:activate-for-players': { mapId: string };
  /** DM-only: delete a map from the session library. Refuses if it is
   *  currently the player ribbon (DM must move the ribbon first). */
  'map:delete': { mapId: string };
}

export interface ServerMapEvents {
  'map:loaded': {
    map: {
      id: string;
      name: string;
      imageUrl: string | null;
      width: number;
      height: number;
      gridSize: number;
      gridType: 'square' | 'hex';
      gridOffsetX: number;
      gridOffsetY: number;
      walls: WallSegment[];
      fogState: FogPolygon[];
    };
    tokens: Token[];
    /** Permanent drawings for this map, filtered by visibility for the
     *  recipient. Ephemeral drawings are never included. */
    drawings?: Drawing[];
    /** True when this payload is a DM's private preview of a map the
     *  players aren't on. Lets the client know not to update its
     *  `playerMapId` cursor. */
    isPreview?: boolean;
  };
  'map:token-moved': { tokenId: string; x: number; y: number; mapId?: string };
  'map:token-added': Token;
  'map:token-removed': { tokenId: string; mapId?: string };
  'map:token-updated': { tokenId: string; changes: Partial<Token>; mapId?: string };
  'map:fog-updated': { fogState: FogPolygon[]; mapId?: string };
  'map:walls-updated': { walls: WallSegment[]; mapId?: string };
  'map:pinged': MapPing;

  // --- Scene Manager (Player Ribbon / DM preview) events ---
  /** Full list of maps in this session, with the ribbon flag already
   *  computed. Sent in response to `map:list` and also whenever the
   *  library changes (add/delete/rename). */
  'map:list-result': { maps: MapSummary[]; playerMapId: string | null };
  /** Lightweight ribbon-moved notification. Broadcast to every client
   *  (DMs and players) whenever the player ribbon changes so their
   *  scene manager sidebars can update without re-fetching. */
  'map:player-map-changed': { mapId: string };
}

// --- Combat Events ---
export interface ClientCombatEvents {
  'combat:start': { tokenIds: string[] };
  'combat:end': {};
  'combat:roll-initiative': { tokenId: string; bonus: number };
  'combat:set-initiative': { tokenId: string; total: number };
  'combat:next-turn': {};
  'combat:damage': { tokenId: string; amount: number };
  'combat:heal': { tokenId: string; amount: number };
  'combat:condition-add': { tokenId: string; condition: Condition };
  'combat:condition-remove': { tokenId: string; condition: Condition };
  'combat:death-save': { tokenId: string };
  'combat:use-action': { actionType: ActionType };
  'combat:use-movement': { feet: number };
  'combat:cast-spell': SpellCastEvent;
}

export interface ServerCombatEvents {
  'combat:started': { combatants: Combatant[]; roundNumber: number };
  'combat:ended': {};
  'combat:initiative-prompt': { tokenId: string; bonus: number };
  'combat:initiative-set': InitiativeRollResult;
  'combat:all-initiatives-ready': { combatants: Combatant[] };
  'combat:turn-advanced': {
    currentTurnIndex: number;
    roundNumber: number;
    actionEconomy: ActionEconomy;
  };
  'combat:hp-changed': { tokenId: string; hp: number; tempHp: number; change: number; type: 'damage' | 'heal' };
  'combat:condition-changed': { tokenId: string; conditions: Condition[] };
  'combat:death-save-updated': { tokenId: string; deathSaves: { successes: number; failures: number }; roll: number };
  'combat:action-used': { tokenId: string; actionType: ActionType; economy: ActionEconomy };
  'combat:movement-used': { tokenId: string; remaining: number };
  'combat:spell-cast': SpellCastEvent & { rollData?: DiceRollData };
}

// --- Drawing Events ---
/**
 * The DM (and optionally players) can draw freehand / shapes / text on
 * the current map. All drawings are broadcast to the room in real time,
 * filtered by visibility (shared / dm-only / player-only).
 *
 * `drawing:create` commits a finished drawing (persisted to DB unless
 * ephemeral). `drawing:stream` and `drawing:stream-end` are the
 * lightweight preview stream used while the creator is still dragging
 * their cursor, so watching clients see the stroke being drawn live
 * instead of popping in on release.
 */
export interface ClientDrawingEvents {
  'drawing:create': { drawing: Drawing };
  'drawing:delete': { drawingId: string };
  'drawing:clear-all': { scope: 'all' | 'mine' };
  'drawing:stream': DrawingStreamPayload;
  'drawing:stream-end': { tempId: string };
}

export interface ServerDrawingEvents {
  'drawing:created': Drawing;
  'drawing:deleted': { drawingId: string };
  'drawing:cleared': { scope: 'all' | 'mine'; userId?: string };
  'drawing:streamed': DrawingStreamPayload;
  'drawing:stream-end': { tempId: string };
}

// --- Character Events ---
export interface ClientCharacterEvents {
  'character:update': { characterId: string; changes: Record<string, unknown> };
  'character:sync-request': { characterId: string };
}

export interface ServerCharacterEvents {
  'character:updated': { characterId: string; changes: Record<string, unknown> };
  'character:synced': { character: Record<string, unknown> };
}

// --- Chat Events ---
export interface ClientChatEvents {
  'chat:message': { type: 'ic' | 'ooc' | 'system'; content: string; characterName?: string };
  'chat:whisper': { targetUserId: string; content: string };
  'chat:roll': { notation: string; reason?: string; hidden?: boolean };
}

export interface ServerChatEvents {
  'chat:new-message': ChatMessage;
  'chat:roll-result': ChatMessage;
  'chat:history': ChatMessage[];
}

// --- Combined types for Socket.io typing ---
export type ClientToServerEvents =
  ClientSessionEvents &
  ClientMapEvents &
  ClientCombatEvents &
  ClientCharacterEvents &
  ClientChatEvents &
  ClientDrawingEvents;

export type ServerToClientEvents =
  ServerSessionEvents &
  ServerMapEvents &
  ServerCombatEvents &
  ServerCharacterEvents &
  ServerChatEvents &
  ServerDrawingEvents;
