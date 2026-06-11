/**
 * Mid-combat map-switch guard (audit #10).
 *
 * `map:activate-for-players` ("Move Players Here") and the legacy
 * `map:load` both clear `room.tokens` for the incoming map. During an
 * active fight that orphans every NPC combatant — their tokens stay on
 * the old map, so each monster turn auto-skips, turn announcements show
 * '???', and the encounter zombifies until combat is force-ended.
 *
 * Pinned here: while `combatState.active`, both handlers reject with a
 * clear `session:error` BEFORE any mutation (tokens untouched, no
 * map:loaded broadcast). With combat inactive they proceed past the
 * guard (and fail later on the mocked-empty DB — asserted only to show
 * the combat message specifically is gone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token, CombatState } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerSceneEvents } from '../socket/sceneEvents.js';
import { registerMapEvents } from '../socket/mapEvents.js';
import { createRoom, getAllRooms, addPlayerToRoom, deleteRoom } from '../utils/roomState.js';

interface Emission {
  channelId: string;
  event: string;
  payload: unknown;
}
type Handler = (data: unknown) => Promise<void> | void;

function fakeIo(emissions: Emission[]) {
  return {
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  } as never;
}

function driverFor(
  register: (io: never, socket: never) => void,
  emissions: Emission[],
  socketId: string
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: socketId,
    on: (event: string, cb: Handler) => handlers.set(event, cb),
    emit: (event: string, payload: unknown) =>
      emissions.push({ channelId: socketId, event, payload }),
    join: () => undefined,
    to: (channelId: string) => ({
      emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
    }),
  };
  register(fakeIo(emissions) as never, socket as never);
  return handlers;
}

const SESSION = 's-map-guard';

function tok(id: string): Token {
  return {
    id,
    mapId: 'map-old',
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
  };
}

function seedRoom(combatActive: boolean) {
  const room = createRoom(SESSION, 'ROOM-MG', 'dm-user');
  room.currentMapId = 'map-old';
  room.playerMapId = 'map-old';
  addPlayerToRoom(SESSION, {
    userId: 'dm-user',
    displayName: 'DM',
    socketId: 'dm-sock',
    role: 'dm',
    characterId: null,
  });
  room.tokens.set('goblin', tok('goblin'));
  if (combatActive) {
    room.combatState = {
      sessionId: SESSION,
      active: true,
      roundNumber: 3,
      currentTurnIndex: 0,
      combatants: [],
      startedAt: new Date().toISOString(),
    } as CombatState;
  }
  return room;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const id of Array.from(getAllRooms().keys())) deleteRoom(id);
});

const combatMsg = (em: Emission[]) =>
  em
    .filter((e) => e.event === 'session:error')
    .map((e) => (e.payload as { message: string }).message)
    .filter((m) => m.includes('End combat'));

describe('map:activate-for-players — combat guard', () => {
  it('rejects the ribbon move while combat is active (tokens untouched)', async () => {
    const em: Emission[] = [];
    const room = seedRoom(true);
    const h = driverFor(registerSceneEvents, em, 'dm-sock');
    await h.get('map:activate-for-players')!({ mapId: 'map-new' });
    expect(combatMsg(em)).toHaveLength(1);
    expect(room.tokens.has('goblin')).toBe(true); // nothing cleared
    expect(em.some((e) => e.event === 'map:loaded')).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled(); // bailed before any DB work
  });

  it('proceeds past the guard when combat is inactive', async () => {
    const em: Emission[] = [];
    seedRoom(false);
    const h = driverFor(registerSceneEvents, em, 'dm-sock');
    await h.get('map:activate-for-players')!({ mapId: 'map-new' });
    expect(combatMsg(em)).toHaveLength(0); // fails later on mocked DB, not on the guard
  });
});

describe('map:load — combat guard', () => {
  it('rejects the legacy load while combat is active (tokens untouched)', async () => {
    const em: Emission[] = [];
    const room = seedRoom(true);
    const h = driverFor(registerMapEvents, em, 'dm-sock');
    await h.get('map:load')!({ mapId: 'map-new' });
    expect(combatMsg(em)).toHaveLength(1);
    expect(room.tokens.has('goblin')).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('proceeds past the guard when combat is inactive', async () => {
    const em: Emission[] = [];
    seedRoom(false);
    const h = driverFor(registerMapEvents, em, 'dm-sock');
    await h.get('map:load')!({ mapId: 'map-new' });
    expect(combatMsg(em)).toHaveLength(0);
  });
});
