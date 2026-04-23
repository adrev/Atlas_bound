import { useEffect, useRef } from 'react';
import { getSocket, disconnectSocket } from '../socket/client';
import { registerListeners } from '../socket/listeners';
import { emitJoinSession } from '../socket/emitters';

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
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') forceResync();
    };
    const onOnline = () => forceResync();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    // Periodic proactive re-join (every 90 s) as final safety net. If
    // the primary socket lost its room membership for any reason we
    // can't detect, the next rejoin tick will re-add it. `emitJoin`
    // is a no-op on the UX side (server resolves the user server-
    // authoritatively); costs one tiny socket message per 1.5 min.
    const keepAliveId = window.setInterval(() => {
      if (!socket.connected) socket.connect();
      rejoin();
    }, 90_000);

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      socket.off('connect', rejoin);
      socket.io.off('reconnect', rejoin);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.clearInterval(keepAliveId);
      disconnectSocket();
    };
  }, [roomCode]);
}
