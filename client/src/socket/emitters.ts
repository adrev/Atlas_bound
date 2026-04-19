import { getSocket } from './client';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMapStore } from '../stores/useMapStore';
import { useDiceAnimationStore } from '../stores/useDiceAnimationStore';
import type {
  Token,
  Condition,
  ActionType,
  SpellCastEvent,
  WallSegment,
  SessionSettings,
  Drawing,
  DrawingStreamPayload,
} from '@dnd-vtt/shared';

// --- Session ---
export function emitJoinSession(roomCode: string) {
  getSocket().emit('session:join', { roomCode });
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

// --- Scene Manager (Player Ribbon / DM preview) ---

/**
 * Ask the server for the full list of maps in this session, along
 * with the current ribbon position. Used by the Scene Manager sidebar
 * when the DM tools tab opens.
 */
export function emitListMaps() {
  getSocket().emit('map:list', {});
}

/**
 * DM-only: Load a map into the DM's private preview. Players do NOT
 * receive this — the ribbon stays put. The server responds with
 * `map:loaded` + `isPreview: true` to ONLY this socket.
 */
export function emitPreviewLoadMap(mapId: string) {
  getSocket().emit('map:preview-load', { mapId });
}

/**
 * DM-only: Move the player ribbon to a new map. Every player gets a
 * full `map:loaded` broadcast and switches their canvas. Every client
 * also gets a lightweight `map:player-map-changed` so scene manager
 * sidebars update the ribbon indicator.
 */
export function emitActivateMapForPlayers(
  mapId: string,
  stagedPositions?: Array<{ characterId: string; name: string; x: number; y: number; imageUrl: string | null; ownerUserId: string }>,
) {
  getSocket().emit('map:activate-for-players', { mapId, stagedPositions });
}

/**
 * DM-only: Remove a map from the session library. Refused server-side
 * if this is the current ribbon (DM must move the ribbon first).
 */
export function emitDeleteMap(mapId: string) {
  getSocket().emit('map:delete', { mapId });
}

/** DM-only: rename a map. Server clamps length to 80 chars and rebroadcasts list. */
export function emitRenameMap(mapId: string, name: string) {
  getSocket().emit('map:rename', { mapId, name });
}

/**
 * DM-only: duplicate a map. Copies walls + encounter zones to a fresh
 * row; starts empty of tokens and with fully-fogged fog state.
 */
export function emitDuplicateMap(mapId: string) {
  getSocket().emit('map:duplicate', { mapId });
}

/**
 * DM-only: persist a new sidebar order. Pass the full ordered list of
 * map IDs; the server assigns display_order = index+1 and broadcasts
 * the updated list to every DM.
 */
export function emitReorderMaps(mapIds: string[]) {
  getSocket().emit('map:reorder', { mapIds });
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

/**
 * Emit a token update to the server AND apply it locally so the UI
 * reflects the change immediately. The server broadcasts to OTHER clients
 * via socket.to(...).emit('map:token-updated', ...) which intentionally
 * excludes the sender — without applying locally, condition / position /
 * conditions changes wouldn't appear until a refresh.
 *
 * Pass `{ skipLocal: true }` if you've already updated the store yourself.
 */
export function emitTokenUpdate(
  tokenId: string,
  changes: Partial<Token>,
  opts: { skipLocal?: boolean } = {},
) {
  getSocket().emit('map:token-update', { tokenId, changes });
  if (!opts.skipLocal) {
    useMapStore.getState().updateToken(tokenId, changes);
  }
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

// --- Encounter spawn zones (DM-only) ---
export function emitZoneAdd(zone: { name: string; x: number; y: number; width: number; height: number }) {
  getSocket().emit('map:zone-add', zone);
}

export function emitZoneUpdate(patch: { zoneId: string; name?: string; x?: number; y?: number; width?: number; height?: number }) {
  getSocket().emit('map:zone-update', patch);
}

export function emitZoneDelete(zoneId: string) {
  getSocket().emit('map:zone-delete', { zoneId });
}

// --- Ready Check ---
export function emitReadyCheck(tokenIds: string[]) {
  getSocket().emit('combat:ready-check', { tokenIds });
}

export function emitReadyResponse(ready: boolean) {
  getSocket().emit('combat:ready-response', { ready });
}

// --- Combat ---
export function emitStartCombat(tokenIds: string[]) {
  getSocket().emit('combat:start', { tokenIds });
}

/** Add a single token to the in-progress initiative order. DM-only; server refuses otherwise. */
export function emitAddCombatant(tokenId: string) {
  getSocket().emit('combat:add-combatant', { tokenId });
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

/**
 * Take the Dash action for the current combatant — consumes the Action
 * slot AND doubles movement for the turn. The server computes the new
 * economy and broadcasts combat:action-used so every client updates.
 */
export function emitDash() {
  getSocket().emit('combat:dash', {});
}

/**
 * Execute an Opportunity Attack against a mover who just left the
 * attacker's melee reach. The server rolls the attack, applies
 * damage, and burns the attacker's reaction slot.
 */
export function emitOAExecute(attackerTokenId: string, moverTokenId: string) {
  getSocket().emit('combat:oa-execute', { attackerTokenId, moverTokenId });
}

/** Decline an OA prompt (reserved for future audit). */
export function emitOADecline(attackerTokenId: string, moverTokenId: string) {
  getSocket().emit('combat:oa-decline', { attackerTokenId, moverTokenId });
}

/**
 * Broadcast a leveled spell cast intent so other clients can show
 * a Counterspell prompt. The cast resolver waits ~2s for a
 * `combat:spell-counterspelled` response before committing the
 * spell's effects.
 */
export function emitSpellCastAttempt(args: {
  castId: string;
  casterTokenId: string;
  casterName: string;
  spellName: string;
  spellLevel: number;
}) {
  getSocket().emit('combat:spell-cast-attempt', args);
}

/** Confirm a counterspell — broadcasts to all clients so the original
 * caster can abort their cast. `counterCasterTokenId` is used by the
 * server for an ownership check. */
export function emitSpellCounterspelled(args: {
  castId: string;
  counterCasterName: string;
  counterSlotLevel: number;
  counterCasterTokenId?: string;
}) {
  getSocket().emit('combat:spell-counterspelled', args);
}

/**
 * Broadcast that an attack would hit so the target's owner can pop
 * a Shield spell prompt. The attacker's resolver pauses ~1.4 s for
 * a response before applying damage.
 */
export function emitAttackHitAttempt(args: {
  attackId: string;
  targetTokenId: string;
  attackerName: string;
  attackTotal: number;
  currentAC: number;
}) {
  getSocket().emit('combat:attack-hit-attempt', args);
}

/** Confirm Shield — broadcasts so the attacker's resolver can recompute.
 * `defenderTokenId` is used by the server for an ownership check. */
export function emitShieldCast(args: {
  attackId: string;
  defenderName: string;
  defenderTokenId?: string;
}) {
  getSocket().emit('combat:shield-cast', args);
}

export function emitUseMovement(feet: number) {
  getSocket().emit('combat:use-movement', { feet });
}

export function emitCastSpell(event: SpellCastEvent) {
  getSocket().emit('combat:cast-spell', event);
}

// --- Conditions with metadata (Phase 5 — duration tracking) ---

export interface ConditionApplyOptions {
  targetTokenId: string;
  conditionName: string;
  source: string;
  casterTokenId?: string;
  /** Combat round AFTER which the condition auto-expires */
  expiresAfterRound?: number;
  saveAtEndOfTurn?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number; advantage?: boolean };
  endsOnDamage?: boolean;
}

/**
 * Apply a condition to a token AND register duration / save retry metadata
 * with the server. The server will automatically expire the condition
 * after the duration, roll save retries at end of turn for spells like
 * Hold Person, and clean up on concentration drop.
 */
export function emitApplyConditionWithMeta(opts: ConditionApplyOptions) {
  getSocket().emit('condition:apply-with-meta', opts);
}

/**
 * Notify the server that a caster has dropped concentration on a spell.
 * The server clears every condition anchored to (casterTokenId, spellName)
 * across the room and broadcasts the updated tokens.
 */
export function emitConcentrationDropped(casterTokenId: string, spellName: string) {
  getSocket().emit('concentration:dropped', { casterTokenId, spellName });
}

/**
 * Notify the server that a token has just taken damage so it can:
 *   1. Roll a CON save to maintain concentration (DC max(10, dmg/2))
 *   2. Clear conditions with endsOnDamage (Sleep)
 *   3. Re-roll saves for saveOnDamage spells (Hideous Laughter)
 *
 * The cast resolver should call this AFTER applying damage to a token.
 * The server broadcasts the resulting condition + character updates.
 */
export function emitDamageSideEffects(tokenId: string, damageAmount: number) {
  if (damageAmount <= 0) return;
  getSocket().emit('damage:side-effects', { tokenId, damageAmount });
}

// --- Music ---
export function emitMusicChange(track: string | null, fileIndex?: number) {
  getSocket().emit('session:music-change', { track, fileIndex });
}

export function emitMusicAction(action: 'pause' | 'resume' | 'next' | 'prev') {
  getSocket().emit('session:music-action', { action });
}

// --- Character ---
/**
 * Emit a character update to the server AND apply it locally so the UI
 * reflects the change immediately. The server broadcasts to OTHER clients
 * via socket.to(...).emit('character:updated', ...), which intentionally
 * excludes the sender — so without applying locally we'd otherwise show
 * stale data on the next render or panel reopen.
 *
 * Pass `{ skipLocal: true }` if you've already updated the store yourself
 * (e.g. via setAllCharacters with extra fields) and just want the network
 * broadcast.
 */
export function emitCharacterUpdate(
  characterId: string,
  changes: Record<string, unknown>,
  opts: { skipLocal?: boolean } = {},
) {
  getSocket().emit('character:update', { characterId, changes });
  if (!opts.skipLocal) {
    useCharacterStore.getState().applyRemoteUpdate(characterId, changes);
  }
}

export function emitCharacterSyncRequest(characterId: string) {
  getSocket().emit('character:sync-request', { characterId });
}

// --- Typing indicator ---
let _lastTypingEmit = 0;
export function emitTyping() {
  const now = Date.now();
  if (now - _lastTypingEmit < 2000) return;
  _lastTypingEmit = now;
  getSocket().emit('chat:typing', {});
}

// --- Presence ---
export function emitViewing(tab: string) {
  getSocket().emit('session:viewing', { tab });
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

export function emitRoll(
  notation: string,
  reason?: string,
  hidden?: boolean,
  template?: import('@dnd-vtt/shared').RollTemplate,
) {
  const payload: Record<string, unknown> = { notation, reason, hidden };
  if (template) payload.template = template;
  getSocket().emit('chat:roll', payload);
}

/**
 * Emit a chat roll whose outcome was determined by the local 3D dice
 * animation (dice-box). Server trusts the reported values instead of
 * re-rolling. Used by the Dice Tray buttons + the `/r` chat command —
 * the only places where the user "physically" throws dice and the 3D
 * animation is the authoritative result.
 *
 * Attack/spell/initiative rolls continue to use plain `emitRoll` so
 * the server handles them as ordinary random rolls.
 */
export function emitPhysicalRoll(
  notation: string,
  reason: string | undefined,
  hidden: boolean | undefined,
  dice: Array<{ type: number; value: number }>,
  total: number,
  template?: import('@dnd-vtt/shared').RollTemplate,
) {
  const payload: Record<string, unknown> = {
    notation, reason, hidden,
    reported: { dice, total },
  };
  if (template) payload.template = template;
  getSocket().emit('chat:roll', payload);
}

/**
 * Start a physical roll — the Dice Tray + /r command's entry point.
 * Queues dice-box to animate the roll; once physics settle the
 * Dice3DOverlay reads the result and calls `emitPhysicalRoll` above.
 * No socket message goes out yet — that happens after the 3D settle.
 */
export function startPhysicalRoll(notation: string, reason?: string, hidden?: boolean) {
  useDiceAnimationStore.getState().playPhysical(notation, reason, hidden);
}

/**
 * Emit a system message to the session chat. Used for spell results,
 * cast announcements, and any other rich consolidated game-event message.
 * Multi-line content is supported.
 */
export function emitSystemMessage(content: string) {
  getSocket().emit('chat:message', { type: 'system', content });
}

// --- Drawings (DM / player map annotations) ---

/**
 * Commit a finished drawing to the room. Server persists it (unless
 * ephemeral) and broadcasts `drawing:created` to every client whose
 * visibility scope covers this drawing.
 *
 * The local store is updated OPTIMISTICALLY at the call site (see
 * useDrawStore.commitStroke), so we don't touch it here.
 */
export function emitDrawingCreate(drawing: Drawing) {
  getSocket().emit('drawing:create', { drawing });
}

/** Delete a drawing by id. Server checks auth (DM or creator). */
export function emitDrawingDelete(drawingId: string) {
  getSocket().emit('drawing:delete', { drawingId });
}

/**
 * Move / reshape an existing drawing. Sends only the new geometry;
 * kind / color / visibility stay what they were at creation. Server
 * gates on DM OR creator. Client should also optimistically mutate
 * the local store so the drag feels instant.
 */
export function emitDrawingUpdate(drawingId: string, geometry: Drawing['geometry']) {
  getSocket().emit('drawing:update', { drawingId, geometry });
}

/**
 * Clear many drawings in one shot.
 *   `all`  → DM wipe of every drawing on the current map (DM-only)
 *   `mine` → wipe of every drawing this user created on the map
 */
export function emitDrawingClearAll(scope: 'all' | 'mine') {
  getSocket().emit('drawing:clear-all', { scope });
}

/**
 * Broadcast an in-progress stroke preview so other clients can see
 * the drawing being drawn live. The server does NOT persist this —
 * it's just forwarded to the applicable audience. Call rAF-throttled
 * from the mouse move handler, not on every raw move event.
 */
export function emitDrawingStream(payload: DrawingStreamPayload) {
  getSocket().emit('drawing:stream', payload);
}

/**
 * Tell the server (and thus other clients) that the streamed preview
 * for `tempId` is done. Watchers drop the preview object from their
 * store; when the final `drawing:created` arrives shortly after it
 * replaces the preview with a real committed drawing.
 */
export function emitDrawingStreamEnd(tempId: string) {
  getSocket().emit('drawing:stream-end', { tempId });
}
