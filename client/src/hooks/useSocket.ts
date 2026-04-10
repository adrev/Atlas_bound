import { useEffect, useRef } from 'react';
import { getSocket, disconnectSocket } from '../socket/client';
import { registerListeners } from '../socket/listeners';
import { emitJoinSession } from '../socket/emitters';
import { useAuthStore } from '../stores/useAuthStore';

export function useSocket(roomCode: string | undefined, displayName: string | null) {
  const cleanupRef = useRef<(() => void) | null>(null);
  // Prefer auth user displayName; fall back to the legacy parameter
  const authDisplayName = useAuthStore((s) => s.user?.displayName);
  const effectiveName = authDisplayName ?? displayName;

  useEffect(() => {
    if (!roomCode || !effectiveName) return;

    const socket = getSocket();
    cleanupRef.current = registerListeners(socket);

    socket.connect();

    socket.on('connect', () => {
      emitJoinSession(roomCode, effectiveName);
    });

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      socket.off('connect');
      disconnectSocket();
    };
  }, [roomCode, effectiveName]);
}
