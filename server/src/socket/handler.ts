import type { Server, Socket } from 'socket.io';
import { registerSessionEvents } from './sessionEvents.js';
import { registerMapEvents } from './mapEvents.js';
import { registerCombatEvents } from './combatEvents.js';
import { registerCharacterEvents } from './characterEvents.js';
import { registerChatEvents } from './chatEvents.js';

// Use untyped Server/Socket to avoid Socket.io strict callback typing issues
// The payloads are validated at runtime via zod schemas instead
export function registerSocketHandler(io: Server): void {
  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    registerSessionEvents(io, socket);
    registerMapEvents(io, socket);
    registerCombatEvents(io, socket);
    registerCharacterEvents(io, socket);
    registerChatEvents(io, socket);
  });
}
