import type { Socket } from 'socket.io';

export function safeHandler(socket: Socket, handler: (data: unknown) => Promise<void>) {
  return async (data: unknown) => {
    try {
      await handler(data);
    } catch (err) {
      console.error('[Socket Error]', err instanceof Error ? err.message : err);
      socket.emit('session:error', { message: 'An unexpected error occurred' });
    }
  };
}
