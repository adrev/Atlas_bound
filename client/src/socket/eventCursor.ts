import type { Socket } from 'socket.io-client';
import { useSessionStore } from '../stores/useSessionStore';
import { dispatchReplayEvent } from './replayHandlers';

/**
 * Event cursor — client half of the resync protocol.
 *
 * The server stamps every meaningful broadcast with a monotonic
 * `_eventId` per-room. We record the highest value we've seen. On
 * reconnect / visibility return / periodic keep-alive, we call the
 * resync endpoint asking for anything we missed, and replay the
 * returned events through the same socket listeners we already have
 * registered.
 *
 * This gives us eventual consistency for free: if a websocket frame
 * is lost (dead socket, Cloud Run instance churn, OS-suspended tab),
 * the next tick catches up without needing a full map reload.
 *
 * The state is deliberately module-level (not React-state) so the
 * `beforeEach socket:event` wrapper can read + write it without
 * flowing through a component re-render.
 */

let lastEventId = 0;

/** Update the cursor when a live event arrives. */
export function recordEventId(id: number): void {
  if (id > lastEventId) lastEventId = id;
}

export function getLastEventId(): number {
  return lastEventId;
}

/** Reset when the user leaves the session (new room, new cursor). */
export function resetEventCursor(): void {
  lastEventId = 0;
}

/**
 * Ask the server for any events since our last-seen id and replay
 * them through the current socket listeners. Returns the number of
 * events replayed (for logging / observability).
 */
export async function pullEventCursor(socket: Socket): Promise<number> {
  const sessionId = useSessionStore.getState().sessionId;
  if (!sessionId) return 0;

  try {
    const resp = await fetch(
      `/api/sessions/${sessionId}/events?since=${lastEventId}`,
      { credentials: 'include' },
    );
    if (resp.status === 410) {
      // Our cursor is older than the replay buffer — server can't
      // guarantee a complete delta. Force a fresh session:join so
      // the client rebuilds state from the authoritative hydration.
      lastEventId = 0;
      // The caller (keep-alive loop) re-emits session:join on the
      // next tick anyway, but nudge it now.
      socket.emit('session:join', {
        roomCode: useSessionStore.getState().roomCode,
      });
      return 0;
    }
    if (!resp.ok) return 0;

    const body = (await resp.json()) as {
      events: Array<{ id: number; kind: string; payload: Record<string, unknown> }>;
      latestEventId: number;
    };

    if (!body.events || body.events.length === 0) {
      // Still advance our cursor to match the server's idea of
      // "nothing new to replay" so we don't re-ask for the same
      // empty range on the next tick.
      if (typeof body.latestEventId === 'number') {
        lastEventId = Math.max(lastEventId, body.latestEventId);
      }
      return 0;
    }

    for (const e of body.events) {
      // Replay through our own dispatcher — mirrors what the live
      // socket listener would do for each event kind but avoids
      // reaching into socket.io-client's internal Emitter callbacks.
      // Handlers are idempotent so re-applying an event we may have
      // already processed is a no-op.
      dispatchReplayEvent(e.kind, e.payload);
      if (e.id > lastEventId) lastEventId = e.id;
    }

    if (typeof body.latestEventId === 'number') {
      lastEventId = Math.max(lastEventId, body.latestEventId);
    }
    return body.events.length;
  } catch {
    // Network blip — the next keep-alive tick will retry.
    return 0;
  }
}
