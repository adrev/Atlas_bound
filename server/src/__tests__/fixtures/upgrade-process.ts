import { configureFixtureDatabase } from './runtime-process.js';
import type { Server } from 'socket.io';

configureFixtureDatabase(
  process.env.ATLAS_RUNTIME_TEST_DATABASE_URL!,
  process.env.ATLAS_RUNTIME_TEST_SCHEMA!,
  `upgrade-${process.pid}`
);
const { rawPool, transportPool } = await import('../../db/connection.js');
try {
  const { initDatabase } = await import('../../db/schema.js');
  const { initRuntimeSchema } = await import('../../db/runtimeSchema.js');
  await initDatabase();
  await initRuntimeSchema();
  const commands = JSON.parse(process.env.ATLAS_RUNTIME_TEST_COMMANDS ?? '[]') as string[];
  if (commands.length) {
    const { configureSessionRuntime, withSessionRuntime } =
      await import('../../services/SessionRuntime.js');
    const { getRoom, addPlayerToRoom } = await import('../../utils/roomState.js');
    const { tryHandleChatCommand } = await import('../../services/ChatCommands.js');
    await import('../../services/chatCommands/xpAndWildShapeHandler.js');
    await import('../../services/chatCommands/restHandlers.js');
    configureSessionRuntime();
    const messages: unknown[] = [];
    const io = {
      to: () => ({
        emit: (...args: unknown[]) => {
          messages.push(args);
        },
      }),
    } as unknown as Server;
    for (const command of commands)
      await withSessionRuntime('s', async () => {
        const room = getRoom('s')!;
        const player = {
          userId: 'u',
          role: 'dm' as const,
          displayName: 'DM',
          socketId: 'fixture',
          characterId: 'c',
        };
        addPlayerToRoom('s', player);
        await tryHandleChatCommand(io, { room, player }, command);
      });
    console.log('UPGRADE_MESSAGES ' + JSON.stringify(messages));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rawPool.end();
  await transportPool.end();
}
