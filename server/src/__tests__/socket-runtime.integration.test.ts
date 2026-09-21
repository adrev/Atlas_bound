import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { socketTestDatabase, socketTestNamespace } from './fixtures/socket-runtime-process.js';

// Opt-in only. No fallback to DATABASE_URL or application/production credentials.
const configured = process.env.ATLAS_RUNTIME_TEST_DATABASE_URL;
const database = configured ? socketTestDatabase(configured) : undefined;
const schema = `atlas_socket_it_${randomUUID().replaceAll('-', '')}`;
const channel = schema.replace('atlas_socket_it_', 'atlas_sock_');
const fixture = fileURLToPath(new URL('./fixtures/socket-runtime-process.ts', import.meta.url));
type Payload = Record<string, any>; // Socket payloads are deliberately untyped in the production registrar.
interface Worker {
  child: ChildProcess;
  url: string;
  messages: Payload[];
  logs: string;
}
interface Client {
  socket: Socket;
  messages: Array<{ kind: string; body: Payload }>;
  event: (kind: string, predicate?: (body: Payload) => boolean, after?: number) => Promise<Payload>;
}
interface Session {
  id: string;
  room: string;
  dm: string;
  player: string;
  dmCookie: string;
  playerCookie: string;
  map: string;
  preview: string;
  hidden: string;
  prepToken: string;
  zone: string;
}

let admin: Pool | undefined;
let sql: Pool;
let created = false;
let first: Worker;
let second: Worker;
const workers = new Set<Worker>();
const clients = new Set<Client>();
let sequence = 0;

async function until<T>(
  read: () => T | Promise<T>,
  label: string,
  timeout = 6_000
): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await delay(25);
  }
  throw new Error(
    `${label}\n${[...workers].map((w) => `child ${w.child.pid}: ${w.logs.slice(-6_000)}`).join('\n')}`
  );
}

async function launch(initialize = false): Promise<Worker> {
  const child = fork(fixture, [], {
    execPath: process.execPath,
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ATLAS_RUNTIME_TEST_DATABASE_URL: database,
      ATLAS_SOCKET_TEST_SCHEMA: schema,
      ATLAS_SOCKET_TEST_CHANNEL: channel,
      ATLAS_SOCKET_TEST_INITIALIZE: initialize ? '1' : '0',
    },
  });
  const worker: Worker = { child, url: '', messages: [], logs: '' };
  workers.add(worker);
  child.stdout?.on('data', (data) => {
    worker.logs = (worker.logs + data).slice(-30_000);
  });
  child.stderr?.on('data', (data) => {
    worker.logs = (worker.logs + data).slice(-30_000);
  });
  child.on('message', (message) => worker.messages.push(message as Payload));
  child.on('error', (error) => {
    worker.logs += error.stack;
  });
  const ready = await until(
    () => {
      const failure = worker.messages.find((m) => m.type === 'failure');
      if (failure) throw new Error(failure.error);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(worker.logs);
      return worker.messages.find((m) => m.type === 'ready');
    },
    'Child did not start',
    30_000
  );
  expect(ready).toMatchObject({ schema, channel, pid: child.pid });
  expect(ready.node).toMatch(/^24\./);
  worker.url = ready.url;
  return worker;
}

async function kill(worker: Worker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const closed = new Promise<void>((done) => worker.child.once('exit', () => done()));
  worker.child.kill('SIGKILL');
  await closed;
}

async function peersReady(worker: Worker): Promise<void> {
  await until(
    async () => {
      const id = ++sequence;
      worker.child.send({ type: 'probe', id });
      const result = await until(
        () => worker.messages.find((m) => m.type === 'probe' && m.id === id),
        'Missing adapter probe'
      );
      return result.peers?.some(
        (peer: Payload) => peer.schema === schema && peer.pid !== worker.child.pid
      );
    },
    'PG adapters did not discover their peer',
    10_000
  );
}

