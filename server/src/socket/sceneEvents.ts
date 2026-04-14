import type { Server, Socket } from 'socket.io';
import type { Token, WallSegment, FogPolygon, MapSummary } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { getPlayerBySocketId } from '../utils/roomState.js';
import {
  mapPreviewLoadSchema, mapDeleteSchema, mapActivateSchema,
} from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { loadDrawingsForMapAsync, filterDrawingsForPlayer } from './drawingEvents.js';

export function registerSceneEvents(io: Server, socket: Socket): void {

  socket.on('map:list', safeHandler(socket, async () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const { rows } = await pool.query(`
      SELECT m.id, m.name, m.image_url, m.width, m.height, m.grid_size, m.created_at,
             (SELECT COUNT(*) FROM tokens t WHERE t.map_id = m.id) AS token_count
      FROM maps m
      WHERE m.session_id = $1
      ORDER BY m.created_at ASC
    `, [ctx.room.sessionId]);

    const maps: MapSummary[] = rows.map(r => ({
      id: r.id, name: r.name, imageUrl: r.image_url,
      width: r.width, height: r.height, gridSize: r.grid_size,
      tokenCount: Number(r.token_count) ?? 0, createdAt: r.created_at,
      isPlayerMap: r.id === ctx.room.playerMapId,
    }));

    console.log(`[SCENE] map:list → ${maps.length} maps, ribbon=${ctx.room.playerMapId ?? 'null'}`);
    socket.emit('map:list-result', { maps, playerMapId: ctx.room.playerMapId });
  }));

  socket.on('map:preview-load', safeHandler(socket, async (data) => {
    const parsed = mapPreviewLoadSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;

    const { mapId } = parsed.data;
    const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1 AND session_id = $2', [mapId, ctx.room.sessionId]);
    const mapRow = mapRows[0] as Record<string, unknown> | undefined;
    if (!mapRow) { socket.emit('session:error', { message: 'Map not found in this session' }); return; }

    ctx.room.dmViewingMap.set(ctx.player.userId, mapId);
    try { await pool.query('UPDATE sessions SET current_map_id = $1 WHERE id = $2', [mapId, ctx.room.sessionId]); } catch { /* ignore */ }

    const { rows: tokenRows } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [mapId]);
    const tokens: Token[] = tokenRows.map(t => ({
      id: t.id, mapId: t.map_id, characterId: t.character_id, name: t.name,
      x: t.x, y: t.y, size: t.size, imageUrl: t.image_url, color: t.color,
      layer: t.layer as Token['layer'], visible: Boolean(t.visible),
      hasLight: Boolean(t.has_light), lightRadius: t.light_radius,
      lightDimRadius: t.light_dim_radius, lightColor: t.light_color,
      conditions: JSON.parse(t.conditions as string), ownerUserId: t.owner_user_id,
      createdAt: t.created_at,
    }));

    const drawings = await loadDrawingsForMapAsync(mapId);
    const visibleDrawings = filterDrawingsForPlayer(drawings, ctx.player);

    const mapData = {
      id: mapRow.id as string, name: mapRow.name as string,
      imageUrl: mapRow.image_url as string | null,
      width: mapRow.width as number, height: mapRow.height as number,
      gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as 'square' | 'hex',
      gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
      walls: JSON.parse(mapRow.walls as string) as WallSegment[],
      fogState: JSON.parse(mapRow.fog_state as string) as FogPolygon[],
    };

    socket.emit('map:loaded', { map: mapData, tokens, drawings: visibleDrawings, isPreview: true });
  }));

  socket.on('map:activate-for-players', safeHandler(socket, async (data) => {
    console.log('[SCENE] map:activate-for-players received', data);
    const parsed = mapActivateSchema.safeParse(data);
    if (!parsed.success) { console.warn('[SCENE] validation failed', parsed.error.issues); return; }

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) { console.warn('[SCENE] no ctx for socket', socket.id); return; }
    if (ctx.player.role !== 'dm') { console.warn('[SCENE] non-DM tried to activate', ctx.player.userId); return; }

    const { mapId } = parsed.data;
    const stagedPositions = parsed.data.stagedPositions ?? [];

    const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1 AND session_id = $2', [mapId, ctx.room.sessionId]);
    const mapRow = mapRows[0] as Record<string, unknown> | undefined;
    if (!mapRow) {
      console.warn('[SCENE] map not found', mapId);
      socket.emit('session:error', { message: 'Map not found in this session' });
      return;
    }
    console.log(`[SCENE] activating map ${mapRow.name} (${mapId}) for ${ctx.room.players.size} players`);

    // Create tokens for staged heroes
    for (const staged of stagedPositions) {
      const { rows: existsRows } = await pool.query('SELECT id FROM tokens WHERE map_id = $1 AND character_id = $2', [mapId, staged.characterId]);
      if (existsRows.length > 0) continue;

      const tokenId = uuidv4();
      const gridSize = (mapRow.grid_size as number) ?? 70;
      await pool.query(`INSERT INTO tokens (
        id, map_id, character_id, name, x, y, size, color, layer, visible,
        image_url, has_light, light_radius, light_dim_radius, light_color,
        conditions, owner_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
        tokenId, mapId, staged.characterId, staged.name,
        staged.x, staged.y, 1, '#666', 'token', 1,
        staged.imageUrl, 0, gridSize * 4, gridSize * 8, '#ffcc66',
        '[]', staged.ownerUserId,
      ]);
      console.log(`[SCENE] staged hero ${staged.name} at (${staged.x}, ${staged.y})`);
    }

    const oldPlayerMapId = ctx.room.playerMapId;

    ctx.room.playerMapId = mapId;
    ctx.room.currentMapId = mapId;
    try {
      await pool.query('UPDATE sessions SET player_map_id = $1, current_map_id = $2 WHERE id = $3', [mapId, mapId, ctx.room.sessionId]);
    } catch { /* ignore */ }

    // Migrate player character tokens
    if (oldPlayerMapId && oldPlayerMapId !== mapId) {
      const { rows: pcTokens } = await pool.query(`
        SELECT id, character_id FROM tokens
        WHERE map_id = $1 AND character_id IS NOT NULL AND owner_user_id IS NOT NULL
      `, [oldPlayerMapId]);

      if (pcTokens.length > 0) {
        const gridSize = (mapRow.grid_size as number) ?? 70;
        const mapWidth = (mapRow.width as number) ?? 1400;
        const mapHeight = (mapRow.height as number) ?? 1050;
        const { rows: alreadyOnNewMap } = await pool.query(
          'SELECT character_id FROM tokens WHERE map_id = $1 AND character_id IS NOT NULL', [mapId],
        );
        const existingCharacterIds = new Set(alreadyOnNewMap.map(r => r.character_id));

        const pcsToMigrate = pcTokens.filter(pc => !existingCharacterIds.has(pc.character_id));
        const lineWidth = pcsToMigrate.length * gridSize;
        const startX = Math.round((mapWidth - lineWidth) / 2);
        const centerY = Math.round(mapHeight / 2);

        let spawnIndex = 0;
        for (const pc of pcsToMigrate) {
          const x = startX + spawnIndex * gridSize;
          await pool.query('UPDATE tokens SET map_id = $1, x = $2, y = $3 WHERE id = $4', [mapId, x, centerY, pc.id]);
          spawnIndex++;
        }
        if (spawnIndex > 0) {
          console.log(`[SCENE] migrated ${spawnIndex} PC token${spawnIndex !== 1 ? 's' : ''} from ${oldPlayerMapId} → ${mapId}`);
        }
      }
    }

    // Load tokens + drawings for new ribbon map
    const { rows: tokenRows } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [mapId]);
    const tokens: Token[] = tokenRows.map(t => ({
      id: t.id, mapId: t.map_id, characterId: t.character_id, name: t.name,
      x: t.x, y: t.y, size: t.size, imageUrl: t.image_url, color: t.color,
      layer: t.layer as Token['layer'], visible: Boolean(t.visible),
      hasLight: Boolean(t.has_light), lightRadius: t.light_radius,
      lightDimRadius: t.light_dim_radius, lightColor: t.light_color,
      conditions: JSON.parse(t.conditions as string), ownerUserId: t.owner_user_id,
      createdAt: t.created_at,
    }));
    ctx.room.tokens.clear();
    for (const t of tokens) ctx.room.tokens.set(t.id, t);

    const drawings = await loadDrawingsForMapAsync(mapId);
    ctx.room.drawings.clear();
    for (const d of drawings) ctx.room.drawings.set(d.id, d);

    const mapData = {
      id: mapRow.id as string, name: mapRow.name as string,
      imageUrl: mapRow.image_url as string | null,
      width: mapRow.width as number, height: mapRow.height as number,
      gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as 'square' | 'hex',
      gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
      walls: JSON.parse(mapRow.walls as string) as WallSegment[],
      fogState: JSON.parse(mapRow.fog_state as string) as FogPolygon[],
    };

    for (const player of ctx.room.players.values()) {
      if (player.role === 'dm') {
        const dmViewing = ctx.room.dmViewingMap.get(player.userId);
        if (dmViewing && dmViewing !== mapId) continue;
        ctx.room.dmViewingMap.delete(player.userId);
      }
      const visibleDrawings = filterDrawingsForPlayer(drawings, player);
      io.to(player.socketId).emit('map:loaded', { map: mapData, tokens, drawings: visibleDrawings, isPreview: false });
    }

    io.to(ctx.room.sessionId).emit('map:player-map-changed', { mapId });
  }));

  socket.on('map:delete', safeHandler(socket, async (data) => {
    const parsed = mapDeleteSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const { mapId } = parsed.data;

    if (ctx.room.playerMapId === mapId) {
      socket.emit('session:error', { message: 'Cannot delete the map the players are currently on. Move the player ribbon to another map first.' });
      return;
    }

    const { rows: mapRows } = await pool.query('SELECT id FROM maps WHERE id = $1 AND session_id = $2', [mapId, ctx.room.sessionId]);
    if (mapRows.length === 0) { socket.emit('session:error', { message: 'Map not found in this session' }); return; }

    try { await pool.query('DELETE FROM maps WHERE id = $1', [mapId]); }
    catch (err) {
      console.warn('[map:delete] DB delete failed:', err);
      socket.emit('session:error', { message: 'Failed to delete map' });
      return;
    }

    for (const [userId, viewing] of Array.from(ctx.room.dmViewingMap.entries())) {
      if (viewing === mapId) ctx.room.dmViewingMap.delete(userId);
    }

    const { rows } = await pool.query(`
      SELECT m.id, m.name, m.image_url, m.width, m.height, m.grid_size, m.created_at,
             (SELECT COUNT(*) FROM tokens t WHERE t.map_id = m.id) AS token_count
      FROM maps m WHERE m.session_id = $1 ORDER BY m.created_at ASC
    `, [ctx.room.sessionId]);

    const maps: MapSummary[] = rows.map(r => ({
      id: r.id, name: r.name, imageUrl: r.image_url,
      width: r.width, height: r.height, gridSize: r.grid_size,
      tokenCount: Number(r.token_count) ?? 0, createdAt: r.created_at,
      isPlayerMap: r.id === ctx.room.playerMapId,
    }));

    for (const player of ctx.room.players.values()) {
      if (player.role !== 'dm') continue;
      io.to(player.socketId).emit('map:list-result', { maps, playerMapId: ctx.room.playerMapId });
    }
  }));
}
