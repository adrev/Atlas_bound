import type { Server, Socket } from 'socket.io';
import { registerSessionEvents } from './sessionEvents.js';
import { registerMapEvents } from './mapEvents.js';
import { registerSceneEvents } from './sceneEvents.js';
import { registerCombatEvents } from './combatEvents.js';
import { registerCharacterEvents } from './characterEvents.js';
import { registerChatEvents } from './chatEvents.js';
import { registerDrawingEvents } from './drawingEvents.js';
import { lucia } from '../auth/lucia.js';

// Use untyped Server/Socket to avoid Socket.io strict callback typing issues
// The payloads are validated at runtime via zod schemas instead
export function registerSocketHandler(io: Server): void {
  // Socket authentication middleware
  io.use(async (socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie ?? '';
    const sessionId = lucia.readSessionCookie(cookieHeader);
    if (!sessionId) return next(new Error('Authentication required'));

    const { session, user } = await lucia.validateSession(sessionId);
    if (!session) return next(new Error('Invalid session'));

    socket.data.userId = user.id;
    socket.data.displayName = user.displayName;
    next();
  });

  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    registerSessionEvents(io, socket);
    registerMapEvents(io, socket);
    registerSceneEvents(io, socket);
    registerCombatEvents(io, socket);
    registerCharacterEvents(io, socket);
    registerChatEvents(io, socket);
    registerDrawingEvents(io, socket);
  });
}