async function connect(worker: Worker, cookie: string): Promise<Client> {
  const socket = io(worker.url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    autoConnect: false,
    extraHeaders: { Cookie: cookie },
  });
  const messages: Client['messages'] = [];
  socket.onAny((kind, body) => messages.push({ kind, body }));
  const client: Client = {
    socket,
    messages,
    event: (kind, predicate = () => true, after = 0) =>
      until(
        () => {
          const error = messages.slice(after).find((m) => m.kind === 'session:error');
          if (error && kind !== 'session:error')
            throw new Error(`Socket error awaiting ${kind}: ${JSON.stringify(error.body)}`);
          return messages.slice(after).find((m) => m.kind === kind && predicate(m.body))?.body;
        },
        `Missing ${kind}; received ${messages.map((m) => m.kind).join(', ')}`
      ),
  };
  clients.add(client);
  const connected = new Promise<void>((done, reject) => {
    socket.once('connect', done);
    socket.once('connect_error', reject);
  });
  socket.connect();
  await connected;
  return client;
}

async function seed(): Promise<Session> {
  const s: Session = {
    id: randomUUID(),
    room: randomUUID().replaceAll('-', '').slice(0, 8),
    dm: randomUUID(),
    player: randomUUID(),
    dmCookie: '',
    playerCookie: '',
    map: randomUUID(),
    preview: randomUUID(),
    hidden: randomUUID(),
    prepToken: randomUUID(),
    zone: randomUUID(),
  };
  for (const [user, label] of [
    [s.dm, 'Fixture DM'],
    [s.player, 'Fixture Player'],
  ]) {
    const auth = randomUUID();
    await sql.query('INSERT INTO auth_users (id, display_name) VALUES ($1, $2)', [user, label]);
    await sql.query('INSERT INTO users (id, display_name, auth_user_id) VALUES ($1, $2, $1)', [
      user,
      label,
    ]);
    await sql.query(
      "INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')",
      [auth, user]
    );
    if (user === s.dm) s.dmCookie = `auth_session=${auth}`;
    else s.playerCookie = `auth_session=${auth}`;
  }
  await sql.query(
    `INSERT INTO sessions (id, name, room_code, dm_user_id, current_map_id, player_map_id,
    settings, invite_code, discord_webhook_url) VALUES ($1, 'Socket smoke', $2, $3, $4, $4, $5, $1, 'fixture-private-webhook')`,
    [
      s.id,
      s.room,
      s.dm,
      s.map,
      JSON.stringify({ showCreatureStatsToPlayers: false, showPlayersToPlayers: false }),
    ]
  );
  await sql.query(
    "INSERT INTO session_players (session_id, user_id, role) VALUES ($1, $2, 'dm'), ($1, $3, 'player')",
    [s.id, s.dm, s.player]
  );
  await sql.query(
    "INSERT INTO maps (id, session_id, name) VALUES ($1, $3, 'Ribbon'), ($2, $3, 'DM prep')",
    [s.map, s.preview, s.id]
  );
  await sql.query(
    `INSERT INTO tokens (id, map_id, name, visible, x, y) VALUES
    ($1, $2, 'Hidden monster', 0, 35, 35), ($3, $4, 'Secret prep monster', 1, 35, 35)`,
    [s.hidden, s.map, s.prepToken, s.preview]
  );
  await sql.query(
    "INSERT INTO map_zones (id, map_id, name, x, y, width, height) VALUES ($1, $2, 'Secret ambush', 0, 0, 70, 70)",
    [s.zone, s.map]
  );
  return s;
}

async function join(client: Client, s: Session) {
  const after = client.messages.length;
  client.socket.emit('session:join', { roomCode: s.room });
  const state = await client.event('session:state-sync', (body) => body.sessionId === s.id, after);
  const map = await client.event('map:loaded', () => true, after);
  await client.event('chat:history', () => true, after);
  return { state, map };
}

