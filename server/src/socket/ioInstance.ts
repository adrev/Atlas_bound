import type { Server } from 'socket.io';

/**
 * Holds the global Socket.io server instance so non-socket modules
 * (HTTP routes, services) can broadcast events without having `io`
 * passed down through function arguments.
 *
 * Set exactly once at startup in index.ts via `setIO(io)`.
 */
let ioInstance: Server | null = null;

export function setIO(io: Server): void {
  ioInstance = io;
}

export function getIO(): Server | null {
  return ioInstance;
}
