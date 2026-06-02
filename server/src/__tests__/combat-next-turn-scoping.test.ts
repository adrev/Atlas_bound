import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Combatant, CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));
vi.mock('../services/ConditionService.js', () => ({
  tickEndOfTurnConditions: vi.fn().mockResolvedValue({ removed: [], messages: [] }),
  tickStartOfTurnConditions: vi.fn().mockReturnValue({ removed: [], messages: [] }),
}));

import { registerCombatInitiative } from '../socket/combat/initiativeEvents.js';
import { addPlayerToRoom, createRoom, getAllRooms, type RoomState } from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

type Handler = (data: unknown) => Promise<void> | void;

function handlersFor(io: never, socketId: string, emissions: Emission[]): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: socketId,
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    emit: (event: string, payload: unknown) => emissions.push({ channelId: socketId, event, payload }),
  };
  registerCombatInitiative(io, socket as never);
  return handlers;
}

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    mapId: 'map-1',
    characterId: null,
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
    ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function combatant(t: Token, overrides: Partial<Combatant> = {}): Combatant {
  return {
    tokenId: t.id,
    characterId: t.characterId,
    name: t.name,
    initiative: 10,
    initiativeBonus: 0,
    hp: 12,
    maxHp: 12,
    tempHp: 0,
    armorClass: 12,
    speed: 30,
    isNPC: !t.ownerUserId,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    portraitUrl: null,
    ...overrides,
  };
}

const SESSION = 's-next-turn-scope';

function seedRoom(currentTurnIndex = 0): RoomState {
  const room = createRoom(SESSION, 'ROOM-NEXT', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'combat';
  const hero = token('hero-token', {
    name: 'Visible Hero',
    ownerUserId: 'player-user',
    characterId: 'char-hero',
  });
  const hidden = token('hidden-token', {
    name: 'Hidden Wraith',
    visible: false,
  });
  room.tokens.set(hero.id, hero);
  room.tokens.set(hidden.id, hidden);
  room.combatState = {
    sessionId: SESSION,
    active: true,
    roundNumber: 1,
    currentTurnIndex,
    combatants: [combatant(hero, { isNPC: false }), combatant(hidden, { isNPC: true })],
    startedAt: new Date().toISOString(),
  } satisfies CombatState;
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  addPlayerToRoom(SESSION, {
    userId: 'player-user',
    displayName: 'Player',
    socketId: 'player-sock',
    role: 'player',
    characterId: 'char-hero',
  });
  return room;
}

function chatContent(emissions: Emission[], channelId: string): string {
  const payload = emissions.find((e) => e.channelId === channelId && e.event === 'chat:new-message')?.payload as {
    content?: string;
  } | undefined;
  return payload?.content ?? '';
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('combat:next-turn chat visibility scoping', () => {
  it('masks hidden next combatant names and recharge reminders for players', async () => {
    const room = seedRoom(0);
    room.rechargePools.set('hidden-token', new Map([
      ['Necrotic Breath', { min: 1, available: false }],
    ]));
    const emissions: Emission[] = [];
    const h = handlersFor(fakeIo(emissions), 'dm-sock', emissions);

    await h.get('combat:next-turn')!({});

    expect(chatContent(emissions, 'dm-sock')).toContain("Hidden Wraith's turn");
    expect(chatContent(emissions, 'dm-sock')).toContain('Necrotic Breath');
    expect(chatContent(emissions, 'player-sock')).toContain("???'s turn");
    expect(chatContent(emissions, 'player-sock')).not.toContain('Hidden Wraith');
    expect(chatContent(emissions, 'player-sock')).not.toContain('Necrotic Breath');
  });

  it('keeps lair action reminders DM-only on round advance', async () => {
    const room = seedRoom(1);
    room.lairActionTokens.add('hidden-token');
    const emissions: Emission[] = [];
    const h = handlersFor(fakeIo(emissions), 'dm-sock', emissions);

    await h.get('combat:next-turn')!({});

    expect(chatContent(emissions, 'dm-sock')).toContain('LAIR ACTION');
    expect(chatContent(emissions, 'dm-sock')).toContain('Hidden Wraith');
    expect(chatContent(emissions, 'player-sock')).not.toContain('LAIR ACTION');
    expect(chatContent(emissions, 'player-sock')).not.toContain('Hidden Wraith');
    expect(chatContent(emissions, 'player-sock')).toContain("Visible Hero's turn");
  });
});
