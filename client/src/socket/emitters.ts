import { getSocket } from './client';
import type {
  Token,
  Condition,
  ActionType,
  SpellCastEvent,
  WallSegment,
  SessionSettings,
} from '@dnd-vtt/shared';

// --- Session ---
export function emitJoinSession(roomCode: string, displayName: string) {
  getSocket().emit('session:join', { roomCode, displayName });
}

export function emitLeaveSession() {
  getSocket().emit('session:leave', {});
}

export function emitKickPlayer(targetUserId: string) {
  getSocket().emit('session:kick', { targetUserId });
}

export function emitUpdateSettings(settings: Partial<SessionSettings>) {
  getSocket().emit('session:update-settings', settings);
}

// --- Map ---
export function emitLoadMap(mapId: string) {
  getSocket().emit('map:load', { mapId });
}

export function emitTokenMove(tokenId: string, x: number, y: number) {
  getSocket().emit('map:token-move', { tokenId, x, y });
}

export function emitTokenAdd(token: Omit<Token, 'id' | 'createdAt'>) {
  getSocket().emit('map:token-add', token);
}

export function emitTokenRemove(tokenId: string) {
  getSocket().emit('map:token-remove', { tokenId });
}

export function emitTokenUpdate(tokenId: string, changes: Partial<Token>) {
  getSocket().emit('map:token-update', { tokenId, changes });
}

export function emitFogReveal(points: number[]) {
  getSocket().emit('map:fog-reveal', { points });
}

export function emitFogHide(points: number[]) {
  getSocket().emit('map:fog-hide', { points });
}

export function emitWallAdd(wall: WallSegment) {
  getSocket().emit('map:wall-add', wall);
}

export function emitWallRemove(index: number) {
  getSocket().emit('map:wall-remove', { index });
}

export function emitPing(x: number, y: number) {
  getSocket().emit('map:ping', { x, y });
}

// --- Combat ---
export function emitStartCombat(tokenIds: string[]) {
  getSocket().emit('combat:start', { tokenIds });
}

export function emitEndCombat() {
  getSocket().emit('combat:end', {});
}

export function emitRollInitiative(tokenId: string, bonus: number) {
  getSocket().emit('combat:roll-initiative', { tokenId, bonus });
}

export function emitSetInitiative(tokenId: string, total: number) {
  getSocket().emit('combat:set-initiative', { tokenId, total });
}

export function emitNextTurn() {
  getSocket().emit('combat:next-turn', {});
}

export function emitDamage(tokenId: string, amount: number) {
  getSocket().emit('combat:damage', { tokenId, amount });
}

export function emitHeal(tokenId: string, amount: number) {
  getSocket().emit('combat:heal', { tokenId, amount });
}

export function emitConditionAdd(tokenId: string, condition: Condition) {
  getSocket().emit('combat:condition-add', { tokenId, condition });
}

export function emitConditionRemove(tokenId: string, condition: Condition) {
  getSocket().emit('combat:condition-remove', { tokenId, condition });
}

export function emitDeathSave(tokenId: string) {
  getSocket().emit('combat:death-save', { tokenId });
}

export function emitUseAction(actionType: ActionType) {
  getSocket().emit('combat:use-action', { actionType });
}

export function emitUseMovement(feet: number) {
  getSocket().emit('combat:use-movement', { feet });
}

export function emitCastSpell(event: SpellCastEvent) {
  getSocket().emit('combat:cast-spell', event);
}

// --- Character ---
export function emitCharacterUpdate(characterId: string, changes: Record<string, unknown>) {
  getSocket().emit('character:update', { characterId, changes });
}

export function emitCharacterSyncRequest(characterId: string) {
  getSocket().emit('character:sync-request', { characterId });
}

// --- Chat ---
export function emitChatMessage(
  type: 'ic' | 'ooc',
  content: string,
  characterName?: string
) {
  getSocket().emit('chat:message', { type, content, characterName });
}

export function emitWhisper(targetUserId: string, content: string) {
  getSocket().emit('chat:whisper', { targetUserId, content });
}

export function emitRoll(notation: string, reason?: string, hidden?: boolean) {
  getSocket().emit('chat:roll', { notation, reason, hidden });
}

/**
 * Emit a system message to the session chat. Used for spell results,
 * cast announcements, and any other rich consolidated game-event message.
 * Multi-line content is supported.
 */
export function emitSystemMessage(content: string) {
  getSocket().emit('chat:message', { type: 'system', content });
}
