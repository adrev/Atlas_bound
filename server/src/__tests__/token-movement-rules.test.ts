import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import type { CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerTokenEvents } from '../socket/tokenEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function makeHarness(actorSocketId: string) {
  const handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const emissions: Emission[] = [];
  const record = (channelId: string) => ({
    emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
  });
  const io = { to: record } as unknown as Server;
  const socket = {
    id: actorSocketId,
    on: (event: string, handler: (d: unknown) => Promise<void> | void) => { handlers[event] = handler; },
    emit: (event: string, payload: unknown) => emissions.push({ channelId: actorSocketId, event, payload }),
    join: () => {},
    to: record,
  } as unknown as Socket;
  return { io, socket, handlers, emissions };
}

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: id === 'hero-token' ? 'char-hero' : null,
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
    ownerUserId: id === 'hero-token' ? 'player-user' : null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function seedCombatRoom(sessionId: string, overrides: Partial<Token> = {}) {
  const room = createRoom(sessionId, sessionId.toUpperCase(), 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.mapGridSizes.set('map-1', 70);
  const hero = token('hero-token', { name: 'Hero', ...overrides });
  room.tokens.set(hero.id, hero);
  room.combatState = {
    sessionId,
    active: true,
    roundNumber: 1,
    currentTurnIndex: 0,
    combatants: [{
      tokenId: hero.id,
      characterId: hero.characterId,
      name: hero.name,
      initiative: 15,
      initiativeBonus: 0,
      hp: 20,
      maxHp: 20,
      tempHp: 0,
      armorClass: 14,
      speed: 30,
      isNPC: false,
      conditions: [],
      deathSaves: { successes: 0, failures: 0 },
      portraitUrl: null,
    }],
    startedAt: new Date().toISOString(),
  } satisfies CombatState;
  room.actionEconomies.set(hero.id, {
    action: false,
    bonusAction: false,
    movementRemaining: 30,
    movementMax: 30,
    reaction: false,
  });
  addPlayerToRoom(sessionId, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: `dm-${sessionId}`,
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(sessionId, {
    userId: 'player-user',
    displayName: 'Player',
    socketId: `player-${sessionId}`,
    role: 'player',
    characterId: 'char-hero',
  });
  return room;
}

function events(emissions: Emission[], event: string): Emission[] {
  return emissions.filter((e) => e.event === event);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('server movement rules', () => {
  it('rejects player combat movement that exceeds remaining speed', async () => {
    const sessionId = 'move-limit';
    const room = seedCombatRoom(sessionId);
    const { io, socket, handlers, emissions } = makeHarness(`player-${sessionId}`);
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'hero-token', x: 490, y: 0 });

    expect(room.tokens.get('hero-token')).toMatchObject({ x: 0, y: 0 });
    expect(events(emissions, 'map:token-moved')).toEqual([
      expect.objectContaining({
        channelId: `player-${sessionId}`,
        payload: expect.objectContaining({ tokenId: 'hero-token', x: 0, y: 0 }),
      }),
    ]);
    const whisper = events(emissions, 'chat:new-message')[0]?.payload as { content?: string };
    expect(whisper.content).toContain('tried to move 35 ft but only 30 ft remain');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE tokens'), expect.anything());
  });

  it('spends movement server-side when a player moves the current combatant', async () => {
    const sessionId = 'move-spend';
    const room = seedCombatRoom(sessionId);
    const { io, socket, handlers, emissions } = makeHarness(`player-${sessionId}`);
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'hero-token', x: 210, y: 210 });

    expect(room.tokens.get('hero-token')).toMatchObject({ x: 210, y: 210 });
    expect(room.actionEconomies.get('hero-token')?.movementRemaining).toBe(15);
    expect(events(emissions, 'combat:movement-used').map((e) => e.channelId).sort()).toEqual([
      `dm-${sessionId}`,
      `player-${sessionId}`,
    ]);
    for (const event of events(emissions, 'combat:movement-used')) {
      expect(event.payload).toEqual({ tokenId: 'hero-token', remaining: 15 });
    }
    expect(events(emissions, 'map:token-moved').map((e) => e.channelId).sort()).toEqual([
      `dm-${sessionId}`,
      `player-${sessionId}`,
    ]);
  });

  it('does not leak hidden combat movement spend to uninvolved players', async () => {
    const sessionId = 'move-hidden-spend';
    seedCombatRoom(sessionId, { visible: false });
    addPlayerToRoom(sessionId, {
      userId: 'bystander-user',
      displayName: 'Bystander',
      socketId: `bystander-${sessionId}`,
      role: 'player',
      characterId: null,
    });
    const { io, socket, handlers, emissions } = makeHarness(`dm-${sessionId}`);
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'hero-token', x: 210, y: 210 });

    expect(events(emissions, 'combat:movement-used').map((e) => e.channelId).sort()).toEqual([
      `dm-${sessionId}`,
      `player-${sessionId}`,
    ]);
  });

  it('rejects player movement when it is not that token turn', async () => {
    const sessionId = 'move-turn';
    const room = seedCombatRoom(sessionId);
    room.combatState!.combatants.unshift({
      ...room.combatState!.combatants[0],
      tokenId: 'other-token',
      characterId: null,
      name: 'Other',
      isNPC: true,
    });
    room.combatState!.currentTurnIndex = 0;
    const { io, socket, handlers, emissions } = makeHarness(`player-${sessionId}`);
    registerTokenEvents(io, socket);

    await handlers['map:token-move']!({ tokenId: 'hero-token', x: 70, y: 0 });

    expect(room.tokens.get('hero-token')).toMatchObject({ x: 0, y: 0 });
    const whisper = events(emissions, 'chat:new-message')[0]?.payload as { content?: string };
    expect(whisper.content).toContain('not that token');
    expect(events(emissions, 'combat:movement-used')).toHaveLength(0);
  });
});
