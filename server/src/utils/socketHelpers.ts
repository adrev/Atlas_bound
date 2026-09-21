import type { Socket } from 'socket.io';

export interface SocketOperationOptions {
  join?: boolean;
}
type Executor = (
  socket: Socket,
  data: unknown,
  operation: () => Promise<void>,
  options?: SocketOperationOptions
) => Promise<void>;
let executor: Executor | undefined;
export function configureSocketExecutor(value: Executor): void {
  executor = value;
}

export function safeHandler(
  socket: Socket,
  handler: (data: unknown) => Promise<void>,
  options?: SocketOperationOptions
) {
  return async (data: unknown) => {
    try {
      if (executor) await executor(socket, data, () => handler(data), options);
      else await handler(data);
    } catch (err) {
      console.error('[Socket Error]', err instanceof Error ? err.message : err);
      socket.emit('session:error', { message: 'An unexpected error occurred' });
    }
  };
}
