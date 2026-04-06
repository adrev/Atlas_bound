import type { Player, SessionSettings, GameMode } from './session.js';
import type { Token, WallSegment, FogPolygon, Condition, MapPing } from './map.js';
import type { Combatant, ActionType, InitiativeRollResult, SpellCastEvent, ActionEconomy } from './combat.js';
import type { ChatMessage, DiceRollData } from './chat.js';
import type { Character } from './character.js';

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
  };
  'map:token-moved': { tokenId: string; x: number; y: number };
  'map:token-added': Token;
  'map:token-removed': { tokenId: string };
  'map:token-updated': { tokenId: string; changes: Partial<Token> };
  'map:fog-updated': { fogState: FogPolygon[] };
  'map:walls-updated': { walls: WallSegment[] };
  'map:pinged': MapPing;
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
  'chat:message': { type: 'ic' | 'ooc'; content: string; characterName?: string };
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
  ClientChatEvents;

export type ServerToClientEvents =
  ServerSessionEvents &
  ServerMapEvents &
  ServerCombatEvents &
  ServerCharacterEvents &
  ServerChatEvents;
