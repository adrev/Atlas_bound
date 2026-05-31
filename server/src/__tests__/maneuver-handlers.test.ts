import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import type { Combatant, CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({
  default: { query: mockQuery },
}));

import { tryHandleChatCommand } from '../services/ChatCommands.js';
import '../services/chatCommands/maneuverHandlers.js';
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
    characterId: id === 'hero-token' ? 'char-hero' : 'char-target',
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

function combatant(tokenId: string, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId,
    characterId: tokenId === 'hero-token' ? 'char-hero' : 'char-target',
    name: tokenId,
    initiative: 10,
    initiativeBonus: 0,
    hp: 20,
    maxHp: 20,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: tokenId !== 'hero-token',
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

function seedContext(targetOverrides: Partial<Token> = {}): PlayerContext {
  const room = createRoom('maneuver-session', 'MANEUVER', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  const hero = token('hero-token', { name: 'Hero' });
  const target = token('target-token', { name: 'Ogre', ...targetOverrides });
  room.tokens.set(hero.id, hero);
  room.tokens.set(target.id, target);
  const state: CombatState = {
    sessionId: room.sessionId,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [combatant(hero.id), combatant(target.id)],
    startedAt: new Date().toISOString(),
  };
  room.combatState = state;
  room.actionEconomies.set(hero.id, {
    action: false,
    bonusAction: false,
    movementRemaining: 30,
    movementMax: 30,
    reaction: false,
  });
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
    if (String(sql).includes('SELECT inventory')) {
      return { rows: [{ inventory: [] }] };
    }
    if (String(sql).includes('SELECT ability_scores')) {
      const characterId = params?.[0];
      return {
        rows: [{
          name: characterId === 'char-hero' ? 'Hero' : 'Ogre',
          ability_scores: { str: characterId === 'char-hero' ? 18 : 10, dex: 10 },
          skills: { athletics: characterId === 'char-hero' ? 'proficient' : 'none', acrobatics: 'none' },
          proficiency_bonus: 2,
        }],
      };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCharacterRows();
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('grapple and shove chat commands', () => {
  it('spends the current combatant action when a grapple is attempted', async () => {
    const ctx = seedContext();
    const emissions: Emission[] = [];
    const originalRandom = Math.random;
    const rolls = [0.95, 0, 0];
    Math.random = () => rolls.shift() ?? 0;
    try {
      const handled = await tryHandleChatCommand(fakeIo(emissions), ctx, '!grapple Ogre');
      expect(handled).toBe(true);
    } finally {
      Math.random = originalRandom;
    }

    expect(ctx.room.actionEconomies.get('hero-token')?.action).toBe(true);
    const actionUsed = emissions.find((e) => e.event === 'combat:action-used')?.payload as {
      tokenId?: string;
      actionType?: string;
    };
    expect(actionUsed).toMatchObject({ tokenId: 'hero-token', actionType: 'action' });
    expect(ctx.room.tokens.get('target-token')?.conditions).toContain('grappled');
  });

  it('rejects a grapple when the action is already spent', async () => {
    const ctx = seedContext();
    ctx.room.actionEconomies.get('hero-token')!.action = true;
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), ctx, '!grapple Ogre');

    expect(ctx.room.tokens.get('target-token')?.conditions).not.toContain('grappled');
    expect(emissions.some((e) => e.event === 'combat:action-used')).toBe(false);
    const whisper = emissions.find((e) => e.event === 'chat:new-message')?.payload as { content?: string };
    expect(whisper.content).toContain('Action is already spent');
  });

  it('rejects shove targets more than one size larger without spending the action', async () => {
    const ctx = seedContext({ size: 3 });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), ctx, '!shove Ogre prone');

    expect(ctx.room.actionEconomies.get('hero-token')?.action).toBe(false);
    expect(ctx.room.tokens.get('target-token')?.conditions).not.toContain('prone');
    const whisper = emissions.find((e) => e.event === 'chat:new-message')?.payload as { content?: string };
    expect(whisper.content).toContain('too large');
  });

  it('rejects maneuvers against targets outside reach without spending the action', async () => {
    const ctx = seedContext({ x: 700, y: 0 });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), ctx, '!shove Ogre prone');

    expect(ctx.room.actionEconomies.get('hero-token')?.action).toBe(false);
    expect(ctx.room.tokens.get('target-token')?.conditions).not.toContain('prone');
    const whisper = emissions.find((e) => e.event === 'chat:new-message')?.payload as { content?: string };
    expect(whisper.content).toContain('out of reach');
  });

  it('rejects a grapple when equipped weapons and shields occupy both hands', async () => {
    const ctx = seedContext();
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT inventory')) {
        return {
          rows: [{
            inventory: [
              { name: 'Longsword', type: 'weapon', equipped: true },
              { name: 'Shield', type: 'shield', equipped: true },
            ],
          }],
        };
      }
      return { rows: [] };
    });
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), ctx, '!grapple Ogre');

    expect(ctx.room.actionEconomies.get('hero-token')?.action).toBe(false);
    expect(ctx.room.tokens.get('target-token')?.conditions).not.toContain('grappled');
    const whisper = emissions.find((e) => e.event === 'chat:new-message')?.payload as { content?: string };
    expect(whisper.content).toContain('both hands occupied');
  });

  it('rejects a maneuver from an incapacitated caller without spending the action', async () => {
    const ctx = seedContext();
    ctx.room.tokens.get('hero-token')!.conditions = ['stunned'];
    const emissions: Emission[] = [];

    await tryHandleChatCommand(fakeIo(emissions), ctx, '!grapple Ogre');

    expect(ctx.room.actionEconomies.get('hero-token')?.action).toBe(false);
    expect(ctx.room.tokens.get('target-token')?.conditions).not.toContain('grappled');
    const whisper = emissions.find((e) => e.event === 'chat:new-message')?.payload as { content?: string };
    expect(whisper.content).toContain('incapacitated or downed');
  });
});
