import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerSessionEvents } from '../socket/sessionEvents.js';
import { createRoom, deleteRoom, getAllRooms, getRoom } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

type Handler = (data: unknown) => Promise<void> | void;

const SESSION = 'session-join-privacy';
const ROOM_CODE = 'JOINQA';
const DM_USER = 'dm-user';
const ALICE_USER = 'alice-user';
const BOB_USER = 'bob-user';
const CAROL_USER = 'carol-user';

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function driverFor(
  emissions: Emission[],
  socketId: string,
  userId: string,
  displayName: string
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: socketId,
    data: { userId, displayName },
    join: vi.fn(),
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    emit: (event: string, payload: unknown) =>
      emissions.push({ channelId: socketId, event, payload }),
  };
  registerSessionEvents(fakeIo(emissions), socket as never);
  return handlers;
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions
    .filter((e) => e.event === event)
    .map((e) => e.channelId)
    .sort();
}

function payloadsFor<T>(emissions: Emission[], event: string): T[] {
  return emissions.filter((e) => e.event === event).map((e) => e.payload as T);
}

function sessionRow() {
  return {
    id: SESSION,
    name: 'Join QA',
    room_code: ROOM_CODE,
    dm_user_id: DM_USER,
    current_map_id: null,
    player_map_id: null,
    game_mode: 'free-roam',
    settings: '{}',
    visibility: 'public',
    password_hash: null,
    invite_code: 'invite-code',
    discord_webhook_url: 'https://discord.example/webhook',
  };
}

function playerRows() {
  return [
    {
      user_id: DM_USER,
      role: 'dm',
      character_id: null,
      display_name: 'DM',
      avatar_url: null,
    },
    {
      user_id: ALICE_USER,
      role: 'player',
      character_id: null,
      display_name: 'Alice',
      avatar_url: null,
    },
    {
      user_id: BOB_USER,
      role: 'player',
      character_id: null,
      display_name: 'Bob',
      avatar_url: null,
    },
    {
      user_id: CAROL_USER,
      role: 'player',
      character_id: null,
      display_name: 'Carol',
      avatar_url: null,
    },
  ];
}

function chatRow(
  id: string,
  type: string,
  content: string,
  userId: string,
  whisperTo: string | null,
  hidden: number,
  createdAt: string
) {
  return {
    id,
    session_id: SESSION,
    user_id: userId,
    display_name: userId,
    type,
    content,
    character_name: null,
    whisper_to: whisperTo,
    roll_data: null,
    attack_result: null,
    spell_result: null,
    save_result: null,
    action_result: null,
    hidden,
    created_at: createdAt,
  };
}

const CHAT_ROWS = [
  chatRow('public', 'chat', 'public table message', ALICE_USER, null, 0, '2026-06-11T10:00:00Z'),
  chatRow('to-bob', 'whisper', 'alice to bob', ALICE_USER, BOB_USER, 0, '2026-06-11T10:01:00Z'),
  chatRow(
    'to-carol',
    'whisper',
    'alice to carol',
    ALICE_USER,
    CAROL_USER,
    0,
    '2026-06-11T10:02:00Z'
  ),
  chatRow('hidden-roll', 'roll', 'secret dm roll', DM_USER, null, 1, '2026-06-11T10:03:00Z'),
];

function mockJoinQueries(): void {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM sessions WHERE room_code'))
      return Promise.resolve({ rows: [sessionRow()] });
    if (sql.includes('FROM session_players sp')) return Promise.resolve({ rows: playerRows() });
    if (sql.includes('FROM session_bans')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM combat_state')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM characters c')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM chat_messages'))
      return Promise.resolve({ rows: [...CHAT_ROWS].reverse() });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  mockJoinQueries();
});

describe('session:join hydration privacy', () => {
  it('replays paused music state to a late-joining player', async () => {
    const room = createRoom(SESSION, ROOM_CODE, DM_USER);
    room.music = { track: 'Tavern Brawl', fileIndex: 2, action: 'pause' };

    const emissions: Emission[] = [];
    const handlers = driverFor(emissions, 'bob-sock', BOB_USER, 'Bob');

    await handlers.get('session:join')?.({ roomCode: ROOM_CODE });

    expect(getRoom(SESSION)!.music).toEqual({
      track: 'Tavern Brawl',
      fileIndex: 2,
      action: 'pause',
    });
    expect(payloadsFor(emissions, 'session:music-changed')).toEqual([
      { track: 'Tavern Brawl', fileIndex: 2 },
    ]);
    expect(payloadsFor(emissions, 'session:music-action-broadcast')).toEqual([{ action: 'pause' }]);
    expect(channelsFor(emissions, 'session:music-changed')).toEqual(['bob-sock']);
    expect(channelsFor(emissions, 'session:music-action-broadcast')).toEqual(['bob-sock']);
  });

  it('filters player chat history to public rows and their own whispers only', async () => {
    createRoom(SESSION, ROOM_CODE, DM_USER);
    const emissions: Emission[] = [];
    const handlers = driverFor(emissions, 'bob-sock', BOB_USER, 'Bob');

    await handlers.get('session:join')?.({ roomCode: ROOM_CODE });

    const [history] = payloadsFor<Array<{ id: string }>>(emissions, 'chat:history');
    expect(history.map((m) => m.id)).toEqual(['public', 'to-bob']);
  });

  it('lets the DM rehydrate whispers and hidden rolls', async () => {
    createRoom(SESSION, ROOM_CODE, DM_USER);
    const emissions: Emission[] = [];
    const handlers = driverFor(emissions, 'dm-sock', DM_USER, 'DM');

    await handlers.get('session:join')?.({ roomCode: ROOM_CODE });

    const [history] = payloadsFor<Array<{ id: string }>>(emissions, 'chat:history');
    expect(history.map((m) => m.id)).toEqual(['public', 'to-bob', 'to-carol', 'hidden-roll']);
  });
});
