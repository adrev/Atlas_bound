import type { Server, Socket } from 'socket.io';
import type { ChatMessage } from '@dnd-vtt/shared';
import { parseDiceNotation } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { getPlayerBySocketId, checkRateLimit } from '../utils/roomState.js';
import * as DiceService from '../services/DiceService.js';
import { chatMessageSchema, chatWhisperSchema, chatRollSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { validateReportedRoll } from '../utils/rollValidator.js';
import { tryHandleChatCommand } from '../services/ChatCommands.js';
// Side-effect imports — register slash-command handlers into the
// central ChatCommands registry at module load.
import '../services/chatCommands/noteHandlers.js';
import '../services/chatCommands/hpHandlers.js';
import '../services/chatCommands/conditionHandlers.js';
import '../services/chatCommands/turnHookHandlers.js';

export function registerChatEvents(io: Server, socket: Socket): void {

  socket.on('chat:message', safeHandler(socket, async (data) => {
    const parsed = chatMessageSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    if (!checkRateLimit(socket.id, 'chat:message', 5, 5000)) return;

    const { type, content, characterName } = parsed.data;

    // Slash-command dispatcher (R1 / R8 / future). Commands starting
    // with `!` are routed here before we persist or broadcast the raw
    // input. A handled command is responsible for emitting whatever
    // chat messages it wants; the user's input line is suppressed so
    // `!gmnote XYZ` doesn't leave the literal command string in chat.
    if (content.startsWith('!')) {
      const handled = await tryHandleChatCommand(io, ctx, content);
      if (handled) return;
    }

    const messageId = uuidv4();
    const now = new Date().toISOString();

    const message: ChatMessage = {
      id: messageId, sessionId: ctx.room.sessionId, userId: ctx.player.userId,
      displayName: ctx.player.displayName, type, content,
      characterName: characterName ?? null, whisperTo: null, rollData: null, createdAt: now,
    };

    await pool.query(`
      INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, character_name, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [messageId, ctx.room.sessionId, ctx.player.userId, ctx.player.displayName, type, content, characterName ?? null, now]);

    io.to(ctx.room.sessionId).emit('chat:new-message', message);
  }));

  socket.on('chat:whisper', safeHandler(socket, async (data) => {
    const parsed = chatWhisperSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Same rate window as chat:message — 5 per 5 seconds.
    if (!checkRateLimit(socket.id, 'chat:whisper', 5, 5000)) return;

    const { targetUserId, content } = parsed.data;

    // Authorize target: must be an actual member of this session
    // (anyone in session_players, not just currently-connected). Without
    // this, a malicious client could whisper to any UUID and the message
    // would be persisted even though no one in the session will ever see
    // it legitimately. Persisting spoof whispers also bloats chat_messages.
    const { rows: memberRows } = await pool.query(
      'SELECT 1 FROM session_players WHERE session_id = $1 AND user_id = $2',
      [ctx.room.sessionId, targetUserId],
    );
    if (memberRows.length === 0) return;

    const messageId = uuidv4();
    const now = new Date().toISOString();

    const message: ChatMessage = {
      id: messageId, sessionId: ctx.room.sessionId, userId: ctx.player.userId,
      displayName: ctx.player.displayName, type: 'whisper', content,
      characterName: null, whisperTo: targetUserId, rollData: null, createdAt: now,
    };

    await pool.query(`
      INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, whisper_to, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [messageId, ctx.room.sessionId, ctx.player.userId, ctx.player.displayName, 'whisper', content, targetUserId, now]);

    const targetPlayer = ctx.room.players.get(targetUserId);
    if (targetPlayer) { io.to(targetPlayer.socketId).emit('chat:new-message', message); }
    socket.emit('chat:new-message', message);
    const dmPlayer = ctx.room.players.get(ctx.room.dmUserId);
    if (dmPlayer && dmPlayer.userId !== ctx.player.userId && dmPlayer.userId !== targetUserId) {
      io.to(dmPlayer.socketId).emit('chat:new-message', message);
    }
  }));

  socket.on('chat:typing', safeHandler(socket, async () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    socket.to(ctx.room.sessionId).emit('chat:typing', {
      userId: ctx.player.userId, displayName: ctx.player.displayName,
    });
  }));

  socket.on('chat:roll', safeHandler(socket, async (data) => {
    const parsed = chatRollSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Rolls write to chat_messages and trigger 3D dice animations for
    // every connected client — rate-limit to 10 per 5 seconds (more
    // generous than chat:message since a single combat turn can
    // legitimately fire attack + damage + save rolls in quick sequence).
    if (!checkRateLimit(socket.id, 'chat:roll', 10, 5000)) return;

    const hidden = parsed.data.hidden && ctx.player.role === 'dm';
    const { notation, reason, reported, template } = parsed.data;

    try {
      // Prefer the client-reported result from the 3D dice (see
      // chatRollSchema for rationale). Fall back to server-side random
      // roll when the client didn't attach one (CLI /r commands in
      // scripts, legacy clients, headless NPC rolls).
      let rollData;
      if (reported) {
        // Sanity-check the client-reported payload against the notation
        // the client claimed to roll. The earlier version derived the
        // modifier from `total - sum(dice)`, which meant a client could
        // report dice:[{type:20,value:1}] and total:10000 and the
        // server would happily persist modifier=9999. Now we parse the
        // notation server-side and enforce:
        //   - each die value is within [1, sides]
        //   - the reported dice bag matches the notation's declared
        //     dice (same count of each sides, ignoring sign)
        //   - total == sum(signed dice) + notation_modifier
        // Any mismatch triggers a fresh server-side roll so a faked
        // total can't land in chat history.
        const parsed = (() => {
          try { return parseDiceNotation(notation); } catch { return null; }
        })();
        const valid = validateReportedRoll(parsed, reported);
        if (valid && parsed) {
          rollData = {
            notation,
            dice: reported.dice,
            modifier: parsed.modifier,
            total: reported.total,
            advantage: 'normal' as const,
            reason,
            // Flag so consumers (DM chat UI, Discord relay) know the
            // total came from the client's dice-box animation and
            // wasn't generated server-side. They can render a subtle
            // marker or log it for audit.
            clientReported: true,
            ...(template ? { template } : {}),
          };
        } else {
          rollData = DiceService.roll(notation, reason);
          if (template) rollData = { ...rollData, template };
        }
      } else {
        rollData = DiceService.roll(notation, reason);
        if (template) rollData = { ...rollData, template };
      }
      const messageId = uuidv4();
      const now = new Date().toISOString();

      const hiddenLabel = hidden ? ' (hidden)' : '';
      const displayContent = reason
        ? `rolled ${notation} for ${reason}${hiddenLabel}: **${rollData.total}**`
        : `rolled ${notation}${hiddenLabel}: **${rollData.total}**`;

      const message: ChatMessage = {
        id: messageId, sessionId: ctx.room.sessionId, userId: ctx.player.userId,
        displayName: ctx.player.displayName, type: 'roll', content: displayContent,
        characterName: null, whisperTo: null, rollData, hidden: !!hidden, createdAt: now,
      };

      await pool.query(`
        INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, roll_data, hidden, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        messageId, ctx.room.sessionId, ctx.player.userId, ctx.player.displayName,
        'roll', displayContent, JSON.stringify(rollData), hidden ? 1 : 0, now,
      ]);

      if (hidden) {
        socket.emit('chat:roll-result', message);
      } else {
        io.to(ctx.room.sessionId).emit('chat:roll-result', message);
      }
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Invalid dice notation',
      });
    }
  }));
}
