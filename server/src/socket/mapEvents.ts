import type { Server, Socket } from 'socket.io';
import type { Token, WallSegment, FogPolygon } from '@dnd-vtt/shared';
import pool from '../db/connection.js';
import { getPlayerBySocketId, resolveViewingMapId, socketsOnMap } from '../utils/roomState.js';
import { loadDrawingsForMapAsync, filterDrawingsForPlayer } from './drawingEvents.js';
import { mapLoadSchema, mapPingSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { safeParseJSON } from '../utils/safeJson.js';
import { rowToToken } from '../utils/tokenMapper.js';

import { registerTokenEvents } from './tokenEvents.js';
import { registerFogEvents } from './fogEvents.js';
import { registerWallEvents } from './wallEvents.js';
import { registerZoneEvents, loadZonesForMap } from './zoneEvents.js';

// Re-export so the existing sessionEvents / sceneEvents imports keep working.
export { loadZonesForMap };

/**
 * Top-level map event registrar.
 *
 * Responsible for the two cross-cutting events (`map:load`, `map:ping`)
 * and for wiring up the domain-specific sub-registrars for tokens,
 * fog, walls, and zones. Each of those lives in its own file so hot
 * paths (token-move) stay easy to find and the handlers themselves
 * can be tested in isolation.
 */
export function registerMapEvents(io: Server, socket: Socket): void {

  socket.on('map:load', safeHandler(socket, async (data) => {
    const parsed = mapLoadSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    if (ctx.player.role !== 'dm') return;
    const { mapId } = parsed.data;

    // Verify map belongs to this session
    const { rows: ownerCheck } = await pool.query('SELECT 1 FROM maps WHERE id = $1 AND session_id = $2', [mapId, ctx.room.sessionId]);
    if (ownerCheck.length === 0) return;

    const { rows: mapRows } = await pool.query('SELECT * FROM maps WHERE id = $1', [mapId]);
    const mapRow = mapRows[0] as Record<string, unknown> | undefined;
    if (!mapRow) return;

    const { rows: tokenRows } = await pool.query('SELECT * FROM tokens WHERE map_id = $1', [mapId]);
    const tokens: Token[] = tokenRows.map(rowToToken);

    ctx.room.currentMapId = mapId;
    // Cache grid size so OA / other sync reach calculations can read
    // it without a DB round-trip.
    const gridSizeForCache = Number(mapRow.grid_size) || 70;
    ctx.room.mapGridSizes.set(mapId, gridSizeForCache);
    if (!ctx.room.playerMapId) {
      ctx.room.playerMapId = mapId;
      try { await pool.query('UPDATE sessions SET player_map_id = $1 WHERE id = $2', [mapId, ctx.room.sessionId]); }
      catch (err) { console.warn('[map:load] player_map_id update failed:', err); }
    }
    ctx.room.tokens.clear();
    for (const token of tokens) ctx.room.tokens.set(token.id, token);

    const persistedDrawings = await loadDrawingsForMapAsync(mapId);
    ctx.room.drawings.clear();
    for (const d of persistedDrawings) ctx.room.drawings.set(d.id, d);

    await pool.query('UPDATE sessions SET current_map_id = $1 WHERE id = $2', [mapId, ctx.room.sessionId]);

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

    // Per-recipient filtering: DMs see everything, players get only
    // visible tokens and no zones. Without this, a player opening
    // devtools could inspect the socket payload and see hidden NPC
    // names, positions, and character data for ambush creatures the
    // DM placed with visible=false.
    for (const player of ctx.room.players.values()) {
      const visibleDrawings = filterDrawingsForPlayer(persistedDrawings, player);
      const isDM = player.role === 'dm';
      const playerTokens = isDM
        ? tokens
        : tokens.filter(t => t.visible !== false && t.visible !== 0 as unknown);
      const mapData = {
        ...baseMapData,
        zones: isDM ? zones : [],
      };
      io.to(player.socketId).emit('map:loaded', { map: mapData, tokens: playerTokens, drawings: visibleDrawings });
    }
  }));

  socket.on('map:ping', safeHandler(socket, async (data) => {
    const parsed = mapPingSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    // Map-scope pings so a DM dropping a waypoint on their preview
    // map doesn't flash up for players on the active ribbon.
    const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!mapId) return;
    for (const sid of socketsOnMap(ctx.room, mapId)) {
      io.to(sid).emit('map:pinged', {
        x: parsed.data.x, y: parsed.data.y, mapId,
        userId: ctx.player.userId, displayName: ctx.player.displayName, timestamp: Date.now(),
      });
    }
  }));

  // Delegate domain-specific events to their own registrars.
  registerTokenEvents(io, socket);
  registerFogEvents(io, socket);
  registerWallEvents(io, socket);
  registerZoneEvents(io, socket);
}
