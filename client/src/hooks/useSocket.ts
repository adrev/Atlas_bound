import { useEffect } from 'react';
import { getSocket, disconnectSocket } from '../socket/client';
import { registerListeners } from '../socket/listeners';
import { emitJoinSession, emitHeartbeat } from '../socket/emitters';
import {
  pullEventCursor,
  recordEventId,
  invalidateSessionSync,
  requestFullRejoin,
  setRejoinHandler,
} from '../socket/eventCursor';
import { pullStateSnapshot } from '../socket/stateSnapshot';
import { useSessionStore } from '../stores/useSessionStore';

/** Bind recovery requests to this room's socket and hydration lifetime. */
export function useSocket(roomCode: string | undefined) {
  useEffect(() => {
    if (!roomCode) return;

    const socket = getSocket();
    invalidateSessionSync();
    const cleanupListeners = registerListeners(socket, roomCode);
    const cleanupRejoin = setRejoinHandler(() => {
      // Never buffer joins while offline; connect will request one fresh join.
      if (socket.connected) emitJoinSession(roomCode);
      else socket.connect();
    });
    const rejoin = () => requestFullRejoin();
    const onDisconnect = () => invalidateSessionSync();

    const onAnyEvent = (_kind: string, payload?: unknown) => {
      if (!useSessionStore.getState().generation) return;
      const id = (payload as { _eventId?: number } | undefined)?._eventId;
      if (typeof id === 'number') recordEventId(id);
    };
    socket.onAny(onAnyEvent);

    // Socket connect fires on every successful reconnect. A Manager reconnect
    // handler as well would issue two overlapping full hydrations.
    socket.on('connect', rejoin);
    socket.on('disconnect', onDisconnect);
    const onHeartbeatAck = (ack?: {
      ok?: boolean;
      rejoinRequired?: boolean;
      generation?: string;
      nextEventId?: number;
    }) => {
      const generation = useSessionStore.getState().generation;
      if (ack?.rejoinRequired || (generation && ack?.ok && ack.generation !== generation)) rejoin();
    };
    socket.on('session:heartbeat-ack', onHeartbeatAck);

    // Attach all handlers before connecting, including StrictMode re-entry.
    if (socket.connected) rejoin();
    else socket.connect();

    const forceResync = () => rejoin();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') forceResync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', forceResync);

    const keepAliveId = window.setInterval(() => {
      if (!socket.connected) {
        socket.connect();
        return;
      }
      if (!useSessionStore.getState().generation) {
        // Retry a lost/failed join, but never poll an unhydrated cold room.
        rejoin();
        return;
      }
      emitHeartbeat(roomCode);
      void pullStateSnapshot();
      void pullEventCursor(socket);
    }, 5_000);

    return () => {
      cleanupRejoin();
      cleanupListeners();
      socket.off('connect', rejoin);
      socket.off('disconnect', onDisconnect);
      socket.off('session:heartbeat-ack', onHeartbeatAck);
      socket.offAny(onAnyEvent);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', forceResync);
      window.clearInterval(keepAliveId);
      invalidateSessionSync();
      disconnectSocket();
    };
  }, [roomCode]);
}
