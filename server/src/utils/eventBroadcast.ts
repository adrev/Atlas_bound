import type { Server } from 'socket.io';
import type { RoomState } from './roomState.js';
import { MAX_EVENT_LOG } from './roomState.js';

/**
 * Wraps a socket.io broadcast with event-log bookkeeping so clients
 * can detect missed events and replay them on reconnect.
 *
 * The payload sent over the wire includes an `_eventId` field added
 * by this helper — clients use it as their "last seen" cursor. If a
 * client reconnects and discovers the latest `_eventId` on any event
 * has skipped ahead of their stored value, they GET
 * `/api/sessions/:id/events?since=<lastSeen>` to pull the delta and
 * replay each missed event through the same socket listeners as if
 * they had arrived live.
 *
 * Why we route every meaningful broadcast through here (instead of
 * letting handlers `io.to(...).emit` directly):
 *   1. Monotonic `eventId` per room for replay ordering.
 *   2. Bounded history buffer so memory doesn't grow unbounded over
 *      a long session.
 *   3. Centralized entry point for per-recipient filtering (hidden
 *      tokens, role-scoped events) on replay.
 *
 * @param io        socket.io server
 * @param room      destination room (source of truth for eventLog + id)
 * @param kind      socket event name, e.g. 'map:token-moved'
 * @param payload   event body — same shape as the prior io.to().emit arg
 * @param opts.tokenId  optional token id reference for visibility filtering
 *                      on replay (so hidden tokens don't leak)
 * @param opts.includeEventId  inject `_eventId` into the live payload
 *                      so the client's listener updates its cursor
 *                      immediately (default true; pass false for events
 *                      with strict-shape Zod schemas on the wire).
 */
export function broadcastEvent(
  io: Server,
  room: RoomState,
  kind: string,
  payload: Record<string, unknown>,
  opts: { tokenId?: string | null; includeEventId?: boolean } = {},
): void {
  const id = ++room.nextEventId;
  const entry = {
    id,
    kind,
    payload,
    ts: Date.now(),
    tokenId: opts.tokenId ?? null,
  };
  room.eventLog.push(entry);
  // Circular buffer — drop the oldest when we overflow so the log stays
  // bounded. Shift is O(n) but MAX_EVENT_LOG is small enough (500) that
  // the cost is negligible compared to the socket write underneath.
  if (room.eventLog.length > MAX_EVENT_LOG) {
    room.eventLog.splice(0, room.eventLog.length - MAX_EVENT_LOG);
  }

  const wirePayload = opts.includeEventId === false
    ? payload
    : { ...payload, _eventId: id };
  io.to(room.sessionId).emit(kind, wirePayload);
}

/**
 * Same as `broadcastEvent` but scopes the emit to a specific set of
 * socket ids (e.g. "only sockets viewing map X"). Still appends to the
 * event log so reconnecting clients can discover + replay the event
 * even if they weren't in the target set when it originally fired.
 */
export function broadcastEventToSockets(
  io: Server,
  room: RoomState,
  kind: string,
  payload: Record<string, unknown>,
  socketIds: Iterable<string>,
  opts: { tokenId?: string | null; includeEventId?: boolean } = {},
): void {
  const id = ++room.nextEventId;
  room.eventLog.push({
    id,
    kind,
    payload,
    ts: Date.now(),
    tokenId: opts.tokenId ?? null,
  });
  if (room.eventLog.length > MAX_EVENT_LOG) {
    room.eventLog.splice(0, room.eventLog.length - MAX_EVENT_LOG);
  }

  const wirePayload = opts.includeEventId === false
    ? payload
    : { ...payload, _eventId: id };
  for (const sid of socketIds) {
    io.to(sid).emit(kind, wirePayload);
  }
}
