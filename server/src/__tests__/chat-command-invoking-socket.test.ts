import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/connection.js', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import {
  registerChatCommand,
  tryHandleChatCommand,
  whisperToCaller,
} from '../services/ChatCommands.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
  type PlayerContext,
} from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 's-command-invoking-socket';

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function seedTwoTabs(): void {
  createRoom(SESSION, 'ROOM-TABS', 'user-1');
  addPlayerToRoom(SESSION, {
    userId: 'user-1',
    displayName: 'Rook',
    socketId: 'older-tab',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'user-1',
    displayName: 'Rook',
    socketId: 'newer-tab',
    role: 'dm',
    characterId: null,
  });
}

function channelsFor(emissions: Emission[]): string[] {
  return emissions
    .filter((emission) => emission.event === 'chat:new-message')
    .map((emission) => emission.channelId);
}

beforeEach(() => {
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedTwoTabs();
});

describe('chat-command invoking socket', () => {
  it('preserves the exact socket that resolved a multi-tab player context', () => {
    expect(getPlayerBySocketId('older-tab')?.socketId).toBe('older-tab');
    expect(getPlayerBySocketId('newer-tab')?.socketId).toBe('newer-tab');
    expect(getPlayerBySocketId('older-tab')?.player.socketId).toBe('newer-tab');
  });

  it('returns an unknown-command whisper to the older tab that issued it', async () => {
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions),
      getPlayerBySocketId('older-tab')!,
      '!definitelynotacommand'
    );

    expect(channelsFor(emissions)).toEqual(['older-tab']);
  });

  it('returns handler failures to the tab that issued the command', async () => {
    registerChatCommand('codex-tab-error', () => {
      throw new Error('expected failure');
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(
      fakeIo(emissions),
      getPlayerBySocketId('older-tab')!,
      '!codex-tab-error'
    );

    expect(channelsFor(emissions)).toEqual(['older-tab']);
    expect(String((emissions[0].payload as { content?: string }).content)).toContain(
      'expected failure'
    );
  });

  it('keeps the primary-socket fallback for manually constructed legacy contexts', () => {
    const resolved = getPlayerBySocketId('older-tab')!;
    const legacyContext: PlayerContext = { room: resolved.room, player: resolved.player };
    const emissions: Emission[] = [];

    whisperToCaller(fakeIo(emissions), legacyContext, 'legacy');

    expect(channelsFor(emissions)).toEqual(['newer-tab']);
  });
});
