import { v4 as uuidv4 } from 'uuid';
import type { Server, Socket } from 'socket.io';
import {
  getPlayerBySocketId,
  playerIsDM,
  isTokenOwnerOrDM,
  isCurrentTurnOwnerOrDM,
  type RoomPlayer,
  type RoomState,
} from '../../utils/roomState.js';
import * as CombatService from '../../services/CombatService.js';
import * as DiceService from '../../services/DiceService.js';
import * as ConditionService from '../../services/ConditionService.js';
import { broadcastEvent } from '../../utils/eventBroadcast.js';
import { combatRollInitiativeSchema, combatSetInitiativeSchema } from '../../utils/validation.js';
import { safeHandler } from '../../utils/socketHelpers.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';
import { emitToTokenViewers } from '../../utils/combatBroadcast.js';
import { tokenVisibleToPlayer } from '../../utils/tokenVisibility.js';

function liveSocketIdsForPlayer(room: RoomState, player: RoomPlayer): string[] {
  const liveSockets = room.userSockets.get(player.userId);
  if (liveSockets && liveSockets.size > 0) return [...liveSockets];
  return [player.socketId];
}

function canSeeTokenDetails(room: RoomState, player: RoomPlayer, tokenId: string): boolean {
  if (player.role === 'dm') return true;
  const token = room.tokens.get(tokenId);
  if (!token) return false;
  return token.ownerUserId === player.userId || tokenVisibleToPlayer(token, player.userId);
}

function combatantLabelForPlayer(
  room: RoomState,
  player: RoomPlayer,
  combatant: { tokenId: string; name: string }
): string {
  return canSeeTokenDetails(room, player, combatant.tokenId) ? combatant.name : '???';
}

/**
 * Initiative + turn-advance events. The end-of-turn / start-of-turn
 * ConditionService ticks, round-hook emits, and lair-action reminders
 * all live here because they fire from `combat:next-turn`.
 */
