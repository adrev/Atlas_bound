import { useEffect, useRef } from 'react';
import { getSocket, disconnectSocket } from '../socket/client';
import { registerListeners } from '../socket/listeners';
import { emitJoinSession } from '../socket/emitters';
import { pullEventCursor, recordEventId, resetEventCursor } from '../socket/eventCursor';
import { pullStateSnapshot } from '../socket/stateSnapshot';

/**
 * Socket.io connection lifecycle bound to the active session.
 *
 * `connect` only fires on the initial handshake. Auto-reconnects after
 * a network blip fire `reconnect` on the Manager AND a fresh `connect`
 * on the Socket — but the earlier implementation subscribed only to
 * `connect`, and in practice was returning stale sockets from
 * `getSocket()` whose `connect` listener had already fired. That left
 * the socket reconnected but NOT rejoined to its session room, so
 * every subsequent `io.to(sessionId).emit(...)` broadcast (combat
 * start/end, token-moved, DM token adds, etc.) silently dropped for
 * the affected client — the canonical "fixed by refresh" bug.
 *
 * The fix: re-emit `session:join` every time socket.io tells us we're
 * connected, regardless of whether it's a first-time connect or an
 * auto-reconnect, AND listen to the Manager's `reconnect` event as a
 * belt-and-braces fallback.
 */
export function useSocket(roomCode: string | undefined) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!roomCode) return;

    const socket = getSocket();
    cleanupRef.current = registerListeners(socket);

    // Event-cursor tracking — capture `_eventId` on every incoming
    // socket event so we know where we are in the server's event log.
    // socket.onAny fires for ANY event, including future ones we add
    // handlers for, so we don't have to keep this list in sync.
    const onAnyEvent = (_kind: string, payload?: unknown) => {
      const id = (payload as { _eventId?: number } | undefined)?._eventId;
      if (typeof id === 'number') recordEventId(id);
    };
    socket.onAny(onAnyEvent);

    // Reset the cursor when we first connect to this session — a new
    // room starts at 0 regardless of what we saw in the last session.
    resetEventCursor();

    socket.connect();

    const rejoin = () => emitJoinSession(roomCode);
    socket.on('connect', rejoin);
    // Socket.io wraps an underlying Manager that emits `reconnect`
    // after a successful recovery. Hook both — belt-and-braces so a
    // missed `connect` doesn't leave us stuck outside the room.
    socket.io.on('reconnect', rejoin);

    // If we attach after the socket already connected (e.g. listener
    // cleanup + reattach from StrictMode double-render), fire once
    // immediately so we don't wait for the next event.
    if (socket.connected) rejoin();

    // Tab visibility / network-online recovery. Reported failure mode:
    // "websockets seem to expire" — a player leaves the tab in the
    // background for 30+ minutes, the OS suspends the connection,
    // socket.io's transparent reconnect doesn't fire because the page
    // never knew the connection died. When the tab comes back, a
    // forced reconnect + re-join rebuilds the room membership so
    // broadcasts flow again. Same logic on `online` after a Wi-Fi blip.
    const forceResync = () => {
      if (!socket.connected) {
        // socket.io already handles reconnection attempts, but if
        // they've exhausted we need to kick it manually.
        socket.connect();
      }
      // Re-emit session:join regardless of connected state. Server
      // tolerates duplicates — it just refreshes the RoomPlayer
      // record with the (current) socketId.
      rejoin();
      // Pull the authoritative state snapshot — this is the
      // ground-truth reconciliation that closes EVERY drift window,
      // regardless of whether the causing broadcast was wrapped in
      // the event cursor or not. See stateSnapshot.ts comments.
      void pullStateSnapshot();
      // Also pull the event cursor delta for live event replay
      // (animations, chat) the snapshot doesn't carry.
      void pullEventCursor(socket);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') forceResync();
    };
    const onOnline = () => forceResync();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    // Periodic keep-alive — three layers of self-heal every 5 s:
    //   1. rejoin()          → refresh server's RoomPlayer record
    //   2. pullStateSnapshot → authoritative state reconciliation
    //                          (fixes drift regardless of which
    //                          broadcast path was used server-side)
    //   3. pullEventCursor   → replay any live-animation events we
    //                          missed (chat, spell animations)
    //
    // Tightened from 15 s → 5 s so even a passive session
    // (everyone AFK, no events triggering on-demand snapshots)
    // reconciles well before a human can notice drift. Combined
    // with the on-demand `triggerSnapshot()` calls wired into every
    // user action (attack, damage, heal, inventory edit, spell,
    // token move, combat state change, map / character load), the
    // client is essentially always at most 150 ms behind the
    // server's idea of the world.
    //
    // Bandwidth at 4 clients × 12 calls/min = 48 /min per session.
    // Snapshot is ~5-30 KB. Below 5 s we'd want long-polling or
    // SSE; this is the natural floor for plain HTTP polling.
    //
    // Previously 90 s → 30 s → 15 s → 5 s: each tightening traced
    // to a user-reported sync symptom. 5 s is below the human
    // notice threshold for "things are out of sync."
    const keepAliveId = window.setInterval(() => {
      if (!socket.connected) socket.connect();
      rejoin();
      void pullStateSnapshot();
      void pullEventCursor(socket);
    }, 5_000);

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      socket.off('connect', rejoin);
      socket.io.off('reconnect', rejoin);
      socket.offAny(onAnyEvent);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.clearInterval(keepAliveId);
      resetEventCursor();
      disconnectSocket();
    };
  }, [roomCode]);
}
