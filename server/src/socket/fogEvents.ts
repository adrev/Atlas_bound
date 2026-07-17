import type { Server, Socket } from 'socket.io';
import type { FogPolygon } from '@dnd-vtt/shared';
import pool from '../db/connection.js';
import { getPlayerBySocketId, resolveViewingMapId, socketsOnMap } from '../utils/roomState.js';
import { fogRevealHideSchema } from '../utils/validation.js';
import { safeHandler } from '../utils/socketHelpers.js';
import { safeParseJSON } from '../utils/safeJson.js';

/**
 * DM fog-brush events. Fog state is stored on the map row
 * (`maps.fog_state`, JSON) and broadcast to all sockets viewing
 * that map so reveals/hides are persistent across reloads.
 *
 * Each edit is a read-modify-write of the whole fog_state array, so two
 * strokes that interleave would clobber each other (the second SELECT
 * runs before the first UPDATE commits, and its append drops the first
 * stroke). `withMapFogLock` serialises the read-modify-write per map so
 * rapid strokes queue instead of racing.
 */
const fogWriteChains = new Map<string, Promise<unknown>>();

function withMapFogLock<T>(mapId: string, task: () => Promise<T>): Promise<T> {
  const prev = fogWriteChains.get(mapId) ?? Promise.resolve();
  // Chain onto the previous write regardless of whether it settled ok, so
  // one failing stroke doesn't wedge the queue.
  const next = prev.catch(() => undefined).then(task);
  fogWriteChains.set(mapId, next);
  // Once this is the tail of the chain, drop the map entry to avoid an
  // unbounded map of settled promises.
  void next
    .catch(() => undefined)
    .finally(() => {
      if (fogWriteChains.get(mapId) === next) fogWriteChains.delete(mapId);
    });
  return next;
}

function registerFogEditHandler(
  io: Server,
  socket: Socket,
  event: 'map:fog-reveal' | 'map:fog-hide',
  mode: 'reveal' | 'hide'
): void {
  socket.on(
    event,
    safeHandler(socket, async (data) => {
      const parsed = fogRevealHideSchema.safeParse(data);
      if (!parsed.success) return;
      const ctx = getPlayerBySocketId(socket.id);
      if (!ctx || ctx.player.role !== 'dm') return;
      const targetMapId = resolveViewingMapId(ctx.room, ctx.player.userId, ctx.player.role);
      if (!targetMapId) return;

      const fogState = await withMapFogLock(targetMapId, async () => {
        const { rows } = await pool.query('SELECT fog_state FROM maps WHERE id = $1', [
          targetMapId,
        ]);
        if (rows.length === 0) return null;

        const state = safeParseJSON<FogPolygon[]>(rows[0].fog_state, [], 'map.fog_state');
        state.push({ points: parsed.data.points, mode });

        await pool.query('UPDATE maps SET fog_state = $1 WHERE id = $2', [
          JSON.stringify(state),
          targetMapId,
        ]);
        return state;
      });
      if (!fogState) return;

      const recipients = socketsOnMap(ctx.room, targetMapId);
      for (const sid of recipients)
        io.to(sid).emit('map:fog-updated', { fogState, mapId: targetMapId });
    })
  );
}

export function registerFogEvents(io: Server, socket: Socket): void {
  registerFogEditHandler(io, socket, 'map:fog-reveal', 'reveal');
  registerFogEditHandler(io, socket, 'map:fog-hide', 'hide');
}