export function registerCombatInitiative(io: Server, socket: Socket): void {
  socket.on(
    'combat:roll-initiative',
    safeHandler(socket, async (data) => {
      const parsed = combatRollInitiativeSchema.safeParse(data);
      if (!parsed.success) return;

      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;
      if (!isTokenOwnerOrDM(ctx, parsed.data.tokenId)) return;

      const { tokenId, bonus } = parsed.data;

      // Roll initiative
      const { roll, total } = DiceService.rollInitiative(bonus);
      CombatService.setInitiative(ctx.room.sessionId, tokenId, total);

      const result = {
        tokenId,
        roll,
        bonus,
        total,
      };

      io.to(ctx.room.sessionId).emit('combat:initiative-set', result);

      // Check if all initiatives are rolled
      if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
        const sorted = CombatService.sortInitiative(ctx.room.sessionId);
        io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
      }
    })
  );

  socket.on(
    'combat:set-initiative',
    safeHandler(socket, async (data) => {
      const parsed = combatSetInitiativeSchema.safeParse(data);
      if (!parsed.success) return;

      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;
      if (!playerIsDM(ctx)) return;

      const { tokenId, total } = parsed.data;
      const combatant = CombatService.setInitiative(ctx.room.sessionId, tokenId, total);
      if (!combatant) return;

      io.to(ctx.room.sessionId).emit('combat:initiative-set', {
        tokenId,
        roll: total - combatant.initiativeBonus,
        bonus: combatant.initiativeBonus,
        total,
      });

      if (CombatService.allInitiativesRolled(ctx.room.sessionId)) {
        const sorted = CombatService.sortInitiative(ctx.room.sessionId);
        io.to(ctx.room.sessionId).emit('combat:all-initiatives-ready', { combatants: sorted });
      }
    })
  );

  /**
   * DM-only. Toggle the Surprise flag on a combatant during the
   * review phase. Broadcasts `combat:surprise-set` so every client's
   * InitiativeReviewModal + stored combatant state stay in sync.
   * Alert feat immunity is enforced in CombatService.setSurprise \u2014
   * null return means "blocked (probably Alert)".
   */
  socket.on(
    'combat:set-surprise',
    safeHandler(socket, async (data) => {
      const raw = data as Record<string, unknown> | undefined;
      const tokenId = typeof raw?.tokenId === 'string' ? raw.tokenId : null;
      const surprised = Boolean(raw?.surprised);
      if (!tokenId) return;
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx || !playerIsDM(ctx)) return;
      const combatant = CombatService.setSurprise(ctx.room.sessionId, tokenId, surprised);
      if (!combatant) {
        io.to(socket.id).emit('combat:set-surprise-rejected', {
          tokenId,
          reason: 'alert-immune-or-missing',
        });
        return;
      }
      io.to(ctx.room.sessionId).emit('combat:surprise-set', {
        tokenId,
        surprised: combatant.surprised === true,
      });
    })
  );

  socket.on(
    'combat:next-turn',
    safeHandler(socket, async () => {
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx) return;
      if (!isCurrentTurnOwnerOrDM(ctx)) return;

      // Allow either the DM OR the current turn's owner to advance.
      // Without this restriction every player has to ask the DM to click
      // End Turn for them, which is annoying.
      const room = ctx.room;
      const state = room.combatState;
      if (!state) return;
      const currentCombatant = state.combatants[state.currentTurnIndex];
      const isCurrentOwner =
        currentCombatant?.characterId &&
        room.tokens.get(currentCombatant.tokenId)?.ownerUserId === ctx.player.userId;
      const isDM = ctx.player.role === 'dm';
      if (!isDM && !isCurrentOwner) return;

      try {
        // \u2500\u2500 Phase 1: END-of-turn tick on the combatant whose turn is
        // ENDING. This is when save-retries (Hold Person, Hideous
        // Laughter, Dominate Person, etc.) get rolled per RAW ("at the
        // end of each of its turns").
        const endingCombatant = state.combatants[state.currentTurnIndex];
        const endTickResult = endingCombatant
          ? await ConditionService.tickEndOfTurnConditions(
              ctx.room.sessionId,
              endingCombatant.tokenId
            )
          : { removed: [], messages: [] };

        // Capture the pre-advance round so R7 round hooks can fire
        // once per transition (e.g. round 3 \u2192 round 4), not on every
        // turn inside a round.
        const preAdvanceRound = state.roundNumber;

        // ── Phase 2: advance the turn order. Route through the event
        // cursor — this is the event players missed most often when
        // their socket was zombied ("DM ended the turn but I never saw
        // it advance on my end"). Replay on reconnect brings us back.
        const result = CombatService.nextTurn(ctx.room.sessionId);
        broadcastEvent(io, ctx.room, 'combat:turn-advanced', {
          currentTurnIndex: result.currentTurnIndex,
          // Clients receive visibility-FILTERED combatant lists, so the
          // raw index points at the wrong row whenever hidden combatants
          // precede it (wrong highlight, camera panning to the wrong
          // token). The tokenId is position-independent — clients resolve
          // it against their own list. Index kept for back-compat.
          currentTokenId: result.currentCombatant?.tokenId ?? null,
          roundNumber: result.roundNumber,
          actionEconomy: result.actionEconomy,
        });

        // \u2500\u2500 Phase 3: START-of-turn tick on the NEW combatant. Expires
        // any of their conditions whose duration has run out (Bless
        // after 10 rounds, etc.). Doing this AFTER nextTurn means
        // `result.roundNumber` is the new round, so a 10-round spell
        // cast in round 1 expires at the start of the FIRST turn of
        // round 11 \u2014 exactly 10 rounds of effect, matching D&D 5e.
        const startingCombatant = result.currentCombatant;
        const startTickResult = startingCombatant
          ? ConditionService.tickStartOfTurnConditions(
              ctx.room.sessionId,
              startingCombatant.tokenId,
              result.roundNumber
            )
          : { removed: [], messages: [] };

        // Broadcast updated conditions if anything changed for the
        // ending combatant (save retries removed something).
        if (endingCombatant && endTickResult.removed.length > 0) {
          const updatedToken = ctx.room.tokens.get(endingCombatant.tokenId);
          if (updatedToken) {
            emitToTokenViewers(io, ctx.room, endingCombatant.tokenId, 'map:token-updated', {
              tokenId: endingCombatant.tokenId,
              changes: tokenConditionChanges(ctx.room, endingCombatant.tokenId),
            });
          }
        }

        // Clear "until your next turn" flags on the combatant whose
        // turn is now STARTING. Dodge, Disengage, and the Shield
        // spell are 5e effects that expire at the start of your own
        // next turn. ALSO broadcast the start-of-turn expiration
        // removals from Phase 3 above.
        if (startingCombatant) {
          const startingToken = ctx.room.tokens.get(startingCombatant.tokenId);
          if (startingToken) {
            const before = startingToken.conditions;
            const after = before.filter(
              (c) => !(['dodging', 'disengaged', 'shield-spell'] as string[]).includes(c)
            );
            const cleanupChanged = after.length !== before.length;
            if (cleanupChanged) startingToken.conditions = after;

            // If either the cleanup OR the start-of-turn expiry tick
            // changed the conditions array, broadcast once.
            if (cleanupChanged || startTickResult.removed.length > 0) {
              emitToTokenViewers(io, ctx.room, startingCombatant.tokenId, 'map:token-updated', {
                tokenId: startingCombatant.tokenId,
                changes: tokenConditionChanges(ctx.room, startingCombatant.tokenId),
              });
            }
          }
        }

        // Announce the new turn in chat as a system message so the round
        // count and current combatant are visible without looking at the
        // initiative tracker. Includes any condition tick messages from
        // BOTH the previous combatant's end-of-turn saves AND the new
        // combatant's start-of-turn expirations.
        const buildAnnouncement = (recipient: RoomPlayer): string => {
          const lines: string[] = [];
          if (endingCombatant && canSeeTokenDetails(ctx.room, recipient, endingCombatant.tokenId)) {
            for (const m of endTickResult.messages) lines.push(m);
          }
          if (
            startingCombatant &&
            canSeeTokenDetails(ctx.room, recipient, startingCombatant.tokenId)
          ) {
            for (const m of startTickResult.messages) lines.push(m);
          }
          // R7 \u2014 round hooks fire when the round number advanced.
          if (result.roundNumber !== preAdvanceRound) {
            for (const m of ctx.room.roundHooks) lines.push(`\uD83D\uDCE3 ${m}`);
            // Lair actions are DM-facing reminders. Sending hidden lair
            // token names to players reveals encounter prep through chat.
            if (recipient.role === 'dm') {
              for (const lairTokenId of ctx.room.lairActionTokens) {
                const lairToken = ctx.room.tokens.get(lairTokenId);
                if (!lairToken) continue;
                lines.push(
                  `\uD83C\uDFF0 LAIR ACTION \u2014 ${lairToken.name} (init 20, losing ties). DM: narrate + resolve via !lair <action>.`
                );
              }
            }
          }
          // Recharge reminders name monster abilities, so only show
          // them when the recipient can see/own the starting combatant.
          if (
            result.rechargedAbilities.length > 0 &&
            startingCombatant &&
            canSeeTokenDetails(ctx.room, recipient, startingCombatant.tokenId)
          ) {
            lines.push(
              `\uD83D\uDD25 ${startingCombatant.name} recharged: ${result.rechargedAbilities.join(', ')}`
            );
          }
          // R7 \u2014 turn hooks for the combatant whose turn is now starting.
          if (
            startingCombatant &&
            canSeeTokenDetails(ctx.room, recipient, startingCombatant.tokenId)
          ) {
            const hooks = ctx.room.turnHooks.get(startingCombatant.tokenId);
            if (hooks && hooks.length > 0) {
              for (const m of hooks) lines.push(`\uD83D\uDCE3 ${m}`);
            }
          }
          const currentName = combatantLabelForPlayer(ctx.room, recipient, result.currentCombatant);
          lines.push(
            result.skippedTokenIds.length > 0
              ? `\u2694\uFE0F Round ${result.roundNumber} \u2014 ${currentName}'s turn (skipped ${result.skippedTokenIds.length} downed)`
              : `\u2694\uFE0F Round ${result.roundNumber} \u2014 ${currentName}'s turn`
          );
          return lines.join('\n');
        };

        // Emit as per-recipient system chat so hidden combatants don't
        // leak through the text payload.
        const msgId = uuidv4();
        const now = new Date().toISOString();
        for (const recipient of ctx.room.players.values()) {
          const payload = {
            id: msgId,
            sessionId: ctx.room.sessionId,
            userId: 'system',
            displayName: 'System',
            type: 'system',
            content: buildAnnouncement(recipient),
            characterName: null,
            whisperTo: null,
            rollData: null,
            createdAt: now,
          };
          for (const sid of liveSocketIdsForPlayer(ctx.room, recipient)) {
            io.to(sid).emit('chat:new-message', payload);
          }
        }
      } catch (err) {
        socket.emit('session:error', {
          message: err instanceof Error ? err.message : 'Failed to advance turn',
        });
      }
    })
  );
}
