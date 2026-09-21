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
let syncGeneration = 0;
let hasSnapshotBaseline = false;
let rejoinHandler: (() => void) | null = null;

/** Local request lifetime; also changes on same-room reconnects and re-entry. */
export function getSyncGeneration(): number {
  return syncGeneration;
}

export function setRejoinHandler(handler: () => void): () => void {
  rejoinHandler = handler;
  return () => {
    if (rejoinHandler === handler) rejoinHandler = null;
  };
}

export function invalidateSessionSync(): void {
  resetEventCursor();
  useSessionStore.setState({ generation: null });
}

/** Only a full socket join may adopt a different server generation. */
export function requestFullRejoin(socket?: Socket): void {
  invalidateSessionSync();
  if (rejoinHandler) rejoinHandler();
  else if (socket && useSessionStore.getState().roomCode) {
    socket.emit('session:join', { roomCode: useSessionStore.getState().roomCode });
  }
}

/** Update the cursor when a live event arrives. */
export function recordEventId(id: number): void {
  if (Number.isSafeInteger(id) && id > lastEventId) lastEventId = id;
}

/** Zero is a valid baseline after hydration, not permission to replay old history. */
export function recordSnapshotCursor(id: number): void {
  recordEventId(id);
  hasSnapshotBaseline = true;
}

export function getLastEventId(): number {
  return lastEventId;
}

/** Reset when the user leaves the session (new room, new cursor). */
export function resetEventCursor(): void {
  lastEventId = 0;
  hasSnapshotBaseline = false;
  syncGeneration += 1;
}

// Observe transitions synchronously, including A -> null -> A while awaiting HTTP.
useSessionStore.subscribe((state, previous) => {
  if (
    state.sessionId !== previous.sessionId ||
    state.roomCode !== previous.roomCode ||
    state.userId !== previous.userId ||
    state.generation !== previous.generation
  )
    resetEventCursor();
});

/**
 * Ask the server for any events since our last-seen id and replay
 * them through the current socket listeners. Returns the number of
 * events replayed (for logging / observability).
 */
export async function pullEventCursor(socket: Socket): Promise<number> {
  const { sessionId, generation } = useSessionStore.getState();
  if (!sessionId || !generation || !hasSnapshotBaseline) return 0;
  const lifetime = getSyncGeneration();
  const since = lastEventId;
  const isCurrent = () => lifetime === getSyncGeneration();

  try {
    const resp = await fetch(
      `/api/sessions/${sessionId}/events?since=${since}&generation=${encodeURIComponent(generation)}`,
      { credentials: 'include' }
    );
    if (!isCurrent()) return 0;
    if (resp.status === 410) {
      // Covers expired history, a cold room, generation mismatch and ahead cursors.
      requestFullRejoin(socket);
      return 0;
    }
    if (!resp.ok) return 0;

    const body = (await resp.json()) as {
      generation?: string;
      events: Array<{ id: number; kind: string; payload: Record<string, unknown> }>;
      latestEventId: number;
    };
    if (!isCurrent()) return 0;
    if (body.generation !== generation || body.latestEventId < since) {
      requestFullRejoin(socket);
      return 0;
    }

    if (!body.events || body.events.length === 0) {
      // Still advance our cursor to match the server's idea of
      // "nothing new to replay" so we don't re-ask for the same
      // empty range on the next tick.
      if (typeof body.latestEventId === 'number') {
        lastEventId = Math.max(lastEventId, body.latestEventId);
      }
      return 0;
    }

    let replayed = 0;
    for (const e of [...body.events].sort((a, b) => a.id - b.id)) {
      if (!isCurrent()) return replayed;
      if (e.id <= lastEventId) continue;
      // Replay through our own dispatcher — mirrors what the live
      // socket listener would do for each event kind but avoids
      // reaching into socket.io-client's internal Emitter callbacks.
      // Handlers are idempotent so re-applying an event we may have
      // already processed is a no-op.
      dispatchReplayEvent(e.kind, e.payload);
      replayed += 1;
      if (!isCurrent()) return replayed;
      recordEventId(e.id);
    }

    if (typeof body.latestEventId === 'number') {
      lastEventId = Math.max(lastEventId, body.latestEventId);
    }
    return replayed;
  } catch {
    // Network blip — the next keep-alive tick will retry.
    return 0;
  }
}
