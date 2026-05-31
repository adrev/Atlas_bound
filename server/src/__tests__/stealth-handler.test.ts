import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import '../services/chatCommands/stealthHandler.js';
import { createRoom, getAllRooms, type PlayerContext } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function fakeIo(emissions: Emission[]): Server {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as unknown as Server;
}

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: id === 'hero-token' ? 'char-hero' : 'char-enemy',
    name: id,
    x: 0,
    y: 0,
    size: 1,
    imageUrl: null,
    color: '#000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    conditions: [],
    ownerUserId: id === 'hero-token' ? 'player-1' : null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function seedContext(): PlayerContext {
  const room = createRoom('stealth-session', 'STEALTH', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  const hero = token('hero-token', { name: 'Hero' });
  const enemy = token('enemy-token', { name: 'Guard' });
  room.tokens.set(hero.id, hero);
  room.tokens.set(enemy.id, enemy);
  return {
    room,
    player: {
      userId: 'player-1',
      displayName: 'Player',
      socketId: 'player-sock',
      role: 'player',
      characterId: 'char-hero',
    },
  };
}

function mockCharacterRows(): void {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes('SELECT ability_scores')) {
      const characterId = params?.[0];
      return {
        rows: [{
          name: characterId === 'char-hero' ? 'Hero' : 'Guard',
          ability_scores: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 },
          skills: { stealth: 'proficient' },
          proficiency_bonus: 2,
          inventory: [
            { name: 'Scale Mail', type: 'armor', equipped: true },
          ],
        }],
      };
    }
    if (text.includes('SELECT senses')) {
      return { rows: [{ senses: { passivePerception: 12 } }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCharacterRows();
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('stealth chat command', () => {
  it('applies armor-imposed stealth disadvantage from equipped inventory', async () => {
    const ctx = seedContext();
    const emissions: Emission[] = [];
    const originalRandom = Math.random;
    const rolls = [0.95, 0.05];
    Math.random = () => rolls.shift() ?? 0;
    try {
      const handled = await tryHandleChatCommand(fakeIo(emissions), ctx, '!stealth');
      expect(handled).toBe(true);
    } finally {
      Math.random = originalRandom;
    }

    const broadcast = emissions.find((e) => e.channelId === ctx.room.sessionId && e.event === 'chat:new-message')?.payload as {
      content?: string;
      actionResult?: { notes?: string[] };
    };
    expect(broadcast.content).toContain('d20=20/2 keep 2+4=6');
    expect(broadcast.content).toContain('armor disadvantage');
    expect(broadcast.actionResult?.notes).toContain('Armor imposes disadvantage on Stealth');

    const whisper = emissions.find((e) => e.channelId === ctx.player.socketId && e.event === 'chat:new-message')?.payload as {
      content?: string;
    };
    expect(whisper.content).toContain('Seen by: Guard (PP 12)');
  });
});
