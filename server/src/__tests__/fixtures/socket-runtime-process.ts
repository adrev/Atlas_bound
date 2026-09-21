import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Validate before importing anything that constructs an application DB pool. */
export function socketTestDatabase(value: string | undefined): string {
  if (!value) throw new Error('ATLAS_RUNTIME_TEST_DATABASE_URL is required');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL required');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Socket integration test refuses non-loopback PostgreSQL');
  }
  if (decodeURIComponent(url.pathname) !== '/atlas_scale_zero') {
    throw new Error('Socket integration test requires dedicated atlas_scale_zero database');
  }
  if (url.search || url.hash) throw new Error('Database URL overrides are forbidden');
  return url.href;
}

export function socketTestNamespace(schema: string, channel: string): void {
  if (!/^atlas_socket_it_[a-f0-9]{32}$/.test(schema))
    throw new Error('Invalid owned socket schema');
  if (channel !== schema.replace('atlas_socket_it_', 'atlas_sock_')) {
    throw new Error('Adapter channel must belong to the isolated test schema');
  }
}

async function run(): Promise<void> {
  const database = socketTestDatabase(process.env.ATLAS_RUNTIME_TEST_DATABASE_URL);
  const schema = process.env.ATLAS_SOCKET_TEST_SCHEMA ?? '';
  const channel = process.env.ATLAS_SOCKET_TEST_CHANNEL ?? '';
  socketTestNamespace(schema, channel);
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Fixture requires Node 24');

  process.env.DATABASE_URL = database;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  process.env.NODE_ENV = 'test';
  process.env.BASE_URL = 'http://127.0.0.1';
  delete process.env.CLOUD_SQL_CONNECTION_NAME;
  const { default: express } = await import('express');
  const { createServer } = await import('node:http');
  const { Server } = await import('socket.io');
  const { createAdapter } = await import('@socket.io/postgres-adapter');
  const { rawPool, transportPool } = await import('../../db/connection.js');
  const actualSchema = (await rawPool.query('SELECT current_schema() AS schema')).rows[0].schema;
  if (actualSchema !== schema) throw new Error(`Unexpected schema ${actualSchema}`);
  if (process.env.ATLAS_SOCKET_TEST_INITIALIZE === '1') {
    const { initDatabase } = await import('../../db/schema.js');
    const { initRuntimeSchema } = await import('../../db/runtimeSchema.js');
    await initDatabase();
    await initRuntimeSchema();
  }

  const { configureSessionRuntime, runSocketOperation } =
    await import('../../services/SessionRuntime.js');
  const { configureSocketExecutor } = await import('../../utils/socketHelpers.js');
  const { installCommittedBroadcasts } = await import('../../socket/committedDelivery.js');
  const { registerSocketHandler } = await import('../../socket/handler.js');
  const { setIO } = await import('../../socket/ioInstance.js');
  const { requireAuth } = await import('../../auth/middleware.js');
  const { default: sessionsRouter } = await import('../../routes/sessions.js');

  const app = express();
  app.use(express.json());
  app.use('/api/sessions', requireAuth, sessionsRouter);
  app.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction
    ) => {
      const failure = error as { status?: number; message?: string };
      console.error('[fixture HTTP]', failure.message);
      res
        .status(failure.status ?? 500)
        .json({ error: failure.message ?? 'Fixture request failed' });
    }
  );
  const http = createServer(app);
  const io = new Server(http, {
    transports: ['websocket'],
    pingInterval: 1_000,
    pingTimeout: 1_000,
  });
  io.adapter(
    createAdapter(transportPool, {
      channelPrefix: channel,
      // Exercise the attachment-table path even for small test broadcasts.
      payloadThreshold: 512,
      heartbeatInterval: 300,
      heartbeatTimeout: 1_500,
      errorHandler: (error) => {
        console.error('[fixture adapter]', error);
        process.send?.({ type: 'adapter-error', error: error.message });
      },
    })
  );
  installCommittedBroadcasts(io);
  configureSessionRuntime(io);
  configureSocketExecutor(runSocketOperation);
  setIO(io);
  registerSocketHandler(io);

  // Test-only discovery proves both real PG adapters can communicate before joins.
  io.on('fixture:peer-probe', (ack: (value: unknown) => void) => ack({ pid: process.pid, schema }));
  process.on('message', (message: unknown) => {
    const request = message as { type?: string; id?: number };
    if (request.type !== 'probe') return;
    io.serverSideEmitWithAck('fixture:peer-probe').then(
      (peers) => process.send?.({ type: 'probe', id: request.id, peers }),
      (error) => process.send?.({ type: 'probe', id: request.id, error: String(error) })
    );
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener');
  process.send?.({
    type: 'ready',
    pid: process.pid,
    node: process.versions.node,
    schema,
    channel,
    url: `http://127.0.0.1:${address.port}`,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    process.send?.({
      type: 'failure',
      error: error instanceof Error ? error.stack : String(error),
    });
    console.error(error);
    process.exit(1);
  });
}
