import type { Server, Socket } from 'socket.io';
import type { Token, WallSegment, FogPolygon, MapSummary } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import { getPlayerBySocketId } from '../utils/roomState.js';
import {
  mapPreviewLoadSchema, mapDeleteSchema, mapActivateSchema,
  mapRenameSchema, mapDuplicateSchema, mapReorderSchema,
} from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { loadDrawingsForMapAsync, filterDrawingsForPlayer } from './drawingEvents.js';
import { loadZonesForMap } from './mapEvents.js';
import { safeParseJSON } from '../utils/safeJson.js';

const MAP_SUMMARY_SELECT = `
  SELECT m.id, m.name, m.image_url, m.width, m.height, m.grid_size, m.created_at, m.display_order,
         (SELECT COUNT(*) FROM tokens t WHERE t.map_id = m.id) AS token_count
  FROM maps m
  WHERE m.session_id = $1
  ORDER BY m.display_order ASC, m.created_at ASC
`;

function rowToSummary(r: Record<string, unknown>, playerMapId: string | null): MapSummary {
  return {
    id: r.id as string,
    name: r.name as string,
    imageUrl: r.image_url as string | null,
    width: r.width as number,
    height: r.height as number,
    gridSize: r.grid_size as number,
    tokenCount: Number(r.token_count) ?? 0,
    createdAt: r.created_at as string,
    isPlayerMap: r.id === playerMapId,
    displayOrder: Number(r.display_order) || 0,
  };
}

/**
 * Fetch the full map list for a session and broadcast it to every DM
 * socket in the room. Called after any mutation that changes the list
 * shape or order (rename / reorder / duplicate / delete).
 */
async function broadcastMapListToDMs(
  io: Server,
  room: { sessionId: string; playerMapId: string | null; players: Map<string, { role: string; socketId: string }> },
): Promise<void> {
  const { rows } = await pool.query(MAP_SUMMARY_SELECT, [room.sessionId]);
  const maps = rows.map(r => rowToSummary(r, room.playerMapId ?? null));
  for (const player of room.players.values()) {
    if (player.role !== 'dm') continue;
    io.to(player.socketId).emit('map:list-result', { maps, playerMapId: room.playerMapId });
  }
}

