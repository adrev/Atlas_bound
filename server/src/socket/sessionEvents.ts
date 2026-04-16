import type { Server, Socket } from 'socket.io';
import type { Player, GameMode } from '@dnd-vtt/shared';
import { DEFAULT_SESSION_SETTINGS } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import {
  createRoom, getRoom,
  addPlayerToRoom, removePlayerFromRoom, getPlayerBySocketId,
  type RoomPlayer,
} from '../utils/roomState.js';
import { sessionJoinSchema, sessionKickSchema, sessionUpdateSettingsSchema, sessionViewingSchema, musicChangeSchema, musicActionSchema, handoutSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { dbRowToCharacter } from '../utils/characterMapper.js';

export function registerSessionEvents(io: Server, socket: Socket): void {

  socket.on('session:join', safeHandler(socket, async (data) => {
    const parsed = sessionJoinSchema.safeParse(data);
    if (!parsed.success) {
      socket.emit('session:error', { message: 'Invalid join data' });
      return;
    }

    const { roomCode } = parsed.data;
    // Identity comes from the authenticated session, never from client data
    const userId = socket.data.userId as string;
    const displayName = socket.data.displayName as string;

    if (!userId) {
      socket.emit('session:error', { message: 'Authentication required' });
      return;
    }

    const { rows: sessionRows } = await pool.query(`
      SELECT id, name, room_code, dm_user_id, current_map_id, player_map_id, game_mode, settings,
             visibility, password_hash, invite_code, discord_webhook_url
      FROM sessions WHERE room_code = $1
    `, [roomCode]);
    const session = sessionRows[0] as {
      id: string; name: string; room_code: string; dm_user_id: string;
      current_map_id: string | null; player_map_id: string | null;
      game_mode: string; settings: string;
      visibility: string; password_hash: string | null; invite_code: string | null;
      discord_webhook_url: string | null;
    } | undefined;

    if (!session) {
      socket.emit('session:error', { message: 'Session not found' });
      return;
    }

    const { rows: playerRows } = await pool.query(`
      SELECT sp.user_id, sp.role, sp.character_id, u.display_name, u.avatar_url
      FROM session_players sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = $1
    `, [session.id]);

    const currentPlayer = playerRows.find(p => p.user_id === userId);

    if (!currentPlayer) {
      socket.emit('session:error', { message: 'You are not a member of this session' });
      return;
    }

    const isDM = currentPlayer.role === 'dm';

    let room = getRoom(session.id);
    if (!room) {
      room = createRoom(session.id, session.room_code, session.dm_user_id);
      room.currentMapId = session.current_map_id;
      room.playerMapId = session.player_map_id ?? session.current_map_id;
      room.gameMode = session.game_mode as GameMode;
    }

    const roomPlayer: RoomPlayer = {
      userId, displayName, socketId: socket.id,
      role: isDM ? 'dm' : 'player', characterId: currentPlayer.character_id,
    };
    addPlayerToRoom(session.id, roomPlayer);
    socket.join(session.id);
    (socket as unknown as Record<string, unknown>).__sessionId = session.id;
    (socket as unknown as Record<string, unknown>).__userId = userId;

    const players: Player[] = playerRows.map(p => {
      const connected = room!.players.has(p.user_id);
      return {
        userId: p.user_id, displayName: p.display_name, avatarUrl: p.avatar_url,
        role: p.role as 'dm' | 'player', characterId: p.character_id, connected,
      };
    });

    const settings = JSON.parse(session.settings || '{}');

    // Bans are public \u2014 every member sees the list. Non-DMs see the
    // same payload so they know who's been excluded (they just don't
    // get the Unban button in the UI).
    const { rows: banRows } = await pool.query(`
      SELECT b.user_id, b.banned_by, b.banned_at, b.reason,
             u.display_name, u.avatar_url,
             bu.display_name AS banned_by_name
      FROM session_bans b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN users bu ON bu.id = b.banned_by
      WHERE b.session_id = $1
      ORDER BY b.banned_at DESC
    `, [session.id]);
    const bans = banRows.map(r => ({
      userId: r.user_id as string,
      displayName: r.display_name as string,
      avatarUrl: r.avatar_url as string | null,
      bannedBy: r.banned_by_name as string | null,
      bannedByUserId: r.banned_by as string,
      bannedAt: r.banned_at as string,
      reason: r.reason as string | null,
    }));

    socket.emit('session:state-sync', {
      sessionId: session.id, roomCode: session.room_code, userId, isDM, players,
      // Only surface the Discord webhook to the DM — it lives on
      // `sessions` alongside invite_code with the same privacy bar.
      settings: {
        ...DEFAULT_SESSION_SETTINGS,
        ...settings,
        ...(isDM ? { discordWebhookUrl: session.discord_webhook_url } : {}),
      },
      currentMapId: room.currentMapId, gameMode: room.gameMode,
      visibility: (session.visibility as 'public' | 'private') ?? 'public',
      hasPassword: session.password_hash !== null,
      inviteCode: isDM ? session.invite_code : null,
      ownerUserId: session.dm_user_id,
      bans,
    });

    socket.to(session.id).emit('session:player-joined', {
      userId, displayName, avatarUrl: currentPlayer.avatar_url,
      role: isDM ? 'dm' : 'player', characterId: currentPlayer.character_id, connected: true,
    });

    // Auto-load current map
    if (room.currentMapId) {
      const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1', [room.currentMapId]);
      const mapRow = mapRows[0] as Record<string, unknown> | undefined;
      if (mapRow) {
        const { rows: tokenRows } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [room.currentMapId]);
        const tokens = tokenRows.map((t: Record<string, unknown>) => ({
          id: t.id as string, mapId: t.map_id as string,
          characterId: t.character_id as string | null, name: t.name as string,
          x: t.x as number, y: t.y as number, size: t.size as number,
          imageUrl: t.image_url as string | null, color: t.color as string,
          layer: t.layer as string, visible: Boolean(t.visible),
          hasLight: Boolean(t.has_light), lightRadius: t.light_radius as number,
          lightDimRadius: t.light_dim_radius as number, lightColor: t.light_color as string,
          conditions: JSON.parse(t.conditions as string || '[]'),
          ownerUserId: t.owner_user_id as string | null, createdAt: t.created_at as string,
        }));

        if (room.tokens.size === 0) {
          for (const t of tokens) room.tokens.set(t.id, t as never);
        }

        const { loadDrawingsForMapAsync, filterDrawingsForPlayer } = await import('./drawingEvents.js');
        const allDrawings = await loadDrawingsForMapAsync(room.currentMapId);
        if (room.drawings.size === 0) {
          for (const d of allDrawings) room.drawings.set(d.id, d);
        }
        const visibleDrawings = filterDrawingsForPlayer(allDrawings, {
          userId, displayName, socketId: socket.id,
          role: isDM ? 'dm' : 'player', characterId: currentPlayer.character_id,
        });

        // Zones are DM planning data \u2014 only load them for DM rejoins
        // so player reconnects don't receive zone coordinates/names.
        const { loadZonesForMap } = await import('./mapEvents.js');
        const zones = isDM ? await loadZonesForMap(room.currentMapId) : [];
        socket.emit('map:loaded', {
          map: {
            id: mapRow.id as string, name: mapRow.name as string,
            imageUrl: mapRow.image_url as string | null,
            width: mapRow.width as number, height: mapRow.height as number,
            gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as string,
            gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
            walls: JSON.parse(mapRow.walls as string || '[]'),
            fogState: JSON.parse(mapRow.fog_state as string || '[]'),
            zones,
          },
          tokens, drawings: visibleDrawings,
        });
      }
    }

    // Rehydrate combat state
    {
      let combatState = room.combatState;
      if (!combatState) {
        const { rows: combatRows } = await pool.query(
          'SELECT round_number, current_turn_index, combatants, started_at FROM combat_state WHERE session_id = $1',
          [session.id],
        );
        const row = combatRows[0];
        if (row) {
          try {
            const combatants = JSON.parse(row.combatants);
            combatState = {
              sessionId: session.id, active: true, roundNumber: row.round_number,
              currentTurnIndex: row.current_turn_index, combatants, startedAt: row.started_at,
            };
            room.combatState = combatState;
            room.gameMode = 'combat';
          } catch { /* malformed */ }
        }
      }

      if (combatState && combatState.active) {
        const cur = combatState.combatants[combatState.currentTurnIndex];
        let economy = cur ? room.actionEconomies.get(cur.tokenId) : undefined;
        if (!economy && cur) {
          economy = {
            action: false, bonusAction: false, movementRemaining: cur.speed,
            movementMax: cur.speed, reaction: false,
          };
          room.actionEconomies.set(cur.tokenId, economy);
        }

        socket.emit('combat:state-sync', {
          combatants: combatState.combatants, roundNumber: combatState.roundNumber,
          currentTurnIndex: combatState.currentTurnIndex,
          actionEconomy: economy ?? {
            action: false, bonusAction: false, movementRemaining: 30, movementMax: 30, reaction: false,
          },
        });
      }
    }

    // Auto-load character
    if (currentPlayer.character_id) {
      const { rows: charRows } = await pool.query('SELECT * FROM characters WHERE id = $1', [currentPlayer.character_id]);
      const charRow = charRows[0] as Record<string, unknown> | undefined;
      if (charRow) {
        socket.emit('character:synced', { character: dbRowToCharacter(charRow) });
      }
    }

    // Send chat history
    const { rows: chatHistory } = await pool.query(`
      SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 100
    `, [session.id]);

    socket.emit('chat:history', chatHistory.reverse()
      .filter(m => {
        if ((m.hidden as number) === 1 && !isDM) return false;
        return true;
      })
      .map(m => ({
        id: m.id, sessionId: m.session_id, userId: m.user_id, displayName: m.display_name,
        type: m.type, content: m.content, characterName: m.character_name,
        whisperTo: m.whisper_to, rollData: m.roll_data ? JSON.parse(m.roll_data) : null,
        hidden: (m.hidden as number) === 1, createdAt: m.created_at,
      })));
  }));

  socket.on('session:leave', () => { handleDisconnect(io, socket); });

  socket.on('session:kick', safeHandler(socket, async (data) => {
    const parsed = sessionKickSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const { targetUserId } = parsed.data;

    // Prevent self-kick: DMs should not be able to accidentally remove themselves.
    if (targetUserId === ctx.player.userId) return;

    // Co-DM hierarchy:
    //   \u2022 Owner cannot be kicked by anyone (use transfer-ownership instead).
    //   \u2022 A co-DM cannot kick another co-DM \u2014 owner must demote first.
    //   \u2022 Any DM can kick a player.
    const { rows: targetRoleRows } = await pool.query(
      `SELECT sp.role, s.dm_user_id
         FROM session_players sp
         JOIN sessions s ON s.id = sp.session_id
         WHERE sp.session_id = $1 AND sp.user_id = $2`,
      [ctx.room.sessionId, targetUserId],
    );
    const targetRow = targetRoleRows[0] as { role: string; dm_user_id: string } | undefined;
    if (targetRow) {
      if (targetRow.dm_user_id === targetUserId) return; // Owner untouchable.
      if (targetRow.role === 'dm') return;               // Peer co-DM untouchable.
    }

    // Remove from the DB so the kick is persistent across reconnects.
    await pool.query(
      'DELETE FROM session_players WHERE session_id = $1 AND user_id = $2',
      [ctx.room.sessionId, targetUserId],
    );

    const targetPlayer = ctx.room.players.get(targetUserId);
    if (targetPlayer) {
      io.to(targetPlayer.socketId).emit('session:kicked', { userId: targetUserId });
      removePlayerFromRoom(ctx.room.sessionId, targetUserId);
      const kickedSocket = io.sockets.sockets.get(targetPlayer.socketId);
      if (kickedSocket) kickedSocket.leave(ctx.room.sessionId);
    }
    socket.to(ctx.room.sessionId).emit('session:player-left', { userId: targetUserId });
  }));

  socket.on('session:update-settings', safeHandler(socket, async (data) => {
    const parsed = sessionUpdateSettingsSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    // The Discord webhook URL lives on its own column (not inside the
    // `settings` JSON blob) so the DiscordService can read it without
    // re-parsing session settings on every combat event.
    const { discordWebhookUrl, ...settingsPatch } = parsed.data;
    if (discordWebhookUrl !== undefined) {
      const urlValue = discordWebhookUrl === '' ? null : discordWebhookUrl;
      await pool.query(
        'UPDATE sessions SET discord_webhook_url = $1 WHERE id = $2',
        [urlValue, ctx.room.sessionId],
      );
    }

    const { rows: sessionRows } = await pool.query(
      'SELECT settings, discord_webhook_url FROM sessions WHERE id = $1',
      [ctx.room.sessionId],
    );
    const currentSettings = sessionRows[0] ? JSON.parse(sessionRows[0].settings) : {};
    const newSettings = { ...DEFAULT_SESSION_SETTINGS, ...currentSettings, ...settingsPatch };
    const currentWebhook = (sessionRows[0]?.discord_webhook_url as string | null) ?? null;

    await pool.query('UPDATE sessions SET settings = $1 WHERE id = $2', [JSON.stringify(newSettings), ctx.room.sessionId]);

    // Emit non-secret settings to EVERY member, but only hand the
    // DM the webhook URL (it's not a password but also not something
    // rando players should see).
    io.to(ctx.room.sessionId).emit('session:settings-updated', newSettings);
    for (const p of ctx.room.players.values()) {
      if (p.role === 'dm') {
        io.to(p.socketId).emit('session:settings-updated', {
          ...newSettings,
          discordWebhookUrl: currentWebhook,
        });
      }
    }
  }));

  socket.on('session:viewing', safeHandler(socket, async (data: unknown) => {
    const parsed = sessionViewingSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    socket.to(ctx.room.sessionId).emit('session:player-viewing', { userId: ctx.player.userId, tab: parsed.data.tab });
  }));

  socket.on('session:music-change', safeHandler(socket, async (data) => {
    const parsed = musicChangeSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;  // DM only
    // Broadcast to all players in the session (including DM)
    io.to(ctx.room.sessionId).emit('session:music-changed', {
      track: parsed.data.track,
      fileIndex: parsed.data.fileIndex ?? null,
    });
  }));

  socket.on('session:music-action', safeHandler(socket, async (data) => {
    const parsed = musicActionSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    io.to(ctx.room.sessionId).emit('session:music-action-broadcast', { action: parsed.data.action });
  }));

  socket.on('session:handout', safeHandler(socket, async (data) => {
    const parsed = handoutSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const { title, content, imageUrl, targetUserIds } = parsed.data;
    const payload = { title, content: content ?? '', imageUrl: imageUrl ?? undefined, fromDM: true };
    if (targetUserIds && targetUserIds.length > 0) {
      for (const uid of targetUserIds) {
        const player = ctx.room.players.get(uid);
        if (player) io.to(player.socketId).emit('session:handout-received', payload);
      }
    } else {
      io.to(ctx.room.sessionId).emit('session:handout-received', payload);
    }

    // Auto-save handout as a shared note
    const noteId = uuidv4();
    await pool.query(
      `INSERT INTO session_notes (id, session_id, title, content, category, is_shared, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [noteId, ctx.room.sessionId, title, content || '', 'general', true, ctx.player.userId]
    );
  }));

  socket.on('disconnect', () => { handleDisconnect(io, socket); });
}

function handleDisconnect(io: Server, socket: Socket): void {
  const ctx = getPlayerBySocketId(socket.id);
  if (!ctx) return;
  removePlayerFromRoom(ctx.room.sessionId, ctx.player.userId);
  socket.to(ctx.room.sessionId).emit('session:player-left', { userId: ctx.player.userId });
  socket.leave(ctx.room.sessionId);
}
