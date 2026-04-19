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

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      socket.off('connect', rejoin);
      socket.io.off('reconnect', rejoin);
      disconnectSocket();
    };
  }, [roomCode]);
}
