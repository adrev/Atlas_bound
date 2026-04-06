import { useEffect, useRef } from 'react';
import { getSocket, disconnectSocket } from '../socket/client';
import { registerListeners } from '../socket/listeners';
import { emitJoinSession } from '../socket/emitters';

export function useSocket(roomCode: string | undefined, displayName: string | null) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!roomCode || !displayName) return;

    const socket = getSocket();
    cleanupRef.current = registerListeners(socket);

    socket.connect();

    socket.on('connect', () => {
      emitJoinSession(roomCode, displayName);
    });

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      socket.off('connect');
      disconnectSocket();
    };
  }, [roomCode, displayName]);
}
