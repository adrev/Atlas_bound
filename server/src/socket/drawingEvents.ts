import type { Server, Socket } from 'socket.io';
import type { Drawing, DrawingVisibility } from '@dnd-vtt/shared';
import pool from '../db/connection.js';
import {
  getPlayerBySocketId, resolveViewingMapId, socketsOnMap,
  type RoomState, type RoomPlayer,
} from '../utils/roomState.js';
import {
  drawingCreateSchema, drawingDeleteSchema, drawingClearAllSchema,
  drawingStreamSchema, drawingStreamEndSchema, drawingUpdateSchema,
} from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { safeParseJSON } from '../utils/safeJson.js';

const STREAM_EVENTS_PER_SECOND = 60;
const streamCounters = new Map<string, { count: number; windowStart: number }>();

function allowStreamEvent(socketId: string): boolean {
  const now = Date.now();
  const entry = streamCounters.get(socketId);
  if (!entry || now - entry.windowStart >= 1000) {
    streamCounters.set(socketId, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  if (entry.count > STREAM_EVENTS_PER_SECOND) return false;
  return true;
}

function socketsForVisibility(
  room: RoomState,
  visibility: DrawingVisibility,
  creatorUserId: string,
  mapId: string,
): string[] {
  // Map-scope first so drawings on a DM preview map don't reach
  // clients on the player ribbon, and vice-versa. socketsOnMap
  // already checks dmViewingMap / playerMapId per client.
  const onMap = new Set(socketsOnMap(room, mapId));
  const out: string[] = [];
  for (const player of room.players.values()) {
    if (!onMap.has(player.socketId)) continue;
    if (visibility === 'shared') { out.push(player.socketId); }
    else if (visibility === 'dm-only') { if (player.role === 'dm') out.push(player.socketId); }
    else { if (player.userId === creatorUserId || player.role === 'dm') out.push(player.socketId); }
  }
  return out;
}

function rowToDrawing(row: Record<string, unknown>): Drawing {
  return {
    id: row.id as string, mapId: row.map_id as string,
    creatorUserId: row.creator_user_id as string,
    creatorRole: row.creator_role as 'dm' | 'player',
    kind: row.kind as Drawing['kind'],
    visibility: row.visibility as DrawingVisibility,
    color: row.color as string, strokeWidth: row.stroke_width as number,
    geometry: safeParseJSON<Drawing['geometry']>(row.geometry, { points: [] } as Drawing['geometry'], 'drawings.geometry'),
    gridSnapped: Boolean(row.grid_snapped),
    createdAt: row.created_at as number,
    fadeAfterMs: row.fade_after_ms as number | null,
  };
}

export function loadDrawingsForMap(_mapId: string): Drawing[] {
  // This is called synchronously in many places. We need a sync wrapper.
  // Since pg is async-only, we cache drawings in memory via the room state.
  // For initial load, the caller should use loadDrawingsForMapAsync instead.
  // This sync version returns an empty array - callers that need data
  // should use the async version.
  return [];
}

export async function loadDrawingsForMapAsync(mapId: string): Promise<Drawing[]> {
  const { rows } = await pool.query('SELECT * FROM drawings WHERE map_id = $1', [mapId]);
  return rows.map(rowToDrawing);
}

export function filterDrawingsForPlayer(drawings: Drawing[], player: RoomPlayer): Drawing[] {
  return drawings.filter((d) => {
    if (d.visibility === 'shared') return true;
    if (d.visibility === 'dm-only') return player.role === 'dm';
    return d.creatorUserId === player.userId || player.role === 'dm';
  });
}

export function registerDrawingEvents(io: Server, socket: Socket): void {

  socket.on('drawing:create', safeHandler(socket, async (data) => {
    const parsed = drawingCreateSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!mapId) return;

    const incoming = parsed.data.drawing;
    const creatorUserId = ctx.player.userId;
    const creatorRole: 'dm' | 'player' = ctx.player.role;
    let visibility: DrawingVisibility = incoming.visibility;
    if (creatorRole !== 'dm' && visibility !== 'player-only') visibility = 'player-only';

    const drawing: Drawing = {
      id: incoming.id, mapId, creatorUserId, creatorRole,
      kind: incoming.kind, visibility, color: incoming.color,
      strokeWidth: incoming.strokeWidth, geometry: incoming.geometry,
      gridSnapped: incoming.gridSnapped, createdAt: Date.now(),
      fadeAfterMs: incoming.kind === 'ephemeral' ? (incoming.fadeAfterMs ?? 10000) : null,
    };

    ctx.room.drawings.set(drawing.id, drawing);

    if (drawing.kind !== 'ephemeral') {
      try {
        await pool.query(`
          INSERT INTO drawings (
            id, map_id, creator_user_id, creator_role, kind, visibility,
            color, stroke_width, geometry, grid_snapped, created_at, fade_after_ms
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [
          drawing.id, drawing.mapId, drawing.creatorUserId, drawing.creatorRole,
          drawing.kind, drawing.visibility, drawing.color, drawing.strokeWidth,
          JSON.stringify(drawing.geometry), drawing.gridSnapped ? 1 : 0,
          drawing.createdAt, drawing.fadeAfterMs,
        ]);
      } catch (err) {
        console.warn('[drawing:create] DB insert failed:', err);
      }
    }

    const recipients = socketsForVisibility(ctx.room, visibility, creatorUserId, mapId);
    for (const sid of recipients) { io.to(sid).emit('drawing:created', drawing); }
  }));

  socket.on('drawing:delete', safeHandler(socket, async (data) => {
    const parsed = drawingDeleteSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const drawing = ctx.room.drawings.get(parsed.data.drawingId);
    if (!drawing) return;

    const isDM = ctx.player.role === 'dm';
    if (!isDM && drawing.creatorUserId !== ctx.player.userId) return;

    ctx.room.drawings.delete(drawing.id);

    if (drawing.kind !== 'ephemeral') {
      try { await pool.query('DELETE FROM drawings WHERE id = $1', [drawing.id]); }
      catch (err) { console.warn('[drawing:delete] DB delete failed:', err); }
    }

    const recipients = socketsForVisibility(ctx.room, drawing.visibility, drawing.creatorUserId, drawing.mapId);
    for (const sid of recipients) { io.to(sid).emit('drawing:deleted', { drawingId: drawing.id, mapId: drawing.mapId }); }
  }));

  // drawing:update — move / reshape an existing drawing. Only the
  // geometry changes via this path; kind, color, visibility, creator
  // stay fixed. Same auth model as delete: creator OR DM.
  socket.on('drawing:update', safeHandler(socket, async (data) => {
    const parsed = drawingUpdateSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const drawing = ctx.room.drawings.get(parsed.data.drawingId);
    if (!drawing) return;

    const isDM = ctx.player.role === 'dm';
    if (!isDM && drawing.creatorUserId !== ctx.player.userId) return;

    // Mutate the in-memory copy first so subsequent queries from the
    // same room (re-renders, hit tests) see the new position.
    drawing.geometry = parsed.data.geometry;

    if (drawing.kind !== 'ephemeral') {
      try {
        await pool.query(
          'UPDATE drawings SET geometry = $1 WHERE id = $2',
          [JSON.stringify(parsed.data.geometry), drawing.id],
        );
      } catch (err) { console.warn('[drawing:update] DB update failed:', err); }
    }

    const recipients = socketsForVisibility(ctx.room, drawing.visibility, drawing.creatorUserId, drawing.mapId);
    for (const sid of recipients) {
      io.to(sid).emit('drawing:updated', {
        drawingId: drawing.id,
        geometry: drawing.geometry,
      });
    }
  }));

  socket.on('drawing:clear-all', safeHandler(socket, async (data) => {
    const parsed = drawingClearAllSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!mapId) return;

    const isDM = ctx.player.role === 'dm';
    const scope = parsed.data.scope;
    if (scope === 'all' && !isDM) return;
    const userId = ctx.player.userId;

    // Broadcast only to sockets currently rendering this map; a DM
    // wiping drawings on a preview map shouldn't flash-clear the
    // player ribbon.
    const mapRecipients = socketsOnMap(ctx.room, mapId);
    if (scope === 'all') {
      for (const [id, d] of ctx.room.drawings) {
        if (d.mapId === mapId) ctx.room.drawings.delete(id);
      }
      try { await pool.query('DELETE FROM drawings WHERE map_id = $1', [mapId]); }
      catch (err) { console.warn('[drawing:clear-all] DB wipe failed:', err); }
      for (const sid of mapRecipients) {
        io.to(sid).emit('drawing:cleared', { scope: 'all', mapId });
      }
    } else {
      for (const [id, d] of ctx.room.drawings) {
        if (d.mapId === mapId && d.creatorUserId === userId) ctx.room.drawings.delete(id);
      }
      try { await pool.query('DELETE FROM drawings WHERE map_id = $1 AND creator_user_id = $2', [mapId, userId]); }
      catch (err) { console.warn('[drawing:clear-all mine] DB wipe failed:', err); }
      for (const sid of mapRecipients) {
        io.to(sid).emit('drawing:cleared', { scope: 'mine', userId, mapId });
      }
    }
  }));

  socket.on('drawing:stream', safeHandler(socket, async (data) => {
    if (!allowStreamEvent(socket.id)) return;
    const parsed = drawingStreamSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!mapId) return;

    const creatorUserId = ctx.player.userId;
    const isDM = ctx.player.role === 'dm';
    let visibility: DrawingVisibility = parsed.data.visibility;
    if (!isDM && visibility !== 'player-only') visibility = 'player-only';

    const payload = {
      tempId: parsed.data.tempId, creatorUserId, kind: parsed.data.kind,
      visibility, color: parsed.data.color, strokeWidth: parsed.data.strokeWidth,
      geometry: parsed.data.geometry, mapId,
    };

    const recipients = socketsForVisibility(ctx.room, visibility, creatorUserId, mapId);
    for (const sid of recipients) {
      if (sid === socket.id) continue;
      io.to(sid).emit('drawing:streamed', payload);
    }
  }));

  socket.on('drawing:stream-end', safeHandler(socket, async (data) => {
    const parsed = drawingStreamEndSchema.safeParse(data);
    if (!parsed.success) return;
    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;
    const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!mapId) return;
    // Map-scoped: only notify clients rendering the same map.
    for (const sid of socketsOnMap(ctx.room, mapId)) {
      if (sid === socket.id) continue;
      io.to(sid).emit('drawing:stream-end', { tempId: parsed.data.tempId, mapId });
    }
  }));

  socket.on('disconnect', () => { streamCounters.delete(socket.id); });
}
