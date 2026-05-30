/**
 * Map-scoped broadcast coverage for ping / fog / zone events. These all
 * resolve the actor's *viewing* map and fan out via socketsOnMap (ping,
 * fog) or dmSocketsOnMap (zones), so:
 *
 *   - a DM acting on their PREVIEW map must not leak to players sitting on
 *     the ribbon map;
 *   - fog is DM-only and map-scoped;
 *   - zones are DM-only data and never reach player sockets at all.
 *
 * Fake-io/socket harness (no Socket.IO boot), same style as
 * combat-start-integration / token-fanout-scoping. Purely additive — no
 * changes to shipped handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Token } from '@dnd-vtt/shared';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('../db/connection.js', () => ({ default: { query: mockQuery } }));

import { registerMapEvents } from '../socket/mapEvents.js';
import { createRoom, getAllRooms, addPlayerToRoom } from '../utils/roomState.js';

interface Emission { channelId: string; event: string; payload: unknown }

function makeHarness(actorSocketId: string, actorUserId: string) {
  const handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const emissions: Emission[] = [];
  const record = (channelId: string) => ({
    emit: (event: string, payload: unknown) => emissions.push({ channelId, event, payload }),
  });
  const io = { to: record } as never;
  const socket = {
    id: actorSocketId,
    data: { userId: actorUserId, displayName: actorUserId },
    on: (event: string, handler: (d: unknown) => Promise<void> | void) => { handlers[event] = handler; },
    emit: (event: string, payload: unknown) => emissions.push({ channelId: actorSocketId, event, payload }),
    join: () => {},
    to: record,
  } as never;
  return { io, socket, handlers, emissions };
}

const SESSION = 's-mapscope';

/** DM (dm-sock) + player (player-sock), both on ribbon map-1 by default. */
function seedRoom(): void {
  const room = createRoom(SESSION, 'ROOM-MS', 'dm-user');
  room.currentMapId = 'map-1';
  room.playerMapId = 'map-1';
  room.gameMode = 'free-roam';
  addPlayerToRoom(SESSION, { userId: 'dm-user', displayName: 'DM', socketId: 'dm-sock', role: 'dm', characterId: null });
  addPlayerToRoom(SESSION, { userId: 'player-user', displayName: 'Pip', socketId: 'player-sock', role: 'player', characterId: null });
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
    color: '#000000',
    layer: 'token',
    visible: true,
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#ffffff',
    conditions: [],
    ownerUserId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function channelsFor(emissions: Emission[], event: string): string[] {
  return emissions.filter((e) => e.event === event).map((e) => e.channelId).sort();
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: unknown) => {
    const s = String(sql);
    if (/SELECT fog_state/i.test(s)) return Promise.resolve({ rows: [{ fog_state: '[]' }] });
    if (/COUNT\(\*\)/i.test(s)) return Promise.resolve({ rows: [{ n: 0 }] });
    return Promise.resolve({ rows: [] });
  });
  for (const id of Array.from(getAllRooms().keys())) getAllRooms().delete(id);
});

describe('map:ping scoping', () => {
  it('does not leak a DM preview-map ping to a player on the ribbon map', async () => {
    seedRoom();
    getAllRooms().get(SESSION)!.dmViewingMap.set('dm-user', 'map-2');
    const { io, socket, handlers, emissions } = makeHarness('dm-sock', 'dm-user');
    registerMapEvents(io, socket);

    await handlers['map:ping']!({ x: 10, y: 10 });

    expect(channelsFor(emissions, 'map:pinged')).toEqual(['dm-sock']);
  });

  it('delivers a ribbon-map ping to every socket on that map', async () => {
    seedRoom(); // DM has no preview → on the ribbon with the player
    const { io, socket, handlers, emissions } = makeHarness('dm-sock', 'dm-user');
    registerMapEvents(io, socket);

    await handlers['map:ping']!({ x: 10, y: 10 });

    expect(channelsFor(emissions, 'map:pinged')).toEqual(['dm-sock', 'player-sock']);
  });
});

describe('map:fog scoping (DM-only)', () => {
  it('ignores a fog-reveal from a non-DM', async () => {
    seedRoom();
    const { io, socket, handlers, emissions } = makeHarness('player-sock', 'player-user');
    registerMapEvents(io, socket);

    await handlers['map:fog-reveal']!({ points: [0, 0, 70, 0, 70, 70] });

    expect(channelsFor(emissions, 'map:fog-updated')).toEqual([]);
  });

  it('does not leak a DM preview-map fog update to a ribbon player', async () => {
    seedRoom();
    getAllRooms().get(SESSION)!.dmViewingMap.set('dm-user', 'map-2');
    const { io, socket, handlers, emissions } = makeHarness('dm-sock', 'dm-user');
    registerMapEvents(io, socket);

    await handlers['map:fog-reveal']!({ points: [0, 0, 70, 0, 70, 70] });

    expect(channelsFor(emissions, 'map:fog-updated')).toEqual(['dm-sock']);
  });

  it('delivers a ribbon-map fog update to DM and player', async () => {
    seedRoom();
    const { io, socket, handlers, emissions } = makeHarness('dm-sock', 'dm-user');
    registerMapEvents(io, socket);

    await handlers['map:fog-reveal']!({ points: [0, 0, 70, 0, 70, 70] });

    expect(channelsFor(emissions, 'map:fog-updated')).toEqual(['dm-sock', 'player-sock']);
  });
});

describe('map:zone scoping (DM-only data)', () => {
  it('ignores a zone-add from a non-DM', async () => {
    seedRoom();
    const { io, socket, handlers, emissions } = makeHarness('player-sock', 'player-user');
    registerMapEvents(io, socket);

    await handlers['map:zone-add']!({ name: 'Ambush', x: 0, y: 0, width: 5, height: 5 });

    expect(channelsFor(emissions, 'map:zones-updated')).toEqual([]);
  });

  it('broadcasts a zone update to DM sockets only — never to players', async () => {
    seedRoom();
    const { io, socket, handlers, emissions } = makeHarness('dm-sock', 'dm-user');
    registerMapEvents(io, socket);

    await handlers['map:zone-add']!({ name: 'Ambush', x: 0, y: 0, width: 5, height: 5 });

    const channels = channelsFor(emissions, 'map:zones-updated');
    expect(channels).toContain('dm-sock');
    expect(channels).not.toContain('player-sock');
  });
});

describe('token:update-vision-overrides scoping', () => {
  it('does not leak hidden-token vision changes to players', async () => {
    seedRoom();
    getAllRooms().get(SESSION)!.tokens.set('hidden-npc', token('hidden-npc', { visible: false }));
    const { io, socket, handlers, emissions } = makeHarness('dm-sock', 'dm-user');
    registerMapEvents(io, socket);

    await handlers['token:update-vision-overrides']!({
      tokenId: 'hidden-npc',
      visionOverrides: { darkvision: 60 },
    });

    expect(channelsFor(emissions, 'map:token-updated')).toEqual(['dm-sock']);
  });

  it('delivers visible-token vision changes to every socket on the map', async () => {
    seedRoom();
    getAllRooms().get(SESSION)!.tokens.set('visible-npc', token('visible-npc', { visible: true }));
    const { io, socket, handlers, emissions } = makeHarness('dm-sock', 'dm-user');
    registerMapEvents(io, socket);

    await handlers['token:update-vision-overrides']!({
      tokenId: 'visible-npc',
      visionOverrides: { darkvision: 60 },
    });

    expect(channelsFor(emissions, 'map:token-updated')).toEqual(['dm-sock', 'player-sock']);
  });
});
