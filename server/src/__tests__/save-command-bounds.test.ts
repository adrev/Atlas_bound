import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import {
  addPlayerToRoom,
  createRoom,
  deleteRoom,
  getAllRooms,
  getPlayerBySocketId,
} from '../utils/roomState.js';
import '../services/chatCommands/saveHandler.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

const SESSION = 'save-bounds-session';

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function seedRoom(): void {
  const room = createRoom(SESSION, 'SAVE', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-1',
    role: 'dm',
    characterId: null,
  });
}

function whispers(emissions: Emission[]): string[] {
  return emissions
    .filter(
      (emission) =>
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'whisper'
    )
    .map((emission) => (emission.payload as { content: string }).content);
}

function publicMessages(emissions: Emission[]): Array<Record<string, unknown>> {
  return emissions
    .filter(
      (emission) =>
        emission.channelId === SESSION &&
        emission.event === 'chat:new-message' &&
        (emission.payload as { type?: string }).type === 'system'
    )
    .map((emission) => emission.payload as Record<string, unknown>);
}

async function run(command: string, emissions: Emission[]): Promise<void> {
  await tryHandleChatCommand(fakeIo(emissions), getPlayerBySocketId('dm-1')!, command);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
  seedRoom();
});

describe('save command resource bounds', () => {
  it.each([
    '!save dex 10junk 1d6/fire Goblin',
    '!save dex 0 1d6/fire Goblin',
    '!save dex 41 1d6/fire Goblin',
    '!save dex 10 0d6/fire Goblin',
    '!save dex 10 101d6/fire Goblin',
    '!save dex 10 1d1/fire Goblin',
    '!save dex 10 1d101/fire Goblin',
    '!save dex 10 100d100/fire Goblin',
    '!save dex 10 1d6+9999/fire Goblin',
    '!save dex 10 999999999999999999999d6/fire Goblin',
  ])('rejects unsafe numeric input before rolling or querying: %s', async (command) => {
    const random = vi.spyOn(Math, 'random');
    const emissions: Emission[] = [];
    await run(command, emissions);
    expect(random).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(publicMessages(emissions)).toEqual([]);
    expect(whispers(emissions)).toHaveLength(1);
  });

  it.each(['!save dex 10 1d6/happiness Goblin', '!save dex 10 1d6/ Goblin'])(
    'rejects unknown or missing explicit damage types: %s',
    async (command) => {
      const random = vi.spyOn(Math, 'random');
      const emissions: Emission[] = [];
      await run(command, emissions);
      expect(random).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(publicMessages(emissions)).toEqual([]);
      expect(whispers(emissions)).toHaveLength(1);
    }
  );

  it('caps target fanout before rolling', async () => {
    const targets = Array.from({ length: 51 }, (_, index) => `Target${index}`).join(' ');
    const random = vi.spyOn(Math, 'random');
    const emissions: Emission[] = [];
    await run(`!save dex 10 1d6/fire ${targets}`, emissions);
    expect(random).not.toHaveBeenCalled();
    expect(whispers(emissions)[0]).toContain('at most 50');
  });

  it('rejects duplicate targets so one token cannot take the same roll twice', async () => {
    const random = vi.spyOn(Math, 'random');
    const emissions: Emission[] = [];
    await run('!save dex 10 1d6/fire Goblin goblin', emissions);
    expect(random).not.toHaveBeenCalled();
    expect(whispers(emissions)[0]).toContain('duplicate');
  });

  it('still accepts bounded official damage types and untyped rolls', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const typed: Emission[] = [];
    await run('!save dex 10 40d6/fire Missing', typed);
    expect(random).toHaveBeenCalledTimes(40);
    expect(publicMessages(typed)).toHaveLength(1);

    random.mockClear();
    const untyped: Emission[] = [];
    await run('!save dex 10 1d20 Missing', untyped);
    expect(random).toHaveBeenCalledTimes(1);
    expect(publicMessages(untyped)).toHaveLength(1);
  });
});
