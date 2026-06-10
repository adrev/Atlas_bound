/**
 * Unknown-`!command` guard — pins the dispatcher behavior that stops a
 * typo'd command from falling through to public chat.
 *
 * Old behavior: `tryHandleChatCommand` returned false for an unknown
 * command and chatEvents persisted + broadcast the raw line room-wide —
 * a silent failure for the player, and a leak vector for the DM
 * (`!gmnotes <secret>` → published to everyone).
 *
 * New contract, pinned here:
 *   • `!` + word-like token with no handler → handled (true), nothing
 *     broadcast publicly, sender gets a private whisper with a
 *     nearest-command suggestion.
 *   • Non-word `!` text ("!!!", "!?") is not a command attempt and
 *     still falls through (false) as ordinary chat.
 *   • Known commands are unaffected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import {
  tryHandleChatCommand,
  registerChatCommand,
  suggestCommand,
} from '../services/ChatCommands.js';
import { createRoom, getAllRooms, addPlayerToRoom, deleteRoom } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

const SESSION = 's-unknown-cmd';

function seedCtx() {
  createRoom(SESSION, 'ROOM-UC', 'dm-user');
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'player-user',
    displayName: 'Pip',
    socketId: 'player-sock',
    role: 'player',
    characterId: null,
  });
  const room = getAllRooms().get(SESSION)!;
  return { room, player: room.players.get('player-user')! };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

// Register a couple of known commands for this test module's registry.
// (Importing ChatCommands directly does NOT pull in the side-effect
// handler imports from chatEvents, so the registry here is ours.)
const seen: string[] = [];
registerChatCommand('fireball', (c) => {
  seen.push(c.rest);
  return true;
});
registerChatCommand('ki', () => true);

describe('unknown !command guard', () => {
  it('suppresses an unknown command and whispers the sender only', async () => {
    const em: Emission[] = [];
    const ctx = seedCtx();
    const handled = await tryHandleChatCommand(fakeIo(em), ctx, '!gmnotes the duke is the traitor');
    expect(handled).toBe(true); // chatEvents will NOT persist/broadcast
    expect(em).toHaveLength(1);
    expect(em[0].channelId).toBe('player-sock'); // whisper to the sender's socket only
    expect(em[0].event).toBe('chat:new-message');
    const msg = em[0].payload as { content: string; whisperTo: string };
    expect(msg.content).toContain('Unknown command `!gmnotes`');
    expect(msg.whisperTo).toBe('player-user');
    expect(mockQuery).not.toHaveBeenCalled(); // nothing persisted
  });

  it('suggests the nearest registered command for a close typo', async () => {
    const em: Emission[] = [];
    const ctx = seedCtx();
    await tryHandleChatCommand(fakeIo(em), ctx, '!firebolt Goblin');
    const msg = em[0].payload as { content: string };
    expect(msg.content).toContain('did you mean `!fireball`?');
  });

  it('omits the suggestion when nothing is close', async () => {
    const em: Emission[] = [];
    const ctx = seedCtx();
    await tryHandleChatCommand(fakeIo(em), ctx, '!zzzzzzqq');
    const msg = em[0].payload as { content: string };
    expect(msg.content).toContain('Unknown command');
    expect(msg.content).not.toContain('did you mean');
  });

  it('lets non-word ! text ("!!!") fall through as ordinary chat', async () => {
    const em: Emission[] = [];
    const ctx = seedCtx();
    expect(await tryHandleChatCommand(fakeIo(em), ctx, '!!!')).toBe(false);
    expect(await tryHandleChatCommand(fakeIo(em), ctx, '!?')).toBe(false);
    expect(em).toHaveLength(0);
  });

  it('does not affect known commands', async () => {
    const em: Emission[] = [];
    const ctx = seedCtx();
    expect(await tryHandleChatCommand(fakeIo(em), ctx, '!fireball Goblin 3')).toBe(true);
    expect(seen).toContain('Goblin 3');
    expect(em).toHaveLength(0); // our stub handler emits nothing
  });
});

describe('suggestCommand', () => {
  it('prefers a unique prefix match', () => {
    expect(suggestCommand('fireb')).toBe('fireball');
  });
  it('tightens the distance budget for very short inputs', () => {
    expect(suggestCommand('kii')).toBe('ki'); // distance 1, allowed
    expect(suggestCommand('xq')).toBeNull(); // distance 2 from 'ki' but max 1 for short input
  });
});