async function pair(s: Session) {
  const dm = await connect(first, s.dmCookie);
  const dmState = await join(dm, s);
  const player = await connect(second, s.playerCookie);
  const playerState = await join(player, s);
  return { dm, player, dmState, playerState };
}

async function addToken(dm: Client, s: Session, name = 'Player hero') {
  const after = dm.messages.length;
  dm.socket.emit('map:token-add', { mapId: s.map, name, x: 35, y: 35, ownerUserId: s.player });
  return dm.event('map:token-added', (body) => body.name === name, after);
}

async function rest(worker: Worker, s: Session, cookie: string, suffix = 'state') {
  const response = await fetch(`${worker.url}/api/sessions/${s.id}/${suffix}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(8_000),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Payload>;
}

describe('socket runtime fixture safety', () => {
  it.each([
    'postgres://postgres@example.com/atlas_scale_zero',
    'postgres://postgres@127.0.0.1/production',
    'postgres://postgres@127.0.0.1/production_atlas_scale_zero',
    'postgres://postgres@127.0.0.1/atlas_scale_zero?host=example.com',
    'postgres://postgres@127.0.0.1/atlas_scale_zero?options=-csearch_path=public',
  ])('rejects unsafe target %s before creating a pool', (value) =>
    expect(() => socketTestDatabase(value)).toThrow()
  );

  it('requires a unique owned schema/channel pair', () => {
    expect(() => socketTestNamespace(schema, channel)).not.toThrow();
    expect(() => socketTestNamespace('public', channel)).toThrow();
    expect(() => socketTestNamespace(schema, 'socket.io')).toThrow();
  });
});

describe.skipIf(!database)('two-process Socket.IO runtime against real local PostgreSQL', () => {
  beforeAll(async () => {
    if (Number(process.versions.node.split('.')[0]) !== 24)
      throw new Error('Run smoke with Node 24');
    admin = new Pool({ connectionString: database, options: '-c search_path=public' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    sql = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
    expect((await sql.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
    first = await launch(true);
    second = await launch();
    await peersReady(first);
    await peersReady(second);
  }, 60_000);

  afterEach(async () => {
    for (const client of clients) client.socket.disconnect();
    clients.clear();
    // Let committed disconnect handlers settle before the next independent room.
    await delay(150);
  });

  afterAll(async () => {
    for (const client of clients) client.socket.disconnect();
    for (const worker of workers) await kill(worker);
    await sql?.end();
    if (created) await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  }, 20_000);

  it('joins DM/player on separate processes and commits token, movement, music and chat fanout', async () => {
    const s = await seed();
    const { dm, player, dmState, playerState } = await pair(s);
    expect(first.child.pid).not.toBe(second.child.pid);
    expect(playerState.state.generation).toBe(dmState.state.generation);
    expect(playerState.state.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: s.dm, connected: true }),
        expect.objectContaining({ userId: s.player, connected: true }),
      ])
    );
    await dm.event('session:player-presence', (body) => body.userId === s.player);
    const added = await addToken(dm, s);
    await player.event('map:token-added', (body) => body.id === added.id);
    expect(
      (await sql.query('SELECT map_id, owner_user_id FROM tokens WHERE id = $1', [added.id]))
        .rows[0]
    ).toMatchObject({ map_id: s.map, owner_user_id: s.player });
    const after = dm.messages.length;
    player.socket.emit('map:token-move', {
      tokenId: added.id,
      x: 105,
      y: 35,
      expectedVersion: added.version,
    });
    const moved = await dm.event(
      'map:token-moved',
      (body) => body.tokenId === added.id && body.x === 105,
      after
    );
    expect(moved._eventId).toBeGreaterThan(added._eventId);
    expect(
      (await sql.query('SELECT x, version FROM tokens WHERE id = $1', [added.id])).rows[0]
    ).toEqual({ x: 105, version: moved.version });
    dm.socket.emit('session:music-change', { track: 'fixture-battle', fileIndex: 2 });
    await player.event('session:music-changed', (body) => body.track === 'fixture-battle');
    const runtime = (
      await sql.query('SELECT state FROM session_runtime WHERE session_id = $1', [s.id])
    ).rows[0].state;
    expect(runtime.values.music).toMatchObject({ track: 'fixture-battle', fileIndex: 2 });
    player.socket.emit('chat:message', { type: 'ooc', content: 'cross-process committed chat' });
    const chat = await dm.event(
      'chat:new-message',
      (body) => body.content === 'cross-process committed chat'
    );
    expect(
      (await sql.query('SELECT content FROM chat_messages WHERE id = $1', [chat.id])).rows[0]
        .content
    ).toBe(chat.content);
    expect(
      [...workers].flatMap((w) => w.messages).filter((m) => m.type === 'adapter-error')
    ).toEqual([]);
  }, 25_000);

  it('filters hidden tokens, prep-map motion, zones and private session settings across processes and REST', async () => {
    const s = await seed();
    const { dm, player, dmState, playerState } = await pair(s);
    expect(dmState.map.tokens.map((t: Payload) => t.id)).toContain(s.hidden);
    expect(playerState.map.tokens).toEqual([]);
    expect(playerState.map.map.zones).toEqual([]);
    expect(dmState.map.map.zones.map((z: Payload) => z.id)).toContain(s.zone);
    expect(playerState.state.inviteCode).toBeNull();
    expect(playerState.state.settings.discordWebhookUrl).toBeUndefined();
    const mark = player.messages.length;
    dm.socket.emit('map:token-move', { tokenId: s.hidden, x: 105, y: 35 });
    await dm.event('map:token-moved', (body) => body.tokenId === s.hidden);
    dm.socket.emit('map:preview-load', { mapId: s.preview });
    await dm.event('map:loaded', (body) => body.map.id === s.preview);
    dm.socket.emit('map:token-move', { tokenId: s.prepToken, x: 175, y: 35 });
    await dm.event('map:token-moved', (body) => body.tokenId === s.prepToken);
    const playerRest = await rest(first, s, s.playerCookie);
    const dmRest = await rest(second, s, s.dmCookie);
    expect(playerRest.mapId).toBe(s.map);
    expect(playerRest.tokens).toEqual([]);
    expect(dmRest.mapId).toBe(s.preview);
    expect(dmRest.tokens).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: s.prepToken, x: 175 })])
    );
    const events = await rest(
      first,
      s,
      s.playerCookie,
      `events?since=0&generation=${playerRest.generation}`
    );
    expect(events.events).toEqual([]);
    await delay(200);
    expect(
      player.messages.slice(mark).filter((m) => ['map:token-moved', 'map:loaded'].includes(m.kind))
    ).toEqual([]);
  }, 25_000);

  it('keeps another-process tab present and receiving movement when one user tab disconnects', async () => {
    const s = await seed();
    const { dm, player } = await pair(s);
    const otherTab = await connect(first, s.playerCookie);
    await join(otherTab, s);
    const added = await addToken(dm, s);
    await player.event('map:token-added', (body) => body.id === added.id);
    await otherTab.event('map:token-added', (body) => body.id === added.id);
    const mark = dm.messages.length;
    otherTab.socket.disconnect();
    await delay(200);
    player.socket.emit('session:heartbeat', { roomCode: s.room });
    expect(await player.event('session:heartbeat-ack')).toMatchObject({ ok: true });
    const after = player.messages.length;
    dm.socket.emit('map:token-move', { tokenId: added.id, x: 245, y: 35 });
    await player.event(
      'map:token-moved',
      (body) => body.tokenId === added.id && body.x === 245,
      after
    );
    expect(
      dm.messages
        .slice(mark)
        .filter((m) => m.kind === 'session:player-left' && m.body.userId === s.player)
    ).toEqual([]);
    player.socket.disconnect();
    await dm.event('session:player-left', (body) => body.userId === s.player, mark);
  }, 25_000);

  it('never delivers a successful token move when its transaction fails', async () => {
    const s = await seed();
    const { dm, player } = await pair(s);
    const added = await addToken(dm, s);
    await player.event('map:token-added', (body) => body.id === added.id);
    // Fail the final checkpoint AFTER the handler has queued its success emit.
    // This distinguishes committed delivery from merely awaiting the token SQL.
    await sql.query(`CREATE FUNCTION reject_socket_fixture_move() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.session_id = '${s.id}' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$`);
    await sql.query(
      'CREATE TRIGGER reject_socket_fixture_move BEFORE UPDATE ON session_runtime FOR EACH ROW EXECUTE FUNCTION reject_socket_fixture_move()'
    );
    const mark = player.messages.length;
    const dmMark = dm.messages.length;
    try {
      dm.socket.emit('map:token-move', { tokenId: added.id, x: 315, y: 35 });
      await dm.event('session:error', () => true, dmMark);
      await delay(200);
      expect(player.messages.slice(mark).filter((m) => m.kind === 'map:token-moved')).toEqual([]);
      expect((await sql.query('SELECT x FROM tokens WHERE id = $1', [added.id])).rows[0].x).toBe(
        35
      );
    } finally {
      await sql.query('DROP TRIGGER reject_socket_fixture_move ON session_runtime');
      await sql.query('DROP FUNCTION reject_socket_fixture_move()');
    }
    const state = await rest(second, s, s.playerCookie);
    expect(state.tokens.find((t: Payload) => t.id === added.id).x).toBe(35);
  }, 25_000);

  it.each(['without leave', 'queued leave then join'])(
    'switches rooms %s and checkpoints the destination',
    async (mode) => {
      const source = await seed();
      const destination = await seed();
      await sql.query(
        "INSERT INTO session_players (session_id, user_id, role) VALUES ($1, $2, 'player')",
        [destination.id, source.player]
      );
      const { dm: sourceDm, player } = await pair(source);
      const destinationDm = await connect(first, destination.dmCookie);
      await join(destinationDm, destination);
      const token = await addToken(destinationDm, { ...destination, player: source.player });
      destinationDm.socket.emit('session:music-change', { track: 'destination-checkpoint' });
      await destinationDm.event(
        'session:music-changed',
        (body) => body.track === 'destination-checkpoint'
      );
      const saved = (
        await sql.query('SELECT state FROM session_runtime WHERE session_id = $1', [destination.id])
      ).rows[0].state.values;
      const mark = player.messages.length;
      if (mode === 'queued leave then join') player.socket.emit('session:leave', {});
      const joined = await join(player, destination);
      expect(joined.state).toMatchObject({
        sessionId: destination.id,
        generation: saved.generation,
        nextEventId: saved.nextEventId,
      });
      expect(joined.map.map.id).toBe(destination.map);
      await player.event(
        'session:music-changed',
        (body) => body.track === 'destination-checkpoint',
        mark
      );
      player.socket.emit('map:token-move', {
        tokenId: token.id,
        x: 595,
        y: 35,
        expectedVersion: token.version,
      });
      const moved = await destinationDm.event(
        'map:token-moved',
        (body) => body.tokenId === token.id && body.x === 595
      );
      const checkpoint = (
        await sql.query('SELECT state FROM session_runtime WHERE session_id = $1', [destination.id])
      ).rows[0].state.values;
      expect(checkpoint.nextEventId).toBe(moved._eventId);
      expect(checkpoint.generation).toBe(saved.generation);
      sourceDm.socket.emit('session:music-change', { track: 'source-only-music' });
      await sourceDm.event('session:music-changed', (body) => body.track === 'source-only-music');
      player.socket.emit('chat:message', { type: 'ooc', content: 'destination-only-message' });
      const message = await destinationDm.event(
        'chat:new-message',
        (body) => body.content === 'destination-only-message'
      );
      expect(
        (await sql.query('SELECT session_id FROM chat_messages WHERE id = $1', [message.id]))
          .rows[0].session_id
      ).toBe(destination.id);
      await delay(200);
      expect(
        player.messages
          .slice(mark)
          .filter((m) => m.kind === 'session:music-changed' && m.body.track === 'source-only-music')
      ).toEqual([]);
      expect(
        sourceDm.messages.filter(
          (m) => m.kind === 'chat:new-message' && m.body.content === 'destination-only-message'
        )
      ).toEqual([]);
    },
    25_000
  );

  it('updates surviving clients presence after a remote process dies without disconnect handlers', async () => {
    const s = await seed();
    const { dm, player } = await pair(s);
    const mark = dm.messages.length;
    try {
      await kill(second);
      await until(() => !player.socket.connected, 'Killed player process left transport connected');
      // Exceed the fixture adapter heartbeat timeout, then force a fresh
      // runtime presence scan through an ordinary acknowledged heartbeat.
      await delay(2_000);
      dm.socket.emit('session:heartbeat', { roomCode: s.room });
      expect(await dm.event('session:heartbeat-ack', () => true, mark)).toMatchObject({ ok: true });
      await dm.event('session:player-left', (body) => body.userId === s.player, mark);
    } finally {
      second = await launch();
      await peersReady(first);
      await peersReady(second);
    }
  }, 25_000);

  it('kills a process, cold-hydrates REST on its replacement and rejoins with durable music/cursor/map', async () => {
    const s = await seed();
    const { dm, player } = await pair(s);
    const added = await addToken(dm, s);
    dm.socket.emit('map:token-move', { tokenId: added.id, x: 385, y: 35 });
    const moved = await player.event(
      'map:token-moved',
      (body) => body.tokenId === added.id && body.x === 385
    );
    dm.socket.emit('session:music-change', { track: 'fixture-restart', fileIndex: 1 });
    await player.event('session:music-changed', (body) => body.track === 'fixture-restart');
    dm.socket.emit('session:music-action', { action: 'pause' });
    await player.event('session:music-action-broadcast', (body) => body.action === 'pause');
    const before = await rest(second, s, s.playerCookie);
    const oldPid = first.child.pid;
    await kill(first);
    await until(() => !dm.socket.connected, 'Killed server left socket connected');
    first = await launch();
    expect(first.child.pid).not.toBe(oldPid);
    await peersReady(first);
    // No socket has joined the new process yet. REST must hydrate from SQL.
    const cold = await rest(first, s, s.playerCookie);
    expect(cold.generation).toBe(before.generation);
    expect(cold.nextEventId).toBe(before.nextEventId);
    expect(cold.tokens.find((t: Payload) => t.id === added.id)).toMatchObject({
      x: 385,
      version: moved.version,
    });
    const newDm = await connect(first, s.dmCookie);
    const joined = await join(newDm, s);
    expect(joined.state).toMatchObject({
      generation: before.generation,
      nextEventId: before.nextEventId,
    });
    expect(joined.map.tokens.find((t: Payload) => t.id === added.id).x).toBe(385);
    await newDm.event(
      'session:music-changed',
      (body) => body.track === 'fixture-restart' && body.fileIndex === 1
    );
    await newDm.event('session:music-action-broadcast', (body) => body.action === 'pause');
    const after = newDm.messages.length;
    player.socket.emit('map:token-move', {
      tokenId: added.id,
      x: 455,
      y: 35,
      expectedVersion: moved.version,
    });
    const resumed = await newDm.event(
      'map:token-moved',
      (body) => body.tokenId === added.id && body.x === 455,
      after
    );
    expect(resumed._eventId).toBeGreaterThan(moved._eventId);
    const mismatch = await fetch(
      `${first.url}/api/sessions/${s.id}/events?since=${resumed._eventId + 500}&generation=${cold.generation}`,
      {
        headers: { Cookie: s.playerCookie },
        signal: AbortSignal.timeout(8_000),
      }
    );
    expect(mismatch.status).toBe(410);
  }, 40_000);
});