export function registerSceneEvents(io: Server, socket: Socket): void {

  socket.on('map:list', safeHandler(socket, async () => {
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Players should only ever receive the currently-active player map
    // in the list. DMs see the full set (including prep/preview scenes).
    const isDM = ctx.player.role === 'dm';
    const playerMapId = ctx.room.playerMapId ?? null;

    let rows: Array<Record<string, unknown>>;
    if (isDM) {
      const result = await pool.query(MAP_SUMMARY_SELECT, [ctx.room.sessionId]);
      rows = result.rows;
    } else if (playerMapId) {
      const result = await pool.query(`
        SELECT m.id, m.name, m.image_url, m.width, m.height, m.grid_size, m.created_at, m.display_order,
               (SELECT COUNT(*) FROM tokens t WHERE t.map_id = m.id) AS token_count
        FROM maps m
        WHERE m.session_id = $1 AND m.id = $2
      `, [ctx.room.sessionId, playerMapId]);
      rows = result.rows;
    } else {
      rows = [];
    }

    const maps: MapSummary[] = rows.map(r => rowToSummary(r, ctx.room.playerMapId ?? null));

    console.log(`[SCENE] map:list (${ctx.player.role}) → ${maps.length} maps, ribbon=${ctx.room.playerMapId ?? 'null'}`);
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

    // Preview is per-DM and in-memory only. Previously we also wrote
    // `sessions.current_map_id` here, which was the single
    // player-facing "what map should I load" pointer used at
    // session:join. That meant a reconnecting player would hydrate
    // onto the DM's prep map, breaking isolation and leaking NPC
    // placements on a map the party hadn't arrived at yet.
    // The DM's preview is now kept purely in `room.dmViewingMap`;
    // `player_map_id` stays the source of truth for player hydration.
    ctx.room.dmViewingMap.set(ctx.player.userId, mapId);

    const { rows: tokenRows } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [mapId]);
    const tokens: Token[] = tokenRows.map(t => ({
      id: t.id, mapId: t.map_id, characterId: t.character_id, name: t.name,
      x: t.x, y: t.y, size: t.size, imageUrl: t.image_url, color: t.color,
      layer: t.layer as Token['layer'], visible: Boolean(t.visible),
      hasLight: Boolean(t.has_light), lightRadius: t.light_radius,
      lightDimRadius: t.light_dim_radius, lightColor: t.light_color,
      conditions: safeParseJSON(t.conditions, [], 'token.conditions'), ownerUserId: t.owner_user_id,
      createdAt: t.created_at,
    }));

    const drawings = await loadDrawingsForMapAsync(mapId);
    const visibleDrawings = filterDrawingsForPlayer(drawings, ctx.player);

    const zones = await loadZonesForMap(mapId);
    const mapData = {
      id: mapRow.id as string, name: mapRow.name as string,
      imageUrl: mapRow.image_url as string | null,
      width: mapRow.width as number, height: mapRow.height as number,
      gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as 'square' | 'hex',
      gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
      walls: safeParseJSON<WallSegment[]>(mapRow.walls, [], 'map.walls'),
      fogState: safeParseJSON<FogPolygon[]>(mapRow.fog_state, [], 'map.fog_state'),
      zones,
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
    } catch (err) { console.warn('[scene:activate] session map pointers update failed:', err); }

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
      conditions: safeParseJSON(t.conditions, [], 'token.conditions'), ownerUserId: t.owner_user_id,
      createdAt: t.created_at,
    }));
    ctx.room.tokens.clear();
    for (const t of tokens) ctx.room.tokens.set(t.id, t);

    const drawings = await loadDrawingsForMapAsync(mapId);
    ctx.room.drawings.clear();
    for (const d of drawings) ctx.room.drawings.set(d.id, d);

    const zones = await loadZonesForMap(mapId);
    const baseMapData = {
      id: mapRow.id as string, name: mapRow.name as string,
      imageUrl: mapRow.image_url as string | null,
      width: mapRow.width as number, height: mapRow.height as number,
      gridSize: mapRow.grid_size as number, gridType: mapRow.grid_type as 'square' | 'hex',
      gridOffsetX: mapRow.grid_offset_x as number, gridOffsetY: mapRow.grid_offset_y as number,
      walls: safeParseJSON<WallSegment[]>(mapRow.walls, [], 'map.walls'),
      fogState: safeParseJSON<FogPolygon[]>(mapRow.fog_state, [], 'map.fog_state'),
    };

    for (const player of ctx.room.players.values()) {
      if (player.role === 'dm') {
        const dmViewing = ctx.room.dmViewingMap.get(player.userId);
        if (dmViewing && dmViewing !== mapId) continue;
        ctx.room.dmViewingMap.delete(player.userId);
      }
      const visibleDrawings = filterDrawingsForPlayer(drawings, player);
      const mapData = {
        ...baseMapData,
        // Only DMs receive zone planning data \u2014 players see an empty list.
        zones: player.role === 'dm' ? zones : [],
      };
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

    await broadcastMapListToDMs(io, ctx.room);
  }));

  socket.on('map:rename', safeHandler(socket, async (data) => {
    const parsed = mapRenameSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const { mapId, name } = parsed.data;

    const { rowCount } = await pool.query(
      'UPDATE maps SET name = $1 WHERE id = $2 AND session_id = $3',
      [name, mapId, ctx.room.sessionId],
    );
    if (rowCount === 0) {
      socket.emit('session:error', { message: 'Map not found in this session' });
      return;
    }
    await broadcastMapListToDMs(io, ctx.room);
  }));

  socket.on('map:reorder', safeHandler(socket, async (data) => {
    const parsed = mapReorderSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const { mapIds } = parsed.data;

    // Verify every supplied id belongs to this session before writing.
    // Skips the partial-update foot-gun where an attacker passes a mix
    // of their own + another session's mapIds and we silently reorder
    // half of theirs.
    const { rows: ownRows } = await pool.query(
      'SELECT id FROM maps WHERE session_id = $1 AND id = ANY($2::text[])',
      [ctx.room.sessionId, mapIds],
    );
    const owned = new Set(ownRows.map(r => r.id as string));
    if (owned.size !== mapIds.length) {
      socket.emit('session:error', { message: 'Reorder list contains maps from another session' });
      return;
    }

    // Single round-trip via UPDATE...FROM unnest so we don't fire 71
    // separate UPDATEs every time the DM drags. Order index = position
    // in the supplied array.
    await pool.query(
      `UPDATE maps SET display_order = sub.ord
         FROM (SELECT * FROM unnest($1::text[], $2::int[]) AS u(id, ord)) sub
        WHERE maps.id = sub.id AND maps.session_id = $3`,
      [mapIds, mapIds.map((_, i) => i + 1), ctx.room.sessionId],
    );
    await broadcastMapListToDMs(io, ctx.room);
  }));

  socket.on('map:duplicate', safeHandler(socket, async (data) => {
    const parsed = mapDuplicateSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const { mapId } = parsed.data;

    const { rows: srcRows } = await pool.query(
      'SELECT * FROM maps WHERE id = $1 AND session_id = $2',
      [mapId, ctx.room.sessionId],
    );
    const src = srcRows[0] as Record<string, unknown> | undefined;
    if (!src) {
      socket.emit('session:error', { message: 'Map not found in this session' });
      return;
    }

    const newId = uuidv4();
    const newName = `${src.name as string} (Copy)`;
    // Slot the duplicate immediately after its source so it appears
    // next to the original in the sidebar instead of at the bottom.
    const sourceOrder = Number(src.display_order) || 0;
    await pool.query(
      'UPDATE maps SET display_order = display_order + 1 WHERE session_id = $1 AND display_order > $2',
      [ctx.room.sessionId, sourceOrder],
    );
    await pool.query(`
      INSERT INTO maps (
        id, session_id, name, image_url, width, height, grid_size, grid_type,
        grid_offset_x, grid_offset_y, walls, fog_state, display_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      newId, ctx.room.sessionId, newName, src.image_url,
      src.width, src.height, src.grid_size, src.grid_type,
      src.grid_offset_x, src.grid_offset_y,
      src.walls ?? '[]',
      // Skip fog reveal state — duplicate starts fully fogged like a fresh map.
      '[]',
      sourceOrder + 1,
    ]);

    // Copy zones (encounter spawn points). Skip tokens by design — a
    // duplicated map is an empty stage you re-dress, not a snapshot.
    await pool.query(`
      INSERT INTO map_zones (id, map_id, name, x, y, width, height)
      SELECT gen_random_uuid()::text, $1, name, x, y, width, height
      FROM map_zones WHERE map_id = $2
    `, [newId, mapId]);

    await broadcastMapListToDMs(io, ctx.room);
  }));
}
