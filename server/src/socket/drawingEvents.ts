import type { Server, Socket } from 'socket.io';
import type { Drawing, DrawingVisibility } from '@dnd-vtt/shared';
import db from '../db/connection.js';
import {
  getPlayerBySocketId, resolveViewingMapId,
  type RoomState, type RoomPlayer,
} from '../utils/roomState.js';
import {
  drawingCreateSchema, drawingDeleteSchema, drawingClearAllSchema,
  drawingStreamSchema, drawingStreamEndSchema,
} from '../utils/validation.js';

/**
 * DM / player drawing real-time events.
 *
 * Flow:
 *   client `drawing:create`  → server validates + persists + broadcasts `drawing:created`
 *   client `drawing:delete`  → server removes + broadcasts `drawing:deleted`
 *   client `drawing:clear-all` → server wipes scope + broadcasts `drawing:cleared`
 *   client `drawing:stream`  → server broadcasts `drawing:streamed` (no persist)
 *   client `drawing:stream-end` → server broadcasts `drawing:stream-end`
 *
 * All broadcasts are filtered by the drawing's `visibility`:
 *   shared      → every socket in the room
 *   dm-only     → every DM socket in the room
 *   player-only → creator socket + every DM socket
 *
 * Ephemeral drawings (`kind === 'ephemeral'`) are held in memory only
 * and never persisted; each client self-expires them via setTimeout.
 */

// Simple per-socket rate limiter for `drawing:stream` events to prevent
// a runaway client from flooding the server. Drop anything above this
// ceiling per second.
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

/**
 * Produce the list of socket ids that should receive a drawing broadcast
 * given its visibility and the creator's userId. Always returns an array
 * of sockets — not a Set — so callers can emit in order.
 */
function socketsForVisibility(
  room: RoomState,
  visibility: DrawingVisibility,
  creatorUserId: string,
): string[] {
  const out: string[] = [];
  for (const player of room.players.values()) {
    if (visibility === 'shared') {
      out.push(player.socketId);
    } else if (visibility === 'dm-only') {
      if (player.role === 'dm') out.push(player.socketId);
    } else {
      // player-only: creator + all DMs
      if (player.userId === creatorUserId || player.role === 'dm') {
        out.push(player.socketId);
      }
    }
  }
  return out;
}

/**
 * Convert a DB row into a Drawing object. Geometry is stored as a JSON
 * string so we deserialize it here.
 */
function rowToDrawing(row: Record<string, unknown>): Drawing {
  return {
    id: row.id as string,
    mapId: row.map_id as string,
    creatorUserId: row.creator_user_id as string,
    creatorRole: row.creator_role as 'dm' | 'player',
    kind: row.kind as Drawing['kind'],
    visibility: row.visibility as DrawingVisibility,
    color: row.color as string,
    strokeWidth: row.stroke_width as number,
    geometry: JSON.parse(row.geometry as string),
    gridSnapped: Boolean(row.grid_snapped),
    createdAt: row.created_at as number,
    fadeAfterMs: row.fade_after_ms as number | null,
  };
}

/**
 * Load all drawings for a map from SQLite. Called once per
 * `map:load` so the in-memory room cache is rehydrated. The per-player
 * visibility filter happens later at broadcast time.
 */
export function loadDrawingsForMap(mapId: string): Drawing[] {
  const rows = db.prepare('SELECT * FROM drawings WHERE map_id = ?').all(mapId) as Array<Record<string, unknown>>;
  return rows.map(rowToDrawing);
}

/**
 * Filter a list of drawings to the subset visible to a given player.
 * Used when sending the initial map load payload so each client only
 * receives drawings it has permission to see.
 */
export function filterDrawingsForPlayer(
  drawings: Drawing[],
  player: RoomPlayer,
): Drawing[] {
  return drawings.filter((d) => {
    if (d.visibility === 'shared') return true;
    if (d.visibility === 'dm-only') return player.role === 'dm';
    // player-only
    return d.creatorUserId === player.userId || player.role === 'dm';
  });
}

