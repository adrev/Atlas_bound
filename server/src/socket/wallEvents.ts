import type { Server, Socket } from 'socket.io';
import type { WallSegment } from '@dnd-vtt/shared';
import pool from '../db/connection.js';
import {
  getPlayerBySocketId, resolveViewingMapId, socketsOnMap,
} from '../utils/roomState.js';
import { wallAddSchema, wallRemoveSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { safeParseJSON } from '../utils/safeJson.js';

/**
 * DM wall-drawing events. Walls block light/visibility raycasting and
 * live inline on the map row (`maps.walls`, JSON array of segments).
 */
export function registerWallEvents(io: Server, socket: Socket): void {
  socket.on('map:wall-add', safeHandler(socket, async (data) => {
    const parsed = wallAddSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT walls FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    const walls = safeParseJSON<WallSegment[]>(rows[0].walls, [], 'map.walls');
    walls.push(parsed.data);

    await pool.query('UPDATE maps SET walls = $1 WHERE id = $2', [JSON.stringify(walls), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
  }));

  socket.on('map:wall-remove', safeHandler(socket, async (data) => {
    const parsed = wallRemoveSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT walls FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    const walls = safeParseJSON<WallSegment[]>(rows[0].walls, [], 'map.walls');
    if (parsed.data.index < 0 || parsed.data.index >= walls.length) return;
    walls.splice(parsed.data.index, 1);

    await pool.query('UPDATE maps SET walls = $1 WHERE id = $2', [JSON.stringify(walls), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
  }));
}
