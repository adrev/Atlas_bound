import type { Server, Socket } from 'socket.io';
import { afterCommit } from '../db/transactionContext.js';

export function installCommittedBroadcasts(io: Server): void {
  const adapter = io.of('/').adapter;
  const broadcast = adapter.broadcast.bind(adapter);
  adapter.broadcast = (packet, options) => {
    const copy = structuredClone(packet);
    const targets = { ...options, rooms: new Set(options.rooms), except: new Set(options.except) };
    afterCommit(() => broadcast(copy, targets));
  };
}

export function installCommittedSocket(socket: Socket): void {
  const emit = socket.emit.bind(socket);
  socket.emit = ((event: string, ...args: unknown[]) => {
    const copy = structuredClone(args);
    afterCommit(() => emit(event, ...copy));
    return true;
  }) as Socket['emit'];
}
