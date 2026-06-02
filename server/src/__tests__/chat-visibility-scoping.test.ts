/**
 * Handler-level coverage for chat *visibility* scoping — the two chat
 * paths that are NOT a plain room-wide broadcast:
 *
 *  • `chat:whisper` — a private message routed to exactly three sockets:
 *    the TARGET, the SENDER (echo), and the DM (oversight). Every other
 *    player in the room must NOT receive it. The target must be a real
 *    session member; a whisper to a non-member is dropped with no DB
 *    write and no emit (anti-spoof — see chatEvents.ts).
 *
 *  • `chat:roll` with `hidden:true` — a DM-only blind roll. The `hidden`
 *    flag is a PRIVILEGE: it is honoured only when the sender is the DM.
 *    A non-DM who sends `hidden:true` has it silently downgraded and the
 *    roll broadcasts room-wide like any other — a player cannot make a
 *    roll nobody else can see. We pin both halves of that gate.
 *
 * As a control, one test pins that an ordinary `chat:message` DOES go
 * room-wide, so the scoped paths above read as deliberate exceptions.
 *
 * Drives the real `registerChatEvents` handlers through a fake socket as
 * the relevant actor (DM / sender / would-be spoofer), isolating recipient
 * routing — the only thing under test. Whisper/hidden-roll emit to the
 * sender via `socket.emit` and to others via `io.to(socketId).emit`, so the
 * fake socket and fake io funnel both into one emission list keyed by the
 * channel id (a socket id, or the session id for room-wide).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the DB before importing the handler — chatEvents transitively pulls
// in the chat-command services, which open a pg pool at module load.
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerChatEvents } from '../socket/chatEvents.js';
import {
  createRoom, getAllRooms, addPlayerToRoom, deleteRoom,
} from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }
type Handler = (data: unknown) => Promise<void> | void;

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

/**
 * Register chat handlers against a fake socket for `socketId`; return
 * event→handler. The socket's own `emit` (sender echo / DM-only blind
 * roll) and `io.to(...).emit` both land in `emissions`, the former keyed
 * by the socket id so "who received X" is a single channel-id lookup.
 */
function driverFor(emissions: Emission[], socketId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: socketId,
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    emit: (event: string, payload: unknown) => emissions.push({ channelId: socketId, event, payload }),
  };
  registerChatEvents(fakeIo(emissions), socket as never);
  return handlers;
}

/** Channel ids that received a specific event, sorted for stable compare. */
function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}

const SESSION = 's-chat-vis';

/** DM + three players (sender Alice, target Bob, bystander Carol). */
function seedRoom(): void {
  createRoom(SESSION, 'ROOM-CV', 'dm-user');
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'alice-user', displayName: 'Alice', socketId: 'alice-sock', role: 'player', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'bob-user', displayName: 'Bob', socketId: 'bob-sock', role: 'player', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'carol-user', displayName: 'Carol', socketId: 'carol-sock', role: 'player', characterId: null });
}

beforeEach(() => {
  mockQuery.mockReset();
  // Default: target IS a session member, so the whisper membership SELECT
  // and the follow-up INSERT both resolve non-empty (rows are ignored on
  // the INSERT). Anti-spoof test overrides this with an empty result.
  mockQuery.mockResolvedValue({ rows: [{ ok: 1 }] });
  // deleteRoom also clears per-socket rate-limit counters, so reused socket
  // ids start each test fresh.
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

describe('chat:whisper — recipient scoping', () => {
  it('reaches only the target, the sender, and the DM — never a bystander', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'alice-sock');
    await h.get('chat:whisper')!({ targetUserId: 'bob-user', content: 'pssst' });
    // Alice (sender echo), Bob (target), DM (oversight) — Carol excluded.
    expect(channelsFor(em, 'chat:new-message')).toEqual(['alice-sock', 'bob-sock', 'dm-sock']);
  });

  it('does not double-emit to the DM when the DM is the whisper target', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'alice-sock');
    await h.get('chat:whisper')!({ targetUserId: 'dm-user', content: 'for your ears' });
    // Target (DM) + sender (Alice). The DM-oversight copy is suppressed
    // because the DM already received it as the target.
    expect(channelsFor(em, 'chat:new-message')).toEqual(['alice-sock', 'dm-sock']);
  });

  it('does not double-emit when the DM is the sender', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('chat:whisper')!({ targetUserId: 'bob-user', content: 'a word' });
    // Target (Bob) + sender echo (DM). No extra DM-oversight copy.
    expect(channelsFor(em, 'chat:new-message')).toEqual(['bob-sock', 'dm-sock']);
  });

  it('drops a whisper to a non-member with no emit and no persist (anti-spoof)', async () => {
    const em: Emission[] = [];
    mockQuery.mockResolvedValue({ rows: [] }); // membership SELECT → not a member
    const h = driverFor(em, 'alice-sock');
    await h.get('chat:whisper')!({ targetUserId: 'ghost-user', content: 'leak attempt' });
    expect(em).toHaveLength(0);
    // Exactly one query (the membership SELECT) — the INSERT never ran, so
    // a spoofed whisper can't bloat chat_messages.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('chat:roll — hidden-roll privilege gate', () => {
  it('a DM hidden roll is delivered only to the DM', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('chat:roll')!({ notation: '1d20', hidden: true });
    expect(channelsFor(em, 'chat:roll-result')).toEqual(['dm-sock']);
  });

  it('a non-DM "hidden" roll is downgraded and broadcasts room-wide', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'alice-sock');
    await h.get('chat:roll')!({ notation: '1d20', hidden: true });
    // Privilege gate: a player cannot hide a roll — everyone sees it.
    expect(channelsFor(em, 'chat:roll-result')).toEqual([SESSION]);
  });

  it('an ordinary (non-hidden) roll broadcasts room-wide', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'dm-sock');
    await h.get('chat:roll')!({ notation: '1d20' });
    expect(channelsFor(em, 'chat:roll-result')).toEqual([SESSION]);
  });
});

describe('chat:message — control (room-wide)', () => {
  it('an ordinary message broadcasts to the whole session', async () => {
    const em: Emission[] = [];
    const h = driverFor(em, 'alice-sock');
    await h.get('chat:message')!({ type: 'ooc', content: 'hello table' });
    expect(channelsFor(em, 'chat:new-message')).toEqual([SESSION]);
  });
});
