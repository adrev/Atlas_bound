import type { Server, Socket } from 'socket.io';
import type { MapZone } from '@dnd-vtt/shared';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/connection.js';
import {
  getPlayerBySocketId, resolveViewingMapId, dmSocketsOnMap,
} from '../utils/roomState.js';
import {
  zoneAddSchema, zoneUpdateSchema, zoneDeleteSchema,
} from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';

/**
 * Encounter-spawn zones. Rectangular regions the DM draws on a map so
 * the Encounter Builder can drop a group of creatures into a specific
 * area instead of at the map's geometric center.
 *
 * Exports `loadZonesForMap` as well \u2014 it's reused by the session
 * join + scene preview/activate map-load payloads so clients rehydrate
 * zones on reconnect.
 */
export async function loadZonesForMap(mapId: string): Promise<MapZone[]> {
  const { rows } = await pool.query(
    'SELECT id, map_id, name, x, y, width, height FROM map_zones WHERE map_id = $1 ORDER BY created_at ASC',
    [mapId],
  );
  return rows.map(r => ({
    id: r.id as string,
    mapId: r.map_id as string,
    name: r.name as string,
    x: Number(r.x),
    y: Number(r.y),
    width: Number(r.width),
    height: Number(r.height),
  }));
}

export function registerZoneEvents(io: Server, socket: Socket): void {
  socket.on('map:zone-add', safeHandler(socket, async (data) => {
    const parsed = zoneAddSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    // Enforce per-map cap to prevent runaway creates.
    const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM map_zones WHERE map_id = $1', [targetMapId]);
    if ((count[0]?.n ?? 0) >= 50) return;

    const id = uuidv4();
    await pool.query(
      'INSERT INTO map_zones (id, map_id, name, x, y, width, height) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, targetMapId, parsed.data.name, parsed.data.x, parsed.data.y, parsed.data.width, parsed.data.height],
    );

    const zones = await loadZonesForMap(targetMapId);
    // Zones are DM planning data. Broadcast only to DMs viewing this
    // map so players never receive zone coordinates or names.
    const recipients = dmSocketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:zones-updated', { zones, mapId: targetMapId });
  }));

  socket.on('map:zone-update', safeHandler(socket, async (data) => {
    const parsed = zoneUpdateSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const field of ['name', 'x', 'y', 'width', 'height'] as const) {
      const v = parsed.data[field];
      if (v !== undefined) { sets.push(`${field} = $${idx++}`); params.push(v); }
    }
    if (sets.length === 0) return;
    params.push(parsed.data.zoneId, targetMapId);
    await pool.query(
      `UPDATE map_zones SET ${sets.join(', ')} WHERE id = $${idx++} AND map_id = $${idx}`,
      params,
    );

    const zones = await loadZonesForMap(targetMapId);
    // Zones are DM planning data. Broadcast only to DMs viewing this
    // map so players never receive zone coordinates or names.
    const recipients = dmSocketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:zones-updated', { zones, mapId: targetMapId });
  }));

  socket.on('map:zone-delete', safeHandler(socket, async (data) => {
    const parsed = zoneDeleteSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx || ctx.player.role !== 'dm') return;
    const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!targetMapId) return;

    await pool.query('DELETE FROM map_zones WHERE id = $1 AND map_id = $2', [parsed.data.zoneId, targetMapId]);

    const zones = await loadZonesForMap(targetMapId);
    // Zones are DM planning data. Broadcast only to DMs viewing this
    // map so players never receive zone coordinates or names.
    const recipients = dmSocketsOnMap(ctx.room, targetMapId);
    for (const sid of recipients) io.to(sid).emit('map:zones-updated', { zones, mapId: targetMapId });
  }));
}
