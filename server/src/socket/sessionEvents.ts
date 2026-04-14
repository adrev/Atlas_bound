import type { Server, Socket } from 'socket.io';
import type { Player, GameMode } from '@dnd-vtt/shared';
import { DEFAULT_SESSION_SETTINGS } from '@dnd-vtt/shared';
import pool from '../db/connection.js';
import {
  createRoom, getRoom, getRoomByCode,
  addPlayerToRoom, removePlayerFromRoom, getPlayerBySocketId,
  type RoomPlayer,
} from '../utils/roomState.js';
import { sessionJoinSchema, sessionKickSchema, sessionUpdateSettingsSchema, sessionViewingSchema, musicChangeSchema } from '../utils/validation.js';
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
      SELECT id, name, room_code, dm_user_id, current_map_id, player_map_id, game_mode, settings
      FROM sessions WHERE room_code = $1
    `, [roomCode]);
    const session = sessionRows[0] as {
      id: string; name: string; room_code: string; dm_user_id: string;
      current_map_id: string | null; player_map_id: string | null;
      game_mode: string; settings: string;
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

    socket.emit('session:state-sync', {
      sessionId: session.id, roomCode: session.room_code, userId, isDM, players,
      settings: { ...DEFAULT_SESSION_SETTINGS, ...settings },
      currentMapId: room.currentMapId, gameMode: room.gameMode,
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

        socket.emit('map:loaded', {
          map: {
            id: mapRow.id as string, name: mapRow.name as string,
            imageUrl: mapRow.image_url as string | null,
            width: mapRow.width as number, height: mapRow.height as number,
            gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as string,
            gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
            walls: JSON.parse(mapRow.walls as string || '[]'),
            fogState: JSON.parse(mapRow.fog_state as string || '[]'),
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
    const targetPlayer = ctx.room.players.get(targetUserId);
    if (!targetPlayer) return;
    io.to(targetPlayer.socketId).emit('session:kicked', { userId: targetUserId });
    removePlayerFromRoom(ctx.room.sessionId, targetUserId);
    socket.to(ctx.room.sessionId).emit('session:player-left', { userId: targetUserId });
    const kickedSocket = io.sockets.sockets.get(targetPlayer.socketId);
    if (kickedSocket) kickedSocket.leave(ctx.room.sessionId);
  }));

  socket.on('session:update-settings', safeHandler(socket, async (data) => {
    const parsed = sessionUpdateSettingsSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const { rows: sessionRows } = await pool.query('SELECT settings FROM sessions WHERE id = $1', [ctx.room.sessionId]);
    const currentSettings = sessionRows[0] ? JSON.parse(sessionRows[0].settings) : {};
    const newSettings = { ...DEFAULT_SESSION_SETTINGS, ...currentSettings, ...parsed.data };

    await pool.query('UPDATE sessions SET settings = $1 WHERE id = $2', [JSON.stringify(newSettings), ctx.room.sessionId]);
    io.to(ctx.room.sessionId).emit('session:settings-updated', newSettings);
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
    io.to(ctx.room.sessionId).emit('session:music-changed', { track: parsed.data.track });
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
