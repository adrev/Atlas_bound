import type { Server, Socket } from 'socket.io';
import type { FogPolygon } from '@dnd-vtt/shared';
import pool from '../db/connection.js';
import {
  getPlayerBySocketId, resolveViewingMapId, socketsOnMap,
} from '../utils/roomState.js';
import { fogRevealHideSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { safeParseJSON } from '../utils/safeJson.js';

/**
 * DM fog-brush events. Fog state is stored on the map row
 * (`maps.fog_state`, JSON) and broadcast to all sockets viewing
 * that map so reveals/hides are persistent across reloads.
 */
export function registerFogEvents(io: Server, socket: Socket): void {
  socket.on('map:fog-reveal', safeHandler(socket, async (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT fog_state FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    const fogState = safeParseJSON<FogPolygon[]>(rows[0].fog_state, [], 'map.fog_state');
    fogState.push({ points: parsed.data.points });

    await pool.query('UPDATE maps SET fog_state = $1 WHERE id = $2', [JSON.stringify(fogState), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:fog-updated', { fogState, mapId: targetMapId });
  }));

  socket.on('map:fog-hide', safeHandler(socket, async (data) => {
    const parsed = fogRevealHideSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const { rows } = await pool.query('SELECT fog_state FROM maps WHERE id = $1', [targetMapId]);
    if (rows.length === 0) return;

    let fogState = safeParseJSON<FogPolygon[]>(rows[0].fog_state, [], 'map.fog_state');
    const targetPoints = JSON.stringify(parsed.data.points);
    fogState = fogState.filter(f => JSON.stringify(f.points) !== targetPoints);

    await pool.query('UPDATE maps SET fog_state = $1 WHERE id = $2', [JSON.stringify(fogState), targetMapId]);

    const recipients = socketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:fog-updated', { fogState, mapId: targetMapId });
  }));
}
