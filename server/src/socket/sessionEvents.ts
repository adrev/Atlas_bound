import type { Server, Socket } from 'socket.io';
import type { Player, GameMode } from '@dnd-vtt/shared';
import { DEFAULT_SESSION_SETTINGS } from '@dnd-vtt/shared';
import db from '../db/connection.js';
import {
  createRoom, getRoom, getRoomByCode,
  addPlayerToRoom, removePlayerFromRoom, getPlayerBySocketId,
  type RoomPlayer,
} from '../utils/roomState.js';
import { sessionJoinSchema, sessionKickSchema, sessionUpdateSettingsSchema } from '../utils/validation.js';

export function registerSessionEvents(io: Server, socket: Socket): void {

  socket.on('session:join', (data) => {
    const parsed = sessionJoinSchema.safeParse(data);
    if (!parsed.success) {
      socket.emit('session:error', { message: 'Invalid join data' });
      return;
    }

    const { roomCode, displayName } = parsed.data;

    // Look up session from DB
    const session = db.prepare(`
      SELECT id, name, room_code, dm_user_id, current_map_id, game_mode, settings
      FROM sessions WHERE room_code = ?
    `).get(roomCode) as {
      id: string; name: string; room_code: string; dm_user_id: string;
      current_map_id: string | null; game_mode: string; settings: string;
    } | undefined;

    if (!session) {
      socket.emit('session:error', { message: 'Session not found' });
      return;
    }

    // Find the user in session_players
    const playerRows = db.prepare(`
      SELECT sp.user_id, sp.role, sp.character_id, u.display_name, u.avatar_url
      FROM session_players sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = ?
    `).all(session.id) as Array<{
      user_id: string; role: string; character_id: string | null;
      display_name: string; avatar_url: string | null;
    }>;

    // Try to find user by display name (matching from join)
    let currentPlayer = playerRows.find(p => p.display_name === displayName);
    if (!currentPlayer) {
      // Could be a new join - find the most recently added player with this name
      currentPlayer = playerRows[playerRows.length - 1];
    }

    if (!currentPlayer) {
      socket.emit('session:error', { message: 'Player not found in session' });
      return;
    }

    const userId = currentPlayer.user_id;
    const isDM = currentPlayer.role === 'dm';

    // Ensure room state exists in memory
    let room = getRoom(session.id);
    if (!room) {
      room = createRoom(session.id, session.room_code, session.dm_user_id);
      room.currentMapId = session.current_map_id;
      room.gameMode = session.game_mode as GameMode;
    }

    // Add player to room
    const roomPlayer: RoomPlayer = {
      userId,
      displayName,
      socketId: socket.id,
      role: isDM ? 'dm' : 'player',
      characterId: currentPlayer.character_id,
    };
    addPlayerToRoom(session.id, roomPlayer);

    // Join the socket room
    socket.join(session.id);

    // Store session context on the socket
    (socket as unknown as Record<string, unknown>).__sessionId = session.id;
    (socket as unknown as Record<string, unknown>).__userId = userId;

    // Build players list for state sync
    const players: Player[] = playerRows.map(p => {
      const connected = room!.players.has(p.user_id);
      return {
        userId: p.user_id,
        displayName: p.display_name,
        avatarUrl: p.avatar_url,
        role: p.role as 'dm' | 'player',
        characterId: p.character_id,
        connected,
      };
    });

    const settings = JSON.parse(session.settings || '{}');

    // Send full state to the joining player
    socket.emit('session:state-sync', {
      sessionId: session.id,
      roomCode: session.room_code,
      userId,
      isDM,
      players,
      settings: { ...DEFAULT_SESSION_SETTINGS, ...settings },
      currentMapId: room.currentMapId,
      gameMode: room.gameMode,
    });

    // Notify others that a player joined
    socket.to(session.id).emit('session:player-joined', {
      userId,
      displayName,
      avatarUrl: currentPlayer.avatar_url,
      role: isDM ? 'dm' : 'player',
      characterId: currentPlayer.character_id,
      connected: true,
    });

    // Auto-load current map for the joining player
    if (room.currentMapId) {
      const mapRow = db.prepare('SELECT * FROM maps WHERE id = ?').get(room.currentMapId) as Record<string, unknown> | undefined;
      if (mapRow) {
        const tokenRows = db.prepare('SELECT * FROM tokens WHERE map_id = ?').all(room.currentMapId) as Array<Record<string, unknown>>;
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
          tokens,
        });
      }
    }

    // Auto-load the player's character if they have one linked
    if (currentPlayer.character_id) {
      const charRow = db.prepare('SELECT * FROM characters WHERE id = ?').get(currentPlayer.character_id) as Record<string, unknown> | undefined;
      if (charRow) {
        // Transform snake_case DB columns to camelCase for the client
        const safeJson = (val: unknown, fallback: unknown) => {
          if (typeof val === 'string') try { return JSON.parse(val); } catch { return fallback; }
          return val ?? fallback;
        };
        const character = {
          id: charRow.id, userId: charRow.user_id, name: charRow.name,
          race: charRow.race, class: charRow.class, level: charRow.level,
          hitPoints: charRow.hit_points, maxHitPoints: charRow.max_hit_points,
          tempHitPoints: charRow.temp_hit_points, armorClass: charRow.armor_class,
          speed: charRow.speed, proficiencyBonus: charRow.proficiency_bonus,
          abilityScores: safeJson(charRow.ability_scores, {}),
          savingThrows: safeJson(charRow.saving_throws, []),
          skills: safeJson(charRow.skills, {}),
          spellSlots: safeJson(charRow.spell_slots, {}),
          spells: safeJson(charRow.spells, []),
          features: safeJson(charRow.features, []),
          inventory: safeJson(charRow.inventory, []),
          deathSaves: safeJson(charRow.death_saves, { successes: 0, failures: 0 }),
          hitDice: safeJson(charRow.hit_dice, []),
          concentratingOn: charRow.concentrating_on ?? null,
          background: safeJson(charRow.background, { name: '', description: '', feature: '' }),
          characteristics: safeJson(charRow.characteristics, {}),
          personality: safeJson(charRow.personality, {}),
          notes: safeJson(charRow.notes_data, {}),
          proficiencies: safeJson(charRow.proficiencies_data, { armor: [], weapons: [], tools: [], languages: [] }),
          senses: safeJson(charRow.senses, {}),
          defenses: safeJson(charRow.defenses, {}),
          conditions: safeJson(charRow.conditions, []),
          currency: safeJson(charRow.currency, {}),
          extras: safeJson(charRow.extras, []),
          spellcastingAbility: charRow.spellcasting_ability ?? '',
          spellAttackBonus: charRow.spell_attack_bonus ?? 0,
          spellSaveDC: charRow.spell_save_dc ?? 10,
          initiative: charRow.initiative ?? 0,
          portraitUrl: charRow.portrait_url, dndbeyondId: charRow.dndbeyond_id,
          source: charRow.source, createdAt: charRow.created_at, updatedAt: charRow.updated_at,
        };
        socket.emit('character:synced', { character });
      }
    }

    // Send chat history
    const chatHistory = db.prepare(`
      SELECT * FROM chat_messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(session.id) as Array<Record<string, unknown>>;

    socket.emit('chat:history', chatHistory.reverse()
      .filter(m => {
        // Filter hidden rolls — only DM can see them
        if ((m.hidden as number) === 1 && !isDM) return false;
        return true;
      })
      .map(m => ({
        id: m.id as string,
        sessionId: m.session_id as string,
        userId: m.user_id as string,
        displayName: m.display_name as string,
        type: m.type as 'ic' | 'ooc' | 'whisper' | 'roll' | 'system',
        content: m.content as string,
        characterName: m.character_name as string | null,
        whisperTo: m.whisper_to as string | null,
        rollData: m.roll_data ? JSON.parse(m.roll_data as string) : null,
        hidden: (m.hidden as number) === 1,
        createdAt: m.created_at as string,
      })));
  });

  socket.on('session:leave', () => {
    handleDisconnect(io, socket);
  });

  socket.on('session:kick', (data) => {
    const parsed = sessionKickSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const { targetUserId } = parsed.data;
    const targetPlayer = ctx.room.players.get(targetUserId);
    if (!targetPlayer) return;

    // Notify the kicked player
    io.to(targetPlayer.socketId).emit('session:kicked', { userId: targetUserId });

    // Remove from room
    removePlayerFromRoom(ctx.room.sessionId, targetUserId);

    // Notify others
    socket.to(ctx.room.sessionId).emit('session:player-left', { userId: targetUserId });

    // Force the kicked player's socket to leave the room
    const kickedSocket = io.sockets.sockets.get(targetPlayer.socketId);
    if (kickedSocket) {
      kickedSocket.leave(ctx.room.sessionId);
    }
  });

  socket.on('session:update-settings', (data) => {
    const parsed = sessionUpdateSettingsSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    // Get current settings
    const sessionRow = db.prepare('SELECT settings FROM sessions WHERE id = ?')
      .get(ctx.room.sessionId) as { settings: string } | undefined;
    const currentSettings = sessionRow ? JSON.parse(sessionRow.settings) : {};
    const newSettings = { ...DEFAULT_SESSION_SETTINGS, ...currentSettings, ...parsed.data };

    db.prepare('UPDATE sessions SET settings = ? WHERE id = ?')
      .run(JSON.stringify(newSettings), ctx.room.sessionId);

    io.to(ctx.room.sessionId).emit('session:settings-updated', newSettings);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    handleDisconnect(io, socket);
  });
}

function handleDisconnect(io: Server, socket: Socket): void {
  const ctx = getPlayerBySocketId(socket.id);
  if (!ctx) return;

  removePlayerFromRoom(ctx.room.sessionId, ctx.player.userId);
  socket.to(ctx.room.sessionId).emit('session:player-left', { userId: ctx.player.userId });
  socket.leave(ctx.room.sessionId);
}
