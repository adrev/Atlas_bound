import type { Server, Socket } from 'socket.io';
import type { WallSegment } from '@dnd-vtt/shared';
import pool from '../db/connection.js';
import { getPlayerBySocketId, resolveViewingMapId, socketsOnMap } from '../utils/roomState.js';
import { wallAddSchema, wallRemoveSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { safeParseJSON } from '../utils/safeJson.js';

type WallMutation = (walls: WallSegment[]) => boolean;

/**
 * Serialize wall edits at the database row so concurrent sockets and
 * separate Cloud Run instances cannot overwrite each other's wall arrays.
 */
async function mutateWalls(mapId: string, mutate: WallMutation): Promise<WallSegment[] | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT walls FROM maps WHERE id = $1 FOR UPDATE', [mapId]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const walls = safeParseJSON<WallSegment[]>(rows[0].walls, [], 'map.walls');
    if (!mutate(walls)) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('UPDATE maps SET walls = $1 WHERE id = $2', [JSON.stringify(walls), mapId]);
    await client.query('COMMIT');
    return walls;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.warn('[walls] rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * DM wall-drawing events. Walls block light/visibility raycasting and
 * live inline on the map row (`maps.walls`, JSON array of segments).
 */
export function registerWallEvents(io: Server, socket: Socket): void {
  socket.on(
    'map:wall-add',
    safeHandler(socket, async (data) => {
      const parsed = wallAddSchema.safeParse(data);
      if (!parsed.success) return;
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx || ctx.player.role !== 'dm') return;
      const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
      if (!targetMapId) return;

      const walls = await mutateWalls(targetMapId, (currentWalls) => {
        currentWalls.push(parsed.data);
        return true;
      });
      if (!walls) return;

      const recipients = socketsOnMap(ctx.room, targetMapId);
      for (const sid of recipients)
        io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
    })
  );

  socket.on(
    'map:wall-remove',
    safeHandler(socket, async (data) => {
      const parsed = wallRemoveSchema.safeParse(data);
      if (!parsed.success) return;
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx || ctx.player.role !== 'dm') return;
      const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
      if (!targetMapId) return;

      const walls = await mutateWalls(targetMapId, (currentWalls) => {
        if (parsed.data.index < 0 || parsed.data.index >= currentWalls.length) return false;
        currentWalls.splice(parsed.data.index, 1);
        return true;
      });
      if (!walls) return;

      const recipients = socketsOnMap(ctx.room, targetMapId);
      for (const sid of recipients)
        io.to(sid).emit('map:walls-updated', { walls, mapId: targetMapId });
    })
  );
}
