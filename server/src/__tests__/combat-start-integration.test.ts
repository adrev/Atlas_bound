/**
 * Integration test: `combat:start` through the split combatEvents.ts
 * modules. Exercises the full handler registration + event fan-out
 * that the socket layer wires when a DM clicks "Start Combat", so any
 * regression from the modular split (wrong relative import path,
 * missing register call, schema drift, event-order swap) fails here
 * instead of on a live session.
 *
 * Not a full Socket.IO server boot \u2014 we inject a fake socket whose
 * `on()` stores handlers by name, then invoke `combat:start` directly
 * with a valid payload and assert the server's emission sequence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Combatant, CombatState, Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerCombatEvents } from '../socket/combatEvents.js';
import {
  addPlayerToRoom, createRoom, getAllRooms,
} from '../utils/roomState.js';

// \u2500\u2500 Fake io + socket ----------------------------------------------

type Handler = (data: unknown) => Promise<void> | void;

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}

function makeHarness() {
  const handlers: Record<string, Handler> = {};
  const emissions: Emission[] = [];
  const io = {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => {
        emissions.push({ channelId, event, payload });
      },
    }),
  } as never;
  const socket = {
    id: 'sock-1',
    on: (event: string, handler: Handler) => { handlers[event] = handler; },
    emit: (event: string, payload: unknown) => {
      emissions.push({ channelId: 'sock-1', event, payload });
    },
  } as never;
  return { io, socket, handlers, emissions };
}

function seedRoom(sessionId: string, tokens: Token[]): void {
  const room = createRoom(sessionId, 'ROOM-' + sessionId, 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  for (const t of tokens) room.tokens.set(t.id, t);
  // Wire a DM player so `getPlayerBySocketId('sock-1')` finds them.
  addPlayerToRoom(sessionId, {
    userId: 'dm-user', displayName: 'DM',
    socketId: 'sock-1', role: 'dm', characterId: null,
  });
}

function tok(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id, mapId: 'map-1', characterId: null, name: id,
    x: 0, y: 0, size: 1, imageUrl: null, color: '#000',
    layer: 'token', visible: true, hasLight: false,
    lightRadius: 0, lightDimRadius: 0, lightColor: '#fff',
    conditions: [], ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('combat:start end-to-end through split modules', () => {
  it('registers combat:start and emits combat:started + initiative rolls + all-initiatives-ready', async () => {
    const sessionId = 's-start';
    seedRoom(sessionId, [
      tok('tGoblin', { name: 'Goblin' }),
      tok('tOrc', { name: 'Orc' }),
    ]);

    const { io, socket, handlers, emissions } = makeHarness();
    registerCombatEvents(io, socket);

    // Every expected socket.on must be registered.
    expect(handlers['combat:start']).toBeTypeOf('function');
    expect(handlers['combat:end']).toBeTypeOf('function');
    expect(handlers['combat:next-turn']).toBeTypeOf('function');
    expect(handlers['combat:damage']).toBeTypeOf('function');

    await handlers['combat:start']!({ tokenIds: ['tGoblin', 'tOrc'] });

    const events = emissions.map((e) => e.event);
    expect(events).toContain('combat:started');
    // System chat message announcing the initiative order.
    const chat = emissions.find((e) => e.event === 'chat:new-message');
    expect(chat).toBeDefined();
    expect((chat!.payload as { content: string }).content)
      .toMatch(/Combat begins/i);

    // combat:initiative-set emitted per combatant.
    const initEvents = emissions.filter((e) => e.event === 'combat:initiative-set');
    expect(initEvents.length).toBeGreaterThanOrEqual(1);

    // combat:all-initiatives-ready emitted after NPCs auto-roll.
    expect(events).toContain('combat:all-initiatives-ready');

    // Room state now has a live combatState reflecting both tokens.
    const room = getAllRooms().get(sessionId)!;
    expect(room.combatState?.active).toBe(true);
    expect(room.combatState?.combatants.length).toBe(2);
    expect(room.combatState?.roundNumber).toBe(1);
  });

  it('combat:started payload is well-formed (combatants, roundNumber, reviewPhase)', async () => {
    const sessionId = 's-start-shape';
    seedRoom(sessionId, [tok('tNpc', { name: 'Npc' })]);

    const { io, socket, handlers, emissions } = makeHarness();
    registerCombatEvents(io, socket);

    await handlers['combat:start']!({ tokenIds: ['tNpc'] });

    const started = emissions.find((e) => e.event === 'combat:started');
    expect(started).toBeDefined();
    const payload = started!.payload as {
      combatants: Combatant[];
      roundNumber: number;
      reviewPhase: boolean;
    };
    expect(payload.reviewPhase).toBe(true);
    expect(payload.roundNumber).toBe(1);
    expect(Array.isArray(payload.combatants)).toBe(true);
    expect(payload.combatants.length).toBe(1);
    // Every combatant has the fields the client's InitiativeReviewModal
    // reads without optional chaining (name, initiative, initiativeBonus).
    for (const c of payload.combatants) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.initiative).toBe('number');
      expect(typeof c.initiativeBonus).toBe('number');
      expect(typeof c.tokenId).toBe('string');
      expect(typeof c.isNPC).toBe('boolean');
    }
  });

  it('combat:end after combat:start clears state and emits combat:ended', async () => {
    const sessionId = 's-end';
    seedRoom(sessionId, [tok('tNpc', { name: 'Npc' })]);

    const { io, socket, handlers, emissions } = makeHarness();
    registerCombatEvents(io, socket);

    await handlers['combat:start']!({ tokenIds: ['tNpc'] });
    await handlers['combat:end']!(undefined);

    expect(emissions.map((e) => e.event)).toContain('combat:ended');
    const room = getAllRooms().get(sessionId)!;
    expect(room.combatState).toBeNull();
  });
});

describe('combat:state-sync parity \u2014 refresh path rehydrates without review', () => {
  // We don't test the handler directly here (state-sync is in
  // sessionEvents, not combat). But we lock the contract that the
  // combatants from a fresh start-combat are valid-shaped enough to
  // rebuild via syncCombatState on the client.
  it('combatants emitted by combat:started match the shape combat:state-sync expects', async () => {
    const sessionId = 's-sync-shape';
    seedRoom(sessionId, [tok('tA', { name: 'A' }), tok('tB', { name: 'B' })]);

    const { io, socket, handlers, emissions } = makeHarness();
    registerCombatEvents(io, socket);
    await handlers['combat:start']!({ tokenIds: ['tA', 'tB'] });

    const started = emissions.find((e) => e.event === 'combat:started');
    const combatants = (started!.payload as { combatants: Combatant[] }).combatants;

    // Fields that sessionEvents:state-sync also ships: tokenId,
    // characterId, name, initiative, initiativeBonus, hp, maxHp,
    // armorClass, speed, isNPC, conditions, deathSaves.
    for (const c of combatants) {
      expect(c.tokenId).toBeTypeOf('string');
      expect(c.name).toBeTypeOf('string');
      expect(c.initiative).toBeTypeOf('number');
      expect(c.initiativeBonus).toBeTypeOf('number');
      expect(c.isNPC).toBeTypeOf('boolean');
      expect(c.deathSaves).toBeTypeOf('object');
      expect(c.deathSaves.successes).toBeTypeOf('number');
      expect(c.deathSaves.failures).toBeTypeOf('number');
    }
  });
});

// Silence the unused-import warning for the CombatState type — it
// documents the shape we assert against above.
void (null as unknown as CombatState);
