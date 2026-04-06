import type { Server, Socket } from 'socket.io';
import type { ChatMessage } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/connection.js';
import { getPlayerBySocketId } from '../utils/roomState.js';
import * as DiceService from '../services/DiceService.js';
import { chatMessageSchema, chatWhisperSchema, chatRollSchema } from '../utils/validation.js';

export function registerChatEvents(io: Server, socket: Socket): void {

  socket.on('chat:message', (data) => {
    const parsed = chatMessageSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { type, content, characterName } = parsed.data;
    const messageId = uuidv4();
    const now = new Date().toISOString();

    const message: ChatMessage = {
      id: messageId,
      sessionId: ctx.room.sessionId,
      userId: ctx.player.userId,
      displayName: ctx.player.displayName,
      type,
      content,
      characterName: characterName ?? null,
      whisperTo: null,
      rollData: null,
      createdAt: now,
    };

    // Persist to DB
    db.prepare(`
      INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, character_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, ctx.room.sessionId, ctx.player.userId, ctx.player.displayName, type, content, characterName ?? null, now);

    io.to(ctx.room.sessionId).emit('chat:new-message', message);
  });

  socket.on('chat:whisper', (data) => {
    const parsed = chatWhisperSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { targetUserId, content } = parsed.data;
    const messageId = uuidv4();
    const now = new Date().toISOString();

    const message: ChatMessage = {
      id: messageId,
      sessionId: ctx.room.sessionId,
      userId: ctx.player.userId,
      displayName: ctx.player.displayName,
      type: 'whisper',
      content,
      characterName: null,
      whisperTo: targetUserId,
      rollData: null,
      createdAt: now,
    };

    // Persist to DB
    db.prepare(`
      INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, whisper_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, ctx.room.sessionId, ctx.player.userId, ctx.player.displayName, 'whisper', content, targetUserId, now);

    // Send to the target player
    const targetPlayer = ctx.room.players.get(targetUserId);
    if (targetPlayer) {
      io.to(targetPlayer.socketId).emit('chat:new-message', message);
    }

    // Send to the sender
    socket.emit('chat:new-message', message);

    // Send to the DM if they're neither sender nor target
    const dmPlayer = ctx.room.players.get(ctx.room.dmUserId);
    if (dmPlayer && dmPlayer.userId !== ctx.player.userId && dmPlayer.userId !== targetUserId) {
      io.to(dmPlayer.socketId).emit('chat:new-message', message);
    }
  });

  socket.on('chat:roll', (data) => {
    const parsed = chatRollSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { notation, reason, hidden } = parsed.data;

    try {
      const rollData = DiceService.roll(notation, reason);
      const messageId = uuidv4();
      const now = new Date().toISOString();

      const hiddenLabel = hidden ? ' (hidden)' : '';
      const displayContent = reason
        ? `rolled ${notation} for ${reason}${hiddenLabel}: **${rollData.total}**`
        : `rolled ${notation}${hiddenLabel}: **${rollData.total}**`;

      const message: ChatMessage = {
        id: messageId,
        sessionId: ctx.room.sessionId,
        userId: ctx.player.userId,
        displayName: ctx.player.displayName,
        type: 'roll',
        content: displayContent,
        characterName: null,
        whisperTo: null,
        rollData,
        createdAt: now,
      };

      // Persist to DB
      db.prepare(`
        INSERT INTO chat_messages (id, session_id, user_id, display_name, type, content, roll_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId, ctx.room.sessionId, ctx.player.userId, ctx.player.displayName,
        'roll', displayContent, JSON.stringify(rollData), now,
      );

      if (hidden) {
        // Hidden roll - only send result back to the roller (DM)
        socket.emit('chat:roll-result', message);
      } else {
        io.to(ctx.room.sessionId).emit('chat:roll-result', message);
      }
    } catch (err) {
      socket.emit('session:error', {
        message: err instanceof Error ? err.message : 'Invalid dice notation',
      });
    }
  });
}