export function registerDrawingEvents(io: Server, socket: Socket): void {

  socket.on('drawing:create', (data) => {
    const parsed = drawingCreateSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Resolve which map THIS socket is drawing on. DMs draw on their
    // preview cursor (or the ribbon if not previewing); players
    // always draw on the ribbon. Without this, a DM drawing on a
    // preview map would persist their marks to the players' map.
    const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!mapId) return;

    const incoming = parsed.data.drawing;

    // Force creatorUserId + creatorRole to the authenticated socket.
    const creatorUserId = ctx.player.userId;
    const creatorRole: 'dm' | 'player' = ctx.player.role;

    // Non-DMs can only create `player-only` drawings. Silently coerce.
    let visibility: DrawingVisibility = incoming.visibility;
    if (creatorRole !== 'dm' && visibility !== 'player-only') {
      visibility = 'player-only';
    }

    // Assemble the canonical drawing we're about to broadcast.
    const drawing: Drawing = {
      id: incoming.id,
      mapId,
      creatorUserId,
      creatorRole,
      kind: incoming.kind,
      visibility,
      color: incoming.color,
      strokeWidth: incoming.strokeWidth,
      geometry: incoming.geometry,
      gridSnapped: incoming.gridSnapped,
      createdAt: Date.now(),
      fadeAfterMs: incoming.kind === 'ephemeral' ? (incoming.fadeAfterMs ?? 10000) : null,
    };

    // Write into memory first so subsequent deletes + clears find it.
    ctx.room.drawings.set(drawing.id, drawing);

    // Persist permanent drawings.
    if (drawing.kind !== 'ephemeral') {
      try {
        db.prepare(`
          INSERT INTO drawings (
            id, map_id, creator_user_id, creator_role, kind, visibility,
            color, stroke_width, geometry, grid_snapped, created_at, fade_after_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          drawing.id, drawing.mapId, drawing.creatorUserId, drawing.creatorRole,
          drawing.kind, drawing.visibility, drawing.color, drawing.strokeWidth,
          JSON.stringify(drawing.geometry), drawing.gridSnapped ? 1 : 0,
          drawing.createdAt, drawing.fadeAfterMs,
        );
      } catch (err) {
        console.warn('[drawing:create] DB insert failed:', err);
      }
    }

    // Broadcast to visibility-appropriate sockets.
    const recipients = socketsForVisibility(ctx.room, visibility, creatorUserId);
    for (const sid of recipients) {
      io.to(sid).emit('drawing:created', drawing);
    }
  });

  socket.on('drawing:delete', (data) => {
    const parsed = drawingDeleteSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    const drawing = ctx.room.drawings.get(parsed.data.drawingId);
    if (!drawing) return;

    // Auth: DM can delete any drawing, players can only delete their own.
    const isDM = ctx.player.role === 'dm';
    if (!isDM && drawing.creatorUserId !== ctx.player.userId) return;

    ctx.room.drawings.delete(drawing.id);

    // Remove from DB (no-op if ephemeral since it was never persisted)
    if (drawing.kind !== 'ephemeral') {
      try {
        db.prepare('DELETE FROM drawings WHERE id = ?').run(drawing.id);
      } catch (err) {
        console.warn('[drawing:delete] DB delete failed:', err);
      }
    }

    // Broadcast to the same audience that would have seen the create.
    const recipients = socketsForVisibility(
      ctx.room, drawing.visibility, drawing.creatorUserId,
    );
    for (const sid of recipients) {
      io.to(sid).emit('drawing:deleted', { drawingId: drawing.id });
    }
  });

  socket.on('drawing:clear-all', (data) => {
    const parsed = drawingClearAllSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Clear the map THIS socket is currently drawing on — preview or
    // ribbon. Otherwise a DM wiping their preview marks would wipe
    // the players' ribbon marks.
    const mapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
    if (!mapId) return;

    const isDM = ctx.player.role === 'dm';
    const scope = parsed.data.scope;

    // Non-DMs can only clear their own drawings. DM asked for `mine`
    // also clears only their own.
    if (scope === 'all' && !isDM) return;

    const userId = ctx.player.userId;

    if (scope === 'all') {
      // DM is wiping everything on the current map.
      for (const [id, d] of ctx.room.drawings) {
        if (d.mapId === mapId) ctx.room.drawings.delete(id);
      }
      try {
        db.prepare('DELETE FROM drawings WHERE map_id = ?').run(mapId);
      } catch (err) {
        console.warn('[drawing:clear-all] DB wipe failed:', err);
      }
      // Broadcast to everybody — they all need to forget every drawing
      // regardless of its prior visibility.
      io.to(ctx.room.sessionId).emit('drawing:cleared', { scope: 'all' });
    } else {
      // Scope 'mine' — drop just this user's drawings.
      for (const [id, d] of ctx.room.drawings) {
        if (d.mapId === mapId && d.creatorUserId === userId) {
          ctx.room.drawings.delete(id);
        }
      }
      try {
        db.prepare('DELETE FROM drawings WHERE map_id = ? AND creator_user_id = ?')
          .run(mapId, userId);
      } catch (err) {
        console.warn('[drawing:clear-all mine] DB wipe failed:', err);
      }
      // A "mine" wipe affects every audience that could see this
      // user's drawings: themselves + all DMs + anyone who can see
      // their 'shared' drawings (effectively, the whole room).
      io.to(ctx.room.sessionId).emit('drawing:cleared', { scope: 'mine', userId });
    }
  });

  socket.on('drawing:stream', (data) => {
    if (!allowStreamEvent(socket.id)) return;

    const parsed = drawingStreamSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Force creator id to the authenticated socket.
    const creatorUserId = ctx.player.userId;
    const isDM = ctx.player.role === 'dm';

    // Coerce visibility for non-DMs.
    let visibility: DrawingVisibility = parsed.data.visibility;
    if (!isDM && visibility !== 'player-only') visibility = 'player-only';

    const payload = {
      tempId: parsed.data.tempId,
      creatorUserId,
      kind: parsed.data.kind,
      visibility,
      color: parsed.data.color,
      strokeWidth: parsed.data.strokeWidth,
      geometry: parsed.data.geometry,
    };

    // Broadcast to visibility audience, EXCLUDING the sender itself
    // (their own client already has the in-progress stroke locally).
    const recipients = socketsForVisibility(ctx.room, visibility, creatorUserId);
    for (const sid of recipients) {
      if (sid === socket.id) continue;
      io.to(sid).emit('drawing:streamed', payload);
    }
  });

  socket.on('drawing:stream-end', (data) => {
    const parsed = drawingStreamEndSchema.safeParse(data);
    if (!parsed.success) return;

    const ctx = getPlayerBySocketId(socket.id);
    if (!ctx) return;

    // Broadcast to everyone except the sender; visibility filter is
    // irrelevant for stream-end (it's just cleanup for ghost previews).
    socket.to(ctx.room.sessionId).emit('drawing:stream-end', { tempId: parsed.data.tempId });
  });

  // Clean up the rate limiter entry when the socket disconnects, so
  // reconnecting clients don't hit a stale quota.
  socket.on('disconnect', () => {
    streamCounters.delete(socket.id);
  });
}
