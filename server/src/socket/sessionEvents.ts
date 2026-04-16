import type { Server, Socket } from 'socket.io';
import type { Player, GameMode, Combatant } from '@dnd-vtt/shared';
import { DEFAULT_SESSION_SETTINGS } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import {
  createRoom, getRoom,
  addPlayerToRoom, removePlayerFromRoom, removeSocketFromRoom, getPlayerBySocketId,
  type RoomPlayer,
} from '../utils/roomState.js';
import { sessionJoinSchema, sessionKickSchema, sessionUpdateSettingsSchema, sessionViewingSchema, musicChangeSchema, musicActionSchema, handoutSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { dbRowToCharacter } from '../utils/characterMapper.js';
import { shouldDeliverChatRow } from '../utils/chatHistoryFilter.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { rowToToken } from '../utils/tokenMapper.js';

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

    const settings = safeParseJSON<Record<string, unknown>>(session.settings, {}, 'sessions.settings');

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

    // Re-emit the currently playing track so a late joiner hears what
    // the DM is already playing. Only fires when a track is set —
    // otherwise the client already defaults to silent, so re-sending
    // "null, stop" to a fresh tab would just churn the audio element.
    if (room.music.track) {
      socket.emit('session:music-changed', {
        track: room.music.track,
        fileIndex: room.music.fileIndex,
      });
      // Only re-emit the last action when it represents a paused
      // state — 'resume', 'next', 'prev' are one-shot transitions that
      // shouldn't be replayed, but a stored 'pause' means the DM
      // stopped the music and we should restore that on the new tab.
      if (room.music.action === 'pause') {
        socket.emit('session:music-action-broadcast', { action: room.music.action });
      }
    }

    // Auto-load map on join.
    //   Players → always the ribbon (player_map_id). No more hydrating
    //               onto a DM's prep/preview map.
    //   DM     → their last preview map if they had one in-memory,
    //               else the ribbon. DM preview is per-DM, never
    //               persisted to sessions.current_map_id any more.
    const hydrationMapId = isDM
      ? (room.dmViewingMap.get(userId) ?? room.playerMapId ?? room.currentMapId)
      : room.playerMapId;

    if (hydrationMapId) {
      const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1', [hydrationMapId]);
      const mapRow = mapRows[0] as Record<string, unknown> | undefined;
      if (mapRow) {
        // Cache the grid size for this map so synchronous server code
        // (OA reach, ping scoping) reads the correct pitch even before
        // the client sends a map:load round-trip.
        room.mapGridSizes.set(hydrationMapId, Number(mapRow.grid_size) || 70);
        const { rows: tokenRows } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [hydrationMapId]);
        const tokens = tokenRows.map(rowToToken);

        if (room.tokens.size === 0) {
          for (const t of tokens) room.tokens.set(t.id, t);
        }

        const { loadDrawingsForMapAsync, filterDrawingsForPlayer } = await import('./drawingEvents.js');
        const allDrawings = await loadDrawingsForMapAsync(hydrationMapId);
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
        const zones = isDM ? await loadZonesForMap(hydrationMapId) : [];
        socket.emit('map:loaded', {
          map: {
            id: mapRow.id as string, name: mapRow.name as string,
            imageUrl: mapRow.image_url as string | null,
            width: mapRow.width as number, height: mapRow.height as number,
            gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as string,
            gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
            walls: safeParseJSON<unknown[]>(mapRow.walls, [], 'maps.walls'),
            fogState: safeParseJSON<unknown[]>(mapRow.fog_state, [], 'maps.fog_state'),
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
          const combatants = safeParseJSON<Combatant[] | null>(row.combatants, null, 'combat_state.combatants');
          if (combatants) {
            combatState = {
              sessionId: session.id, active: true, roundNumber: row.round_number,
              currentTurnIndex: row.current_turn_index, combatants, startedAt: row.started_at,
            };
            room.combatState = combatState;
            room.gameMode = 'combat';
          }
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

    // Send chat history — filter per-user so whispers stay private and
    // DM-only hidden rolls don't leak to players. Without this filter
    // every session member who joined after a whisper was sent would
    // receive the full private message history on reconnect.
    const { rows: chatHistory } = await pool.query(`
      SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 100
    `, [session.id]);

    socket.emit('chat:history', chatHistory.reverse()
      .filter((m) => shouldDeliverChatRow(
        {
          type: m.type as string,
          user_id: m.user_id as string,
          whisper_to: m.whisper_to as string | null,
          hidden: (m.hidden as number | boolean | null),
        },
        { userId, isDM },
      ))
      .map(m => ({
        id: m.id, sessionId: m.session_id, userId: m.user_id, displayName: m.display_name,
        type: m.type, content: m.content, characterName: m.character_name,
        whisperTo: m.whisper_to, rollData: safeParseJSON<unknown | null>(m.roll_data, null, 'chat_messages.roll_data'),
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
    const currentSettings = sessionRows[0]
      ? safeParseJSON<Record<string, unknown>>(sessionRows[0].settings, {}, 'sessions.settings')
      : {};
    const newSettings = { ...DEFAULT_SESSION_SETTINGS, ...currentSettings, ...settingsPatch };
    const currentWebhook = (sessionRows[0]?.discord_webhook_url as string | null) ?? null;

    await pool.query('UPDATE sessions SET settings = $1 WHERE id = $2', [JSON.stringify(newSettings), ctx.room.sessionId]);

    // Emit per-role so DMs get the webhook URL (they own it) and
    // players don't (it's not a secret, but not something they need).
    // One emit per socket avoids duplicate broadcasts on the DM path.
    for (const p of ctx.room.players.values()) {
      const payload = p.role === 'dm'
        ? { ...newSettings, discordWebhookUrl: currentWebhook }
        : newSettings;
      io.to(p.socketId).emit('session:settings-updated', payload);
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

    // Cache the authoritative current track on the room so players who
    // join mid-session get synced via the state-sync emit below.
    // Otherwise late joiners sit in silence until the DM reselects a
    // track, which is a common "my music isn't working" confusion.
    ctx.room.music.track = parsed.data.track ?? null;
    ctx.room.music.fileIndex = parsed.data.fileIndex ?? null;
    // Picking a track implicitly resumes playback; unsetting the track
    // (pause/stop) is signalled separately via music-action.
    ctx.room.music.action = parsed.data.track ? 'resume' : null;

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

    // Mirror the latest action into room state so rejoiners see the
    // correct play/pause indicator (stopping doesn't clear the track
    // name — the UI still shows "X is paused").
    ctx.room.music.action = parsed.data.action;

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

function handleDisconnect(_io: Server, socket: Socket): void {
  const ctx = getPlayerBySocketId(socket.id);
  if (!ctx) return;
  // Multi-tab-aware: only broadcast session:player-left when this was
  // the LAST socket for the user. An old tab closing while a newer
  // one is still active used to yank the user's presence + stop their
  // live socket events, even though they were still in the app.
  const result = removeSocketFromRoom(ctx.room.sessionId, socket.id);
  if (result?.userFullyLeft) {
    socket.to(ctx.room.sessionId).emit('session:player-left', { userId: result.userId });
  }
  socket.leave(ctx.room.sessionId);
}
