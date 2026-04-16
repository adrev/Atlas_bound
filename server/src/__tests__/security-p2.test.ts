/* eslint-disable @typescript-eslint/no-explicit-any */
// Test mocks use `any` for hoisted vi helpers and handler shims.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock for the DB pool. Hoisted so vi.mock can see it.
// ---------------------------------------------------------------------------
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery, connect: vi.fn() },
}));

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// P2.9: Room code generator
// ---------------------------------------------------------------------------
describe('generateRoomCode', () => {
  it('returns an 8-char string from the expected alphabet', async () => {
    const { generateRoomCode } = await import('../routes/sessions.js');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(8);
      for (const ch of code) {
        expect(alphabet.includes(ch)).toBe(true);
      }
    }
  });

  it('produces variety (non-deterministic)', async () => {
    const { generateRoomCode } = await import('../routes/sessions.js');
    const set = new Set<string>();
    for (let i = 0; i < 20; i++) set.add(generateRoomCode());
    // 40 bits of entropy — collisions in 20 samples are astronomically unlikely.
    expect(set.size).toBeGreaterThan(15);
  });
});

// ---------------------------------------------------------------------------
// P2.8: DDB proxy-image behavior
// ---------------------------------------------------------------------------
describe('proxy-image endpoint', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  async function callProxy(url: string) {
    // Build a minimal express app on demand so fetch is already mocked.
    const { default: express } = await import('express');
    const dndbeyondRouter = (await import('../routes/dndbeyond.js')).default;
    const app = express();
    app.use((req, _res, next) => { (req as any).user = { id: 'u1' }; next(); });
    app.use('/api/dndbeyond', dndbeyondRouter);

    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address();
          if (!addr || typeof addr === 'string') throw new Error('no addr');
          const resp = await originalFetch(
            `http://127.0.0.1:${addr.port}/api/dndbeyond/proxy-image?url=${encodeURIComponent(url)}`,
          );
          const text = await resp.text();
          let body: any;
          try { body = JSON.parse(text); } catch { body = text; }
          resolve({ status: resp.status, body });
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
  }

  function mockUpstream(response: Response) {
    globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
  }

  it('rejects an SVG content-type with 403', async () => {
    const body = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    mockUpstream(new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
    const res = await callProxy('https://www.dndbeyond.com/evil.svg');
    expect(res.status).toBe(403);
    expect(res.body?.error).toMatch(/SVG/);
  });

  it('rejects image/svg (no +xml) variant with 403', async () => {
    mockUpstream(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/svg' } }));
    const res = await callProxy('https://www.dndbeyond.com/evil.svg');
    expect(res.status).toBe(403);
  });

  it('rejects responses whose content-length exceeds the 5MB cap', async () => {
    const huge = (6 * 1024 * 1024).toString();
    mockUpstream(new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': huge },
    }));
    const res = await callProxy('https://www.dndbeyond.com/big.png');
    expect(res.status).toBe(413);
  });

  it('rejects streamed bodies that exceed the 5MB cap even without content-length', async () => {
    // Produce a body that reads more than 5MB over multiple chunks.
    const chunkSize = 1024 * 1024; // 1MB
    const chunk = new Uint8Array(chunkSize);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 7) { controller.close(); return; }
        emitted++;
        controller.enqueue(chunk);
      },
    });
    mockUpstream(new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }));
    const res = await callProxy('https://www.dndbeyond.com/stream.png');
    expect(res.status).toBe(413);
  });

  it('passes through a normal PNG', async () => {
    const payload = new Uint8Array(Buffer.from('fake-png-bytes'));
    mockUpstream(new Response(payload, { status: 200, headers: { 'content-type': 'image/png' } }));
    const res = await callProxy('https://www.dndbeyond.com/ok.png');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// P2.10: kick handler behavior
// ---------------------------------------------------------------------------
describe('session:kick handler', () => {
  let registerSessionEvents: typeof import('../socket/sessionEvents.js').registerSessionEvents;
  let roomState: typeof import('../utils/roomState.js');

  beforeEach(async () => {
    vi.resetModules();
    mockQuery.mockReset();
    ({ registerSessionEvents } = await import('../socket/sessionEvents.js'));
    roomState = await import('../utils/roomState.js');
  });

  function setupHandler(dmSocketId: string, sessionId: string, roomCode: string) {
    const handlers = new Map<string, (data: unknown) => Promise<void> | void>();
    const io: any = {
      to: () => ({ emit: vi.fn() }),
      sockets: { sockets: new Map() },
    };
    const socket: any = {
      id: dmSocketId,
      data: {},
      emit: vi.fn(),
      on: (name: string, cb: (data: unknown) => Promise<void> | void) => {
        handlers.set(name, cb);
      },
      to: () => ({ emit: vi.fn() }),
    };

    registerSessionEvents(io, socket);

    // Seed the room with a DM (us) so getPlayerBySocketId works.
    roomState.createRoom(sessionId, roomCode, '11111111-1111-1111-1111-111111111111');
    roomState.addPlayerToRoom(sessionId, {
      userId: '11111111-1111-1111-1111-111111111111',
      displayName: 'DM',
      socketId: dmSocketId,
      role: 'dm',
      characterId: null,
    });
    return { handlers, io };
  }

  it('rejects kicking yourself (no DELETE issued)', async () => {
    const { handlers } = setupHandler('sock-dm', 'sess-1', 'ROOM1234');
    const kick = handlers.get('session:kick')!;
    await kick({ targetUserId: '11111111-1111-1111-1111-111111111111' });
    // No DB writes should have happened.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a co-DM kicking another co-DM (owner must demote first)', async () => {
    // With co-DMs, the hierarchy is explicit: one DM cannot kick their
    // peer \u2014 the owner has to demote them before they can be kicked.
    // The handler issues ONE combined role+owner lookup, sees role=dm
    // on someone who isn't the session owner, and bails without a DELETE.
    const { handlers } = setupHandler('sock-dm', 'sess-2', 'ROOM5678');
    roomState.addPlayerToRoom('sess-2', {
      userId: '22222222-2222-2222-2222-222222222222',
      displayName: 'Other DM',
      socketId: 'sock-dm2',
      role: 'dm',
      characterId: null,
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: 'dm', dm_user_id: '99999999-9999-9999-9999-999999999999' }],
    });

    const kick = handlers.get('session:kick')!;
    await kick({ targetUserId: '22222222-2222-2222-2222-222222222222' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls.every(c => !/DELETE/i.test(c[0] as string))).toBe(true);
  });

  it('rejects kicking the session owner', async () => {
    const { handlers } = setupHandler('sock-dm', 'sess-2b', 'ROOM9999');
    const ownerId = '77777777-7777-7777-7777-777777777777';
    roomState.addPlayerToRoom('sess-2b', {
      userId: ownerId,
      displayName: 'Owner',
      socketId: 'sock-owner',
      role: 'dm',
      characterId: null,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'dm', dm_user_id: ownerId }] });

    const kick = handlers.get('session:kick')!;
    await kick({ targetUserId: ownerId });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls.every(c => !/DELETE/i.test(c[0] as string))).toBe(true);
  });

  it('deletes the session_players row when kicking a regular player', async () => {
    const { handlers } = setupHandler('sock-dm', 'sess-3', 'ROOMABCD');
    roomState.addPlayerToRoom('sess-3', {
      userId: '33333333-3333-3333-3333-333333333333',
      displayName: 'Alice',
      socketId: 'sock-p1',
      role: 'player',
      characterId: null,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'player' }] }) // role lookup
      .mockResolvedValueOnce({ rows: [] }); // DELETE

    const kick = handlers.get('session:kick')!;
    await kick({ targetUserId: '33333333-3333-3333-3333-333333333333' });

    // The last call should be the DELETE.
    const calls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(calls.some(sql => /DELETE\s+FROM\s+session_players/i.test(sql))).toBe(true);
  });
});
