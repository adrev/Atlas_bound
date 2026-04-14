import { useEffect, useRef } from 'react';
import { getSocket, disconnectSocket } from '../socket/client';
import { registerListeners } from '../socket/listeners';
import { emitJoinSession } from '../socket/emitters';

export function useSocket(roomCode: string | undefined) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!roomCode) return;

    const socket = getSocket();
    cleanupRef.current = registerListeners(socket);

    socket.connect();

    socket.on('connect', () => {
      emitJoinSession(roomCode);
    });

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      socket.off('connect');
      disconnectSocket();
    };
  }, [roomCode]);
}
